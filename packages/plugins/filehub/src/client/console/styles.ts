/**
 * M5 console + settings stylesheet. Kept separate from the M1 STYLES module
 * (owned by the upload domain) so the two domains inject independently; both
 * share the `zdsh-filehub-` class prefix and the no-host-classes discipline.
 */

export const CONSOLE_STYLES = `
.zdsh-filehub-console {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 2px;
  font-size: 12px;
  min-width: 0;
}
.zdsh-filehub-console-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.zdsh-filehub-console-search {
  flex: 1 1 140px;
  max-width: 260px;
  min-width: 0;
  padding: 4px 8px;
  font: inherit;
  border-radius: 6px;
  border: 1px solid rgba(127, 127, 127, 0.35);
  background: transparent;
  color: inherit;
}
.zdsh-filehub-console-search:focus {
  outline: none;
  border-color: rgba(127, 127, 127, 0.7);
}
.zdsh-filehub-chip {
  border: 1px solid rgba(127, 127, 127, 0.35);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  cursor: pointer;
  opacity: 0.75;
}
.zdsh-filehub-chip:hover { opacity: 1; }
.zdsh-filehub-chip[aria-pressed="true"] {
  opacity: 1;
  background: rgba(127, 127, 127, 0.18);
  border-color: rgba(127, 127, 127, 0.7);
}
.zdsh-filehub-console-stats {
  font-size: 11px;
  opacity: 0.72;
}
.zdsh-filehub-console-list {
  position: relative;
  height: 300px;
  overflow-y: auto;
  overflow-x: hidden;
  border: 1px solid rgba(127, 127, 127, 0.22);
  border-radius: 8px;
}
.zdsh-filehub-console-row {
  position: absolute;
  left: 0;
  right: 0;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  box-sizing: border-box;
  cursor: pointer;
  white-space: nowrap;
}
.zdsh-filehub-console-row:hover,
.zdsh-filehub-console-row[aria-selected="true"] {
  background: rgba(127, 127, 127, 0.12);
}
.zdsh-filehub-console-rowheader {
  cursor: default;
  font-weight: 600;
  opacity: 0.65;
  font-size: 11px;
  background: transparent;
}
.zdsh-filehub-console-rowheader:hover { background: transparent; }
.zdsh-filehub-kinddot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.zdsh-filehub-entryname {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.zdsh-filehub-entrymeta {
  flex: none;
  opacity: 0.6;
  font-size: 11px;
}
.zdsh-filehub-console-detail {
  border: 1px solid rgba(127, 127, 127, 0.25);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  word-break: break-all;
}
.zdsh-filehub-console-detailpath {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  opacity: 0.85;
}
.zdsh-filehub-console-note {
  font-size: 11px;
  opacity: 0.7;
}
.zdsh-filehub-console-error {
  color: #e5484d;
  font-size: 11px;
}
.zdsh-filehub-confirmcard {
  border: 1px solid rgba(230, 130, 60, 0.55);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* ---- Settings panel ------------------------------------------------------ */
.zdsh-filehub-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 520px;
  padding: 12px 4px;
  font-size: 13px;
}
.zdsh-filehub-settings h3 {
  margin: 0 0 8px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.65;
}
.zdsh-filehub-settingrow {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0;
}
.zdsh-filehub-settingtext {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.zdsh-filehub-settingdesc {
  font-size: 12px;
  opacity: 0.6;
}
.zdsh-filehub-switch {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid rgba(127, 127, 127, 0.45);
  background: transparent;
  cursor: pointer;
  padding: 0;
}
.zdsh-filehub-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.55;
  transition: transform 120ms ease;
}
.zdsh-filehub-switch[aria-checked="true"]::after {
  transform: translateX(14px);
  opacity: 1;
}
.zdsh-filehub-numberinput,
.zdsh-filehub-select {
  flex: none;
  width: 90px;
  padding: 4px 6px;
  font: inherit;
  border-radius: 6px;
  border: 1px solid rgba(127, 127, 127, 0.35);
  background: transparent;
  color: inherit;
}
.zdsh-filehub-select option { color: #111; }
.zdsh-filehub-settings-status {
  font-size: 12px;
  min-height: 18px;
}
.zdsh-filehub-settings-saved { opacity: 0.75; }
.zdsh-filehub-settings-error { color: #e5484d; }
`
