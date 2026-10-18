# Claudian Thinking Translator — 规格

## 1. 目标 / 用户 / 现状

- **目标**：把 Claudian 的思考过程实时译成简体中文；只在思考块**展开**时翻译，默认显示译文、点按钮切回原文。
- **用户**：使用 `super-useful-claudian` 插件、阅读 Claude 思考过程的 Obsidian 桌面用户。
- **现状**：现在只能读英文思考原文；本插件旁挂 DOM（不改第三方 bundle）注入翻译条与译文。

## 2. 非目标

- 不修改 `super-useful-claudian` 的 `main.js`（只依赖其 DOM 契约）。
- 不引入本地模型、不引入需要注册的新服务。
- 不做多端同步、不把译文持久化到 vault。
- 折叠状态零请求：不翻译已折叠块的内容（重新展开才翻）。

## 3. 契约

### 3.1 设置字段表（`DEFAULT_SETTINGS` 全部键）

| 字段 | 类型 | 默认值 | 取值范围 | 作用 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | true/false | 关闭后停止扫描、不发请求 |
| `engine` | string | `'google'` | `'google'` \| `'deepseek'` | 翻译引擎 |
| `apiBase` | string | `'https://api.deepseek.com'` | 任意 URL（空值回落到默认） | DeepSeek 请求基址 |
| `model` | string | `'deepseek-flash'` | 任意非空串 | DeepSeek 模型名 |
| `secretRef` | string | `'op://Agent/DeepSeek API/credential'` | `op://` 引用、明文、或空串 | 密钥来源；空串走 `process.env.DEEPSEEK_API_KEY` |
| `minChars` | number | `120` | 40–400（步长 20） | 攒够多少字符才开始切段 |
| `chunkChars` | number | `420` | 200–1200（步长 50） | 每段目标长度 |
| `idleMs` | number | `1800` | 600–5000（步长 200） | 静默多久后把剩余尾巴翻掉 |
| `glossary` | string | `'vault skill token agent prompt session Claudian Obsidian DeepSeek omp MCP CLI'` | 任意文本 | 术语白名单，这些词保留英文 |
| `translateExistingOnLoad` | boolean | `false` | true/false | 是否翻译加载时已展开的历史块 |
| `debug` | boolean | `false` | true/false | 控制台 `[CTT]` 日志 |

### 3.2 引擎契约

**免费机翻（`engine === 'google'`，无需密钥）** —— 降级顺序固定，逐级尝试，任一返回非空文本即成功：

| 顺序 | 引擎 | 端点 | 超时 |
|---|---|---|---|
| 1 | Google (clients5) | `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN&q=<urlenc>` | 12s |
| 2 | Google (gtx) | `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=<urlenc>` | 15s |
| 3 | MyMemory | `https://api.mymemory.translated.net/get?langpair=en%7Czh-CN&q=<urlenc>`，超过 450 字符先切段再逐段请求 | 15s |

- 成功判据：`run()` 返回 `out` 且 `out.trim()` 非空，且 `text.length > 80` 时 `out.length >= text.length * 0.25`（低于此视为被截断，转下一级）；状态尾缀记为 ` · Google` / ` · Google(gtx)` / ` · MyMemory`。
- 失败判据：三个引擎全部 reject（网络错误、非 200、非 JSON、超时、空结果、译文异常短）→ 抛出「免费接口全部失败（…）」。

**DeepSeek（`engine === 'deepseek'`，需密钥）**：

- 主路径 `streamTranslate`：`POST {apiBase}/chat/completions`，SSE 流式，`temperature:0.3`，`thinking:{type:'disabled'}`，超时 **60s**。
  - 成功判据：HTTP 200，逐 `data:` 行累积 `choices[0].delta.content` 直到 `[DONE]` 或流结束。
  - 失败判据：非 200 → reject（`HTTP <code> <前300字符>`）；网络错误 / 超时 → reject。
