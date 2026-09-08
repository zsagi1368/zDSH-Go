/**
 * FileHub client stylesheet, self-injected once per document. Every selector
 * is scoped under the plugin-owned `zdsh-filehub-` class prefix; no
 * host-private class names are referenced anywhere (hash-named host classes
 * break across versions). Layout-affecting properties stay inside our own
 * subtrees so slot owners keep control of their geometry.
 */

export const STYLES = `
.zdsh-filehub-hidden-input { display: none !important; }

button.zdsh-filehub-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0.82;
}
button.zdsh-filehub-btn:hover,
button.zdsh-filehub-btn:focus-visible {
  opacity: 1;
  background: rgba(127, 127, 127, 0.14);
  outline: none;
}
.zdsh-filehub-btn-icon { width: 14px; height: 14px; }

.zdsh-filehub-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(16, 24, 40, 0.45);
  backdrop-filter: blur(2px);
  pointer-events: none;
}
.zdsh-filehub-mask-card {
  max-width: 420px;
  padding: 20px 32px;
  border-radius: 12px;
  border: 2px dashed rgba(255, 255, 255, 0.55);
  background: rgba(16, 24, 40, 0.72);
  color: #fff;
  text-align: center;
}
.zdsh-filehub-mask-title { font-size: 18px; font-weight: 600; }
.zdsh-filehub-mask-sub { margin-top: 6px; font-size: 12px; opacity: 0.85; }

.zdsh-filehub-dock {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 0;
}
.zdsh-filehub-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 3px 6px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.3;
}
.zdsh-filehub-row:hover { background: rgba(127, 127, 127, 0.10); }
.zdsh-filehub-badge {
  flex: none;
  min-width: 30px;
  text-align: center;
  padding: 2px 4px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.18);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  overflow: hidden;
}
.zdsh-filehub-name {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zdsh-filehub-dir-mark { flex: none; opacity: 0.7; }
.zdsh-filehub-size { flex: none; opacity: 0.65; font-variant-numeric: tabular-nums; }
.zdsh-filehub-bar {
  flex: 1 1 60px;
  height: 4px;
  min-width: 48px;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.22);
  overflow: hidden;
}
.zdsh-filehub-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: currentColor;
  transition: width 120ms ease-out;
}
.zdsh-filehub-status { flex: none; opacity: 0.75; }
.zdsh-filehub-status--done { color: #2fa36b; opacity: 1; }
.zdsh-filehub-status--error { color: #e5484d; opacity: 1; }
.zdsh-filehub-error-text { color: #e5484d; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zdsh-filehub-xbtns { display: inline-flex; gap: 2px; margin-left: auto; flex: none; }
button.zdsh-filehub-xbtn {
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.75;
}
button.zdsh-filehub-xbtn:hover { opacity: 1; background: rgba(127, 127, 127, 0.16); }
`
