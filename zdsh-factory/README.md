# zdsh-factory — factory preinstall manifest

English | [中文](README.zh.md)

- **Purpose**: a zDSH-managed declarative file defining the factory-preset plugin set (the normative base within the Q5 framework). It is kept separate from `catalog.json` — catalog = the installable pool (PluginRegistry's source of truth), seed = the factory set.
- **Consumer**: the governance-host preinstall executor (`SeedPreinstaller`, implemented in batch 1.2b). The seed path is injected through the gateway Config `seedPath?`; if the file does not exist, the whole pass is a no-op (zero disturbance).
- **Schema**: see the `$comment` / `entryFields` inside `seed.json`; the frozen proposal maps to DESIGN-intake-tech.md §1.1, and the two-state integrity ruling is in §1.1-D1 (local: leave null / npm: sha512 required).
- **Change discipline**: each new item in `entries` must come with a Gate-P probe (§6), or it will not be merged.
- **Boundary**: this directory holds root-level data files, not workspace packages, and does not touch `pnpm-workspace.yaml`; real entries are implemented in later batches (1.2a/1.3), so this file is currently an empty skeleton.
