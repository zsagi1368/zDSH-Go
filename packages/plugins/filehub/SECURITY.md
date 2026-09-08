# Security Policy

zDSH FileHub handles user files, so every security claim in this file is
**implemented and verified**: each row cites the test files and named cases
that prove it. Claims are never added ahead of their tests.

## Implemented & verified

### FR-F1 — SSRF fence (URL policy)

The vision caption waterfall's two outbound channels are locked in opposite
directions:

- **Local probe lock (reverse lock):** the Ollama probe may ONLY target the
  loopback — `localhost`, `127.0.0.1` (any inet_aton spelling), `::1`,
  `::ffff:127.0.0.1` unwrapped — any other target throws and the level is
  skipped with a warning.
- **Explicit endpoint lock:** http/https only; localhost, loopback (127/8, ::1,
  v4-mapped re-classified after unwrap), RFC1918, CGNAT 100.64/10, link-local
  169.254/16 + fe80::/10, 0.0.0.0/8, benchmarking 198.18/15, reserved 240/4,
  multicast, unique-local and site-local v6 are all rejected. Decimal / octal /
  hex / shorthand IP spellings are NORMALIZED before classification
  (out-of-range numerics fail closed); real hostnames are DNS-resolved with
  EVERY answer re-classified (DNS-rebinding defense: one private answer or a
  resolution failure refuses the call).
- **No redirect following:** both channels pass `redirect: 'error'` so a
  hostile endpoint cannot hop the fence via 302.

Evidence: `tests/server/urlPolicy.test.ts` (public/loopback classification,
rebinding, resolver failure), `tests/adversarial/network.test.ts`
("normalizes oversized / octal / hex / decimal IP spellings…", "defeats the
userinfo trick…", "rejects IPv6 zone-id spellings…", "fails closed when DNS
resolves ANY private answer…", "never follows redirects: every outbound call
passes redirect:\"error\"", behavioral 3xx case).

### FR-F2 — Path sandbox

Every server-side path decision funnels through `src/server/pathPolicy.ts`:
resolve-then-containment assertions (prefix + explicit `!isAbsolute(relative)`
guard against the Windows cross-drive trap), per-segment filename sanitization
(control characters, Windows-illegal characters incl. ADS colons, reserved
device names, trailing dots/spaces, traversal heads), session-id whitelist
(`^[A-Za-z0-9_-]{1,64}$`), and relative-path bounds (32 segments / 512 chars).
Since M6, upload destinations, DELETE targets, console removals, and
`read_document` reads additionally re-assert containment on REAL paths
(`fs.realpath`) so directory junctions/symlinks planted inside a workspace
cannot carry writes, deletions, or reads outside it.

Evidence: `tests/server/pathPolicy.test.ts`, `tests/adversarial/paths.test.ts`
(traversal variants, UNC/drive-letter/ADS/trailing-dot cases, sibling-prefix,
junction write/delete escapes, symlink-file read escape, sessionId attacks),
`tests/server/lifecycle.test.ts` ("rejects the sibling-prefix attack…",
"rejects paths outside any workspace").

### FR-F3 — Rate limits and quotas

Upload guard rails evaluate in order: dangerous-extension deny list → 415;
Content-Length pre-check → 413; per-session KV-accounted quota → 507;
concurrency semaphore → 429; streaming accumulation re-enforces BOTH byte
ceilings against the real count (a lying Content-Length cannot bypass either).
Every rejection path drains the request body so keep-alive connections stay
usable.

Evidence: `tests/server/upload.test.ts` ("answers 415 for a dangerous
extension…", "rejects an honest oversized Content-Length and keeps the
connection reusable", "catches chunked bodies whose real byte count crosses
the limit", "pre-checks an honest Content-Length against KV-accounted usage",
"admits up to maxConcurrent and answers 429 beyond it").

### FR-F4 — Byte-sniffing type authority

Magic bytes outrank declared content types and file extensions everywhere an
upload is classified (upload response, library kind buckets); known binary
signatures are not rescued by text hints; OOXML central directories are
distinguished.