- 兜底 `fallbackTranslate`：`requestUrl` 非流式同端点、同 body，`throw:false`。
  - 成功判据：`res.status === 200` 且取 `choices[0].message.content`。
  - 失败判据：非 200 → `throw 'HTTP <code>'`。二者都失败 → 该段进入「译失败」。
- 密钥读取 `getApiKey()`：`op://` 引用走 `execFileP(resolveOpBinary(), ['read', ref], {timeout:30000})`；缓存 30 分钟；失败后 30 秒冷却期内直接抛「密钥暂不可用（30 秒后重试）」。

### 3.3 状态机

| 状态文案 | 触发条件 | 终态？ |
|---|---|---|
| `待译` | 块被武装并首次建 UI（初始态） | 否 |
| `翻译中…`（`is-busy`） | `runJob` 开始处理该段 | 否 |
| `已译 N 段` | 一段成功后，`N=segments`；免费引擎尾缀加 ` · <引擎名>` | 是（后续段追加，N 递增） |
| `已译 N 段 · 术语待核` | `finalizeTranslation` 判定：有术语占位符未被还原，或模型凭空输出 `⟦…⟧` 被清除 | 是 |
| 组合形态 | `已译 N 段 · 术语待核 · <引擎名>`（免费引擎 + 术语受损时三段式，顺序固定） | 是 |
| `中文·跳过` | `enqueue` 检测到 `han > 0 && han > letters`（纯中文 `letters=0` 同样命中） | 是（不发请求） |
| `译失败`（`is-error`） | `pumpQueue` catch：该段请求链全失败 | 是（新文本触发再翻时重置为 `翻译中…`） |

**并发与切分**：

- 跨块并发上限：免费引擎 3、DeepSeek 1；**同一块严格串行**（`BlockState.busy`），避免两份 job 共享 `outBuf/store` 把术语串味。
- 切分：句边界优先；超过 `chunkChars*2` 仍无边界则硬切。`idleMs` 后的尾段同样受 `chunkChars` 约束，超出则先切一段、剩下的下一轮继续。
- 关闭 `enabled` 或卸载：`teardownDom()` 清空队列、移除全部 `.ctt-*` 节点与类、`generation++`；在途请求的结果按代次丢弃。

- 收起再展开：首次扫描时已存在的块记入 `preExisting`（`armed=false`，不主动翻）；折叠时加入 `reArmed`，重新展开后 `armed=true` → 重新翻译。`translateExistingOnLoad=true` 时，仅**当前视口内**的预存在块直接武装（防止一次排入上百个块）。

### 3.4 DOM 契约

注入到 `.claudian-thinking-block` 的**子节点**（作为 `.claudian-thinking-content` 之后的后继兄弟）：

- `div.ctt-bar`：容器，含 `span.ctt-status`（状态文案）与 `button.ctt-toggle`（文案 `原文` / `译文`）。
- `div.ctt-translation`：译文文本。

类名联动：

- 译文非空 → 块加 `.ctt-has-translation`；`.ctt-has-translation:not(.ctt-show-original) > .claudian-thinking-content` 隐藏原文。
- 点 toggle → 切换块的 `.ctt-show-original`；`.ctt-show-original > .ctt-translation` 隐藏译文。
- `.claudian-thinking-block:not(.expanded) > .ctt-bar / .ctt-translation` 折叠时隐藏。
- `.claudian-thinking-content.claudian-hidden ~ .ctt-bar / .ctt-translation`：内容折叠态时翻译条与译文一并隐藏。

### 3.5 错误码 / 失败表现表

