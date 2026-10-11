/**
 * WorkerSandbox - Worker Thread 沙箱
 *
 * 为中等风险插件提供 Worker Thread 隔离。
 * 使用 Node.js worker_threads 创建独立执行环境。
 */

import { Worker, MessageChannel } from 'worker_threads'
import { PluginSandboxConfig, ExecResult, SandboxContext } from '../spec/index.js'

interface WorkerHandle {
  worker: Worker
  channel: MessageChannel
  startTime: number
  memoryUsage: number
  pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>
}

/**
 * WorkerSandbox - Worker Thread 沙箱
 *
 * 为中等风险插件提供 Worker Thread 隔离。
 * 使用 Node.js worker_threads 创建独立执行环境。
 */
export class WorkerSandbox implements SandboxContext {
  private workers = new Map<string, WorkerHandle>()
  private pluginId: string
  private config: PluginSandboxConfig
  private entryPoint: string
  private requestId = 0

  constructor(pluginId: string, config: PluginSandboxConfig, entryPoint: string) {
    this.pluginId = pluginId
    this.config = config
    this.entryPoint = entryPoint
  }

  /**
   * 启动 Worker
   */
  start(): Promise<void> {
    if (this.workers.has(this.pluginId)) {
      return Promise.reject(new Error(`Plugin ${this.pluginId} is already running`))
    }

    const channel = new MessageChannel()

    const worker = new Worker(this.entryPoint, {
      workerData: {
        pluginId: this.pluginId,
        config: this.config,
        // port 必须同时进入 workerData，工作线程才能拿到请求通道
        port: channel.port2,
      },
      transferList: [channel.port2],
      resourceLimits: {
        maxOldGenerationSizeMb: this.config.resources.memoryLimitMb,
        maxYoungGenerationSizeMb: 50,
        stackSizeMb: 10,
      },
    })

    const handle: WorkerHandle = {
      worker,
      channel,
      startTime: Date.now(),
      memoryUsage: 0,
      pendingRequests: new Map(),
    }

    this.workers.set(this.pluginId, handle)

    // 设置消息处理
    channel.port1.on('message', (message) => {
      this.handleMessage(message)
    })

    worker.on('exit', (code) => {
      this.workers.delete(this.pluginId)
      // Reject all pending requests
      for (const { reject } of handle.pendingRequests.values()) {
        reject(new Error(`Worker exited with code ${code}`))
      }
      handle.pendingRequests.clear()
    })

    /* v8 ignore next 7 -- production worker-crash wiring; an in-test worker error would surface as an uncaught exception. */
    worker.on('error', (error) => {
      this.workers.delete(this.pluginId)
      for (const { reject } of handle.pendingRequests.values()) {
        reject(error)
      }
      handle.pendingRequests.clear()
      throw error
    })

    return Promise.resolve()
  }

  /**
   * 停止 Worker
   */
  async stop(): Promise<void> {
    const handle = this.workers.get(this.pluginId)
    if (!handle) return

    await handle.worker.terminate()
    this.workers.delete(this.pluginId)
  }

  /**
   * 执行命令（受限）
   */
  exec(_command: string, _options?: unknown): Promise<ExecResult> {
    // Worker 线程不允许直接执行命令
    // 必须通过主线程 IPC
    return Promise.reject(
      new Error('exec() is not available in Worker sandbox. Use Process sandbox instead.'),
    )
  }

  /**
   * 读取文件（受限）
   */
  async read(path: string): Promise<string> {
    const result = await this.postMessage({
      type: 'read',
      path,
    })
    return result as string
  }

  /**
   * 写入文件（受限）
   */
  async write(path: string, content: string): Promise<void> {
    await this.postMessage({
      type: 'write',
      path,
      content,
    })
  }

  /**
   * 列出目录（受限）
   */
  async list(path: string): Promise<string[]> {
    const result = await this.postMessage({
      type: 'list',
      path,
    })
    return result as string[]
  }

  /**
   * 检查 Worker 是否运行
   * @returns 当前是否已有运行中的 Worker。
   */
  isRunning(): boolean {
    return this.workers.has(this.pluginId)
  }

  /**
   * 发送消息到工作线程并等待响应
   */
  private postMessage(message: Record<string, unknown>): Promise<unknown> {
    const handle = this.workers.get(this.pluginId)
    if (!handle) {
      return Promise.reject(new Error(`Plugin ${this.pluginId} is not running`))
    }

    const id = ++this.requestId
    const timeout = this.config.resources.timeoutMs

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        handle.pendingRequests.delete(id)
        reject(new Error('IPC timeout'))
      }, timeout)

      handle.pendingRequests.set(id, { resolve, reject })

      // port2 已转移给工作线程；主线程保留的 port1 是唯一的请求入口。
      // 信封字段放在展开之后，避免载荷里的同名字段覆盖协议字段。
      handle.channel.port1.postMessage({
        ...message,
        type: 'request',
        id,
      })
    })
  }

  /**
   * 处理来自工作线程的消息（经主线程保留的 port1 收到）
   */
  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return

    const msg = message as Record<string, unknown>

    // 处理响应（来自工作线程的响应）
    if (msg.type !== 'response') return

    /* v8 ignore start -- a response racing stop()'s workers.delete() cannot be synthesized deterministically. */
    const handle = this.workers.get(this.pluginId)
    if (!handle) return
    /* v8 ignore stop */

    const id = msg.id as number
    const pending = handle.pendingRequests.get(id)
    if (!pending) return

    handle.pendingRequests.delete(id)
    if (msg.error) {
      pending.reject(new Error(msg.error as string))
    } else {
      pending.resolve(msg.result)
    }
  }
}
