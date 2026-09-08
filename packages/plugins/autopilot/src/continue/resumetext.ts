/**
 * Resume text templates with placeholder filling and idempotency guardrails.
 *
 * The guardrail suffix depends on where the previous turn died: a tool whose
 * result never arrived gets "confirm first, do not redo", a tool that clearly
 * succeeded gets "already done, continue after it", and a failed tool gets NO
 * guardrail — retrying it is the whole point.
 */
export type TemplateKind = 'continue' | 'continue-max-tokens' | 'loop'

export interface TemplateContext {
  code?: string
  message?: string
  status?: string
  tool?: string
  turn?: string
  elapsedMs?: number
}

export type GuardToolState = 'pending' | 'done' | 'failed'

export interface GuardTexts {
  pending?: string
  done?: string
  failed?: string
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}

export function fillTemplate(template: string, ctx: TemplateContext): string {
  const replacements: Record<string, string> = {
    code: ctx.code ?? 'unknown',
    message: (ctx.message ?? '').slice(0, 200),
    status: ctx.status ?? '',
    tool: ctx.tool ?? '',
    turn: ctx.turn ?? '',
    elapsed: ctx.elapsedMs === undefined ? '' : formatElapsed(ctx.elapsedMs),
  }
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => replacements[key] ?? whole)
}

export function buildResumeText(args: {
  kind: TemplateKind
  texts: { continue: string; continueMaxTokens: string; loop: string }
  ctx: TemplateContext
  guardState?: GuardToolState
  guards: GuardTexts
}): string {
  const base =
    args.kind === 'loop'
      ? args.texts.loop
      : args.kind === 'continue-max-tokens'
        ? args.texts.continueMaxTokens
        : args.texts.continue
  let text = fillTemplate(base, args.ctx)

  if (args.kind !== 'loop' && args.guardState) {
    const suffix =
      args.guardState === 'pending'
        ? args.guards.pending
        : args.guardState === 'done'
          ? args.guards.done
          : undefined // failed → no guardrail: retrying IS the intent
    if (suffix) text = `${text}\n\n${fillTemplate(suffix, { ...args.ctx })}`
  }
  return text
}
