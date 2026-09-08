# Changelog

All notable changes to zDSH FileHub are documented here. Format follows
Keep a Changelog; versioning is SemVer.

## [Unreleased]

### Changed

- **Dev-dependency baseline** — the 16 pinned `@deepseek-ai/dsh-*`
  devDependencies moved from `=0.1.2-alpha.4` to `=0.1.2-rc.1` (exact pins, to
  prevent drift). `peerDependencies` are unchanged (all `*`, optional; the host
  resolves them at runtime). This is a registry-baseline alignment to the
  nearest reproducible snapshot, not a feature change.

### Compatibility verification (one-time, against local 0.1.3-alpha.1)

- The compile-time host surface (`dsh-client-ui-conversation` /
  `-input-trigger` / `-renderer` / `-settings`) was temporarily linked to the
  local zDSH main-repo working tree at commit `59a5f3ca61` (version
  `0.1.3-alpha.1`) and type-checked. Under FileHub's real config
  (`skipLibCheck: true`) `tsc --noEmit` is green; under a stricter
  `skipLibCheck: false` pass no error originates from FileHub's own
  `src`/`tests` (remaining diagnostics are `lib`/`@types` duplication noise and
  issues inside the host's own `.d.ts`). The link was reverted afterwards; the
  committed dependency files carry no link residue.
- Wording note: this records a one-time compatibility check against
  `0.1.3-alpha.1`. FileHub's committed baseline remains `0.1.2-rc.1`; it is not
  claimed to be "adapted to / targeting 0.1.3".

### Planned (after 0.1.3 is published to npm)

- **Add `@deepseek-ai/dsh-client-file-upload` to devDependencies** when the
  dev-dependency pins are next bumped to a published `0.1.3`. Reason: in
  `0.1.3-alpha.1`, `dsh-client-ui-conversation`'s emitted
  `client/contract/slots.d.ts` imports `FileUploadReceiptId` from
  `@deepseek-ai/dsh-client-file-upload/client`, but that package is only a
  `devDependency` of `ui-conversation` (a workspace sibling) and therefore does
  **not** propagate to registry consumers. With `skipLibCheck: true` (FileHub's
  default) the dangling reference is suppressed and typecheck stays green; with
  `skipLibCheck: false` a registry consumer would hit `TS2307` on
  `@deepseek-ai/dsh-client-file-upload`. This is an upstream packaging gap in
  the host bundle, not a FileHub code issue — the current `0.1.2-rc.1` baseline
  does not reference `file-upload` at all. Tracking this here so the future
  bump is mechanical: add the `file-upload` devDep alongside the version bump.

## [0.1.0] - 2026-08-24

First public release.

### Added

- **Upload channels** — composer button, full-page drag-drop with recursive
  folder traversal, paste-to-upload; streaming transfer with double size caps,
  concurrency gate (429), per-session quota (507); sha256 dedup with atomic
  writes and race recovery; session-workspace storage `.filehub/<sessionId>/`;
  queue dock with progress, retry and remove.
- **Byte-sniffing layer** (`src/detect.ts`) — magic-bytes authority across
  tools, uploads and metadata; OOXML central-directory discrimination;
  BOM/NUL/gb18030 text heuristics.
- **@ file mentions** — dual-source candidates (bounded workspace index +
  uploaded files), word-start grammar aligned with the host, send-time
  existence validation injecting structured `<workspace-reference>` messages
  (file content never crosses the wire), keyboard-navigable picker with
  disambiguation, chip reference bar, event-driven index invalidation
  (`fs/write-intent`/`fs/edit-intent`) with TTL fallback.
- **AI document reading** — `read_document` tool for text/PDF/DOCX/XLSX with
  probe-then-read sheets, per-format output budgets and explicit truncation
  markers; never-fail parse waterfall; content-addressed LRU cache with
  in-flight dedup; `list_workspace_files`; system-prompt usage guidance.
- **Image captioning waterfall** — multimodal route gate
  (`inputModalities` truth source) passes native images through untouched;
  otherwise explicit endpoint → loopback-only Ollama probe → graceful off;
  URL policy dual lock (local probes locked to loopback, remote endpoints
  locked to public hosts with post-DNS re-check); caption caching.
- **File console** — cross-session "Files" view tab: search/filter, storage
  usage stats, two-step dry-run cleanup, per-session delete.
- **Settings center** — `settings.plugins.tab` panel backed by validated
  KV persistence; zh/en i18n dictionary with host-locale binding.
- **Security hardening** — path sandbox with resolve-then-containment +
  realpath re-check (junction/symlink escape-proof), same-origin hardening,
  SSRF fences, adversarial test suite (5 successful attacks fixed, 27
  hardened regressions) in `tests/adversarial/`.
- **Integration playbook** — `docs/integration-playbook.md` lists every seam
  awaiting first-party branch integration.