Evidence: `tests/server/detect.test.ts`, `tests/server/upload.test.ts`
("sniffs magic bytes server-side regardless of the declared content type"),
`tests/server/library.test.ts`.

### FR-F5 — Idempotent deletion

DELETE answers 204 for missing targets exactly like successful ones; the
containment assertion runs BEFORE any filesystem mutation.

Evidence: `tests/server/lifecycle.test.ts` ("deletes an existing file and
answers 204", "is idempotent: deleting a missing file still answers 204",
"answers 204 for a missing workspace root too"), plus the M6 race-triangle
regression in `tests/adversarial/paths.test.ts`.

### FR-F6 — Whole-fleet sweeper correctness

The TTL sweeper walks EVERY session workspace — the union of live sessions and
sessions remembered through upload metadata — prunes empty parent chains back
to (never including) each root, and cleans up metadata rows. Since M6 the
console layer also self-heals KV rows whose files vanished out-of-band: ghost
entries are stat-detected, pruned from metadata, and skipped within the same
request.

Evidence: `tests/server/lifecycle.test.ts` ("expires files across ALL
sessions — including dead ones found via metadata — and prunes empty dirs"),
`tests/adversarial/logic.test.ts` ("library drops the entry AND prunes its
metadata row once the file vanished").

### FR-F7 — Same-origin hardening

Uploads require BOTH conditions: the Origin header's hostname matches the Host
header (absent Origin passes for non-browser clients; present-but-unparseable
fails closed) AND the socket remote address is a loopback (IPv4-mapped
spellings unwrapped before matching; unmapped hex forms fail closed).

Evidence: `tests/server/upload.test.ts` ("rejects an Origin whose hostname
differs from Host", "rejects a matching Origin arriving from a NON-loopback
remote", "Origin absent passes; present-but-unparseable fails closed"),
`tests/adversarial/network.test.ts` (Origin forgery matrix additions incl.
`Origin: null`, spoofed non-loopback remote wire case).

### S-2 — Dependency governance

Runtime dependencies are limited to `zod`, `mammoth`, `pdfjs-dist`,
`read-excel-file`; no install scripts; all host packages are OPTIONAL peer
dependencies so the plugin loads degraded on bare contexts.

### S-3 — Privacy: zero outbound bytes by default

Default configuration performs NO external network calls: the explicit vision
endpoint is unset and gated twice (urlPolicy public-only lock + privacy
local-first posture requiring explicit opt-in), the local probe is loopback-
locked, and captions cache by content digest. Captions persist into upload
metadata only after a successful waterfall run.

Evidence: `tests/server/vision.test.ts` (privacy gate, degradation, cache
dedupe cases), `tests/server/caption-passthrough.test.ts` (caption chain).

### Adversarial validation

Three red-team rounds were executed on 2026-08-24; five successful attacks
(junction write/delete/read escapes, redirect-hop SSRF, KV ghost entries) were
fixed in-round and every attack — successful or not — is pinned as a named
regression. Full log: `docs/adversarial-log.md`. Suites:
`tests/adversarial/{paths,network,logic,xss}.test.ts`.
Performance budgets (100k-file bounded index ≤3 s class, 50 MiB upload memory
ceiling, 5000-entry console model): `tests/performance/budget.test.ts`.

## Known limitations

These seams are implemented honestly but depend on host capabilities that do
not exist yet; they are tracked, with acceptance criteria, in
`docs/integration-playbook.md`:

1. The FR-D1 route gate interrogates a CONFIGURED provider/model route until
   the host exposes the live session-route seam to plugins.
2. Route/timer disposal is caller-owned until the loader pins an effect
   contract (`ctx.effect`).
3. The metadata store picks "the first backend exposing a KV facet" until the
   shipped composition names its authoritative backend.
4. Sessions without a cwd are refused (403) unless/until the host guarantees a
   default working directory.
5. The rich mention picker ships as a presentation layer until the host offers
   a caret-level trigger observation or overlay mount hook.
6. Branch integration itself (four whitelisted wiring points) is frozen behind
   an explicit user go signal.

## Reporting

Open a GitHub issue with reproduction steps; do not include secrets or real
personal files in reports.
