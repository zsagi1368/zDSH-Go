/**
 * Subprocess runtime for project plugins (S-43 M2b).
 *
 * A project plugin whose clamped sandbox type is `'process'` or `'worker'` is
 * loaded and executed in a subprocess (child process or worker thread). The
 * subprocess runs a mini Cordis runtime that loads the plugin entry module,
 * registers its tools, and responds to tool execution requests via IPC.
 *
 * Key design points:
 * - The subprocess bootstrap is generated as a string with inlined absolute
 *   module paths, so no bare-specifier resolution is needed at the subprocess
 *   side: the host resolves `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`,
 *   and `@deepseek-ai/dsh-system-prompt` via `createRequire` and passes the
 *   file:// URLs into the bootstrap source.
 * - On timeout (config.resources.timeoutMs), the subprocess is killed
 *   (SIGKILL for child_process, terminate() for worker_threads) — the hung
 *   execution body is reclaimed and the host event loop survives (B-06).
 * - Memory limits are enforced via V8 `--max-old-space-size` (process mode)
 *   or Worker `resourceLimits` (worker mode, reusing the WorkerSandbox
 *   precedent at worker-sandbox.ts:52-56).
 * - IPC whitelist: only manifest-declared tool names are accepted; the host
 *   registers proxy tools from the manifest capabilities, so only whitelisted
 *   names can reach the subprocess.
 * @module @deepseek-ai/dsh-plugin-project-root
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { PluginSandboxConfig } from '@deepseek-ai/dsh-plugin-governance'
import { deriveSandboxEnvironment } from '@deepseek-ai/dsh-plugin-governance'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * IPC message envelope from the host to the subprocess.
 * @internal
 */
interface SubprocessRequest {
  type: 'execute-tool' | 'shutdown'
  id: number
  name?: string
  args?: unknown
}

/**
 * IPC message envelope from the subprocess to the host.
 * @internal
 */
interface SubprocessResponse {
  type: 'ready' | 'tool-result' | 'tool-error'
  id?: number
  result?: ToolExecutionResult
  error?: { name: string; message: string }
}

/** Error thrown when a subprocess tool execution times out. */
export class SubprocessTimeoutError extends Error {
  override readonly name = 'SubprocessTimeoutError'
  constructor(pluginId: string, timeoutMs: number) {
    super(`subprocess plugin ${JSON.stringify(pluginId)} timed out after ${timeoutMs}ms; execution body reclaimed`)
  }
}

/** Error thrown when a subprocess tool execution fails. */
export class SubprocessToolError extends Error {
  override readonly name = 'SubprocessToolError'
  constructor(pluginId: string, message: string) {
    super(`subprocess plugin ${JSON.stringify(pluginId)}: ${message}`)
  }
}

/**
 * Options for creating a subprocess runtime.
 */
export interface SubprocessRuntimeOptions {
  /** Canonical manifest plugin id. */
  pluginId: string
  /** Sandbox type: 'process' (child_process) or 'worker' (worker_threads). */
  type: 'process' | 'worker'
  /** Absolute path to the plugin entry file (index.js). */
  entryFile: string
  /** Clamped sandbox config (resources.timeoutMs, memoryLimitMb, environment). */
  config: PluginSandboxConfig
  /** IPC whitelist: tool names that the host may forward to this subprocess. */
  toolWhitelist: string[]
}

/**
 * A running subprocess runtime that manages one plugin's subprocess lifecycle.
 */
export interface SubprocessRuntime {
  /** Start the subprocess, load the plugin, and wait for the ready handshake. */
  start(): Promise<void>
  /** Gracefully stop the subprocess (SIGTERM then SIGKILL, or terminate). */
  stop(): Promise<void>
  /** Whether the subprocess is currently running. */
  isRunning(): boolean
  /**
   * Execute a tool call in the subprocess.
   * @param name - tool name (must be in the whitelist).
   * @param args - tool arguments (lossless JSON).
   * @returns the full ToolExecutionResult from the subprocess.
   * @throws {SubprocessTimeoutError} on timeout (the subprocess is killed).
   * @throws {SubprocessToolError} on subprocess-reported error.
   * @throws {Error} when the subprocess is not running.
   */
  executeTool(name: string, args: unknown): Promise<ToolExecutionResult>
}

// ---------------------------------------------------------------------------
// Bootstrap generation
// ---------------------------------------------------------------------------

/**
 * Resolved absolute paths for the package modules the subprocess needs.
 * Computed once on the host from the plugin-project-root package's own
 * node_modules (which has cordis and dsh-tools, and, via the tools package's
 * node_modules, dsh-system-prompt).
 */
function resolveHostModulePaths(): { cordis: string; tools: string; systemPrompt: string } {
  const here = dirname(fileURLToPath(import.meta.url))
  const req = createRequire(join(here, 'resolve.js'))
  const cordis = req.resolve('@deepseek-ai/cordis')
  const tools = req.resolve('@deepseek-ai/dsh-tools')
  const toolsReq = createRequire(join(dirname(tools), 'resolve.js'))
  const systemPrompt = toolsReq.resolve('@deepseek-ai/dsh-system-prompt')
  return { cordis, tools, systemPrompt }
}

