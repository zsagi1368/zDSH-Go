/** Node child execution over an inherited control channel; no Harness services run here. */
import type { Duplex } from 'node:stream'
import { JsonChannel } from './channel.ts'
import { runProgram } from './bootstrap.ts'
import { HARNESS_HOME_ENVIRONMENT_NAMES, STARTUP_ENVIRONMENT_NAMES } from './environment.ts'
import type { PatchableStream } from './bootstrap.ts'
import type { ReplyMessage, ProgramBootData, ProgramToHost } from './protocol.ts'

/** Process-owned environment and output streams consumed by the child bootstrap. */
export interface ProgramProcess {
  env: NodeJS.ProcessEnv
  stdout: PatchableStream
  stderr: PatchableStream
  exitCode: string | number | null | undefined
}

/**
 * Run one host-supplied program after the control handshake.
 * @param stream - Inherited, already-adopted control endpoint.
 * @param maxMessageBytes - Host-validated maximum frame and queued-write bytes.
 * @param processState - Environment, output streams and exit status of this Node child.
 * @returns After control output flushes and host shutdown is observed, or transport failure closes the channel.
 */
export async function runNodeMain(stream: Duplex, maxMessageBytes: number, processState: ProgramProcess): Promise<void> {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0 || maxMessageBytes > 0xffff_ffff) throw new Error('invalid control message limit')
  // Scrub the ambient object IN PLACE first: this process IS `process`, and a
  // module that captured `process.env` before this point must not keep reading
  // ambient values. Native startup names stay because process creation needs
  // them; the harness home names stay because a program that runs the `dsh`
  // CLI must reach the same installation that is running it.
  for (const key of Object.keys(processState.env)) {
    const upper = key.toUpperCase()
    if (STARTUP_ENVIRONMENT_NAMES.has(upper) || HARNESS_HOME_ENVIRONMENT_NAMES.has(upper)) continue
    Reflect.deleteProperty(processState.env, key)
  }
  // The program's own environment starts empty apart from the harness home
  // directories, which is the one exception the execution instructions name.
  const kept: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv
  for (const key of Object.keys(processState.env)) {
    if (!HARNESS_HOME_ENVIRONMENT_NAMES.has(key.toUpperCase())) continue
    kept[key] = processState.env[key]
  }
  processState.env = kept
  const boot = Promise.withResolvers<ProgramBootData>()
  const listeners: Array<(message: ReplyMessage) => void> = []
  let started = false
  let failed = false
  let terminalSent = false
  const hostClosed = Promise.withResolvers<void>()
  const onClose = (): void => { hostClosed.resolve() }
  stream.once('close', onClose)
  const channel = new JsonChannel(stream, maxMessageBytes, (raw) => {
    if (!started) {
      started = true
      if (typeof raw !== 'object' || raw === null || (raw as { type?: unknown }).type !== 'boot') {
        boot.reject(new Error('expected program boot frame'))
        return
      }
      boot.resolve((raw as { data: ProgramBootData }).data)
      return
    }
    if (terminalSent) return
    for (const listener of listeners) listener(raw as ReplyMessage)
  }, (error, kind) => {
    if (!terminalSent || kind === 'protocol') {
      failed = true
      boot.reject(error)
      channel.close()
      processState.exitCode = 1
    }
    hostClosed.resolve()
  })
  const pending = new Set<Promise<void>>()
  const send = (message: ProgramToHost): void => {
    if (terminalSent) return
    if (message.type === 'done') terminalSent = true
    const task = channel.send(message).catch(() => {
      failed = true
      channel.close()
      processState.exitCode = 1
      hostClosed.resolve()
    }).finally(() => { pending.delete(task) })
    pending.add(task)
  }
  try {
    await channel.send({ type: 'ready' })
    const data = await boot.promise
    await runProgram({
      postMessage: send,
      on: (_event, listener) => { listeners.push(listener) },
    }, data, { stdout: processState.stdout, stderr: processState.stderr })
    while (pending.size > 0) await Promise.all(pending)
    await channel.drain()
    // Host binding replies can race the terminal frame; the host owns channel shutdown.
    await hostClosed.promise
  } finally {
    stream.off('close', onClose)
    channel.close()
    // Transport callbacks can set failed while the awaited program executes.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (failed) processState.exitCode = 1
  }
}
