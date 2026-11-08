/** Deliver console interrupts to CLI listeners in Electron's Windows Node mode. */

/**
 * Register the CLI process's Windows console handler.
 * Koffi queues callbacks from the console thread onto the JavaScript thread.
 * The registration lasts until process exit; unknown events retain native handling.
 * @returns Completion once the console handler is registered.
 */
export async function installWindowsCliSignals(): Promise<void> {
  const { default: koffi } = await import('koffi')
  const kernel = koffi.load('kernel32.dll')
  // Electron（Chromium 引导）在 Windows node 模式下把 CTRL_C 置为进程级 ignore
  // （SetConsoleCtrlHandler(NULL, TRUE) 语义；CTRL_BREAK 不受该标志约束，故只有
  // SIGINT 丢失）。注册处理器前先解除 ignore——这是本模块职责的一部分：不解除，
  // CTRL_C 永远到不了任何处理器（探针实测 ready=1 signalled=1 completed=0；解除后
  // completed=1 code=130 marker=SIGINT）。best-effort：个别系统上调用失败时退化为
  // 既有行为（SIGBREAK 可达），不阻塞 CLI 启动。
  kernel.func('int __stdcall SetConsoleCtrlHandler(void *handler, int add)')(null, 0)
  const type = koffi.proto('int __stdcall DshCliConsoleHandler(uint32_t event)')
  const handler = koffi.register((event: number) => {
    if (event === 0) return Number(process.emit('SIGINT'))
    if (event === 1) return Number(process.emit('SIGBREAK'))
    return 0
  }, koffi.pointer(type))
  const install = kernel.func('int __stdcall SetConsoleCtrlHandler(DshCliConsoleHandler *handler, int add)')
  if (!install(handler, 1)) {
    koffi.unregister(handler)
    throw new Error('desktop CLI: cannot register the Windows console handler')
  }
}
