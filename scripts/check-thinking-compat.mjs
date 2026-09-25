// 回归检查：思考参数的严格网关兼容（2026-09，实测 AMD Radeon 端点 400）。
//
// ── 背景 ────────────────────────────────────────────────────────────────
//
// 用户实测：AMD 的 OpenAI 兼容端点对 `thinking` 字段回 400 ——
//   "thinking" is not supported … Use "reasoning_effort"
// 而同时发 thinking + reasoning_effort 还会被某些网关拒
// （Roo-Code #11001：volcengine "Invalid combination"）。
// GitHub 调研结论：没有哪个思考字段全网通用，成熟做法是
// **先发 → 400 且报错点名参数 → 按点名剥参数重试**（hermes-agent #34786）。
//
// ── 这里的兼容契约 ──────────────────────────────────────────────────────
//
//   · 认 thinking 的网关（DeepSeek 官方/中转）→ 第一次就成功，行为不变
//   · 不认的网关（AMD/OpenAI 官方）→ 第一次 400，自动剥掉被点名的参数重发，
//     用户无感；报错点名 reasoning_effort 时只剥它
//   · 其它 400（图片太大等）→ 不剥参数、照常抛错（剥了也解决不了）
//
// 测试方式：按 check-chat-providers.mjs 的依赖注入套路，用假 fetch 真跑
// callOpenAICompatibleChat，捕获每次请求体做断言。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'web', 'js', 'chat-providers.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

// 从 chat-providers.js 里截出 rejectedRequestParam（按大括号配对）单测
function grabFn(source, name) {
    const i = source.indexOf('function ' + name);
    if (i < 0) throw new Error('not found: ' + name);
    let depth = 0, started = false, end = i;
    for (let k = i; k < source.length; k++) {
        if (source[k] === '{') { depth++; started = true; }
        else if (source[k] === '}') { depth--; if (started && depth === 0) { end = k; break; } }
    }
    return source.slice(i, end + 1);
}
const rejectedRequestParam = new Function(
    grabFn(src, 'rejectedRequestParam') + '\nreturn rejectedRequestParam;'
)();

// ---------- 单测 rejectedRequestParam ----------
console.log('=== 1. rejectedRequestParam：从 400 里认出被拒参数 ===');
{
    const amdPayload = {
        error: {
            message: '"thinking" is not supported on /v1/chat/completions and was not applied. Use "reasoning_effort" (or "reasoning.effort") to control thinking.',
            type: 'invalid_request_error',
            param: 'thinking',
            code: 'unsupported_parameter',
        },
    };
    ok(rejectedRequestParam({ status: 400, payload: amdPayload, rawText: JSON.stringify(amdPayload) }) === 'thinking',
        '★ AMD 报错（param 字段）→ thinking');
    ok(rejectedRequestParam({ status: 400, rawText: 'Invalid reasoning_effort for this model' }) === 'reasoning_effort',
        '★ 文本点名 reasoning_effort → reasoning_effort');
    ok(rejectedRequestParam({ status: 400, rawText: "cannot specify both 'thinking' and 'reasoning_effort'" }) === 'thinking',
        '★ "both thinking and reasoning_effort" → thinking（连带剥强度）');
    ok(rejectedRequestParam({ status: 400, payload: { error: { message: '图片过大 max 20MB' } }, rawText: '图片过大' }) === null,
        '★ 其它 400（图片类）→ null（不剥参数，照常抛错）');
    ok(rejectedRequestParam({ status: 500, rawText: 'thinking not supported' }) === null,
        '★ 非 400 → null（5xx 不是参数问题）');
}

