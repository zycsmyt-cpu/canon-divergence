/**
 * 原作偏离引擎 Canon Divergence  v0.2.0
 *
 * 解决的场景：
 *   同人卡把「原著指导」做成几百条常驻剧情条目，模型把它读成剧本，
 *   每一轮都在复现原著该发生的事，主角做过的改变被抹平。
 *
 * 做法：
 *   每轮生成前，在对话末尾注入一段很短的偏离规则：
 *   原著是"没有主角时会发生什么"的基线，不是必须完成的剧情。
 *   另外检测主角是否被旁置（连续短输入 + 剧情在自走），命中就加一段拦截。
 *
 * 世界书里那条 <原著指导> 的开场声明是静态的，会被长文本冲淡；
 * 这里是每轮贴脸重述，管的是模型读到原著时的解读方式。
 *
 * 依赖：window.SillyTavern.getContext()（SillyTavern / TauriTavern 均有）。
 */

const SETTINGS_KEY = 'canonDivergence';
const LEGACY_KEY = 'narrativeBalance';
const PROMPT_KEY = 'canon_divergence_directive';

// SillyTavern 注入常量（不 import，避免路径差异）
const POS_IN_CHAT = 1;
const ROLE_SYSTEM = 0;

const DEFAULTS = Object.freeze({
    enabled: true,
    intercept: true,   // 主角被旁置时追加拦截段
    depth: 2,          // 注入深度，越小越贴脸
    _v: 2,             // 设置结构版本，供将来迁移用
});

/* ------------------------------------------------------------------ */
/* 文本工具                                                             */
/* ------------------------------------------------------------------ */

