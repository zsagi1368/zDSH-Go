# Configuration — zdsh-plugin-center

All options live in the Cordis plugin config, i.e. the plugin's entry inside
the profile composition (what `cordis.patch.yml` inserts). Defaults are safe:
with zero configuration the plugin serves the bundled seed catalog read-write
against the `web` profile.

## Keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `defaultProfile` | string | `"web"` | Profile name used when staging plans. |
| `profileDir` | string | resolved | Explicit profile directory override; skips home resolution. |
| `dshHome` | string | auto | Storage home root; resolution order: this key → `$DSH_BRANCH_HOME` → `$DSH_HOME` → `~/.dsh-zdsh` → `~/.dsh`. |
| `dataRoot` | string | `~/.zdsh-plugin-center` | Backups, audit log, catalog cache, guardian state. |
| `remoteCatalogUrl` | string \| null | `null` | Remote signed-snapshot catalog URL. `null` = seed + cache only (offline-first). |
| `catalogSeedPath` | string | bundled | Seed catalog override for custom distributions/tests. |
| `webPort` | number | `3080` | Loopback port of the DSH web host, used by the guardian probe and status surface. |
| `launchCommand` | `{cmd,args}` | derived | Command the guardian relaunches after a crash. Derived from the running process when omitted. |
| `mutationsEnabled` | boolean | `true` | Master switch; `false` turns every write route into `403 mutations_disabled`. |

## Example: enable the remote registry

```yaml
# inside the plugin's config block of the profile composition
defaultProfile: web
remoteCatalogUrl: https://raw.githubusercontent.com/zsagi1368/zdsh-plugin-registry/main/catalog.json
webPort: 3080
```

Loading order per request: remote success rewrites the local cache (`fresh`);
remote failure falls back to the cached snapshot (`cached`); with no cache the
bundled seed is served (`seed`). The UI shows a banner for non-fresh modes.

## Example: read-only kiosk

```yaml
defaultProfile: web
mutationsEnabled: false
```

## Data layout under `dataRoot`

```
~/.zdsh-plugin-center/
├── audit-log.jsonl      # redacted append-only audit trail
├── backups/<ts>-<action>/  # pre-install snapshots of the three profile files
├── cache/catalog.json   # last successful remote snapshot
└── guardian/            # watchdog pidfile, frozen config, status mirror
```

## 配置速览（中文）

零配置即可用（种子目录 + web profile + 可写）。常用项：`remoteCatalogUrl`
接第一方注册表快照；`mutationsEnabled: false` 变只读；`webPort` 对应宿主
环回端口；`launchCommand` 覆盖看门狗的重启命令。数据全部落在
`~/.zdsh-plugin-center`，绝不写官方 `~/.dsh`。
