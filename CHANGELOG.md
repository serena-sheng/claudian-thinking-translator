# Changelog

## 0.2.1 — 2026-10-18

按 QA 报告的 P1/P2 修复（`docs/spec.md` 已同步）。

### Fixed
- **P1 同块并发串味**：同一思考块的两个 job 共享 `st.outBuf/st.store`，术语会被另一段顶掉（`vault`→`Claudian`）。改为**同块严格串行**（`st.busy`），跨块仍并发。
- **P1 尾段不切分 + MyMemory 截断**：`idleMs` 后的尾巴不按 `chunkChars` 切，MyMemory 又硬截 480 字符，导致内容静默丢失。改为尾段也按上限切；MyMemory 按 450 字符分段请求；新增「译文短于源文 1/4 视为截断」的质量门。
- **P1 纯中文永远「待译」**：`letters < 10` 早退挡住中文判定。改为先判中文（`han > 0 && han > letters`），纯中文也能显示「中文·跳过」。
- **P2 占位符损伤**：模型改写（`⟦1加⟧`）或凭空输出（`⟦99⟧`）的占位符会直接显示给用户。改为按编号尽量还原、残留一律清除并置「术语待核」。
- **P2 加载即全量排队**：`translateExistingOnLoad=true` 时一次排入上百个块。改为只武装**视口内**的预存在块。
- **P3 中英粘连**：还原后中文与拉丁字符之间补空格。
- **P3 关闭不清理**：关闭 `enabled` 或卸载时清空队列、移除全部注入节点与类；在途请求按 `generation` 丢弃结果。

### Changed
- 状态新增三段式 `已译 N 段 · 术语待核 · <引擎>`（规格已定义，不再是未定义行为）。

## 0.2.0 — 2026-10-18

### Added
- **免费机翻引擎**：`google`（无需密钥），三级降级 `clients5 → gtx → MyMemory`；状态栏显示实际引擎。
- 设置页「翻译引擎」下拉（免费机翻 / DeepSeek 付费）。
- 免费引擎并发上限 3（付费仍为 1，控制花费）。
- 记录 `lastEngine` / `lastLatency` / `lastError`，供设置页与验收取证。

### Fixed
- 免费分支成功后抛 `user is not defined`，把成功翻译盖成「译失败」。
- 多段译文互相覆盖：改为 `doneText` 累积 + 当前段流式渲染。
- 「术语待核」误报：原实现清空输出缓冲后才统计占位符，改为对未清空的 `rawOut` 统计。
- 源文本自带的 `⟦n⟧` 被还原成空串：未命中的占位符现在原样保留。
- Obsidian GUI 进程 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，`execFile('op')` 必 ENOENT；改为显式解析 `~/.local/bin/op` 等候选。

### Changed
- 默认引擎：`deepseek` → `google`。
- 未翻译的块不再插入任何 UI（只在真正开始翻译时建 DOM）。

## 0.1.0 — 2026-10-18

- 首个版本：旁挂 DOM 翻译 Claudian 思考块，默认仅译文、点「原文」切换、只在展开时翻译。
- DeepSeek 引擎：`deepseek-flash` + `thinking: disabled` + SSE 流式；密钥走 1Password，内存缓存 30 分钟。
- 术语用 `⟦n⟧` 占位符硬保护；按句边界切分、静默合并、单并发。
- 首次扫描快照：加载时已展开的历史块跳过，收起再展开才翻。
