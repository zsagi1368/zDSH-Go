# Security — zdsh-plugin-center

This document states the trust boundaries, the guarantees the plugin tries to
uphold, and the residual risks users accept. 中文要点见文末。

## Trust boundaries

| Boundary | Trust level |
|---|---|
| The DSH host process and its web UI origin | trusted (same-origin only) |
| The catalog source (bundled seed, cache, or configured remote) | semi-trusted: structure is validated, but entries are data, not code |
| Third-party plugin repositories being installed | untrusted until a plan is confirmed; execution is delegated to the official `dsh` CLI |
| Filesystem outside `dataRoot` and the target profile directory | never written |

## Guarantees

1. **Pinned targets only.** GitHub installs require an exact 40-hex commit;
   npm installs pin an exact version. Floating branches are rejected at plan
   time (`untrusted_source`).
2. **One-shot plans.** Every install/update/uninstall is staged into a plan
   that is consumed by exactly one confirmation carrying the deterministic
   phrase code bound to the plan content. Replay returns `plan_consumed`.
3. **Byte-exact rollback.** Before any command runs, the three profile files
   are hashed and backed up; after failure (command error or failed health
   probe) the originals are restored and re-hashed. A rollback that cannot be
   verified reports `rollback_failed` instead of pretending success.
4. **Script gate.** When target manifest data is available, declared
   lifecycle scripts that are not on the explicit allowlist block staging
   with `script_blocked`. Catalog `scriptsPolicy` carries the declaration
   when live manifest data is unavailable.
5. **SSRF guard.** Outbound fetches go through one guard: http/https only,
   no embedded credentials, loopback/private/CGNAT/reserved hosts rejected,
   IPv4-mapped IPv6 unwrapped, redirects re-validated per hop.
6. **Same-origin + intent.** Mutating HTTP routes require the browser's own
   origin and an explicit intent header; read-only mode disables all writes.
7. **No secrets on disk.** Audit records pass a redaction filter keyed on
   sensitive names and secret-shaped values before anything is written.
8. **Bounded restarts.** The watchdog restarts the host at most 3 times in
   5 minutes, then gives up and records its state instead of looping.

## Residual risks (accepted for v0.x)

- **Binding assumption.** The loopback Host gate is a browser-side CSRF /
  rebinding defense; it assumes the DSH webserver binds to `127.0.0.1` only.
  If a deployment exposes the host on a LAN address, that binding — not this
  plugin — becomes the trust boundary. This requirement must hold when the
  plugin is integrated branch-natively (see INTEGRATION-PLAYBOOK).
- The official CLI itself executes package installation (including dependency
  lifecycle scripts) once a plan is applied; the script gate above is
  advisory when live manifest data cannot be fetched.
- Catalog entries point at third-party repositories; their future content
  changes at a *new* commit are not automatically pulled — pinned commits age.
- DNS rebinding is out of scope: the SSRF guard judges literal hosts; pinning
  resolved addresses per connection is future work.
- The watchdog trusts its config file (`<dataRoot>/guardian/config.json`);
  anyone who can write there can shape the relaunch command.

## 安全要点（中文）

仅固定 commit/版本可安装；计划一次性消费；失败逐字回滚并校验；脚本未放行即拒绝；
出站请求统一 SSRF 守卫；变更需同源+意图头，支持只读模式；审计先脱敏再落盘；
看门狗 5 分钟最多重启 3 次。残余风险详见英文部分。
