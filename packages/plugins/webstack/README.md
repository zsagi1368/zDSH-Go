<div align="center">

# WebStack

**Integrated web search & fetch kernel plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**

One plugin. Every search layer. Hardened by default.

[![CI](https://github.com/zsagi1368/dsh-webstack/actions/workflows/ci.yml/badge.svg)](https://github.com/zsagi1368/dsh-webstack/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zsagi1368/dsh-webstack)](https://github.com/zsagi1368/dsh-webstack/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node%20%3E%3D%2022.19-brightgreen)
![Tests](https://img.shields.io/badge/tests-761%20passing-success)

English · [简体中文](./README.zh.md)

</div>

---

WebStack registers a single neutral aggregator into the host `ctx.web` seam — both the `search` and `fetch` faces — and keeps every decision inside itself: layer routing (`native` / `free` / `api` / `selfhosted` / `mcp`), query-complexity banding, multi-engine fallback, RRF fusion, caching, credential resolution and a four-gate SSRF pipeline. It ships in **coexist mode**: the bundled cordis patch is empty, upstream selectors stay untouched, and switching layers is a runtime config change — never a re-patch.

## Highlights

**Search**
- **Keyless free pool, zero-config** — DuckDuckGo plus a Bing RSS lite channel work out of the box; free-tier engines are structurally barred from requiring keys.
- **Six keyed engines** — Tavily · Brave · Exa · Jina · Firecrawl · AnySearch, with a least-in-flight key pool that swaps keys only on auth failures.
- **MCP engines** — any search-oriented MCP server becomes an engine; the preset catalog ships version-pinned templates and bare `npx` commands are structurally rejected.
- **Native delegate** — the `native` layer forwards to host built-ins and fails diagnosably when unavailable.

**Intelligence**
- **Deterministic hints layer** — regex extraction of `site:` filters, quoted phrases, freshness words and locale; hard constraints push down to engines, soft preferences stay advisory.
- **Complexity banding** — queries are banded simple / medium / complex; the band picks the engine set and enables fusion.
- **Tunable fusion** — RRF merging with time-decay half-life, authority-domain boost and same-host diversity discount. Duplicate URLs keep their first-seen original string.

**Resilience**
- **Fallback + cooldowns** — per-error-class decisions (retry once / move on / abort); rate limits and quota exhaustion cool engines down, honoring server `Retry-After`. Fused legs share a band-level budget race with real cancellation.
- **Two-tier cache** — sha256 semantic fingerprints over every result-affecting dimension, LRU + single-flight in memory, optional durable tier (host storage or `~/.webstack/cache`) with joint invalidation.
- **Session online mode** — host-owned off / on / ask switch; `on` forces fresh, cache-skipping reads.

**Safety**
- **SSRF four gates** — static URL check → DNS-resolved IP classification → per-hop redirect re-validation → bounded body read. Exemptions can only skip gate 2, never 1/3/4.
- **Credential chain** — legacy literal → host credential reference → environment variable, resolved per operation into masked snapshots only; plaintext never enters logs, cache or the render tree.
- **Capability ladder** — every optional host seam is probed before use; missing capabilities degrade gracefully instead of throwing.

**Experience**
- **Web UI** — settings card with a staged-draft state machine and a session online toggle in the composer; both degrade to read-only/local when the host offers no writable surface. Keys are never rendered.
- **Model tools** — `web_backend_status` (side-effect-free diagnostics), `web_batch_search` (order-preserving fan-out, ≤10 queries, per-item isolation), `web_history` (replay/clear).
- **Bilingual throughout** — zh/en diagnostics, error prescriptions and UI copy.

## Quick start

Install through your DSH plugin mechanism, either from a release asset:

```bash
# grab dsh-webstack-<version>.tgz from GitHub Releases, then reference it in your bundle manifest
```

```yaml
# bundle dependency example
dependencies:
  - name: dsh-webstack
```

That's it — the `free` layer works with no keys and no extra services. To go further:

```yaml
search:
  layer: api            # switch to keyed engines
engines:
  tavily:
    key: tvly-...       # or a credentialRef / WEBSTACK_TAVILY_API_KEY env var
mcpServers:
  - id: ddg-mcp
    transport: stdio
    command: npx duckduckgo-mcp-server@0.1.2   # pinned versions only
```

Optional satellites (same repo, independently installable):

| Package | What it adds |
| --- | --- |
| [`dsh-webstack-bridge`](../bridge/extension/README.md) | Browser-render rescue for JS-heavy pages (MV3 extension + pairing protocol) |
| [`dsh-webstack-verticals`](../verticals) | Experimental credential-free X/Twitter leg (off by default, opt-in) |

## Configuration

Full key set: [`src/settings/schema.ts`](./src/settings/schema.ts). **Hot** = next operation picks it up; **restart** = structural change, reload required.

| Key | Default | Mode | Notes |
| --- | --- | --- | --- |
| `enabled` | `true` | hot | master switch; off = provider reports unavailable |
| `search.layer` | `free` | hot | `native` / `free` / `api` / `selfhosted` / `mcp` |
| `search.autoFallback` | `true` | hot | `false` = first-choice engine only |
| `search.maxResults` | `8` | hot | request-level value wins when present |
| `search.fusion.enabled` | `true` | hot | RRF fusion switch |
| `search.fusion.timeDecayHalfLifeH` | `24` | hot | freshness half-life (hours); `0` disables decay |
| `search.fusion.authorityBoost` | `1.0` | hot | authority-domain weight multiplier |
| `search.fusion.diversityDiscount` | `0.85` | hot | same-host repetition discount |
| `search.complexityRouting` | `true` | hot | off = fixed medium-band width |
| `fetch.pipeline` | `t1` | hot | `t1` / `t1+t2` / `t1+t2+t3` |
| `fetch.defaultMode` | `raw` | hot | preferred extract mode (chain may downgrade) |
| `fetch.maxContentChars` | `12000` | hot | rendered budget; canonical derives ×4, capped at 8 MiB |
| `mode.sessionOnline` | `off` | hot | `on` forces fresh cache-skipping reads |
| `cache.enabled` | `true` | hot | search-result cache switch |
| `cache.ttlSearchMin` / `cache.ttlFetchMin` | `10` / `60` | hot | per-domain TTLs (minutes) |
| `cache.persist` | `memory` | hot | `durable` enables the L1 tier |
| `safety.ssrfExempts` | `[]` | hot | `host:port` / IPv4 CIDR entries (gate-2 only) |
| `engines.<id>.key` / `.credentialRef` | — | **restart** | per-engine credentials |
| `mcpServers` | `[]` | **restart** | validated MCP entries register as engines |
| `verticals.packEnabled` + `channels.x` | `false` | hot*/restart | vertical leg master + channel switches |
| `verticals.selectorRules` | `[]` | hot | site-specific extraction rules (`hostSuffix` + selector subset) |
| `advanced.winProxyFallback` | `false` | hot | probe & inject the Windows system proxy (best-effort) |

## How a search flows

```text
query → extractHints        # site:/quotes/freshness/locale (deterministic)
      → estimateBand        # simple | medium | complex
      → planSearch          # layer pool × band width × autoFallback
      → creds               # 3-level chain, resolved once per operation
      → cache               # sha256 fingerprint over all dimensions
      → fallback            # cooldown skip · retry-once · terminal abort
      → fuse                # RRF × decay × authority × diversity
      → seam                # truncation stays with the platform
```

Fetch shares the hardened outbound channel: budgets → SSRF gates → optional site rules → extract chain (raw→fit) → status-as-data reporting, with a single browser-bridge rescue when the satellite is paired.

Stage-by-stage envelopes live in [`docs/BENCHMARK.md`](./docs/BENCHMARK.md) — reproduce locally with `pnpm --filter dsh-webstack bench`.

## Development

```bash
pnpm install
pnpm lint              # biome across all packages
pnpm -r run check      # typecheck + test + build per package
pnpm --filter dsh-webstack bench
```

Requires Node.js ≥ 22.19 and pnpm ≥ 10. Zero native modules.

## Documentation

| Doc | Contents |
| --- | --- |
| [`CHANGELOG.md`](./CHANGELOG.md) | Release notes |
| [`SECURITY.md`](./SECURITY.md) | Security model, trust boundaries, disclosure |
| [`docs/AUDIT-W10.md`](./docs/AUDIT-W10.md) | Adversarial audit round: findings & dispositions |
| [`docs/BENCHMARK.md`](./docs/BENCHMARK.md) | Performance envelopes vs. budgets |
| [`docs/CALIBRATION.md`](./docs/CALIBRATION.md) | Platform version baseline & upgrade procedure |
| [`docs/GOTCHAS.md`](./docs/GOTCHAS.md) | Engineering pitfalls, captured for future maintainers |
| [`docs/CONTRACTS.md`](./docs/CONTRACTS.md) | Frozen type contracts quick reference |

## Roadmap

- Native-layer handle capture so `native` forwards directly to host built-ins.
- Host locale probing for prompt sections (currently fixed zh/en).
- Fetch-domain cache wiring.
- Settings-surface editor for selector rules; more vertical channels.
- npm publish automation.

## License

[MIT](./LICENSE)
