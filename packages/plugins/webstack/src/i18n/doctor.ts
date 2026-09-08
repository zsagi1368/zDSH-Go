/**
 * 诊断面双语文案（W-B-113/114 / W-B-79 双语全覆盖）：键集 =
 * `webstack.doctor.*`，供 runDoctor/renderDoctor 与 web_backend_status 工具
 * 渲染使用。只允许 i18n 键引用，禁止自由文本拼接（W-B-53 防注入）。
 * zh/en 键集奇偶一致性由 tests/diag-doctor.test.ts 锁死。
 * @module webstack/i18n/doctor
 */

import type { TierMode } from '../kernel/types.ts'

/** 诊断文案键闭集 union（新增键 = 先加 zh，en 缺失直接红）。 */
export type DoctorI18nKey =
  | `webstack.doctor.tier.${TierMode}`
  | `webstack.doctor.rx.${TierMode}`
  | 'webstack.doctor.engine.ok'
  | 'webstack.doctor.engine.cooldown'
  | 'webstack.doctor.engine.unwired'
  | 'webstack.doctor.engine.last-code'
  | 'webstack.doctor.cache.stats'
  | 'webstack.doctor.bridge.online'
  | 'webstack.doctor.bridge.offline'
  | 'webstack.doctor.vertical.on'
  | 'webstack.doctor.vertical.off'
  | 'webstack.doctor.vertical.pack-missing'
  | 'webstack.doctor.rx.all-cooldown'
  | 'webstack.doctor.header'

/** 语言闭包（与 src/i18n/index.ts 的 Locale 同形；就地声明避免反向依赖）。 */
type Locale = 'zh' | 'en'

/** 中文诊断文案。`%s` 为值占位符，由 renderDoctor 按序替换。 */
export const doctorMessagesZh: Readonly<Record<DoctorI18nKey, string>> = Object.freeze({
  'webstack.doctor.tier.takeover': '运行档位：接管——宿主搜索选择器已指向 WebStack。',
  'webstack.doctor.tier.coexist': '运行档位：共存——WebStack 已注册为可选提供者，可在设置中选择。',
  'webstack.doctor.tier.diagnostic': '运行档位：只读诊断——宿主 web 接缝不可用，仅提供状态查看。',
  'webstack.doctor.rx.takeover': '无需处理；如需回退宿主内置搜索，在插件补丁配置中关闭接管即可。',
  'webstack.doctor.rx.coexist':
    '如需让 web_search 走本插件：将环境变量 DSH_WEB_SEARCH_PROVIDER / DSH_WEB_FETCH_PROVIDER 设为 webstack，或在宿主设置中指定 provider id。',
  'webstack.doctor.rx.diagnostic':
    '宿主缺少 ctx.web 服务或版本过旧：请升级 DeepSeek Harness 至支持 dsh-web 接缝的版本后再使用搜索功能。',
  'webstack.doctor.engine.ok': '[正常] %s',
  'webstack.doctor.engine.cooldown': '[冷却] %s（约 %s 秒后自动恢复）',
  'webstack.doctor.engine.unwired': '[未接线] %s（已配置但未注册，重载插件）',
  'webstack.doctor.engine.last-code': '上次错误码 %s',
  'webstack.doctor.cache.stats': '缓存统计：命中 %s 次 / 未命中 %s 次 / 当前条目 %s 条',
  'webstack.doctor.bridge.online': '浏览器桥接卫星：在线（T3 渲染兜底可用）。',
  'webstack.doctor.bridge.offline':
    '浏览器桥接卫星：离线/未配对（抓取仅静态管线）。处置：打开桥接扩展弹窗完成配对，并确认扩展 service worker 存活、桥接总闸已开启；不使用桥接可忽略本行。',
  'webstack.doctor.vertical.on': '垂直频道（X）：已开启，命中触发词时加发垂直腿。',
  'webstack.doctor.vertical.off': '垂直频道（X）：关闭（设置 verticals.channels.x 可开启）。',
  'webstack.doctor.vertical.pack-missing':
    '垂直频道（X）：已开启但卫星包 dsh-webstack-verticals 缺失，垂直腿将静默跳过；安装后重载即可启用。',
  'webstack.doctor.rx.all-cooldown':
    '全部引擎处于冷却：多为上游限流或网络异常所致。处置：等待上方倒计时自动恢复；若反复出现，检查对应引擎的凭据与网络出口，或调整候选层设置。',
  'webstack.doctor.header': 'WebStack 引擎体检报告',
})

/** English diagnostic copy. `%s` placeholders are replaced in order by renderDoctor. */
export const doctorMessagesEn: Readonly<Record<DoctorI18nKey, string>> = Object.freeze({
  'webstack.doctor.tier.takeover':
    'Tier mode: takeover — the host search selector points at WebStack.',
  'webstack.doctor.tier.coexist':
    'Tier mode: coexist — WebStack is registered as an optional provider; select it in settings.',
  'webstack.doctor.tier.diagnostic':
    'Tier mode: read-only diagnostics — the host web seam is unavailable; status view only.',
  'webstack.doctor.rx.takeover':
    'Nothing to do; to fall back to the built-in host search, disable takeover in the plugin patch config.',
  'webstack.doctor.rx.coexist':
    'To route web_search through this plugin: set DSH_WEB_SEARCH_PROVIDER / DSH_WEB_FETCH_PROVIDER to webstack, or pin the provider id in host settings.',
  'webstack.doctor.rx.diagnostic':
    'The host lacks the ctx.web service or it is too old: upgrade DeepSeek Harness to a build with the dsh-web seam before using search.',
  'webstack.doctor.engine.ok': '[OK] %s',
  'webstack.doctor.engine.cooldown': '[COOLDOWN] %s (recovers in about %s s)',
  'webstack.doctor.engine.unwired':
    '[UNWIRED] %s (configured but not registered; reload the plugin)',
  'webstack.doctor.engine.last-code': 'last error code %s',
  'webstack.doctor.cache.stats': 'Cache stats: %s hits / %s misses / %s entries',
  'webstack.doctor.bridge.online':
    'Browser bridge satellite: online (T3 render fallback available).',
  'webstack.doctor.bridge.offline':
    'Browser bridge satellite: offline/unpaired; fetch uses the static pipeline only. Fix: open the bridge extension popup to complete pairing, and make sure the extension service worker is alive and the bridge switch is on. Ignore this line if you do not use the bridge.',
  'webstack.doctor.vertical.on':
    'Vertical channel (X): enabled; a vertical leg is fired when trigger words match.',
  'webstack.doctor.vertical.off':
    'Vertical channel (X): off (enable via verticals.channels.x in settings).',
  'webstack.doctor.vertical.pack-missing':
    'Vertical channel (X): enabled but the satellite package dsh-webstack-verticals is missing; vertical legs are skipped silently. Install it and reload to enable.',
  'webstack.doctor.rx.all-cooldown':
    'All engines are cooling down: usually upstream rate limits or network failures. Wait for the countdowns above to elapse; if this keeps recurring, check the engine credentials and network egress, or adjust the candidate layer in settings.',
  'webstack.doctor.header': 'WebStack engine doctor report',
})

/** 取诊断文案；未知 locale 安全回落中文（与 errorText 同约定）。 */
export function doctorText(key: DoctorI18nKey, locale: Locale = 'zh'): string {
  return locale === 'en' ? doctorMessagesEn[key] : doctorMessagesZh[key]
}
