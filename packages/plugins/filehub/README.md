<div align="center">

# zDSH FileHub

**The unified file center for DeepSeek Harness.**

Upload anywhere, reference anything with `@`, let the model read your documents, caption your images — and manage every file across all sessions from one console.

[![ci](https://github.com/zsagi1368/zdsh-filehub/actions/workflows/ci.yml/badge.svg)](https://github.com/zsagi1368/zdsh-filehub/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)](./package.json)

English | [中文](README.zh.md)

</div>

---

## Why FileHub

DeepSeek Harness ships a great multimodal chat experience, but everything non-image lives at the edges: there is no click-to-upload button, no generic (non-image) upload channel, no way for the model to open a PDF or spreadsheet, and no place to see the files a session has produced.

FileHub closes those gaps with one batteries-included plugin:

- **Four upload entries** feeding one queue — button, full-page drag & drop, paste, and whole folders with hierarchy preserved.
- **`@` file mentions done right** — candidates are ranked instantly from a bounded workspace index *and* your uploaded files, and every mention is existence-checked when the message is sent, then injected as a structured reference. The model sees exactly which file you mean — never its contents unless it asks.
- **Document reading for the model** — `read_document` opens text, PDF, DOCX and XLSX with pagination, per-format output budgets and explicit truncation markers, so long documents are traversed on demand instead of flooding the context window.
- **Image captioning waterfall** — if your active route is multimodal, images pass straight through untouched; otherwise captions come from a local Ollama instance by default. Zero bytes leave your machine unless you say so.
- **A real file console** — every session's files, searchable and filterable, with storage stats and two-step-confirmed cleanup.

## Features

### Upload channel

| Entry | Behavior |
|---|---|
| Composer button | Multi-select file picker |
| Drag & drop | Full-page overlay, recursive directory traversal, relative paths preserved |
| Paste | Any clipboard files, not just images |
| Queue dock | Per-item progress, retry, cancel, remove (removal deletes server-side too) |

Transfers are streaming with double enforcement of size caps, a concurrency gate, and per-session quotas. Content-addressed deduplication means uploading the same file twice never stores it twice. Files land in an isolated session workspace (`.filehub/<sessionId>/`) that the agent can reach with its normal file tools and the sandbox already covers.

### @ file mentions

Type `@` in the composer to search both the workspace index and files uploaded in the current session. Candidates show type icons, disambiguated parent paths and full keyboard navigation. At send time each mention token is validated against the filesystem (path traversal rejected) and expanded into a structured `<workspace-reference>` message — invalid paths are surfaced, never silently dropped. A chip bar above the composer tracks every referenced file and lets you remove one precisely.

### AI document reading

| Tool | Purpose |
|---|---|
| `read_document` | Read text/PDF/DOCX/XLSX with `offset`/`limit` pagination, `sheet` selection, and a `probe` mode that returns structure (page count, sheet list, sizes) without dumping content |
| `list_workspace_files` | List the session workspace (bounded, with truncation flag) |

Per-format character budgets keep responses predictable; truncated reads carry an explicit continuation marker teaching the model how to fetch the next slice. Parsed content is cached content-addressed, so repeated reads of the same file cost nothing.

### Image captioning

When the active route declares `image` in its input modalities, FileHub steps aside completely — native multimodal behavior is untouched. Otherwise captions are produced through a strict waterfall: explicit endpoint (public HTTPS only) → local Ollama probe (loopback only, on by default) → gracefully off. Results are cached per image hash; concurrent uploads of the same picture trigger exactly one caption call.

### File console

The conversation view gains a **Files** tab aggregating every session: search and type filters, per-session grouping, storage usage breakdown, and cleanup actions guarded by a dry-run preview plus confirmation. The assistant message menu also offers quick actions built on the same store.

## Installation

```sh
dsh plugin --profile <your-profile> add https://github.com/zsagi1368/zdsh-filehub
```

That's it — the bundled manifest wires up both halves automatically. No manual configuration is required; sensible defaults apply everywhere.

## Configuration

Everyday options live in **Settings → FileHub** inside the web UI (language, paste handling, candidate limit, privacy toggles). Server-side tuning accepts a profile config object:

```ts
{
  storageDirName: '.filehub',            // session-workspace subdirectory
  upload: {
    maxBytes: 50 * 1024 * 1024,          // single-file cap (streaming-enforced)
    maxConcurrent: 4,                    // parallel transfer gate
    perSessionQuotaBytes: 512 * 1024 * 1024,
    // dangerousExtensions: [...],       // optional deny-list override
  },
  lifecycle: {
    ttlMs: 7 * 24 * 60 * 60 * 1000,      // retention window
    sweepIntervalMs: 60 * 60 * 1000,     // sweeper cadence (all sessions)
  },
  mention: {
    indexMaxFiles: 5000,                 // bounded index hard stop
    indexTtlMs: 30_000,                  // staleness fallback
    searchLimit: 50,
  },
  reading: {
    budgets: { /* per-format char budgets */ },
    cacheEntries: 64,
    cacheBytes: 256 * 1024 * 1024,
  },
  vision: {
    mode: 'off' | 'caption' | 'analyze',
    endpoint: undefined,                 // public http(s) captioning endpoint
    ollamaProbe: true,                   // loopback-only local fallback
    timeoutMs: 20_000,
  },
  console: { maxEntries: 2000 },
}
```

## Security

FileHub handles user files, so security claims here are backed by named tests (`tests/adversarial/`) rather than prose:

- **Path sandbox** — resolve-then-containment assertions with `realpath` re-checks on both endpoints of every operation; immune to symlink/junction escapes, sibling-prefix tricks, ADS payloads and Windows drive-relative path traps.
- **SSRF fences** — local probes are locked to loopback addresses; remote endpoints must be public hosts verified after DNS resolution; redirects are refused, not followed.
- **Same-origin hardening** — Origin hostname comparison plus remote-address loopback verification.
- **Resource limits** — streaming size caps, concurrency gate, per-session quota, TTL sweeper that provably visits *all* sessions.

See [SECURITY.md](./SECURITY.md) for the claim-by-claim evidence map.

## Development

```sh
pnpm install   # host types resolve from registry-pinned devDependencies (=0.1.2-rc.1, zDSH baseline)
pnpm run check # typecheck + test + build
```

The build produces the ESM host half and the single-file client bundle served by the harness web server. `docs/integration-playbook.md` documents the seams for embedding FileHub as a first-party extension of a distribution branch.

## License

[MIT](./LICENSE)

## Model Experience

### Document reading tools

#### What the model sees

The `read_document` tool opens text, PDF, DOCX and XLSX files with `offset`/`limit` pagination, `sheet` selection and a structure-only `probe` mode; `list_workspace_files` lists the session workspace with a bounded result and truncation flag.

#### Token effect

Per-format character budgets cap each response, and truncated reads carry an explicit continuation marker describing how to fetch the next slice; parsed content is cached content-addressed, so repeated reads cost nothing.

#### KV Cache effect

`@` mentions inject a structured `<workspace-reference>` naming the file — never its contents unless the model asks; file contents enter context only through explicit `read_document` calls.

### Image captioning

#### What the model sees

When the active route declares `image` input, images pass through untouched; otherwise a caption produced by the strict waterfall (explicit endpoint → local Ollama probe → off) is attached as text.

#### Token effect

Captions are cached per image hash, and concurrent uploads of the same picture trigger exactly one caption call, so repeated images do not multiply tokens.

#### KV Cache effect

The message shape is unchanged whether images pass through natively or as captions; no prompt or tool schema is registered by the captioning path itself.

## Known Limitations and Deferred Work

- Sessions without a cwd are refused unless the host guarantees a workspace.
- The rich mention picker is presentation-only until the host offers the matching extension points.
- Branch integration stays limited to the four whitelisted wiring points documented in the integration playbook.
- Non-image upload support depends on host surfaces; where they are absent the queue degrades to local-only operation.
