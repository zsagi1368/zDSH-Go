/**
 * Inline SVG icon set for mention candidates and chips (spec FR-B7: eight
 * extension classes). Pure presentation, self-contained, scoped by the
 * zdsh-filehub- prefix; no host assets or class names.
 */
import type { ReactNode } from 'react'

const ICON_STROKE = 'currentColor'

function FileGlyph({ body }: { body: ReactNode }): ReactNode {
  return (
    <svg className="zdsh-filehub-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4 1.5h5L13 5v9a.9.9 0 0 1-.9.9H4.9A.9.9 0 0 1 4 14V2.4Z"
        fill="none"
        stroke={ICON_STROKE}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {body}
    </svg>
  )
}

/** Extension-class icons: markdown, ts/js family, python, json/yaml, image, pdf, archive, generic file/directory. */
export function iconForEntry(kind: 'file' | 'directory', name: string): ReactNode {
  if (kind === 'directory') {
    return (
      <svg className="zdsh-filehub-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M1.8 3.5h4l1.4 1.6h6.9c.4 0 .7.3.7.7v7.4c0 .4-.3.7-.7.7H1.8a.7.7 0 0 1-.7-.7V4.2c0-.4.3-.7.7-.7Z"
          fill="none"
          stroke={ICON_STROKE}
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'md':
    case 'markdown':
      return (
        <FileGlyph body={
          <path d="M6 11V7l2 2.2L10 7v4M12.5 7v4m0-1.6 1.3-1.5m-1.3 3.1 1.3 1.4" fill="none" stroke={ICON_STROKE} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        } />
      )
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return (
        <FileGlyph body={
          <path d="m6.4 7.6-1.8 1.8 1.8 1.8m3.2-3.6 1.8 1.8-1.8 1.8" fill="none" stroke={ICON_STROKE} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        } />
      )
    case 'py':
      return (
        <FileGlyph body={
          <>
            <circle cx="6.6" cy="9" r="0.7" fill={ICON_STROKE} />
            <circle cx="9.4" cy="11" r="0.7" fill={ICON_STROKE} />
            <path d="M8.2 6.6c-1.6 0-1.6 1.2-1.6 1.2v1h2.8v.9s.1 1.3-1.4 1.3" fill="none" stroke={ICON_STROKE} strokeWidth="1" strokeLinecap="round" />
          </>
        } />
      )
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
      return (
        <FileGlyph body={
          <path d="M6 6.4 4.4 8 6 9.6m4-3.2L11.6 8 10 9.6M8.6 5.8l-1.2 4.4" fill="none" stroke={ICON_STROKE} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        } />
      )
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'ico':
    case 'svg':
      return (
        <FileGlyph body={
          <>
            <rect x="5.6" y="7" width="6.2" height="4.6" rx="0.6" fill="none" stroke={ICON_STROKE} strokeWidth="1" />
            <circle cx="7.3" cy="8.6" r="0.6" fill={ICON_STROKE} />
            <path d="m6.4 11.2 1.7-1.7 1.2 1.2 1.1-1.1 1 1" fill="none" stroke={ICON_STROKE} strokeWidth="0.9" strokeLinejoin="round" />
          </>
        } />
      )
    case 'pdf':
      return (
        <FileGlyph body={
          <path d="M6.2 11.4V7h1.5a1.1 1.1 0 1 1 0 2.2H6.2m3.8-.1v2.3m0-2.3c0-1 1.8-1 1.8 0s-1.8 1-1.8 2.3Z" fill="none" stroke={ICON_STROKE} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
        } />
      )
    case 'zip':
    case 'gz':
    case 'tar':
    case 'tgz':
      return (
        <FileGlyph body={
          <>
            <path d="M8 6.4v1m0 .9v1m0 .9v.9" stroke={ICON_STROKE} strokeWidth="1" strokeLinecap="round" />
            <rect x="6.9" y="11.2" width="2.2" height="1.4" rx="0.3" fill="none" stroke={ICON_STROKE} strokeWidth="0.9" />
          </>
        } />
      )
    default:
      return (
        <FileGlyph body={
          <path d="M6.4 8.4h3.2M6.4 10.2h3.2" stroke={ICON_STROKE} strokeWidth="1" strokeLinecap="round" />
        } />
      )
  }
}
