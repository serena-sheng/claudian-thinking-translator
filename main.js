'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian');
const https = require('https');
const { execFile } = require('child_process');

/* ------------------------------------------------------------------ */
/* 默认设置                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
    enabled: true,
    // 'google' = 免费机翻（无需密钥）；'deepseek' = 付费 LLM 翻译
    engine: 'google',
    apiBase: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    // 1Password 引用；也可直接填 API key（不推荐）或留空走环境变量
    secretRef: 'op://Agent/DeepSeek API/credential',
    minChars: 120,      // 少于这个字符先攒着
    chunkChars: 420,    // 每段目标长度
    idleMs: 1800,       // 静默多久后把剩下的尾巴也翻掉
    glossary: 'vault skill token agent prompt session Claudian Obsidian DeepSeek omp MCP CLI',
    translateExistingOnLoad: false,
    opPath: '',
    networkNoticeShown: false,
    debug: false,
};

const KEY_TTL_MS = 30 * 60 * 1000;
const SCAN_MS = 400;
const RENDER_MS = 90;
const PROMPT_VERSION = 1;

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */

function execFileP(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, opts || {}, (err, stdout) => {
            if (err) reject(err);
            else resolve(String(stdout || ''));
        });
    });
}

/**
 * Obsidian 的 GUI 进程 PATH 很窄，直接 execFile('op') 常常 ENOENT。
 * 这里只按绝对路径候选逐个尝试执行，不读环境变量、不碰文件系统、不经 shell。
 * 用户可在设置里显式指定 op 路径。
 */
function opCandidates(preferred) {
    const list = [];
    if (preferred) list.push(preferred);
    list.push('/opt/homebrew/bin/op', '/usr/local/bin/op', '/usr/bin/op', 'op');
    return Array.from(new Set(list));
}

function countLetters(t) {
    return (t.match(/[A-Za-z]/g) || []).length;
}

function countHan(t) {
    return (t.match(/[\u4e00-\u9fff]/g) || []).length;
}

