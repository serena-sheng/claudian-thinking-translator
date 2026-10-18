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

界面只讲读者语言，不讲段数、引擎名与内部判断。

| 状态 | 触发条件 | 界面表现 |
|---|---|---|
| 待译 | 已武装、还没入队 | **不渲染任何自有节点**（连 `.ctt-bar` 都没有） |
| 翻译中（首字未到） | `runJob` 开始 | 题注 `正在译成中文`；无按钮；原文仍显示 |
| 已译 | 首段译文到达 | 题注清空；只留 `⇄ 看原文`；原文隐藏 |
| 原文视图 | 点 `看原文` | 只留 `⇄ 看译文`；译文隐藏、原文显示 |
| 个别词可能不准 | `finalizeTranslation` 判定术语受损 | 题注 `个别词可能不准` + `看原文` |
| 失败 · 无译文 | 该段整链失败且无已有译文 | 题注 `没能译成中文` + `重试`；切换按钮隐藏 |
| 失败 · 有部分译文 | 失败但已有译文 | 无题注（不宣称定位不到的缺口）+ `重译` + `看原文` |
| 中文内容 | `han > 0 && han > letters` | **不渲染任何自有节点**，不发请求 |
| 重试进行中 | 点 `重试` / `重译` | 回到 `正在译成中文`，按钮消失 |

**布局与并发**

- 题注行 `.ctt-bar` 插在宿主 header 之后、原文 content **之前**；否则看原文时按钮会被长段落挤到屏幕外。
- 控件收在 `.ctt-actions` 里，`margin-inline-start:auto` 钉在行尾；`重试/重译` 在 `看原文` 左侧；换视图时右缘坐标不变。
- 跨块并发上限：免费 3、DeepSeek 1；**同一块严格串行**（`st.busy`）。
- 切分：句边界优先；超 `chunkChars*2` 硬切；`idleMs` 尾段同样受 `chunkChars` 约束。
- 关闭 `enabled` 或卸载：`teardownDom()` 清空队列、移除全部自有节点与类、`generation++`，在途结果按代次丢弃。
- 收起再展开：首次扫描已存在的块记入 `preExisting`（不主动翻）；折叠后进 `reArmed`，再展开才翻。`translateExistingOnLoad=true` 时只武装**视口内**的预存在块。

### 3.4 DOM 契约

注入到 `.claudian-thinking-block` 的**子节点**，顺序固定：

1. `.ctt-bar`（插在宿主 `.claudian-thinking-content` 之前）
   - `span.ctt-status`：题注；无文案时加 `.is-hidden`
   - `div.ctt-actions`
     - `button.ctt-toggle`：`看原文` / `看译文`
     - `button.ctt-retry`：`重试` / `重译`
2. `.ctt-translation`（译文，纯文本 + `white-space:pre-wrap`）

类名联动：

- 首段译文到达 → 块加 `.ctt-has-translation`；`.ctt-has-translation:not(.ctt-show-original) > .claudian-thinking-content` 隐藏原文。
- 点切换 → `.ctt-show-original`；`.ctt-show-original > .ctt-translation` 隐藏译文。
- 折叠（块失去 `.expanded`）→ `.ctt-bar` 与 `.ctt-translation` 一起隐藏。
- 未进入翻译态 → `.ctt-bar.is-hidden`，不占位。

视觉语法（Rail Note）：

- 原文 = 宿主 1px **实线**；译文 = 同色 1px **节奏线**（`repeating-linear-gradient` 5px/4px 伪元素）。
- 译文不再使用 `max-height` 嵌套滚动，交给宿主滚动。
- 控件常态无边框无底色（ghost），仅 `:hover` / `:focus-visible` / `:active` 显形；`::after` 把热区外扩到约 40px。
- 字号：题注与按钮 12px，译文 13px / 行高 1.75。

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

1. 展开一个还没开始翻译的英文块：块内**没有任何** `.ctt-bar` 与按钮。
2. 翻译开始、首字未到：只出现 `正在译成中文`，没有按钮，原文仍可读。
3. 首字到达：原文消失、译文出现；题注行只有一个 `⇄ 看原文`，没有数字、没有引擎名。
4. 点 `看原文`：原文出现、译文消失、按钮原地变 `⇄ 看译文`，且按钮右缘坐标不变；再点恢复。
5. 术语受损：出现（不可点的）`个别词可能不准` 与 `看原文`；该文字不可 Tab 聚焦。
6. 失败且无译文：`没能译成中文` + `重试`，无 `看原文`；点重试后按钮消失、回到 `正在译成中文`，恢复后出译文。
7. 失败但已有译文：无题注，`重译` 在左、`看原文` 在右；点 `重译` 不清空已有译文。
8. 纯中文块：不出现 `.ctt-bar`，零请求；折叠再展开同样为零。
9. 折叠展示中的块：题注与译文一起消失；翻译完成后重新展开，译文直接可见且不产生新请求。
10. 关闭 `enabled`：所有 `.ctt-bar` / `.ctt-translation` 立即移除，零请求；重新开启后恢复。
11. 亮/暗主题：只用 Obsidian 变量；两套主题下按钮常态均无底色无描边。
12. 键盘：按钮为原生 `button[type=button]`，Tab 可达，`focus-visible` 有 2px 轮廓，Enter/Space 等同点击。

## 5. 已知风险

1. **免费引擎误报失败**：多任务并发 + 降级链下，某段可能实际已有译文却置为「译失败」——`runJob` 里免费分支异常未被逐段隔离（待修，本规格仅记录现状）。
2. **免费引擎是未认证公开端点**：clients5/gtx/MyMemory 的可用性、限流、字段格式为外部事实，可能随上游变化（MyMemory 已按 480 字符截断）。
3. **密钥仅内存缓存 30 分钟**：GUI 进程 PATH 受限，依赖 `resolveOpBinary()` 探测的绝对路径；`op` 不在常见位置时密钥解析会失败（回落到 `op` 裸命令，可能 ENOENT）。