/** Maximum time (ms) to wait for the subprocess to send its 'ready' message. */
const SUBPROCESS_STARTUP_TIMEOUT_MS = 10_000

/**
 * Generate the bootstrap source string for the subprocess. The bootstrap is
 * self-contained: every dependency is an absolute file:// URL inlined from
 * {@link resolveHostModulePaths}, and the channel abstraction makes the same
 * source work for worker_threads and child_process IPC.
 */
function generateBootstrapSource(
  type: 'process' | 'worker',
  pluginId: string,
  entryFile: string,
  toolWhitelist: string[],
): string {
  const paths = resolveHostModulePaths()
  const cordisUrl = pathToFileURL(paths.cordis).href
  const toolsUrl = pathToFileURL(paths.tools).href
  const syspromptUrl = pathToFileURL(paths.systemPrompt).href
  const entryUrl = pathToFileURL(entryFile).href

  // Channel abstraction: worker mode uses parentPort (via require in CJS),
  // process mode uses process.send/on('message') (available because stdio
  // includes 'ipc'). Both modes run as CJS (no static imports needed).
  // The bootstrap is a CJS script so it works in both eval worker and
  // `node -e` (no `--input-type=module` flag).
  const channel = type === 'worker'
    ? 'const { parentPort } = require("node:worker_threads"); const send = (m) => parentPort.postMessage(m); const onMessage = (h) => parentPort.on("message", h)'
    : 'const send = (m) => { if (typeof process.send === "function") process.send(m) }; const onMessage = (h) => process.on("message", h)'

  // Shutdown handling differs: worker threads have no process.exit; the host
  // force-kills 500ms after shutdown anyway, so the handler is best-effort.
  const shutdownBody = type === 'worker'
    ? 'await ctx.fiber.dispose(); parentPort.close()'
    : 'await ctx.fiber.dispose(); process.exit(0)'

  return `
${channel}

var cordisUrl = ${JSON.stringify(cordisUrl)}
var toolsUrl = ${JSON.stringify(toolsUrl)}
var syspromptUrl = ${JSON.stringify(syspromptUrl)}
var entryUrl = ${JSON.stringify(entryUrl)}
var toolWhitelist = ${JSON.stringify(toolWhitelist)}
var pluginId = ${JSON.stringify(pluginId)}

async function main() {
  var { Context } = await import(cordisUrl)
  var { default: SystemPrompt } = await import(syspromptUrl)
  var { default: ToolRuntime } = await import(toolsUrl)
  var ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  var mod = await import(entryUrl)
  var entryModule = mod.default ?? mod
  await ctx.plugin(entryModule, {})
  send({ type: "ready" })
  onMessage(async function(msg) {
    if (msg.type === "shutdown") { ${shutdownBody} }
    if (msg.type !== "execute-tool") return
    if (!toolWhitelist.includes(msg.name)) {
      send({ type: "tool-error", id: msg.id, error: { name: "SubprocessToolError", message: "tool " + JSON.stringify(msg.name) + " is not in the IPC whitelist" } })
      return
    }
    try {
      var result = await ctx.tools.execute({ signal: new AbortController().signal, callId: String(msg.id), name: msg.name, arguments: msg.args })
      send({ type: "tool-result", id: msg.id, result })
    } catch (error) {
      send({ type: "tool-error", id: msg.id, error: { name: error?.name ?? "Error", message: error?.message ?? String(error) } })
    }
  })
}
main().catch(async function(error) {
  send({ type: "tool-error", id: -1, error: { name: "BootstrapError", message: error?.message ?? String(error) } })
  ${type === 'worker' ? 'parentPort.close()' : 'process.exit(1)'}
})
`
}

// ---------------------------------------------------------------------------
// Runtime implementation
// ---------------------------------------------------------------------------

