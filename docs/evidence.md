# 证据账本 — Claudian Thinking Translator

规则：**没有证据的「完成」记为未完成。** 一行 = 一个声称 + 可复现的证据。

| # | 声称 | 证据类型 | 证据 | 谁验的 | 时间 |
|---|---|---|---|---|---|
| 1 | 免费引擎能翻译展开的思考块 | eval 实测 | 注入 152 字符块 → 1 请求、状态 `已译 1 段 · Google`、译文「在接触捆绑包之前…」 | builder | 10-18 |
| 2 | 术语占位符可往返 | eval 实测 | 输入含 `Claudian` / `vault` → 译文保留英文原词，状态无「术语待核」 | builder | 10-18 |
| 3 | 增量追加不覆盖 | eval 实测 | 追加第二段后 `stats.requests=2`，译文两段换行拼接 | builder | 10-18 |
| 4 | 原文/译文切换 | eval 实测 | `getComputedStyle` 由 `none`↔`block` 互换，按钮文案同步 | builder | 10-18 |
| 5 | 折叠零请求 | eval 实测 | 加载后 372 个块（91 个已展开）→ `stats.requests=0`、`.ctt-bar` 计数 0 | builder | 10-18 |
| 6 | 免费引擎延迟 | eval 实测 | HTTP 0.54s / 1.79s / 2.35s（clients5），端到端 2.0–2.7s | builder | 10-18 |
| 7 | DeepSeek 引擎可用 | eval + curl | 1 请求 / 176 prompt tokens / 1.22s，占位符保留 | builder | 10-18 |
| 8 | 纯函数正确性 | 单元测试 | `NODE_PATH=/tmp/ctt-test/node_modules node /tmp/ctt-test/test.js` → 16/16 通过 | builder | 10-18 |
| 9 | 免费分支不再假失败 | eval 实测 | 修复前 `lastError="user is not defined"`；修复后 `lastError=null`、状态正确 | builder | 10-18 |
| 10 | 契约与实现一致 | 静态差集 + 18 条验收 | QA 首轮：14 pass / 1 fail / 3 unverified，判 `block` | qa | 10-18 |
| 11 | 同块任务已串行化（P1 修复） | eval 实测 | 同块连投两个 chunk：`during={running:1,busy:true,queuedSameSt:1}` → `after={requests:2,running:0}`，译文顺序正确 | builder | 10-18 |
| 12 | 长块按 chunk 切分、不丢内容（P1 修复） | eval 实测 | 871 字符块 → `segments=3`、`consumed==srcLen`、译文 272 字，状态 `已译 3 段 · Google` | builder | 10-18 |
| 13 | 纯中文显示「中文·跳过」（P1 修复） | eval 实测 | 41 字符纯中文块 → `status="中文·跳过"`、`transLen=0`、请求 0 | builder | 10-18 |
| 14 | 占位符损伤可清理（P2 修复） | 单元测试 | `finalizeTranslation('译文⟦99⟧残留', [])` → `text="译文残留"`、`degraded=true`；`⟦0加⟧` 能还原成 `Claudian` | builder | 10-18 |
| 15 | 加载时翻译只武装视口内块（P2 修复） | eval 实测 | `translateExistingOnLoad=true` 重载：118 个展开块 → `bars=0, queue=0`（均不在视口）；`isVisible` 探针 `{visible:true, faraway:false}` | builder | 10-18 |
| 16 | 免费引擎三级降级 | eval 实测 | `Google` / `Google(gtx)` / `MyMemory` 三种尾缀均复现 | qa | 10-18 |
| 17 | 单测 | 单元测试 | `node /tmp/ctt-test/test.js` → 26/26 通过 | builder | 10-18 |

## 复现命令（最小集）

```bash
# 单元测试
NODE_PATH=/tmp/ctt-test/node_modules node /tmp/ctt-test/test.js

# 真实插件：注入块并等待译文
obsidian vault="Serena-heart" eval code="(async()=>{
  const id='claudian-thinking-translator';
  await app.plugins.disablePlugin(id); await app.plugins.enablePluginAndSave(id);
  await new Promise(r=>setTimeout(r,1500));
  /* 造 .claudian-messages > .claudian-thinking-block.expanded > .claudian-thinking-content */
})()"
```

## 未取证项（待补）

- DeepSeek 真实密钥下的完整链路（仅测过单次请求 1.22s；`fallbackTranslate` 兜底路径未触发）
- MyMemory 限流/配额耗尽后的表现
- 469 个真实块下 400ms 扫描的长期 CPU 占用（未做性能剖析）

## 已由 QA 取证（首轮）

- 免费引擎全失败 → `译失败` + 单次 Notice
- 1Password 未解锁 / 未配置密钥 → 各自文案
- 关闭 `enabled` → 无请求、无新 UI
- 卸载重载 → DOM 零残留
- `glossary` / `minChars` / `chunkChars` / `idleMs` / `debug` 五项接线均有可观察效果
