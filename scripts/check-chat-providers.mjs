// 回归检查：对话 API 格式适配器（web/js/chat-providers.js）。
//
// 为什么需要：这三个函数是**对话功能的全部出口** —— 搬错一处，AI 就完全无法回复。
// 而且它用「依赖注入」的方式从 index.html 取依赖（window.ChatDeps），
// **漏挂一个依赖的表现是运行到那一步才报 "xxx is not a function"**，
// 静态看源码看不出来。所以这个检查专门盯住"依赖有没有挂全"。
//
// 覆盖：
//   1. 从 chat-providers.js 源码里扫出所有 deps() 解构出的名字，逐个断言在 ChatDeps 里
//   2. 三种格式都有实现（分发表完整），且未知格式有兜底
//   3. 三个函数签名一致（(messages, opts, settings)）
//   4. 用**假依赖**真的跑一遍三个函数，断言请求体/端点的形状正确
//   5. index.html 确实引用了本文件、且挂了 ChatDeps
//
// 用法：node scripts/check-chat-providers.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS_FILE = path.join(ROOT, 'web', 'js', 'chat-providers.js');
const HTML_FILE = path.join(ROOT, 'web', 'index.html');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label, detail) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

const src = readFileSync(PROVIDERS_FILE, 'utf8');
// ChatDeps 挂载与 CHAT_API_FORMATS 都随主脚本拆到了 web/js/app-*.js 里
const html = readFrontend();

// ============================================================ 1. 依赖清单
console.log('=== 1. 依赖注入是否挂全 ===');

// 扫出所有 `const { a, b, c } = deps();` 里的名字
const needed = new Set();
for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*deps\(\)/g)) {
    for (const raw of m[1].split(',')) {
        const name = raw.trim().split(':').pop().trim();   // 兼容 { a: b } 写法
        if (name) needed.add(name);
    }
}
console.log('  chat-providers.js 需要 ' + needed.size + ' 个依赖:');
console.log('    ' + [...needed].sort().join(', '));

// 从 index.html 里找 window.ChatDeps = { ... } 的键
const depsBlock = html.match(/window\.ChatDeps\s*=\s*\{([\s\S]*?)\n\s*\};/);
ok(Boolean(depsBlock), 'index.html 里有 window.ChatDeps 挂载');
const provided = new Set();
if (depsBlock) {
    for (const raw of depsBlock[1].split(/[,\n]/)) {
        const name = raw.replace(/\/\/.*$/, '').trim().split(':')[0].trim();
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) provided.add(name);
    }
}
console.log('  index.html 提供了 ' + provided.size + ' 个:');
console.log('    ' + [...provided].sort().join(', '));

const missing = [...needed].filter((n) => !provided.has(n));
ok(missing.length === 0, '所有需要的依赖都已挂载', missing.length ? '缺: ' + missing.join(', ') : '');

// 反向：挂了一堆没用到的也算噪音（不失败，只提示）
const unused = [...provided].filter((n) => !needed.has(n));
if (unused.length) console.log('  提示：挂载了但没用到 → ' + unused.join(', '));

