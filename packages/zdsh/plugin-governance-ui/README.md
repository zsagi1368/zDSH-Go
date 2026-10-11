---
description: "Governance tab in Web Plugins settings: roster badges, lifecycle and admission actions, health counts, and presets."
kind: "package-reference"
---

# dsh-client-ui-plugin-governance

English | [中文](README.zh.md)

## Summary

The governance tab lives in Web Plugins settings and gives the roster, lifecycle, admission, health, and presets of every governed plugin. It projects rows through `pluginGovernance.list`, offers `approve`/`enable`/`disable` remote actions, and saves/loads/deletes governance presets. Choose it when a browser UI must operate the plugin governance host without a terminal.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### Governance roster

#### What the model sees

Roster rows are projected through `pluginGovernance.list`: each row carries its source and admission state; operations go through the `approve`/`enable`/`disable` remote faces.

##### Roster view

```markdown
roster row -> { pluginId, source, approvalRequired, approved, status }
```

#### Token effect

Rows are assembled only when queried; no fixed prompt text is injected and no session event is produced.

#### KV Cache effect

None: this package reads and writes no KV cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The UI wiring for remote plugin install (npm source) is not implemented yet; the server side already has it.
- The preset editor only supports save/load/delete, not visual orchestration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

#### Future: visual preset orchestration

The preset editor intentionally ships save/load/delete only. A visual editor would need a schema-driven form for `PresetNameRequest`-style payloads; the governance host already exposes the full preset surface, so this is purely a client-side investment.

**Runtime invariant:** No companion is published because the tab is a read-mostly projection of the governance Remote with actions validated by the host's own admission checks; there is no local durable state or background event stream to assert against.

</details>