function stripTags(text) {
    if (!text) return '';
    return String(text)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\{\{[^}]+\}\}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function textLen(text) {
    const s = stripTags(text).replace(/[，。！？、；：""''（）《》…—\-\s.,!?;:'"()[\]]/g, '');
    return s.length;
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
}

/** 从 AI 回复里取当前幕（斗罗系卡写在 <story>日期｜幕名</story>） */
function extractScene(mes) {
    if (!mes) return '';
    const m = mes.match(/<story>([^<]*)<\/story>/i);
    if (!m) return '';
    const raw = m[1].trim();
    const parts = raw.split(/[｜|]/);
    const scene = (parts.length > 1 ? parts.slice(1).join('｜') : '').trim();
    return scene.slice(0, 40);
}

/* ------------------------------------------------------------------ */
/* 信号                                                                 */
/* ------------------------------------------------------------------ */

function analyze(chat, ctx) {
    const msgs = (chat || []).filter(m => m && typeof m.mes === 'string' && !m.is_system);
    const recent = msgs.slice(-12);
    const userMsgs = recent.filter(m => m.is_user);
    const aiMsgs = recent.filter(m => !m.is_user);

    const lastUser = userMsgs[userMsgs.length - 1];
    const userLen = lastUser ? textLen(lastUser.mes) : 0;

    // 连续短输入：主角在旁观
    let idleTurns = 0;
    for (let i = msgs.length - 1; i >= 0 && idleTurns < 6; i--) {
        const m = msgs[i];
        if (m.is_user) {
            if (textLen(m.mes) <= 8) idleTurns++;
            else break;
        }
    }

    // 最近一条 AI 回复里的当前幕
    let scene = '';
    for (let i = aiMsgs.length - 1; i >= 0 && !scene; i--) {
        scene = extractScene(aiMsgs[i].mes);
    }

    // 主角是否被提及（弱信号，只用来提示）
    const lastReply = aiMsgs.length ? aiMsgs[aiMsgs.length - 1].mes : '';
    const userName = (ctx && ctx.name1) || '';
    const presence = (lastReply.match(/你/g) || []).length
        + (userName && userName !== '你'
            ? (lastReply.match(new RegExp(escapeRe(userName), 'g')) || []).length
            : 0);

    return { userLen, idleTurns, presence, scene, msgs: msgs.length };
}

/* ------------------------------------------------------------------ */
/* 注入文案                                                             */
/* ------------------------------------------------------------------ */

const CORE = `【原作偏离 · 运行时】
你读到的原著指导（剧情篇章、时间线、原著设定），记录的是"没有{{user}}介入时"，这个故事原本会怎么走。它是一条基线，不是剧本，不是这一轮必须完成的任务。

- 已经发生的事就是事实。{{user}}做过的事，不因为原著里没写而失效、被淡化，或"恰好什么都没改变"。
- 因果一旦被改动，后面的走向必须按新的因果重算。不要为了让剧情回到原著轨道，把{{user}}的影响抹平。
- 原著人物对{{user}}的态度，由已经发生的事决定，不由书里写的关系决定。
- 需要原著时，用它取时代、势力、人性、力量体系、前史；不要用它取"下一步该发生什么"。
- 当你发现自己正要写"原著里本该发生的事"时，先给出理由：{{user}}之前做的那些为什么没有改变它。`;

const INTERCEPT = `【旁置拦截】
最近几轮{{user}}的输入很短，而剧情一直在自己往前走——这是偏离失效的信号。
本轮把镜头收回到{{user}}面前：
- 不推进时间，不切场景。
- 由在场的人直接找{{user}}说话或出手，而不是让 Ta 在旁边看着。
- {{user}}上一条说的、做的，就是这一轮的起点。
- 收尾停在只有{{user}}能回应的节点上。`;

function buildDirective(a, settings, ctx) {
    const userName = (ctx && ctx.name1) || '你';
    const parts = [CORE];

    if (settings.intercept && a.idleTurns >= 2) {
        parts.push(INTERCEPT);
    }

    if (a.scene) {
        parts.push(`【当前基线】原著在这一刻走到：${a.scene}。核对：{{user}}至今让它偏离了多少？按偏离后的写。`);
    }

    let text = parts.join('\n\n').replace(/\{\{user\}\}/gi, userName);
    text = `<原作偏离 运行时注入>\n${text}\n</原作偏离>`;

    return { text, analysis: a, userName };
}

/* ------------------------------------------------------------------ */
/* 宿主                                                                 */
/* ------------------------------------------------------------------ */

function getCtx() {
    try {
        const st = window.SillyTavern;
        if (!st) return null;
        return typeof st.getContext === 'function' ? st.getContext() : st;
    } catch {
        return null;
    }
}

async function waitForCtx(timeoutMs = 30000) {
    const started = Date.now();
    for (;;) {
        const ctx = getCtx();
        if (ctx && ctx.chat) return ctx;
        if (Date.now() - started > timeoutMs) return null;
        await new Promise(r => setTimeout(r, 200));
    }
}

function settingsOf(ctx) {
    let store = ctx.extensionSettings || window.extension_settings;
    if (!store) {
        store = {};
        window.extension_settings = store;
    }
    // 从旧名字迁移（v0.1 叫 narrativeBalance）
    if (store[SETTINGS_KEY] === undefined && store[LEGACY_KEY] !== undefined) {
        const old = store[LEGACY_KEY] || {};
        store[SETTINGS_KEY] = { ...DEFAULTS, enabled: old.enabled !== false };
    }
    if (!store[SETTINGS_KEY]) store[SETTINGS_KEY] = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
        if (store[SETTINGS_KEY][k] === undefined) store[SETTINGS_KEY][k] = DEFAULTS[k];
    }
    return store[SETTINGS_KEY];
}

function persist(ctx) {
    try {
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    } catch { /* 存不下不影响本轮 */ }
}

/* ------------------------------------------------------------------ */
/* 注入                                                                 */
/* ------------------------------------------------------------------ */

let lastResult = null;
let $panel = null;

function pushPrompt(ctx, settings, result) {
    const fn = ctx.setExtensionPrompt;
    if (typeof fn !== 'function') return false;
    try {
        fn(PROMPT_KEY, settings.enabled ? result.text : '', POS_IN_CHAT,
            Number(settings.depth) || 0, false, ROLE_SYSTEM);
        return true;
    } catch (e) {
        console.error('[原作偏离] 注入失败', e);
        return false;
    }
}

function renderDiag(result) {
    if (!result || !$panel) return;
    const a = result.analysis;
    const bits = [
        a.scene ? `基线 <b>${escapeHtml(a.scene)}</b>` : '未读到当前幕',
        `末条输入 ${a.userLen} 字`,
        `旁观 ${a.idleTurns} 轮`,
        a.idleTurns >= 2 ? '<b>拦截已启用</b>' : '拦截待命',
    ];
    $panel.querySelector('#cd_diag').innerHTML = bits.join(' · ');
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function computeAndPush(ctx, settings) {
    const a = analyze(ctx.chat, ctx);
    lastResult = buildDirective(a, settings, ctx);
    pushPrompt(ctx, settings, lastResult);
    renderDiag(lastResult);
    return lastResult;
}

/* ------------------------------------------------------------------ */
/* UI                                                                   */
/* ------------------------------------------------------------------ */

function buildPanel(ctx, settings) {
    const host = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');
    if (!host) return false;

    const uname = escapeHtml(ctx.name1 || '你');

    const wrap = document.createElement('div');
    wrap.id = 'cd_panel';
    wrap.className = 'cd-panel';
    wrap.innerHTML = `
        <div class="cd-title">原作偏离引擎
            <span class="cd-sub">原著是基线，不是剧本</span>
        </div>
        <label class="cd-row cd-check">
            <input type="checkbox" id="cd_enabled">
            <span>启用</span>
        </label>
        <label class="cd-row cd-check">
            <input type="checkbox" id="cd_intercept">
            <span>旁置拦截（${uname} 连续短输入时，把镜头拉回来）</span>
        </label>
        <div class="cd-row">
            <span class="cd-label">注入深度</span>
            <input type="number" id="cd_depth" min="0" max="10" step="1">
            <span class="cd-hint">越小越贴脸，2 通常合适</span>
        </div>
        <div class="cd-diag" id="cd_diag">尚未运行</div>
        <div class="cd-row cd-actions">
            <button id="cd_trial" class="menu_button">试算一次</button>
            <button id="cd_peek" class="menu_button">看本轮注入</button>
        </div>
        <div class="cd-out" id="cd_out"></div>
    `;
    host.appendChild(wrap);
    $panel = wrap;

    const $enabled = wrap.querySelector('#cd_enabled');
    const $intercept = wrap.querySelector('#cd_intercept');
    const $depth = wrap.querySelector('#cd_depth');
    const $out = wrap.querySelector('#cd_out');

    $enabled.checked = Boolean(settings.enabled);
    $intercept.checked = Boolean(settings.intercept);
    $depth.value = String(settings.depth);

    $enabled.addEventListener('change', () => {
        settings.enabled = $enabled.checked;
        persist(ctx);
        if (!settings.enabled && typeof ctx.setExtensionPrompt === 'function') {
            try {
                ctx.setExtensionPrompt(PROMPT_KEY, '', POS_IN_CHAT, Number(settings.depth) || 0, false, ROLE_SYSTEM);
            } catch { /* ignore */ }
        }
    });

    $intercept.addEventListener('change', () => {
        settings.intercept = $intercept.checked;
        persist(ctx);
    });

    $depth.addEventListener('change', () => {
        settings.depth = clamp(Number($depth.value) || 0, 0, 10);
        $depth.value = String(settings.depth);
        persist(ctx);
    });

    wrap.querySelector('#cd_trial').addEventListener('click', () => {
        $out.textContent = '';
        computeAndPush(ctx, settings);
        if (lastResult) $out.textContent = lastResult.text;
    });

    wrap.querySelector('#cd_peek').addEventListener('click', () => {
        $out.textContent = lastResult ? lastResult.text : '还没有算过';
    });

    return true;
}

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

async function boot() {
    const ctx = await waitForCtx();
    if (!ctx) {
        console.warn('[原作偏离] 等不到 SillyTavern 上下文，未激活');
        return;
    }

    const settings = settingsOf(ctx);
    persist(ctx);

    for (let i = 0; i < 50; i++) {
        if (buildPanel(ctx, settings)) break;
        await new Promise(r => setTimeout(r, 200));
    }

    const events = ctx.eventSource;
    const types = ctx.eventTypes;
    if (!events || !types) {
        console.warn('[原作偏离] 没有 eventSource，只能手动试算');
        return;
    }

    const onGenerate = () => {
        try {
            computeAndPush(ctx, settingsOf(ctx));
        } catch (e) {
            console.error('[原作偏离] 计算失败', e);
        }
    };

    events.on(types.GENERATION_STARTED, onGenerate);
    if (types.CHAT_CHANGED) events.on(types.CHAT_CHANGED, onGenerate);

    console.info('[原作偏离] 已就绪');
}

boot();