| 场景 | UI 表现 |
|---|---|
| 免费引擎网络失败 / 非 200 / 非 JSON / 超时 | 按 3.2 逐级降级；三级全败 → 状态 `译失败`（红色），弹 Notice「思考翻译失败：…」（每块首次一次，`errorNotified`） |
| DeepSeek 网络失败 / 超时 | 主路径失败 → 自动兜底 `fallbackTranslate`；兜底也失败 → `译失败` + Notice |
| DeepSeek 429 / 非 200 | 主路径 reject → 兜底 `requestUrl(throw:false)` 得到非 200 → `throw HTTP 429` → `译失败` + Notice（无专门重试） |
| 密钥缺失（空引用 + 无环境变量） | `getApiKey` 抛「未配置 API 密钥」→ `译失败` + Notice |
| 1Password 未解锁 / `op read` 失败 | 抛「1Password 取密钥失败（需要解锁或 Touch ID）：…」→ `译失败` + Notice；30 秒内重试直接报「密钥暂不可用」 |
| 占位符丢失 / 被模型改写（含 `⟦1加⟧`） | 尽量按编号还原；未还原或凭空多出的 `⟦…⟧` 会被清理，状态 `已译 N 段 · 术语待核`，不弹错误 |
| 译文为空 / 无字母内容（`letters < 10`） | 不发请求，状态保持 `待译`（`enqueue` 直接 return） |
| 纯中文内容（`han > 0 && han > letters`，含零拉丁字母） | 状态 `中文·跳过`，不发请求 |

## 4. 验收条件

1. 展开一个含英文思考的块，出现 `ctt-bar` 与 `ctt-status`，初始文案为「待译」。
2. 英文内容超过 `minChars` 且出现切点后，状态变为「翻译中…」，随后变为「已译 N 段」且 `ctt-translation` 出现非空中文。
3. 译文出现后，原文 `.claudian-thinking-content` 被隐藏（块带 `ctt-has-translation`）。
4. 点「原文」按钮：块加 `ctt-show-original`、原文显示、译文隐藏、按钮文案变「译文」；再点恢复。
5. 折叠思考块后，`ctt-bar` 与 `ctt-translation` 均不可见；重新展开重新出现。
6. 折叠期间插件不发出任何翻译请求（网络面板零请求）。
7. 关闭 `enabled` 开关后，展开块不再出现翻译条、无请求；打开后恢复。
8. 纯中文思考内容：状态显示「中文·跳过」，无请求。
9. 断网（引擎 `google`）下翻译：状态最终为「译失败」且弹出一次 Notice「思考翻译失败：…」。
10. 引擎切到 `deepseek` 且 1Password 锁定：状态「译失败」，Notice 文案含「1Password 取密钥失败」。
11. 引擎 `deepseek`、密钥有效：翻译成功，状态为「已译 N 段」（无 ` · 机翻` 尾缀）。
12. 引擎 `google`、翻译成功：状态尾缀为 ` · Google` / ` · Google(gtx)` / ` · MyMemory` 之一。
13. 设置「加载时翻译已展开的块」关闭时，重启/重载后已展开的历史块不主动翻；收起再展开才翻。
14. `translateExistingOnLoad=true` 时，重载后已展开块直接翻译。
15. 术语白名单词（如 `Claudian`）在译文中保持英文原样。
16. `debug=true` 时控制台出现 `[CTT]` 日志；`debug=false` 时无。
17. 命令「测试翻译接口」：引擎 `google` 弹「翻译自测（<引擎>）：…」Notice；`deepseek` 弹「翻译自测：…」。
18. 卸载/重载插件后，DOM 中不再残留 `.ctt-bar` / `.ctt-translation` / `.ctt-has-translation` / `.ctt-show-original`。

## 5. 已知风险

1. **免费引擎误报失败**：多任务并发 + 降级链下，某段可能实际已有译文却置为「译失败」——`runJob` 里免费分支异常未被逐段隔离（待修，本规格仅记录现状）。
2. **免费引擎是未认证公开端点**：clients5/gtx/MyMemory 的可用性、限流、字段格式为外部事实，可能随上游变化（MyMemory 已按 480 字符截断）。
3. **密钥仅内存缓存 30 分钟**：GUI 进程 PATH 受限，依赖 `resolveOpBinary()` 探测的绝对路径；`op` 不在常见位置时密钥解析会失败（回落到 `op` 裸命令，可能 ENOENT）。
