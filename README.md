# Claudian Thinking Translator

把 [Claudian](https://github.com/YishenTu/claudian) 的思考过程**实时译成中文**。

- 默认只显示译文，点一下切回原文
- **只在展开思考块时翻译**，折叠状态零请求
- 默认走**免费机翻**（Google），不需要任何密钥
- 以旁挂 DOM 的方式工作：**不改 Claudian 一行代码**

![亮色](docs/preview/light.png)

## 安装

```bash
git clone https://github.com/<you>/claudian-thinking-translator
cp main.js manifest.json styles.css \
  "$YOUR_VAULT/.obsidian/plugins/claudian-thinking-translator/"
```

然后在 Obsidian 设置 → 第三方插件里启用 **Claudian Thinking Translator**。

仓库里的 `install.sh` 会把文件同步到指定库：

```bash
VAULT="/path/to/vault" ./install.sh
```

## 用法

思考块展开后，块底部出现一行极简状态与「原文」按钮：

| 情形 | 表现 |
|---|---|
| 翻译中 | 先显示原文，首段译文到达后切换 |
| 已译 | 只显示译文，「原文」可切回 |
| 内容本身是中文 | 跳过，不请求 |
| 全部引擎失败 | 状态变成「译失败」，点一下重试 |

命令面板里还有：

- `切换思考翻译开关`
- `测试翻译接口`

## 引擎

| 引擎 | 成本 | 说明 |
|---|---|---|
| Google（默认） | 免费、无密钥 | 三级降级：clients5 → gtx → MyMemory |
| DeepSeek | 按 token 计费 | 术语更稳；密钥从 1Password 读取，不落盘 |

免费引擎的两道闸：空结果、译文短于源文 1/4 都判失败并转下一级，避免「假成功」。

## 设置

| 键 | 默认 | 作用 |
|---|---|---|
| 启用 | 开 | 关闭后不扫描、不请求 |
| 翻译引擎 | 免费机翻 | 或 DeepSeek |
| 最小翻译长度 | 120 | 攒够才切段 |
| 每段目标长度 | 420 | 越长越省请求，出译文越晚 |
| 静默合并时间 | 1800ms | 停顿多久把尾巴翻掉 |
| 术语白名单 | `vault skill token …` | 这些词保留英文 |
| 加载时翻译已展开的块 | 关 | 开了也只翻视口内的块 |

## 隐私

- 免费机翻会把**待翻译文本**发给 Google / MyMemory；DeepSeek 发给 DeepSeek。
- 翻译只发生在你展开思考块时；折叠时不会把内容外发。
- 涉密内容请关闭插件或改用自建端点。
- 本插件不写日志、不持久化译文；密钥只在内存里缓存 30 分钟。

## 设计文档与证据

- 规格与契约：`docs/spec.md`
- 证据账本：`docs/evidence.md`
- 变更记录：`CHANGELOG.md`

## 已知限制

- 机翻质量：会出现生硬译法（例如 closing note → 结束音符），需要高保真时切 DeepSeek。
- 依赖 Claudian 的 DOM 契约（`.claudian-thinking-block` / `.claudian-thinking-content`）。上游改结构会导致失效——失效时插件不会报错，只是不工作。
- 目前只在桌面端验证。

## License

MIT