/** One pending IPC request with its timeout timer. */
interface PendingRequest {
  resolve: (value: ToolExecutionResult) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Create a subprocess runtime for one project plugin.
 *
 * @param options - runtime options derived from the clamped sandbox and manifest.
 * @returns the runtime handle.
 */
export function createSubprocessRuntime(options: SubprocessRuntimeOptions): SubprocessRuntime {
  const { pluginId, type, entryFile, config, toolWhitelist } = options
  const whitelist = new Set(toolWhitelist)

  // --- State ---
  let child: ChildProcess | null = null
  let worker: Worker | null = null
  let running = false
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  let readyResolve: (() => void) | null = null
  let startReject: ((error: Error) => void) | null = null
  const pending = new Map<number, PendingRequest>()
  let nextId = 1

  /** Send a message to the subprocess. */
  function send(msg: SubprocessRequest): void {
    if (worker !== null) {
      worker.postMessage(msg)
    } else if (child !== null && child.connected) {
      child.send(msg)
    }
  }

  /** Handle a response message from the subprocess. */
  function onResponse(msg: SubprocessResponse): void {
    if (msg.type === 'ready') {
      if (startupTimer !== null) {
        clearTimeout(startupTimer)
        startupTimer = null
      }
      readyResolve?.()
      readyResolve = null
      return
    }
    if (msg.id === undefined) return
    const pendingEntry = pending.get(msg.id)
    if (pendingEntry === undefined) return
    clearTimeout(pendingEntry.timer)
    pending.delete(msg.id)
    if (msg.type === 'tool-result' && msg.result !== undefined) {
      pendingEntry.resolve(msg.result)
    } else {
      pendingEntry.reject(new SubprocessToolError(pluginId, msg.error?.message ?? 'unknown subprocess error'))
    }
  }

  /** Reject all pending requests with a given error. */
  function rejectAllPending(error: Error): void {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    pending.clear()
  }

  /** The subprocess died unexpectedly: settle everything the host is waiting on. */
  function onSubprocessExit(error: Error): void {
    running = false
    if (startupTimer !== null) {
      clearTimeout(startupTimer)
      startupTimer = null
    }
    rejectAllPending(error)
    if (startReject !== null) {
      const reject = startReject
      startReject = null
      reject(error)
    }
  }

  /** Kill the subprocess forcefully. */
  function terminate(): void {
    if (worker !== null) {
      void worker.terminate()
      worker = null
    } else if (child !== null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // already dead
      }
      child = null
    }
    running = false
    readyResolve = null
  }

  // --- Runtime interface ---

  const runtime: SubprocessRuntime = {
    async start(): Promise<void> {
      if (running) return

      // The subprocess environment is derived from the host env through the
      // sandbox environment filter (B-09: no sensitive host env leaks).
      const childEnv = deriveSandboxEnvironment(config, process.env)
      const bootstrap = generateBootstrapSource(type, pluginId, entryFile, toolWhitelist)

      if (type === 'worker') {
        worker = new Worker(bootstrap, {
          eval: true,
          env: childEnv,
          resourceLimits: {
            maxOldGenerationSizeMb: config.resources.memoryLimitMb,
            maxYoungGenerationSizeMb: 50,
            stackSizeMb: 10,
          },
        })
        worker.on('message', onResponse)
        worker.on('exit', (code) => {
          onSubprocessExit(new SubprocessToolError(pluginId, `worker exited with code ${code}`))
        })
        worker.on('error', (error) => {
          onSubprocessExit(new SubprocessToolError(pluginId, `worker error: ${error.message}`))
        })
      } else {
        child = spawn(process.execPath, [
          `--max-old-space-size=${config.resources.memoryLimitMb}`,
          '-e',
          bootstrap,
        ], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: childEnv,
          windowsHide: true,
        })
        child.on('message', onResponse)
        child.on('exit', (code) => {
          onSubprocessExit(new SubprocessToolError(pluginId, `child process exited with code ${code}`))
        })
        child.on('error', (error) => {
          onSubprocessExit(new SubprocessToolError(pluginId, `child process error: ${error.message}`))
        })
      }

      running = true

      // Wait for the 'ready' handshake within the startup timeout. The ready
      // message resolves; an exit before ready rejects via onSubprocessExit.
      await new Promise<void>((resolve, reject) => {
        readyResolve = resolve
        startReject = reject
        startupTimer = setTimeout(() => {
          startupTimer = null
          terminate()
          reject(new SubprocessToolError(pluginId, 'subprocess did not send ready within startup timeout'))
        }, SUBPROCESS_STARTUP_TIMEOUT_MS)
      })
    },

    async stop(): Promise<void> {
      if (!running) return
      // Graceful shutdown: ask the subprocess to dispose, force-kill after a
      // short grace period.
      send({ type: 'shutdown', id: 0 })
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          terminate()
          resolve()
        }, 500)
        const onExit = (): void => {
          clearTimeout(timeout)
          resolve()
        }
        if (worker !== null) {
          worker.once('exit', onExit)
        } else if (child !== null) {
          child.once('exit', onExit)
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })
      running = false
      readyResolve = null
    },

    isRunning(): boolean {
      return running
    },

    async executeTool(name: string, args: unknown): Promise<ToolExecutionResult> {
      // IPC whitelist enforcement (host-side gate, T3-E).
      if (!whitelist.has(name)) {
        throw new SubprocessToolError(pluginId, `tool ${JSON.stringify(name)} is not in the IPC whitelist`)
      }
      if (!running) {
        throw new SubprocessToolError(pluginId, 'subprocess is not running')
      }
      const id = nextId++
      return new Promise<ToolExecutionResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          // The subprocess is hung — reclaim the execution body by killing it.
          terminate()
          reject(new SubprocessTimeoutError(pluginId, config.resources.timeoutMs))
        }, config.resources.timeoutMs)
        pending.set(id, { resolve, reject, timer })
        send({ type: 'execute-tool', id, name, args })
      })
    },
  }

  return runtime
}