function commonPrefix(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/* 文本处理：占位符保护 / 切分 / 还原                                    */
/* ------------------------------------------------------------------ */

const PH_RE = /⟦\s*(\d+)[^\d⟧]{0,3}⟧/g;

function protectText(text, glossary) {
    const store = [];
    const put = (s) => {
        store.push(s);
        return '⟦' + (store.length - 1) + '⟧';
    };

    let out = String(text);

    // 代码块、行内代码
    out = out.replace(/```[\s\S]*?```/g, put);
    out = out.replace(/`[^`\n]{1,300}`/g, put);
    // URL
    out = out.replace(/\bhttps?:\/\/[^\s)>\]]+/g, put);
    // 带扩展名的文件名 / 路径片段
    out = out.replace(
        /\b[\w.~/-]+\.(?:md|mjs|cjs|js|ts|tsx|jsx|json|jsonl|py|css|scss|html|yaml|yml|toml|sh|zsh|txt|png|jpe?g|gif|webp|svg|pdf|csv|xlsx|db|sqlite|dmg|app)\b/gi,
        put
    );
    // 绝对路径（保留前导空白，保证可逆）
    out = out.replace(/(^|\s)(~\/[\w.@-]+(?:\/[\w.@-]+)+)/g, (m, ws, p) => ws + put(p));
    // 版本号
    out = out.replace(/\bv?\d+\.\d+(?:\.\d+)*(?:-[A-Za-z0-9.]+)?\b/g, put);
    // 标识符：snake_case / CamelCase / ALLCAPS
    out = out.replace(
        /\b(?:[a-z0-9]+(?:_[a-z0-9]+)+|[A-Za-z]*[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|[A-Z]{2,}[A-Z0-9_-]*)\b/g,
        put
    );
    // 术语白名单（按词匹配）
    const terms = String(glossary || '')
        .split(/[\s,，、;；]+/)
        .filter((t) => t.length > 1);
    for (const term of terms) {
        out = out.replace(new RegExp('\\b' + escapeRe(term) + '\\b', 'gi'), (m) => put(m));
    }

    return { text: out, store };
}

function restoreText(text, store) {
    return String(text).replace(PH_RE, (m, idx) => {
        const v = store[Number(idx)];
        return v === undefined ? m : v; // 源文本自带的 ⟦n⟧ 原样留下，不要吞掉
    });
}

function countPlaceholders(text) {
    const t = String(text);
    const re = /⟦[^⟧]{0,16}⟧/g;
    let n = 0;
    while (re.exec(t)) n++;
    return n;
}

/** 中英之间补空格；不改动已有空白 */
function spaceCJK(text) {
    if (!text) return text;
    return String(text)
        .replace(/([\u4e00-\u9fff])([A-Za-z0-9(`'"\[\/])/g, '$1 $2')
        .replace(/([A-Za-z0-9)`'"\]\/])([\u4e00-\u9fff])/g, '$1 $2');
}

/**
 * 收尾：还原占位符 → 统计缺失 → 清掉模型凭空加的 ⟦…⟧ → 中英补空格。
 * 返回 { text, missing, degraded }
 */
function finalizeTranslation(raw, store) {
    const src = String(raw || '');
    const used = new Set();
    (store || []).forEach((_v, i) => {
        const re = new RegExp('⟦\\s*' + i + '[^\\d⟧]{0,3}⟧');
        if (re.test(src)) used.add(i);
    });
    const missing = (store || []).reduce((n, _v, i) => (used.has(i) ? n : n + 1), 0);

    let out = restoreText(src, store);
    let degraded = missing > 0;
    if (/⟦[^⟧]{0,16}⟧/.test(out)) {
        out = out.replace(/⟦[^⟧]{0,16}⟧/g, '');
        degraded = true;
    }
    return { text: spaceCJK(out), missing, degraded };
}

/**
 * 在 max 以内找一个"安全"的切点：句末、段末、列表项末。
 * 找不到就返回 -1（调用方决定是否硬切）。
 */
function pickCut(text, max) {
    const win = text.slice(0, max);
    let best = -1;
    const re = /[.!?。！？；;](?=\s|$)|\n{2,}|\n(?=[-*+]\s|\d+[.)]\s)/g;
    let m;
    while ((m = re.exec(win)) !== null) {
        best = m.index + m[0].length;
        if (m[0].length === 0) re.lastIndex++;
    }
    return best > max * 0.3 ? best : -1;
}

/** 在 max 处硬切，尽量切在空白处 */
function hardCut(text, max) {
    const win = String(text).slice(0, max);
    const sp = win.lastIndexOf(' ');
    return sp > max * 0.6 ? sp + 1 : max;
}

function nextCut(avail, settings) {
    if (avail.length < settings.minChars) return -1;
    const cut = pickCut(avail, settings.chunkChars);
    if (cut > 0) return cut;
    if (avail.length >= settings.chunkChars * 2) return hardCut(avail, settings.chunkChars);
    return -1;
}

/** 按上限切段（用于 MyMemory 这类有长度限制的端点） */
function splitForLimit(text, limit) {
    const t = String(text);
    if (t.length <= limit) return [t];
    const out = [];
    let rest = t;
    while (rest.length > limit) {
        const cut = hardCut(rest, limit);
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest.trim()) out.push(rest);
    return out;
}

function cleanupTranslation(s) {
    let t = String(s || '').trim();
    t = t.replace(/^(?:译文|翻译|中文|translation)\s*[:：]\s*/i, '');
    t = t.replace(/^```[A-Za-z]*\s*\n?/, '').replace(/\n?```$/, '');
    return t.trim();
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

function buildSystemPrompt(settings) {
    const g = String(settings.glossary || '').trim();
    return [
        '你是翻译器。把用户给的英文思考片段译成简体中文。',
        '只输出译文：不加解释、不加引号、不输出“译文：”之类前缀、不重复原文。',
        '⟦n⟧ 形式的占位符原样保留，不翻译、不增删、不改顺序。',
        '已是中文的部分原样保留；代码、路径、URL 原样保留。',
        '除上面点名保留的词以外，其余英文一律译成中文，不要夹生。',
        g ? '这些词保留英文原样：' + g + '。' : '',
    ]
        .filter(Boolean)
        .join('');
}

function buildUserPrompt(segment, prevTail) {
    const head = prevTail
        ? '上文译文末尾（仅供衔接，不要重复输出）：' + prevTail + '\n\n'
        : '';
    return head + '待译片段：\n' + segment;
}

function streamTranslate(opts) {
    const { apiBase, apiKey, model, system, user, onDelta, signal } = opts;
    return new Promise((resolve, reject) => {
        let url;
        try {
            url = new URL(String(apiBase).replace(/\/+$/, '') + '/chat/completions');
        } catch (e) {
            return reject(new Error('API 地址无效: ' + apiBase));
        }
        const payload = JSON.stringify({
            model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            temperature: 0.3,
            stream: true,
            thinking: { type: 'disabled' },
        });

        const req = https.request(
            {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    Authorization: 'Bearer ' + apiKey,
                    Accept: 'text/event-stream',
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    let err = '';
                    res.on('data', (c) => (err += c));
                    res.on('end', () =>
                        reject(new Error('HTTP ' + res.statusCode + ' ' + err.slice(0, 300)))
                    );
                    return;
                }
                res.setEncoding('utf8');
                let buf = '';
                res.on('data', (chunk) => {
                    buf += chunk;
                    let i;
                    while ((i = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, i).trim();
                        buf = buf.slice(i + 1);
                        if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
                        const data = line.slice(5).trim();
                        if (!data || data === '[DONE]') continue;
                        try {
                            const j = JSON.parse(data);
                            const t = j.choices && j.choices[0] && j.choices[0].delta
                                ? j.choices[0].delta.content
                                : '';
                            if (t) onDelta(t);
                        } catch (e) {
                            /* 忽略不完整行 */
                        }
                    }
                });
                res.on('end', () => resolve());
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error('请求超时')));
        if (signal && signal.addEventListener) {
            signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
        }
        req.write(payload);
        req.end();
    });
}

async function fallbackTranslate(opts) {
    const { apiBase, apiKey, model, system, user } = opts;
    const res = await requestUrl({
        url: String(apiBase).replace(/\/+$/, '') + '/chat/completions',
        method: 'POST',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            temperature: 0.3,
            stream: false,
            thinking: { type: 'disabled' },
        }),
        throw: false,
    });
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    const j = res.json;
    const t = j && j.choices && j.choices[0] && j.choices[0].message
        ? j.choices[0].message.content
        : '';
    return String(t || '');
}

/* ------------------------------------------------------------------ */
/* 免费机翻（无需密钥）                                                  */
/* ------------------------------------------------------------------ */

const UA_HEADER =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function httpGetJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': UA_HEADER } }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('返回不是 JSON'));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 15000, () => req.destroy(new Error('请求超时')));
    });
}

function flattenGoogle(raw) {
    if (typeof raw === 'string') return raw;
    if (!Array.isArray(raw)) return '';
    // clients5 / dict-chrome-ex：["译文", ...]
    if (raw.every((x) => typeof x === 'string')) return raw.join('');
    // gtx：[[["译文","原文",...], ...], ...]
    if (Array.isArray(raw[0])) {
        if (Array.isArray(raw[0][0])) {
            return raw[0]
                .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
                .join('');
        }
        return raw[0].filter((x) => typeof x === 'string').join('');
    }
    return '';
}

const FREE_ENGINES = [
    {
        name: 'Google',
        async run(text) {
            const url =
                'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN&q=' +
                encodeURIComponent(text);
            return flattenGoogle(await httpGetJson(url, 12000));
        },
    },
    {
        name: 'Google(gtx)',
        async run(text) {
            const url =
                'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' +
                encodeURIComponent(text);
            return flattenGoogle(await httpGetJson(url, 15000));
        },
    },
    {
        name: 'MyMemory',
        async run(text) {
            const pieces = splitForLimit(text, 450);
            const outs = [];
            for (const piece of pieces) {
                const url =
                    'https://api.mymemory.translated.net/get?langpair=en%7Czh-CN&q=' +
                    encodeURIComponent(piece);
                const j = await httpGetJson(url, 15000);
                const t = j && j.responseData ? j.responseData.translatedText : '';
                if (!t) throw new Error('空结果');
                outs.push(String(t));
            }
            return outs.join(' ');
        },
    },
];

async function translateFree(text) {
    const errors = [];
    for (const engine of FREE_ENGINES) {
        try {
            const out = await engine.run(text);
            if (!out || !out.trim()) throw new Error('空结果');
            // 英文→中文大致 0.4–0.6；短于 1/4 说明内容被截断
            if (text.length > 80 && out.length < text.length * 0.25) {
                throw new Error('译文异常短，疑似被截断');
            }
            return { text: out, engine: engine.name };
        } catch (e) {
            errors.push(engine.name + ': ' + (e && e.message ? e.message : e));
        }
    }
    throw new Error('免费接口全部失败（' + errors.join('；') + '）');
}

/* ------------------------------------------------------------------ */
/* 单块状态                                                             */
/* ------------------------------------------------------------------ */

class BlockState {
    constructor(el, plugin) {
        this.el = el;
        this.plugin = plugin;
        this.lastSource = '';
        this.consumed = 0;
        this.lastChange = Date.now();
        this.prevTail = '';
        this.outBuf = '';
        this.doneText = '';
        this.store = [];
        this.hasTranslation = false;
        this.busy = false;
        this.segments = 0;
        this.renderTimer = null;
        this.errorNotified = false;
        this.uiBuilt = false;
    }

    ensureUi() {
        if (this.uiBuilt) return;
        this.uiBuilt = true;
        this.buildUi();
    }

    buildUi() {
        this.barEl = this.el.createDiv({ cls: 'ctt-bar is-hidden' });
        // 题注要在原文之前：否则「看原文」时按钮会被长原文挤到屏幕外，回不去译文
        const contentEl = this.el.querySelector(':scope > .claudian-thinking-content');
        if (contentEl) this.el.insertBefore(this.barEl, contentEl);
        this.statusEl = this.barEl.createSpan({ cls: 'ctt-status' });

        this.actionsEl = this.barEl.createDiv({ cls: 'ctt-actions' });

        this.toggleEl = this.actionsEl.createEl('button', {
            cls: 'ctt-toggle',
            text: '看原文',
            attr: { type: 'button' },
        });
        this.toggleEl.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const showing = this.el.hasClass('ctt-show-original');
            this.el.toggleClass('ctt-show-original', !showing);
            this.toggleEl.setText(showing ? '看原文' : '看译文');
        });

        this.retryEl = this.actionsEl.createEl('button', {
            cls: 'ctt-retry',
            text: '重试',
            attr: { type: 'button' },
        });
        this.retryEl.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.retry();
        });

        this.transEl = this.el.createDiv({ cls: 'ctt-translation is-hidden' });
        this.barEl.addEventListener('click', (ev) => ev.stopPropagation());
    }

    setStatus(text, cls) {
        if (!this.statusEl) return;
        this.statusEl.setText(text || '');
        this.statusEl.className = 'ctt-status' + (cls ? ' ' + cls : '');
        this.statusEl.toggleClass('is-hidden', !text);
    }

    updateToggleLabel() {
        this.toggleEl.setText(this.el.hasClass('ctt-show-original') ? '看译文' : '看原文');
    }

    /** 正在译成中文：只有说明，没有可点的东西（原文还在眼前） */
    showTranslating() {
        this.ensureUi();
        this.barEl.removeClass('is-hidden');
        this.setStatus('正在译成中文', 'is-busy');
        this.toggleEl.addClass('is-hidden');
        this.retryEl.addClass('is-hidden');
    }

    /** 已有译文：不宣布完成，只留一个「看原文」 */
    showTranslation() {
        this.ensureUi();
        this.barEl.removeClass('is-hidden');
        this.setStatus('');
        this.retryEl.addClass('is-hidden');
        this.toggleEl.removeClass('is-hidden');
        this.updateToggleLabel();
    }

    /** 术语可能被改写：加一句提醒，控件照旧 */
    showDegraded() {
        this.ensureUi();
        this.barEl.removeClass('is-hidden');
        this.setStatus('个别词可能不准');
        this.retryEl.addClass('is-hidden');
        this.toggleEl.removeClass('is-hidden');
        this.updateToggleLabel();
    }

    /** 失败：说结果、给重试；已有译文时才保留切换 */
    showFailed() {
        this.ensureUi();
        this.barEl.removeClass('is-hidden');
        // 已有译文时不宣称「有一处没译成」——画面上定位不到那句缺口，只留重译
        this.setStatus(this.hasTranslation ? '' : '没能译成中文', 'is-error');
        this.retryEl.setText(this.hasTranslation ? '重译' : '重试');
        this.retryEl.removeClass('is-hidden');
        if (this.hasTranslation) {
            this.toggleEl.removeClass('is-hidden');
            this.updateToggleLabel();
        } else {
            this.toggleEl.addClass('is-hidden');
        }
    }

    hideAll() {
        if (!this.uiBuilt) return;
        this.barEl.addClass('is-hidden');
        this.transEl.addClass('is-hidden');
    }

    retry() {
        if (!this.failedText) return;
        const text = this.failedText;
        this.failedText = null;
        this.showTranslating();
        this.plugin.enqueue(this, text);
    }

    queueRender() {
        if (this.renderTimer) return;
        this.renderTimer = window.setTimeout(() => {
            this.renderTimer = null;
            if (!this.transEl) return;
            const text = this.doneText + restoreText(this.outBuf, this.store);
            this.transEl.setText(text);
            this.transEl.removeClass('is-hidden');
            if (text.trim() && !this.hasTranslation) {
                this.hasTranslation = true;
                this.el.addClass('ctt-has-translation');
                this.showTranslation();
            }
        }, RENDER_MS);
    }
}

/* ------------------------------------------------------------------ */
/* 主插件                                                               */
/* ------------------------------------------------------------------ */

class ClaudianThinkingTranslator extends Plugin {
    async onload() {
        await this.loadSettings();
        this.blocks = new WeakMap();
        this.queue = [];
        this.runningCount = 0;
        this.firstScanDone = false;
        this.preExisting = null;
        this.reArmed = new WeakSet();
        this.keyCache = null;
        this.keyAt = 0;
        this.keyFailAt = 0;
        this.generation = 0;
        this.lastEngine = 'Google';
        this.stats = { requests: 0, inChars: 0, outChars: 0, errors: 0 };

        this.addCommand({
            id: 'toggle-thinking-translation',
            name: '切换思考翻译开关',
            callback: async () => {
                this.settings.enabled = !this.settings.enabled;
                await this.saveSettings();
                new Notice('思考翻译：' + (this.settings.enabled ? '已开启' : '已关闭'));
            },
        });

        this.addCommand({
            id: 'test-translation',
            name: '测试翻译接口',
            callback: () => this.selfTest(),
        });

        this.addSettingTab(new CTTSettingTab(this.app, this));

        if (!this.settings.networkNoticeShown) {
            this.settings.networkNoticeShown = true;
            await this.saveData(this.settings);
            new Notice(
                '思考翻译会把待译文本发送到 Google / MyMemory（默认引擎），可选 DeepSeek。可在插件设置里关闭或换引擎。',
                9000
            );
        }

        if (this.settings.enabled) this.startScanner();
        this.log('loaded');
    }

    onunload() {
        this.stopScanner();
        this.teardownDom();
        this.log('unloaded');
    }

    /** 清掉所有注入的 DOM 与状态；在途请求靠 generation 守卫丢弃结果 */
    teardownDom() {
        this.generation = (this.generation || 0) + 1;
        this.queue.length = 0;
        document.querySelectorAll('.ctt-bar, .ctt-translation').forEach((e) => e.remove());
        document
            .querySelectorAll('.ctt-has-translation, .ctt-show-original')
            .forEach((e) => {
                e.removeClass('ctt-has-translation');
                e.removeClass('ctt-show-original');
            });
        this.blocks = new WeakMap();
        this.preExisting = null;
        this.reArmed = new WeakSet();
        this.firstScanDone = false;
    }

    /** 元素当前是否在视口内（用于"加载时翻译已展开块"的限流） */
    isVisible(el) {
        try {
            const r = el.getBoundingClientRect();
            const h = window.innerHeight || 900;
            return r.height > 0 && r.bottom > 0 && r.top < h;
        } catch (e) {
            return true;
        }
    }

    log(...args) {
        if (this.settings && this.settings.debug) console.log('[CTT]', ...args);
    }

    startScanner() {
        if (this.scanTimer) return;
        this.scanTimer = window.setInterval(() => this.scan(), SCAN_MS);
        this.registerInterval(this.scanTimer);
    }

    stopScanner() {
        if (this.scanTimer) {
            window.clearInterval(this.scanTimer);
            this.scanTimer = null;
        }
    }

    /* -------------------------- 扫描 -------------------------- */

    scan() {
        if (!this.settings.enabled) return;
        const blocks = document.querySelectorAll(
            '.claudian-messages .claudian-thinking-block'
        );

        // 第一次扫描时把已经展开的历史块记下来：它们不主动翻，等用户收起再展开
        if (!this.firstScanDone) {
            this.firstScanDone = true;
            this.preExisting = new WeakSet();
            blocks.forEach((el) => this.preExisting.add(el));
        }

        for (const el of blocks) {
            const expanded = el.classList.contains('expanded');
            let st = this.blocks.get(el);

            // 折叠状态下 Claudian 自己不渲染内容，这里只负责"重新武装"
            if (!expanded) {
                if (this.preExisting && this.preExisting.has(el)) this.reArmed.add(el);
                if (st) st.armed = true;
                continue;
            }

            const content = el.querySelector(':scope > .claudian-thinking-content');
            if (!content || content.classList.contains('claudian-hidden')) continue;

            const text = content.textContent || '';
            if (!text.trim()) continue;

            if (!st) {
                st = new BlockState(el, this);
                const existed = this.preExisting.has(el);
                st.armed =
                    (!existed) ||
                    this.reArmed.has(el) ||
                    (this.settings.translateExistingOnLoad === true && this.isVisible(el));
                this.blocks.set(el, st);
            }
            if (!st.armed) continue;
            this.trackBlock(st, text);
        }
    }

    trackBlock(st, text) {
        if (text !== st.lastSource) {
            const cp = commonPrefix(st.lastSource, text);
            if (cp < st.consumed) st.consumed = cp; // 重渲染导致回退，重新对齐
            st.lastSource = text;
            st.lastChange = Date.now();
            this.pumpBlock(st);
            return;
        }

        // 文本稳定：静默够久就把尾巴也翻掉
        const avail = st.lastSource.slice(st.consumed);
        if (!avail.trim()) return;
        if (Date.now() - st.lastChange < this.settings.idleMs) return;
        if (avail.replace(/\s/g, '').length < 12) return;
        const lim = this.settings.chunkChars;
        if (avail.length > lim) {
            const cut = hardCut(avail, lim);
            st.consumed += cut;
            this.enqueue(st, avail.slice(0, cut));
            return; // 剩下的下一轮扫描继续切
        }
        st.consumed = st.lastSource.length;
        this.enqueue(st, avail);
    }

    pumpBlock(st) {
        const avail = st.lastSource.slice(st.consumed);
        if (!avail) return;
        const cut = nextCut(avail, this.settings);
        if (cut <= 0) return;
        st.consumed += cut;
        this.enqueue(st, avail.slice(0, cut));
    }

    /* -------------------------- 队列 -------------------------- */

    enqueue(st, text) {
        const probe = text.replace(/`{1,3}[\s\S]*?`{1,3}/g, ' ');
        const letters = countLetters(probe);
        const han = countHan(probe);
        if (han > 0 && han > letters) {     // 已经是中文（纯中文时 letters=0）
            st.hideAll();
            return;
        }
        if (letters < 10) return;           // 没有可译内容
        this.queue.push({ st, text });
        this.pumpQueue();
    }

    maxParallel() {
        // 免费机翻是串行 HTTP，放宽并发；付费 LLM 保持单并发控制花费
        return this.settings.engine === 'deepseek' ? 1 : 3;
    }

    pumpQueue() {
        this.runningCount = this.runningCount || 0;
        const max = this.maxParallel();
        // 同一块必须串行：两个并发 job 会共享 st.outBuf / st.store，把术语串味
        for (let i = 0; i < this.queue.length && this.runningCount < max; ) {
            const job = this.queue[i];
            if (job.st.busy) {
                i++;
                continue;
            }
            this.queue.splice(i, 1);
            job.st.busy = true;
            this.runningCount++;
            this.runJob(job.st, job.text)
                .catch((e) => {
                    this.stats.errors++;
                    this.lastError = String((e && e.message) || e);
                    this.log('job failed', this.lastError);
                    job.st.failedText = job.text;
                    job.st.showFailed();
                })
                .finally(() => {
                    job.st.busy = false;
                    this.runningCount--;
                    if (this.queue.length) this.pumpQueue();
                });
        }
    }

    async runJob(st, raw) {
        const settings = this.settings;
        const gen = this.generation || 0;
        const { text: masked, store } = protectText(raw, settings.glossary);

        st.outBuf = '';
        st.store = store;
        st.showTranslating();

        if (settings.engine === 'deepseek') {
            const key = await this.getApiKey();
            const system = buildSystemPrompt(settings);
            const user = buildUserPrompt(masked, st.prevTail);
            const onDelta = (d) => {
                st.outBuf += d;
                st.queueRender();
            };
            try {
                await streamTranslate({
                    apiBase: settings.apiBase,
                    apiKey: key,
                    model: settings.model,
                    system,
                    user,
                    onDelta,
                });
            } catch (e) {
                this.log('stream failed, fallback', e && e.message);
                const whole = await fallbackTranslate({
                    apiBase: settings.apiBase,
                    apiKey: key,
                    model: settings.model,
                    system,
                    user,
                });
                st.outBuf = whole;
                st.queueRender();
            }
        } else {
            const t0 = Date.now();
            const r = await translateFree(masked);
            this.lastLatency = Date.now() - t0;
            st.outBuf = r.text;
            this.lastEngine = r.engine;
            st.queueRender();
        }

        if ((this.generation || 0) !== gen) return; // 期间被关闭/重载，丢弃结果
        this.stats.requests++;
        this.stats.inChars += raw.length;
        this.stats.outChars += st.outBuf.length;

        const rawOut = st.outBuf;
        const fin = finalizeTranslation(rawOut, st.store);
        const restored = cleanupTranslation(fin.text);
        st.doneText = st.doneText ? st.doneText + '\n' + restored : restored;
        st.outBuf = '';
        st.prevTail = restored.slice(-60);
        st.segments++;
        if (st.renderTimer) {
            window.clearTimeout(st.renderTimer);
            st.renderTimer = null;
        }
        if (st.transEl) {
            st.transEl.setText(st.doneText);
            st.transEl.removeClass('is-hidden');
            if (st.doneText.trim() && !st.hasTranslation) {
                st.hasTranslation = true;
                st.el.addClass('ctt-has-translation');
            }
        }
        if (fin.degraded) st.showDegraded();
        else st.showTranslation();
        this.log('translated', raw.length, '->', restored.length);
    }

    async getApiKey() {
        if (this.keyCache && Date.now() - this.keyAt < KEY_TTL_MS) return this.keyCache;
        if (this.keyFailAt && Date.now() - this.keyFailAt < 30000) {
            throw new Error('密钥暂不可用（30 秒后重试）');
        }
        const ref = String(this.settings.secretRef || '').trim();
        let key = '';
        if (ref.startsWith('op://')) {
            const bins = opCandidates(String(this.settings.opPath || '').trim());
            let tried = 0;
            for (const bin of bins) {
                tried++;
                try {
                    key = (await execFileP(bin, ['read', ref], { timeout: 30000 })).trim();
                    if (key) break;
                } catch (e) {
                    const msg = String((e && e.message) || e);
                    if (msg.includes('ENOENT')) continue;
                    this.keyFailAt = Date.now();
                    throw new Error('1Password 取密钥失败（需要解锁或 Touch ID）：' + msg);
                }
            }
            if (!key) {
                this.keyFailAt = Date.now();
                throw new Error(
                    '找不到 1Password CLI（op），试过 ' +
                        tried +
                        ' 个位置；可在插件设置里填写 op 的绝对路径'
                );
            }
        } else if (ref) {
            key = ref;
        } else {
            key = '';
        }
        if (!key) throw new Error('未配置 API 密钥');
        this.keyFailAt = 0;
        this.keyCache = key;
        this.keyAt = Date.now();
        return key;
    }

    async selfTest() {
        try {
            const st = {
                outBuf: '',
                store: [],
                prevTail: '',
                setStatus: () => {},
                queueRender: () => {},
            };
            const { text: masked, store } = protectText(
                'Let me check whether the vault index has the Claudian plugin manifest.',
                this.settings.glossary
            );
            if (this.settings.engine !== 'deepseek') {
                const r = await translateFree(masked);
                new Notice('翻译自测（' + r.engine + '）：\n' + cleanupTranslation(restoreText(r.text, store)), 8000);
                return;
            }
            const key = await this.getApiKey();
            let out = '';
            try {
                await streamTranslate({
                    apiBase: this.settings.apiBase,
                    apiKey: key,
                    model: this.settings.model,
                    system: buildSystemPrompt(this.settings),
                    user: buildUserPrompt(masked, ''),
                    onDelta: (d) => (out += d),
                });
            } catch (e) {
                out = await fallbackTranslate({
                    apiBase: this.settings.apiBase,
                    apiKey: key,
                    model: this.settings.model,
                    system: buildSystemPrompt(this.settings),
                    user: buildUserPrompt(masked, ''),
                });
            }
            const restored = cleanupTranslation(restoreText(out, store));
            new Notice('翻译自测：\n' + restored, 8000);
        } catch (e) {
            new Notice('自测失败：' + (e && e.message ? e.message : e), 8000);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        if (this.settings.enabled) this.startScanner();
        else {
            this.stopScanner();
            this.teardownDom();
        }
    }
}

/* ------------------------------------------------------------------ */
/* 设置页                                                               */
/* ------------------------------------------------------------------ */

class CTTSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        const p = this.plugin;
        const s = p.settings;

        containerEl.createEl('p', {
            cls: 'setting-item-description',
            text: '只在展开思考块时翻译；默认显示译文，点击「原文」可切换。免费机翻不需要密钥；选 DeepSeek 时密钥从 1Password 读取，不落盘。',
        });

        new Setting(containerEl)
            .setName('启用')
            .setDesc('关闭后不再扫描，也不再产生请求')
            .addToggle((t) =>
                t.setValue(s.enabled).onChange(async (v) => {
                    s.enabled = v;
                    await p.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('加载时翻译已展开的块')
            .setDesc('默认关闭：只翻你新点开的；已展开的历史块先跳过，收起再展开才翻')
            .addToggle((t) =>
                t.setValue(s.translateExistingOnLoad).onChange(async (v) => {
                    s.translateExistingOnLoad = v;
                    await p.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('翻译引擎')
            .setDesc('免费机翻无需密钥；DeepSeek 更准但要花钱、要密钥')
            .addDropdown((d) =>
                d
                    .addOption('google', '免费机翻（Google，无需密钥）')
                    .addOption('deepseek', 'DeepSeek（付费，术语更稳）')
                    .setValue(s.engine || 'google')
                    .onChange(async (v) => {
                        s.engine = v;
                        await p.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('模型')
            .setDesc('默认 deepseek-flash（翻译请求会显式关闭 thinking）')
            .addText((t) =>
                t.setValue(s.model).onChange(async (v) => {
                    s.model = v.trim() || DEFAULT_SETTINGS.model;
                    await p.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('API 地址')
            .addText((t) =>
                t.setValue(s.apiBase).onChange(async (v) => {
                    s.apiBase = v.trim() || DEFAULT_SETTINGS.apiBase;
                    await p.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('1Password CLI 路径')
            .setDesc('留空则依次尝试 /opt/homebrew/bin/op、/usr/local/bin/op 等；填绝对路径最稳')
            .addText((t) =>
                t.setValue(s.opPath || '').onChange(async (v) => {
                    s.opPath = v.trim();
                    p.keyCache = null;
                    p.keyFailAt = 0;
                    await p.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('密钥来源')
            .setDesc('op:// 引用优先；也可填环境变量名以外的明文（不推荐）')
            .addText((t) =>
                t.setValue(s.secretRef).onChange(async (v) => {
                    s.secretRef = v.trim();
                    p.keyCache = null;
                    p.keyFailAt = 0;
                    await p.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('最小翻译长度')
            .setDesc('少于这个字符数先攒着，避免把一句话切碎')
            .addSlider((t) =>
                t
                    .setLimits(40, 400, 20)
                    .setValue(s.minChars)
                    .setDynamicTooltip()
                    .onChange(async (v) => {
                        s.minChars = v;
                        await p.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('每段目标长度')
            .setDesc('越长越省请求，但出译文越晚')
            .addSlider((t) =>
                t
                    .setLimits(200, 1200, 50)
                    .setValue(s.chunkChars)
                    .setDynamicTooltip()
                    .onChange(async (v) => {
                        s.chunkChars = v;
                        await p.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('静默合并时间')
            .setDesc('思考停顿多久后把剩下的尾巴也翻掉（毫秒）')
            .addSlider((t) =>
                t
                    .setLimits(600, 5000, 200)
                    .setValue(s.idleMs)
                    .setDynamicTooltip()
                    .onChange(async (v) => {
                        s.idleMs = v;
                        await p.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('术语白名单')
            .setDesc('这些词保留英文原样（空格分隔）；其余标识符自动用占位符保护')
            .addTextArea((t) => {
                t.setValue(s.glossary).onChange(async (v) => {
                    s.glossary = v;
                    await p.saveSettings();
                });
                t.inputEl.rows = 3;
            });

        new Setting(containerEl)
            .setName('调试日志')
            .setDesc('在开发者控制台输出请求与耗时')
            .addToggle((t) =>
                t.setValue(s.debug).onChange(async (v) => {
                    s.debug = v;
                    await p.saveSettings();
                })
            );

        const st = p.stats;
        new Setting(containerEl)
            .setName('本次会话用量')
            .setDesc(
                `引擎 ${s.engine === 'deepseek' ? 'DeepSeek（付费）' : '免费机翻'} · 请求 ${st.requests} 次 · 输入 ${st.inChars} 字符 · 输出 ${st.outChars} 字符 · 失败 ${st.errors} 次`
            )
            .addButton((b) =>
                b.setButtonText('测试翻译接口').onClick(() => p.selfTest())
            );
    }
}

module.exports = ClaudianThinkingTranslator;
module.exports.__internals = {
    protectText,
    restoreText,
    pickCut,
    nextCut,
    cleanupTranslation,
    buildSystemPrompt,
    buildUserPrompt,
    countPlaceholders,
    finalizeTranslation,
    spaceCJK,
    splitForLimit,
    hardCut,
    translateFree,
};
