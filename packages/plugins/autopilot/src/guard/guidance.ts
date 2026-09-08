/**
 * Policy-sourced agent guidance.
 *
 * When Auto mode is active we do not just enforce rules silently — we inject
 * a dynamic system-prompt section teaching the agent how to live inside the
 * policy (split risky calls into visible literals, prefer reversible ops,
 * route sub-agent escalation requests upward). Compliance becomes
 * collaboration instead of adversarial whack-a-mole.
 */

export function buildGuidanceText(): string {
  return [
    '<auto_mode_policy>',
    'You are working under sandbox-first automatic approvals:',
    '- Ordinary work runs without prompts; stay inside the workspace.',
    '- Prefer reversible operations; before deleting anything that existed',
    '  before this session, say what it is and why in one short line.',
    '- Deletions must use ONE visible literal target per command — no globs,',
    '  no variables, no multi-target one-liners. Split them.',
    '- If you need a capability beyond the workspace boundary (danger-full-',
    '  access), request it once with a concrete justification; sub-agents must',
    '  report the need upward instead of escalating themselves.',
    '- When an action is denied, choose a safer alternative or ask the user;',
    '  never attempt to bypass the denial.',
    '</auto_mode_policy>',
  ].join('\n')
}
