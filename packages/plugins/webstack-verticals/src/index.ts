/**
 * WebStack Verticals (网栈·垂) — 实验性垂直频道卫星包入口。
 *
 * 纯库形态：本包不做 cordis 装配、不自行启动；装配层（宿主插件或测试）
 * 按需 import `XVerticalChannel` 并注入 `VerticalDeps`。默认关闭纪律由
 * webstack 设置面（verticals.packEnabled / channels.x 默认 false）承载。
 *
 * @module dsh-webstack-verticals
 */

export * from './framework.ts'
export * from './x-search.ts'