// ---------- 集成：真跑 callOpenAICompatibleChat ----------
console.log('\n=== 2. 集成：假网关真跑，看降级重试 ===');
// chat-providers.js 是普通 <script>，靠 window.ChatDeps 取依赖 ——
// 在 eval 之前就建好 window，场景之间只换 window.ChatDeps 的内容。
globalThis.window = { ChatDeps: null };
    // 最小化的 deps() 套路：与 check-chat-providers.mjs 相同
    // 注意：把同一个 window 对象传进去（deps() 调用时读 window.ChatDeps），
    // 场景里改 window.ChatDeps 才能生效。
    const ChatProviders = new Function(
        'window',
        src + '\nreturn window.ChatProviders;'
    )(globalThis.window);

    // requestChatJson 的最小假实现：记录请求体，按脚本决定返回
    // responses: [{ test(result), reply: {ok, status, payload} }]
    function makeDeps(script, captured) {
        return {
            ClientApiError: class ClientApiError extends Error {
                constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra || {}); }
            },
            getChatBaseUrl: (s) => String(s.baseUrl || '').replace(/\/$/, ''),
            isDeepSeekOfficial: (u) => /deepseek\.com/.test(u || ''),
            buildThinkingParams: null,   // 下面注入真实现（从 app-01-core.js 截取）
            normalizeChatReply: (c, r) => ({ content: c, reasoning: r }),
            throwProviderResponseError: async (result) => {
                const err = new Error('HTTP ' + result.status);
                err.providerLogged = true;
                throw err;
            },
            requestChatJson: async (endpoint, body) => {
                captured.push({ endpoint, body });
                for (const s of script) {
                    if (s.match(body, captured.length)) return s.reply;
                }
                return { ok: true, status: 200, payload: { choices: [{ message: { content: 'OK' } }] } };
            },
        };
    }

    // 从 app-01-core.js 截真实现（别在测试里重写一遍逻辑 —— 测的不是真代码就没意义）
    const coreSrc = readFileSync(path.join(ROOT, 'web', 'js', 'app-01-core.js'), 'utf8');
    function grabCore(name) {
        const i = coreSrc.indexOf('function ' + name);
        let depth = 0, started = false, end = i;
        for (let k = i; k < coreSrc.length; k++) {
            if (coreSrc[k] === '{') { depth++; started = true; }
            else if (coreSrc[k] === '}') { depth--; if (started && depth === 0) { end = k; break; } }
        }
        return coreSrc.slice(i, end + 1);
    }
    const realBuildThinkingParams = new Function(
        'isDeepSeekOfficial', 'mapThinkingEffort',
        grabCore('detectThinkingVendor') + '\n' + grabCore('buildThinkingParams') +
        '\nreturn buildThinkingParams;'
    )((u) => /deepseek\.com/.test(u || ''), (l) => l);

    const settings = {
        apiKey: 'test-key',
        model: 'gpt-oss',
        baseUrl: 'https://developer.amd.com.cn/radeon/api/v1',
    };
    const opts = { thinking: false, thinkingEffort: 'medium', maxTokens: 100 };

    // 场景 A：AMD 式网关 —— 带 thinking 字段就 400，剥掉就 200。
    //
    // ★ 模型名故意用 deepseek-v4-pro：让 vendor 判定走"模型名兜底"变成
    //   deepseek（真实场景 —— 用户在 AMD 网关上跑 DeepSeek 模型，或中转站
    //   包着 DeepSeek）。这才能测到**降级路径**：第一次带 thinking 被 400，
    //   剥掉后重试成功。若是普通模型名，app-01-core 的修复已经不发 thinking
    //   （那也是一条已验证的正确路径 —— 场景 A 的第一次请求断言就是它）。
    {
        const captured = [];
        const amd = makeDeps(null, captured);
        amd.buildThinkingParams = realBuildThinkingParams;
        amd.requestChatJson = async (endpoint, body) => {
            captured.push({ endpoint, body });
            if ('thinking' in body) {
                const payload = {
                    error: {
                        message: '"thinking" is not supported on /v1/chat/completions and was not applied. Use "reasoning_effort".',
                        type: 'invalid_request_error', param: 'thinking', code: 'unsupported_parameter',
                    },
                };
                return { ok: false, status: 400, payload, rawText: JSON.stringify(payload) };
            }
            return { ok: true, status: 200, payload: { choices: [{ message: { content: 'AMD_OK' } }] } };
        };
        window.ChatDeps = amd;
        const r = await ChatProviders.callOpenAICompatibleChat([{ role: 'user', content: 'hi' }], opts,
            { ...settings, model: 'deepseek-v4-pro' });
        ok(r.content === 'AMD_OK', '★ AMD 网关 + DeepSeek 模型：400 后自动剥 thinking 重试成功', JSON.stringify(r));
        ok(captured.length === 2, '恰好发了两次（首次 + 降级重试）', String(captured.length));
        ok('thinking' in captured[0].body, '★ 第一次仍带 thinking（DeepSeek 模型的正常行为）');
        ok(!('thinking' in captured[1].body), '★ 第二次剥掉了 thinking', JSON.stringify(captured[1].body));
        ok(captured[1].body.max_tokens === 100 && Array.isArray(captured[1].body.messages),
            '重试请求其余字段原样保留（messages/max_tokens 不丢）');
    }

    // 场景 A2：AMD 网关 + 普通模型（vendor=generic）—— 现在也带 thinking 字段
    // （设计定稿：一律发，兼容靠 400 降级），但会通过 AMD 的 400 触发降级后成功。
    {
        const captured = [];
        const amd = makeDeps(null, captured);
        amd.buildThinkingParams = realBuildThinkingParams;
        amd.requestChatJson = async (endpoint, body) => {
            captured.push({ endpoint, body });
            if ('thinking' in body) {
                return { ok: false, status: 400, payload: { error: { message: 'thinking not supported', param: 'thinking' } }, rawText: 'x' };
            }
            return { ok: true, status: 200, payload: { choices: [{ message: { content: 'GENERIC_OK' } }] } };
        };
        window.ChatDeps = amd;
        const r = await ChatProviders.callOpenAICompatibleChat([{ role: 'user', content: 'hi' }], opts, settings);
        ok(r.content === 'GENERIC_OK', '★ 普通模型 + AMD 网关：降级后成功');
        ok(captured.length === 2, '首次带 thinking 被 400，重试剥掉后通过', String(captured.length));
        ok('thinking' in captured[0].body && !('thinking' in captured[1].body),
            '★ 关思考请求第一次也带显式 disabled（DeepSeek 系网关需要它）',
            JSON.stringify(captured[0]?.body.thinking));
    }

    // 场景 B：DeepSeek 官方 —— 第一次就成功，thinking 字段照发（关闭态必须 disabled）
    {
        const captured = [];
        const ds = makeDeps(null, captured);
        ds.buildThinkingParams = realBuildThinkingParams;
        ds.requestChatJson = async (endpoint, body) => {
            captured.push({ endpoint, body });
            return { ok: true, status: 200, payload: { choices: [{ message: { content: 'DS_OK' } }] } };
        };
        window.ChatDeps = ds;
        const r = await ChatProviders.callOpenAICompatibleChat(
            [{ role: 'user', content: 'hi' }], opts,
            { apiKey: 'k', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' });
        ok(r.content === 'DS_OK', 'DeepSeek 官方：一次成功');
        ok(captured.length === 1, '没有多余重试', String(captured.length));
        ok(captured[0].body.thinking?.type === 'disabled',
            '★ 关思考时仍显式发 thinking.disabled（DeepSeek 默认开启，不发关不掉）',
            JSON.stringify(captured[0].body.thinking));
    }

    // 场景 C：其它 400（剥参数解决不了）→ 不重试，直接抛
    {
        const captured = [];
        const img = makeDeps(null, captured);
        img.buildThinkingParams = realBuildThinkingParams;
        img.requestChatJson = async (endpoint, body) => {
            captured.push({ endpoint, body });
            const payload = { error: { message: 'image too large', type: 'invalid_request_error', param: 'image' } };
            return { ok: false, status: 400, payload, rawText: 'image too large' };
        };
        window.ChatDeps = img;
        let threw = null;
        try {
            await ChatProviders.callOpenAICompatibleChat([{ role: 'user', content: 'hi' }], opts, settings);
        } catch (e) { threw = e; }
        ok(Boolean(threw), '★ 非 thinking 类 400 照常抛错', threw && threw.message);
        ok(captured.length === 1, '★ 不做无意义的重试（剥图片参数解决不了问题）', String(captured.length));
    }

// ---------- 源码层：warn 一行是英文事实行 ----------
console.log('\n=== 3. 降级时有日志痕迹 ===');
{
    ok(/\[Provider\] gateway rejected "\$\{param\}"/.test(src),
        '★ 降级重试留一行英文 warn（可 grep）');
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('失败项见上');
process.exit(fail ? 1 : 0);
