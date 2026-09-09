# dsh-webstack-verticals (Experimental · off by default · explicit user opt-in)

English | [中文](README.zh.md)

> **Experimental · off by default · explicit user opt-in only.** Experimental, off by default, and only enabled when the user explicitly opts in via settings (`verticals.packEnabled` and the per-channel switches all default to `false`). This package changes none of dsh-webstack's kernel defaults.

WebStack Verticals — vertical-channel satellite package (**host side**) for the [dsh-webstack](../webstack) plugin family.

## Structure

- `src/framework.ts` — minimal vertical-channel framework: the `VerticalChannel` interface plus the `VerticalRegistry` (register/list/canRun). The types are a local structural mirror of the W-B-05 shape, structurally compatible with dsh-webstack's frozen contracts, with zero import dependency on it and compilable outside the monorepo.
- `src/x-search.ts` — compliant credential-free X retrieval fallback chain:
  - Leg 1: run `site:x.com OR site:twitter.com <topic>` through the injected `deps.search` free-pool callback to obtain a result list;
  - Leg 2: for tweet URLs of the `/status/<id>` shape, call the official public endpoint `https://publish.twitter.com/oembed?url=<enc>&omit_script=true&dnt=true` one by one (GET; outbound traffic goes through the injected `outboundFetch` — if absent, the structural probe fails and the leg is silently skipped), using the returned html to enrich the snippet and tag `provenance.via = 'oembed'`;
  - When both legs fail it returns an empty array and never throws; every result honestly carries its via tag (W-B-17).
  - Concurrency governance: single-flight per topic to prevent duplicates; one in-session oEmbed cache per URL.

## Compliance posture

- No scraping, no login-wall bypass: it only consumes the public search results of the free-pool engines and the public output of X's official oEmbed endpoint; no credentials, no session spoofing, no automated browsing traffic.
- descriptor id `x-vertical`, tier `free`, caps.vertical; `keysRequired` is always 0.

## Tests

```bash
pnpm test   # 全离线：search/outboundFetch 均为注入替身，不出网
```

## Model Experience

Indirectly, through vertical-channel results merged into dsh-webstack search aggregation; the consuming web tools own every model-visible effect.

#### KV Cache effect

No direct effect; vertical results are ordinary search-result content once the host tools render them.

## Known Limitations and Deferred Work

- The package ships experimental and off by default; every channel switch defaults to `false`.
- Only the X/Twitter leg exists today; further vertical channels are pending.
- The oEmbed leg enriches snippets only when the public endpoint answers; failures degrade silently to plain search results.
