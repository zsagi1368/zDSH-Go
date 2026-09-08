/**
 * Shell lexical decomposition for Bash and PowerShell, written from scratch.
 *
 * Design contract: a parse FAILURE is not a danger verdict. Anything the
 * static layer cannot see through (command substitution, heredocs, process
 * substitution, splatting) becomes an `opaque` segment; the assessment layer
 * then only checks a small set of high-confidence semantic markers and
 * otherwise lets the OS sandbox confine the write boundary.
 */

export type ShellKind = 'bash' | 'pwsh'

export interface Segment {
  kind: 'word' | 'opaque'
  text: string
  /** Operator that separated this segment (&& || ; | > >> 2>&1). */
  joiner?: string | undefined
}

export interface Decomposition {
  segments: Segment[]
  /** Set when the whole line could not be statically decomposed. */
  opaqueReason?: string
}

export type Decision = 'allow' | 'classify' | 'deny'

export interface Assessment {
  decision: Decision
  reason: string
}

const BASH_JOINERS = ['&&', '||', ';', '|', '>', '>>']

/** Split on joiners while respecting quotes; $() `` $(()) << heredoc > opaque. */
export function decomposeBash(line: string): Decomposition {
  const segments: Segment[] = []
  let current = ''
  let lastJoiner = ''
  let i = 0
  const flush = (joiner: string) => {
    const text = current.trim()
    if (text.length > 0) {
      segments.push({
        kind: /[`$]|\bheredoc\b|<<|\$\(/.test(text) ? 'opaque' : 'word',
        text,
        joiner: lastJoiner || undefined,
      })
    }
    current = ''
    lastJoiner = joiner
  }

  while (i < line.length) {
    const ch = line[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      current += ch
      i += 1
      while (i < line.length && line[i] !== quote) {
        if (quote === '"' && line[i] === '\\' && i + 1 < line.length) {
          current += line.charAt(i) + (line[i + 1] ?? '')
          i += 2
          continue
        }
        current += line.charAt(i)
        i += 1
      }
      if (i >= line.length) return { segments: [], opaqueReason: 'unbalanced-quote' }
      current += quote
      i += 1
      continue
    }
    const rest = line.slice(i)
    const joiner = BASH_JOINERS.find(j => rest.startsWith(j))
    if (joiner) {
      flush(joiner)
      i += joiner.length
      continue
    }
    if (rest.startsWith('2>&1')) {
      current += '2>&1'
      i += 4
      continue
    }
    // Command substitution / heredoc intro makes the remainder opaque.
    if (rest.startsWith('$(') || rest.startsWith('`') || rest.startsWith('<<')) {
      segments.push({ kind: 'opaque', text: rest.trim(), joiner: lastJoiner || undefined })
      return { segments }
    }
    current += ch ?? ''
    i += 1
  }
  flush('')
  return { segments }
}

export function decomposePwsh(line: string): Decomposition {
  const segments: Segment[] = []
  let current = ''
  let lastJoiner = ''
  let i = 0
  const flush = (joiner: string) => {
    const text = current.trim()
    if (text.length > 0) {
      const splatting = /(^|\s)@\w/.test(text)
      segments.push({ kind: splatting ? 'opaque' : 'word', text, joiner: lastJoiner || undefined })
    }
    current = ''
    lastJoiner = joiner
  }

  while (i < line.length) {
    const ch = line[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      current += ch
      i += 1
      while (i < line.length && line[i] !== quote) {
        current += line.charAt(i)
        i += 1
      }
      if (i >= line.length) return { segments: [], opaqueReason: 'unbalanced-quote' }
      current += quote
      i += 1
      continue
    }
    const rest = line.slice(i)
    const joiner = ['&&', '||', ';', '|', '>', '>>'].find(j => rest.startsWith(j))
    if (joiner) {
      flush(joiner)
      i += joiner.length
      continue
    }
    // Subexpressions and splatting stay opaque.
    if (/^\(\s*\(|^\$\(/.test(rest) || /(^|\s)@\w+/.test((ch ?? '') + rest.slice(1, 8)) && ch === '@') {
      segments.push({ kind: 'opaque', text: rest.trim(), joiner: lastJoiner || undefined })
      return { segments }
    }
    current += ch ?? ''
    i += 1
  }
  flush('')
  return { segments }
}

export function decompose(shell: ShellKind, line: string): Decomposition {
  return shell === 'bash' ? decomposeBash(line) : decomposePwsh(line)
}
