/**
 * 联网模式三态按钮（`conversation.input.left` 列表槽的会话级条目）。
 *
 * 三态循环 off → on → ask → off，对应宿主 `mode.sessionOnline`
 * （SessionOnlineMode）。写入通道由装配层注入：settingsScope 可写时经
 * `scope.set('mode.sessionOnline', …)` 落宿主文档；不可达/不可写时
 * requestChange 缺省，按钮退化为会话内本地态（刷新即回到初始值）。
 *
 * 交互约束沿用 composer 工具行的惯例：小尺寸、常显、不占独立行。
 *
 * @module webstack/client/input-toggle
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useState } from 'react'
import type { SessionOnlineMode } from '../kernel/types.ts'
import type { ToggleKey } from './locale.ts'

/** 三态循环序。 */
export const ONLINE_MODE_CYCLE: readonly SessionOnlineMode[] = ['off', 'on', 'ask']

/** 循环取下一态。 */
export function nextOnlineMode(mode: SessionOnlineMode): SessionOnlineMode {
  const at = ONLINE_MODE_CYCLE.indexOf(mode)
  return ONLINE_MODE_CYCLE[(at + 1) % ONLINE_MODE_CYCLE.length] ?? 'off'
}

const TIP_KEY: Record<SessionOnlineMode, ToggleKey> = {
  off: 'tipOff',
  on: 'tipOn',
  ask: 'tipAsk',
}

const MODE_KEY: Record<SessionOnlineMode, ToggleKey> = {
  off: 'modeOff',
  on: 'modeOn',
  ask: 'modeAsk',
}

/** 组件 props：框架标准座席（t）+ 可选的宿主写入通道。alpha.4 起框架标准座不再注入 sessionId。 */
export interface OnlineModeToggleProps {
  t: TranslateNS<'webstack.toggle'>
  /** 初始态；宿主可读时由装配层从快照注入，缺省 off。 */
  initial?: SessionOnlineMode | undefined
  /** 宿主写入通道；缺席 = 本地态降级。返回 false 表示写入被拒绝（本地回滚）。 */
  requestChange?: ((next: SessionOnlineMode) => boolean) | undefined
}

export function OnlineModeToggle(props: OnlineModeToggleProps) {
  const [mode, setMode] = useState<SessionOnlineMode>(props.initial ?? 'off')
  const click = () => {
    const next = nextOnlineMode(mode)
    const accepted = props.requestChange?.(next) ?? true
    if (accepted) setMode(next)
  }
  return (
    <button
      type="button"
      data-webstack-online=""
      data-mode={mode}
      aria-pressed={mode !== 'off'}
      title={
        mode === 'off' && props.requestChange === undefined
          ? props.t('tipLocalOnly')
          : props.t(TIP_KEY[mode])
      }
      onClick={click}
    >
      {`${props.t('toggleLabel')}:${props.t(MODE_KEY[mode])}`}
    </button>
  )
}
