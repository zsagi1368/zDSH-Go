/** Scoped stylesheet for the plugin center settings section. */
export const pluginCenterStyles = `
.zdsh-pc { display:flex; flex-direction:column; gap:14px; width:100%; max-width:760px;
  padding-bottom:24px; color:var(--dsw-alias-label-primary,#17191c);
  font-family:var(--dsw-font-family,inherit); }
.zdsh-pc * { box-sizing:border-box; }
.zdsh-pc-toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.zdsh-pc-input { border:1px solid var(--dsw-alias-border-primary,#e4e6ea);
  border-radius:8px; padding:6px 10px; font-size:12px; background:transparent;
  color:inherit; min-width:0; }
.zdsh-pc-input[type="search"] { flex:1 1 180px; }
.zdsh-pc-toggle { display:flex; align-items:center; gap:5px; font-size:12px; }
.zdsh-pc-list { display:flex; flex-direction:column; gap:8px; }
.zdsh-pc-card { border:1px solid var(--dsw-alias-border-primary,#e4e6ea); border-radius:10px;
  padding:10px 12px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
.zdsh-pc-card-main { min-width:0; }
.zdsh-pc-card-title { font-size:13px; font-weight:600; }
.zdsh-pc-card-desc { font-size:12px; margin-top:3px; overflow-wrap:anywhere; }
.zdsh-pc-badges { display:flex; flex-wrap:wrap; gap:5px; margin-top:6px; }
.zdsh-pc-badge { font-size:10.5px; border-radius:999px; padding:1.5px 8px;
  background:var(--dsw-alias-fill-secondary,#f1f2f4); }
.zdsh-pc-badge-good { background:#e5f5ec; color:#116932; }
.zdsh-pc-badge-warn { background:#fdf3d8; color:#7a5a00; }
.zdsh-pc-badge-dim { color:var(--dsw-alias-label-tertiary,#7b8088); }
.zdsh-pc-btn { border:1px solid var(--dsw-alias-border-primary,#d9dbe0); border-radius:8px;
  padding:6px 12px; font-size:12px; cursor:pointer; background:transparent; color:inherit; }
.zdsh-pc-btn[disabled] { opacity:.45; cursor:not-allowed; }
.zdsh-pc-pager { display:flex; align-items:center; gap:10px; font-size:12px;
  justify-content:center; }
.zdsh-pc-note { font-size:11px; color:var(--dsw-alias-label-tertiary,#7b8088); }
.zdsh-pc-dialog-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.35);
  display:flex; align-items:center; justify-content:center; z-index:60; }
.zdsh-pc-dialog { background:var(--dsw-alias-bg-primary,#fff); color:inherit;
  border-radius:12px; padding:18px; width:min(420px,92vw); display:flex;
  flex-direction:column; gap:10px; box-shadow:0 12px 32px rgba(0,0,0,.18); }
.zdsh-pc-code { font-family:ui-monospace,Menlo,monospace; font-size:15px;
  letter-spacing:.14em; text-align:center; padding:6px; border-radius:8px;
  background:var(--dsw-alias-fill-secondary,#f1f2f4); user-select:all; }
.zdsh-pc-actions { display:flex; justify-content:flex-end; gap:8px; }
.zdsh-pc-banner { border-radius:10px; padding:10px 12px; font-size:12px;
  background:#e5f5ec; color:#116932; }
.zdsh-pc-audit-row { display:flex; gap:8px; font-size:11px; padding:2px 0;
  font-family:ui-monospace,Menlo,monospace; }
`
