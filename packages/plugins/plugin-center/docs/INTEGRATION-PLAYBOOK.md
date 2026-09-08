# Integration playbook — plugin center → zDSH branch

This is the frozen plan for turning the standalone plugin into branch-native
core packages once (a) the branch's main development line has settled and
(b) the user gives the explicit go-ahead. **Do not execute any step of this
file without that instruction.**

Source documents: `PluginR&D/plan/P02-zdsh-plugin-center-plan.md` (v2) and
`PluginR&D/docs/R04` (branch extension points).

## Target shape (Option A trio)

| Standalone module today | Branch-native package tomorrow |
|---|---|
| `src/shared` + `src/host` domain/engine | `packages/plugins/plugin-center` |
| host gateway / route surface | `packages/host/plugin-center-host` (Typert Remotes, GovernanceResult envelopes; implements governance's not-implemented install/uninstall for real) |
| `src/client` | `packages/client/ui-plugin-center` (`settings.plugins.tab`, order 30) |

## Whitelisted upstream touches (budget ≤ 8 files)

1. `tsconfig.host.json` — references += plugin-center, plugin-center-host
2. `tsconfig.client.json` — references += ui-plugin-center
3. `packages/api/remotes` — client mount line for the new service key
4. `packages/bundle/web-app/cordis.patch.yml` — insert line
5. settings tab roster line
6. lockfile (automatic)
7. `knip.json` — only if test layout needs a scoped project entry
8. optional CI lane yaml

Every touched line gets a `// zDSH:` marker comment so rebases are greppable.

## Upgrade-replay procedure

1. Fetch the new upstream rc; run `node scripts/diff-with-official.mjs`.
2. Re-apply any whitelist lines the rebase lost (grep `zDSH:` markers).
3. Run the three contract gates:
   - slots contract: client registers `settings.section` id/order unchanged;
   - envelope contract: every remote returns the closed result union;
   - reconcile contract: `tests/integration/http-loop.spec.ts` stays green
     against the real CLI shape.
4. Regenerate `docs/dsh/diff-baseline.txt`; update CHANGELOG triplets and the
   Agent Note triplets under `.agents/notes/implemented/feature/`.
5. Replace shelling-out to the CLI with in-process calls where the branch now
   exposes them (governance remotes), keeping the transaction engine intact.

## What carries over unchanged

Domain model, evidence levels, plan store, lifecycle engine, SSRF guard,
redaction, watchdog budget logic — all are host-agnostic and land as-is.
