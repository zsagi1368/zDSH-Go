/**
 * ProcessSandbox - 进程级沙箱
 *
 * 为高风险插件提供独立的进程隔离。
 * 使用 Node.js child_process 创建独立进程，
 * 并通过 IPC 进行通信。
 */

import { spawn, ChildProcess, execFile } from 'child_process'
import { PluginSandboxConfig, ExecResult, ExecOptions, SandboxContext } from '../spec/index.js'
import { checkPathAllowed } from './path-guard.js'
import { deriveSandboxEnvironment } from './env.js'

/**
 * Strictly extract the base command (executable) from a command string.
 * Handles quoted arguments and shell metacharacters safely.
 * Returns undefined if the command contains dangerous characters.
 * @param command - the raw command string to parse.
 * @returns the extracted executable token, or `undefined` when the command
 * carries dangerous shell operators or no token survives parsing.
 */
export function extractCommandBase(command: string): string | undefined {
  // Reject commands with dangerous shell operators
  if (/[$`\\;|&><\n\r]/.test(command)) {
    return undefined
  }

  // Use a simple tokenizer that respects quotes
  let i = 0
  let token = ''
  let inSingleQuote = false
  let inDoubleQuote = false

  while (i < command.length) {
    const ch = command.charAt(i)
    if (inSingleQuote) {
      if (ch === "'") inSingleQuote = false
      else token += ch
    } else if (inDoubleQuote) {
      if (ch === '"') inDoubleQuote = false
      else token += ch
    } else if (ch === "'") {
      inSingleQuote = true
    } else if (ch === '"') {
      inDoubleQuote = true
    } else if (/\s/.test(ch)) {
      if (token.length > 0) break
    } else {
      token += ch
    }
    i++
  }

  return token.length > 0 ? token : undefined
}

interface ProcessHandle {
  process: ChildProcess
  startTime: number
  memoryUsage: number
  exitCode: number | null
  signal: string | null
}

/**
 * ProcessSandbox - 进程级沙箱
 *
 * 为高风险插件提供独立的进程隔离。
 * 使用 Node.js child_process 创建独立进程，并通过 IPC 进行通信。
 */
export class ProcessSandbox implements SandboxContext {
  private processes = new Map<string, ProcessHandle>()
  private processIntervals = new Map<string, ReturnType<typeof setInterval>>()
  private pluginId: string
  private config: PluginSandboxConfig
  private entryPoint: string
  /**
   * 宿主显式授予的完全执行权限。与 manifest 自声明的 `fullyAuthorized`
   * 不同，该字段只能由宿主构造沙箱时传入，manifest 无法自声明——两者同时
   * 为真才绕过命令白名单（fail-closed）。
   */
  private hostGrantedFull: boolean

  constructor(
    pluginId: string,
    config: PluginSandboxConfig,
    entryPoint: string,
    hostGrantedFull = false,
  ) {
    this.pluginId = pluginId
    this.config = config
    this.entryPoint = entryPoint
    this.hostGrantedFull = hostGrantedFull
  }

  /**
   * 启动插件进程
   */
  start(): Promise<void> {
    if (this.processes.has(this.pluginId)) {
      return Promise.reject(new Error(`Plugin ${this.pluginId} is already running`))
    }

    // 过滤环境变量
    const filteredEnv = this.filterEnvironment()

    // 创建子进程
    const child = spawn('node', [this.entryPoint], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: filteredEnv,
      detached: false,
      windowsHide: true,
    })

    const handle: ProcessHandle = {
      process: child,
      startTime: Date.now(),
      memoryUsage: 0,
      exitCode: null,
      signal: null,
    }

    this.processes.set(this.pluginId, handle)

    // 设置事件监听
    child.on('exit', (code, signal) => {
      handle.exitCode = code
      handle.signal = signal
      this.processes.delete(this.pluginId)
      const interval = this.processIntervals.get(this.pluginId)
      if (interval) {
        clearInterval(interval)
        this.processIntervals.delete(this.pluginId)
      }
    })

    /* v8 ignore next 3 -- production spawn-failure wiring; a failed spawn surfaces as 'exit' on every supported platform. */
    child.on('error', (error) => {
      this.processes.delete(this.pluginId)
      throw error
    })

    // 开始监控
    this.monitorProcess(this.pluginId)
    return Promise.resolve()
  }

  /**
   * 停止沙箱进程（先 SIGTERM，超时后 SIGKILL）
   */
  async stop(): Promise<void> {
    const handle = this.processes.get(this.pluginId)
    if (!handle) return

    handle.process.kill('SIGTERM')

    // 等待进程退出
    await new Promise<void>((resolve) => {
      /* v8 ignore next 3 -- SIGKILL fallback for children that ignore SIGTERM; not synthesizable cross-platform in tests. */
      const timeout = setTimeout(() => {
        handle.process.kill('SIGKILL')
        resolve()
      }, 5000)

      handle.process.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    this.processes.delete(this.pluginId)
    /* v8 ignore start -- the child's exit handler always clears the interval before stop() looks. */
    const interval = this.processIntervals.get(this.pluginId)
    if (interval) {
      clearInterval(interval)
      this.processIntervals.delete(this.pluginId)
    }
    /* v8 ignore stop */
  }

  /**
   * 执行命令
   */
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    // 两种模式的子进程环境都从白名单派生（见 deriveSandboxEnvironment），
    // 再合并调用方显式传入的覆盖项，杜绝全量宿主 env 泄露。
    const childEnv = {
      ...deriveSandboxEnvironment(this.config),
      ...(options?.env ?? {}),
    }

    // 完全授权模式：manifest 自声明 + 宿主显式授予同时成立才绕过命令白名单
    // （R-S43 前提 B：自声明不再自动授予，未授予时 fail-closed 落回白名单检查）。
    if (this.config.process.fullyAuthorized === true && this.hostGrantedFull) {
      const timeout = options?.timeout || this.config.resources.timeoutMs
      const start = Date.now()

      // 安全修复：使用 execFile 替代 exec，避免 shell 注入
      const cmdParts = command.trim().split(/\s+/)
      const cmd = cmdParts[0] || ''
      const args = cmdParts.slice(1)

      return new Promise((resolve, reject) => {
        execFile(cmd, args, {
          cwd: options?.cwd || process.cwd(),
          env: childEnv,
          timeout: timeout,
          maxBuffer: this.config.resources.maxOutputBytes * 2,
          windowsHide: true,
        }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(error.message))
          } else {
            resolve({
              exitCode: 0,
              stdout: stdout.substring(0, this.config.resources.maxOutputBytes),
              stderr,
              duration: Date.now() - start,
            })
          }
        })
      })
    }

    // 普通模式：需要白名单检查
    const cmdBase = extractCommandBase(command)
    if (!cmdBase || !this.config.process.allowedCommands.includes(cmdBase)) {
      throw new Error(`Command '${command}' is not allowed`)
    }

    const timeout = options?.timeout || this.config.resources.timeoutMs
    const start = Date.now()

    // 安全修复：使用 execFile 替代 spawn 带 shell: true
    const cmdParts = command.trim().split(/\s+/)
    const args = cmdParts.slice(1)

    return new Promise((resolve, reject) => {
      execFile(cmdBase, args, {
        cwd: options?.cwd || process.cwd(),
        env: childEnv,
        timeout: timeout,
        maxBuffer: this.config.resources.maxOutputBytes * 2,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(error.message))
        } else {
          resolve({
            exitCode: 0,
            stdout: stdout.substring(0, this.config.resources.maxOutputBytes),
            stderr,
            duration: Date.now() - start,
          })
        }
      })
    })
  }

  /**
   * 读取文件
   */
  async read(path: string): Promise<string> {
    // access 可能来自不受信的 JSON 配置，用宽松字符串比较做运行时闸门。
    const access = this.config.filesystem.access as string
    /* v8 ignore next 1 -- typed configs admit only readonly/readwrite; the second comparison guards decoded-JSON junk. */
    if (access === 'readonly' || access === 'readwrite') {
      if (this.isPathAllowed(path)) {
        const { readFileSync } = await import('fs')
        return readFileSync(path, 'utf-8')
      }
    }
    throw new Error(`Read access denied for path: ${path}`)
  }

  /**
   * 写入文件
   */
  async write(path: string, content: string): Promise<void> {
    if (this.config.filesystem.access === 'readwrite') {
      if (this.isPathAllowed(path)) {
        const { writeFileSync } = await import('fs')
        writeFileSync(path, content)
        return
      }
    }
    throw new Error(`Write access denied for path: ${path}`)
  }

  /**
   * 列出目录
   */
  async list(path: string): Promise<string[]> {
    const access = this.config.filesystem.access as string
    /* v8 ignore next 1 -- typed configs admit only readonly/readwrite; the second comparison guards decoded-JSON junk. */
    if (access === 'readonly' || access === 'readwrite') {
      if (this.isPathAllowed(path)) {
        const { readdirSync } = await import('fs')
        return readdirSync(path)
      }
    }
    throw new Error(`List access denied for path: ${path}`)
  }

  /**
   * 检查进程是否运行
   * @returns 是否已有运行中的沙箱进程。
   */
  isRunning(): boolean {
    return this.processes.has(this.pluginId)
  }

  /**
   * 获取内存使用
   * @returns 最近一次采样的进程内存使用量（字节），无进程时为 0。
   */
  getMemoryUsage(): number {
    const handle = this.processes.get(this.pluginId)
    return handle?.memoryUsage || 0
  }

  /**
   * 过滤环境变量
   * 安全修复：默认从运行必需项白名单派生（PATH/SYSTEMROOT/TEMP/NODE_* 等），
   * 不再下发全量宿主 env；显式白名单可点名提取，黑名单与敏感形状始终生效。
   * @returns 派生的沙箱子进程环境。
   */
  filterEnvironment(): NodeJS.ProcessEnv {
    return deriveSandboxEnvironment(this.config)
  }

  /**
   * 检查路径是否允许（与 InlineSandbox 共享同一 fail-closed 闸门）
   * @param path - 待检查的路径。
   * @returns 路径是否被允许访问。
   */
  isPathAllowed(path: string): boolean {
    return checkPathAllowed(this.config.filesystem, path)
  }

  /**
   * 监控进程
   */
  private monitorProcess(pluginId: string): void {
    const interval = setInterval(() => {
      const handle = this.processes.get(pluginId)
      /* v8 ignore start -- exit/stop always clear the interval with the handle. */
      if (!handle) {
        clearInterval(interval)
        this.processIntervals.delete(pluginId)
        return
      }
      /* v8 ignore stop */

      // 检查内存使用（实际实现需要获取进程统计）
      handle.memoryUsage = 0

      // 检查超时
      const elapsed = Date.now() - handle.startTime
      if (elapsed > this.config.resources.timeoutMs) {
        handle.process.kill()
        this.processes.delete(pluginId)
        clearInterval(interval)
        this.processIntervals.delete(pluginId)
      }
    }, 5000)
    this.processIntervals.set(pluginId, interval)
  }
}