// ============================================================ 2. 分发表
console.log('\n=== 2. 分发表完整性 ===');
const KNOWN_FORMATS = ['openai-compatible', 'anthropic', 'openai-responses'];
for (const f of KNOWN_FORMATS) {
    ok(new RegExp(`'${f}'\\s*:`).test(src), `分发表含 ${f}`);
}
ok(/forFormat\s*\(/.test(src), '提供 forFormat() 分发方法');
ok(/PROVIDERS\[format\]\s*\|\|\s*PROVIDERS\[/.test(src) || /PROVIDERS\[DEFAULT_FORMAT\]/.test(src),
    '未知格式有兜底（不抛错，与原 if 链一致）');

// 与 index.html 的格式表对拍：CHAT_API_FORMATS 里的每个格式都必须有实现
const formatsBlock = html.match(/const CHAT_API_FORMATS = Object\.freeze\(\{([\s\S]*?)\n\s*\}\);/);
if (formatsBlock) {
    const declared = [...formatsBlock[1].matchAll(/^\s*'?([a-z-]+)'?\s*:\s*\{/gm)].map((m) => m[1]);
    console.log('  CHAT_API_FORMATS 声明: ' + declared.join(', '));
    for (const d of declared) {
        ok(new RegExp(`'${d}'\\s*:`).test(src), `声明了的格式 ${d} 有实现`);
    }
} else {
    ok(false, '能读到 CHAT_API_FORMATS');
}

// ============================================================ 3. 签名一致
console.log('\n=== 3. 函数签名 ===');
for (const fn of ['callOpenAICompatibleChat', 'callAnthropicChat', 'callOpenAIResponsesChat']) {
    const m = src.match(new RegExp(`async function ${fn}\\(([^)]*)\\)`));
    ok(Boolean(m), `${fn} 存在`);
    if (m) {
        const params = m[1].split(',').map((s) => s.trim());
        ok(params.join(',') === 'messages,opts,settings', `${fn} 签名是 (messages, opts, settings)`, m[1]);
    }
}

// ============================================================ 4. 真跑一遍（假依赖）
console.log('\n=== 4. 用假依赖实跑三个格式 ===');

// 真实的「思考参数构造器」：从 index.html 抠出来，供假依赖使用。
// 为什么要抠真的而不是写个假的：本检查要断言"关思考时请求体里到底有没有 disabled"，
// 那是被测代码算出来的东西，用假实现就等于自己测自己。
function extractFnForThinking(name) {
    const start = html.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('在 index.html 里找不到函数: ' + name + '（重命名了？请同步更新本检查）');
    let i = html.indexOf('(', start);
    let paren = 0;
    for (; i < html.length; i++) {
        if (html[i] === '(') paren++;
        else if (html[i] === ')') { paren--; if (paren === 0) { i++; break; } }
    }
    let depth = 0;
    i = html.indexOf('{', i);
    for (; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return html.slice(start, i);
}
const buildThinkingParamsReal = new Function('isDeepSeekOfficial', `
    const THINKING_EFFORTS = Object.freeze(['low', 'medium', 'high']);
    ${extractFnForThinking('mapThinkingEffort')}
    ${extractFnForThinking('detectThinkingVendor')}
    ${extractFnForThinking('buildThinkingParams')}
    return buildThinkingParams;
`)((url) => /api\.deepseek\.com/i.test(url));

/** 造一份可控的假依赖，记录每次请求 */
function makeFakeDeps() {
    const calls = [];
    // 先建容器，让 requestChatJson 能引用同一份假出口（保持"只有网络出口是假的"）
    const depsRef = {};
    Object.assign(depsRef, {
        ClientApiError: class ClientApiError extends Error {
            constructor(code, message) { super(message); this.code = code; this.name = 'ClientApiError'; }
        },
            getChatBaseUrl: (settings) => settings.baseUrl,
            isDeepSeekOfficial: (url) => /api\.deepseek\.com/i.test(url),
            normalizeChatReply: (content, reasoning) => ({ content, reasoning: reasoning || '' }),
            throwProviderResponseError: async (result, fallback) => {
                const err = new Error(fallback + ': ' + (result.rawText || ''));
                err.isProvider = true;
                throw err;
            },
            postJsonFromDevice: async (url, body, headers) => {
                calls.push({ url, body, headers });
                // 按端点返回对应形状的假响应
                if (/\/chat\/completions$/.test(url)) {
                    return { ok: true, status: 200, payload: { choices: [{ message: { content: 'OPENAI_OK', reasoning_content: 'R1' } }] } };
                }
                if (/\/messages$/.test(url)) {
                    return { ok: true, status: 200, payload: { content: [{ type: 'text', text: 'ANTHROPIC_OK' }, { type: 'thinking', thinking: 'R2' }] } };
                }
                if (/\/responses$/.test(url)) {
                    return { ok: true, status: 200, payload: { output: [
                        { type: 'message', content: [{ type: 'output_text', text: 'RESP_OK' }] },
                        { type: 'reasoning', summary: [{ text: 'R3' }] },
                    ] } };
                }
                return { ok: false, status: 404, rawText: 'unknown endpoint' };
            },
            extractTextContent: (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c.map((p) => p?.text || '').join('') : '')),
            stripThinkTags: (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/g, ''),
            resolveOutputTokenLimit: (model, maxTokens) => (Number.isFinite(maxTokens) ? maxTokens : 4096),
            ANTHROPIC_MIN_MAX_TOKENS: 4096,
    });
    return {
        calls,
        deps: {
            ...depsRef,
            // providers 现在走 requestChatJson（它内部才决定流式/非流式）。
            // 本检查验证的是"发出去的请求体"，所以这里转发到同一个假出口。
            requestChatJson: async (endpoint, body, headers, opts) =>
                await depsRef.postJsonFromDevice(endpoint, body, headers, opts?.timeoutMs, opts?.signal),
            // 真实的思考参数构造器（从 index.html 抠出来注入），
            // 否则断言"关思考发了什么"就测不到真东西。
            buildThinkingParams: buildThinkingParamsReal,
        },
    };
}

// 在 Node 里加载这个浏览器脚本：给它一个假的 window
const sandbox = makeFakeDeps();
const vm = await import('node:vm');
const context = vm.createContext({
    window: { ChatDeps: sandbox.deps },
    console,
    Error,
    Object,
    Array,
    Number,
    String,
    Math,
    RegExp,
    JSON,
});
vm.runInContext(src, context);
const CP = context.window.ChatProviders;

ok(Boolean(CP), '脚本能在假环境下加载并挂上 window.ChatProviders');
if (CP) {
    ok(CP.formats().sort().join(',') === KNOWN_FORMATS.slice().sort().join(','), 'formats() 返回三种格式', CP.formats().join(','));
    ok(CP.forFormat('不存在的格式') === CP.PROVIDERS['openai-compatible'], '未知格式兜底到 openai-compatible');

    const msgs = [{ role: 'system', content: 'SYS' }, { role: 'user', content: '你好' }];

    // ---- openai-compatible ----
    {
        sandbox.calls.length = 0;
        const r = await CP.callOpenAICompatibleChat(msgs, { maxTokens: 100 }, { apiKey: 'k', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' });
        const c = sandbox.calls[0];
        ok(c && /\/chat\/completions$/.test(c.url), 'openai: 端点是 /chat/completions', c && c.url);
        ok(c && c.headers.Authorization === 'Bearer k', 'openai: 用 Bearer 认证');
        ok(c && c.body.max_tokens === 100, 'openai: max_tokens 正确', c && String(c.body.max_tokens));
        ok(r.content === 'OPENAI_OK', 'openai: 回复解析正确', r.content);
        ok(r.reasoning === 'R1', 'openai: reasoning 解析正确', r.reasoning);
        // 关思考必须**显式**发 disabled：DeepSeek 现在默认开思考，
        // 不发这个字段用户会白等、白花钱，而界面上什么都看不到。
        const cOff = await (async () => {
            sandbox.calls.length = 0;
            await CP.callOpenAICompatibleChat(msgs, { thinking: false }, { apiKey: 'k', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' });
            return sandbox.calls[0];
        })();
        ok(cOff && cOff.body.thinking && cOff.body.thinking.type === 'disabled',
            'openai: 关思考 → 显式 thinking.type = disabled', cOff && JSON.stringify(cOff.body.thinking));
        // 老模型名映射到当前模型，而不是换成 reasoner
        const cLegacy = await (async () => {
            sandbox.calls.length = 0;
            await CP.callOpenAICompatibleChat(msgs, {}, { apiKey: 'k', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' });
            return sandbox.calls[0];
        })();
        ok(cLegacy && cLegacy.body.model === 'deepseek-flash',
            'openai: 老名字 deepseek-chat → 映射到 deepseek-flash', cLegacy && cLegacy.body.model);
        // 用户明确选了 pro 就不能被降级（那是花他的钱还改他的选择）
        const cPro = await (async () => {
            sandbox.calls.length = 0;
            await CP.callOpenAICompatibleChat(msgs, {}, { apiKey: 'k', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1' });
            return sandbox.calls[0];
        })();
        ok(cPro && cPro.body.model === 'deepseek-v4-pro',
            'openai: 用户选的 deepseek-v4-pro 不被降级', cPro && cPro.body.model);
    }

    // ---- anthropic ----
    {
        sandbox.calls.length = 0;
        const r = await CP.callAnthropicChat(msgs, { maxTokens: 200 }, { apiKey: 'k', model: 'claude-sonnet-4-20250514', baseUrl: 'https://api.anthropic.com' });
        const c = sandbox.calls[0];
        ok(c && /\/v1\/messages$/.test(c.url), 'anthropic: 端点是 /v1/messages', c && c.url);
        ok(c && c.headers['x-api-key'] === 'k', 'anthropic: 用 x-api-key 认证');
        ok(c && c.headers['anthropic-version'] === '2023-06-01', 'anthropic: 带版本头');
        ok(c && c.body.system === 'SYS', 'anthropic: system 提到顶层', c && JSON.stringify(c.body.system));
        ok(c && !c.body.messages.some((m) => m.role === 'system'), 'anthropic: messages 里不再有 system');
        ok(c && c.body.max_tokens === 200, 'anthropic: max_tokens 正确');
        ok(r.content === 'ANTHROPIC_OK', 'anthropic: 回复解析正确', r.content);
        ok(r.reasoning === 'R2', 'anthropic: thinking 块解析正确', r.reasoning);
    }

    // ---- openai-responses ----
    {
        sandbox.calls.length = 0;
        const r = await CP.callOpenAIResponsesChat(msgs, { maxTokens: 300 }, { apiKey: 'k', model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' });
        const c = sandbox.calls[0];
        ok(c && /\/responses$/.test(c.url), 'responses: 端点是 /responses', c && c.url);
        ok(c && c.body.max_output_tokens === 300, 'responses: 用 max_output_tokens（不是 max_tokens）', c && JSON.stringify(Object.keys(c.body)));
        ok(c && !('messages' in c.body), 'responses: 不用 messages 字段');
        ok(c && c.body.instructions === 'SYS', 'responses: system 走顶层 instructions');
        ok(c && Array.isArray(c.body.input), 'responses: 内容走 input 数组');
        ok(r.content === 'RESP_OK', 'responses: 回复解析正确', r.content);
        ok(r.reasoning === 'R3', 'responses: reasoning 解析正确', r.reasoning);
    }

    // ---- 分发 ----
    {
        sandbox.calls.length = 0;
        await CP.forFormat('anthropic')(msgs, {}, { apiKey: 'k', model: 'm', baseUrl: 'https://api.anthropic.com' });
        ok(/\/messages$/.test(sandbox.calls[0].url), 'forFormat(anthropic) 走 anthropic 实现');

        sandbox.calls.length = 0;
        await CP.forFormat('unknown-xyz')(msgs, {}, { apiKey: 'k', model: 'm', baseUrl: 'https://x.com/v1' });
        ok(/\/chat\/completions$/.test(sandbox.calls[0].url), 'forFormat(未知) 兜底到 openai-compatible');
    }

    // ---- 缺 Key 的报错 ----
    {
        let threw = null;
        try { await CP.callOpenAICompatibleChat(msgs, {}, { apiKey: '', model: 'm', baseUrl: 'https://x.com/v1' }); }
        catch (e) { threw = e; }
        ok(threw && threw.code === 'APP_KEY_MISSING', '缺 API Key 时抛 APP_KEY_MISSING', threw && threw.code);
    }

    // ---- 转换器 ----
    {
        const conv = CP.convertOpenAIToAnthropicMessages([
            { role: 'system', content: 'A' },
            { role: 'system', content: 'B' },
            { role: 'user', content: 'u1' },
            { role: 'user', content: 'u2' },
        ]);
        ok(conv.system === 'A\n\nB', 'anthropic 转换: 多条 system 合并', JSON.stringify(conv.system));
        ok(conv.messages.length === 1, 'anthropic 转换: 相邻 user 合并成一条', 'got ' + conv.messages.length);

        const conv2 = CP.convertOpenAIToResponsesInput([
            { role: 'system', content: 'S' },
            { role: 'user', content: 'u' },
            { role: 'assistant', content: 'a' },
        ]);
        ok(conv2.instructions === 'S', 'responses 转换: system → instructions');
        ok(conv2.input[0].content[0].type === 'input_text', 'responses 转换: user 用 input_text');
        ok(conv2.input[1].content[0].type === 'output_text', 'responses 转换: assistant 用 output_text');
    }
}

// ============================================================ 5. index.html 接线
console.log('\n=== 5. index.html 接线 ===');
ok(/<script\s+src="\/js\/chat-providers\.js"><\/script>/.test(html), 'index.html 引用了 chat-providers.js');

// 加载顺序：必须在主脚本（最后一个内联 script）之前
const refIdx = html.indexOf('/js/chat-providers.js');
const lastInline = html.lastIndexOf('<script>');
ok(refIdx > 0 && refIdx < lastInline, '引用位置在主脚本之前');

ok(/window\.ChatProviders\.forFormat\(/.test(html), 'callChatAPI 用了 forFormat 分发');

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：' + failures.join('、'));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
