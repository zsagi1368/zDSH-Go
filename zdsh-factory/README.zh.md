# zdsh-factory — 出厂预装清单

[English](README.md) | 中文

- **用途**：zDSH 自管声明性文件，定义出厂预装插件集（Q5 框架内的规范性底座）。
  与 `catalog.json` 分离——catalog=可装池（PluginRegistry 权威仓），seed=出厂集。
- **消费方**：governance-host 预装执行器（`SeedPreinstaller`，批次 1.2b 实现）。
  seed 路径经 gateway Config `seedPath?` 指入；文件不存在则整个 pass no-op（零扰动）。
- **Schema**：见 `seed.json` 内 `$comment` / `entryFields`，冻结案对应
  DESIGN-intake-tech.md §1.1；integrity 两态裁定见 §1.1-D1（local: 留 null / npm: 必填 sha512）。
- **修改纪律**：`entries` 每增一项须配 Gate-P 探针（§6），否则不予合并。
- **边界**：本目录为根级数据文件，非 workspace 包，不触 `pnpm-workspace.yaml`；
  实际条目实装属后续批次（1.2a/1.3），本文件当前为空骨架。
