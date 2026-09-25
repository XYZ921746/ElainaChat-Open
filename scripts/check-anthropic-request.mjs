/**
 * 回归检查：对话请求的形状（Anthropic 格式为主，外加跨格式的 max_tokens 下限）。
 *
 * 背景（真实故障一）：用户切到 Anthropic 格式后必然 400 ——
 *   400 "max_tokens must be greater than 1024 for manual Claude thinking"
 * 原因不在我们这侧的参数，而在**中转站会按模型名后缀替我们决定要不要开 thinking**：
 * 只要模型名以 `-thinking` 结尾（或含 `-thinking-<数字>`），new-api 就会开 manual thinking，
 * 而 manual thinking 要求 `1024 <= budget_tokens < max_tokens`，于是 max_tokens <= 1024 的请求被拒。
 * 我们当时发的是 900（ROLEPLAY_OUTPUT_TOKEN_LIMITS.text），所以必然失败；
 * 「测试对话连接」按钮发的是 8，同样失败。
 *
 * 背景（真实故障二的隐患）：这条约束**跨协议**。new-api 的 `ApplyReasoning()` 里，
 * OpenAI → Claude 的转换（crossProtocol）一定走 `RenderClaude`，
 * 所以用 OpenAI 兼容格式调一个 `…-thinking` 的模型名会踩同一个坑。
 * 因此下限判据被提到 `callChatAPI`，三种格式共用 —— 本检查直接驱动 `callChatAPI` 验证这一点。
 *
 * 做法：把 index.html 里的真实函数体抠出来，只把网络出口（postJsonFromDevice）换成假的，
 * 检查**真正会发出去的 body**。不联网、不复制逻辑。
 *
 * 2026-09 更新：三种协议的实现已拆到 `web/js/chat-providers.js`（表驱动分发）。
 * 本检查相应改成**直接加载那个真模块**，而不是继续从 HTML 里正则抠 ——
 * 抠函数那种做法本来就脆（改个格式就断），拆出去后正好改成"测线上真正跑的那份"。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readFrontend } from './frontend-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFrontend();

/** 按函数名抠出完整函数声明；`async` 前缀必须一起带上，否则里面的 await 会语法错误 */
function extractFn(name) {
    let start = html.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('在 web/index.html 里找不到函数: ' + name + '（重命名了？请同步更新本检查）');
    const asyncMatch = html.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (asyncMatch) start -= asyncMatch[0].length;
    // **先跳过参数表**：`opts = {}` 这种默认值里就有大括号，
    // 直接找第一个 `{` 会把它当成函数体开头 —— 抠出来是半截函数，报错还是莫名其妙的语法错误。
    let i = html.indexOf('(', start);
    let paren = 0;
    for (; i < html.length; i++) {
        if (html[i] === '(') paren++;
        else if (html[i] === ')') { paren--; if (paren === 0) { i++; break; } }
    }
    let depth = 0;
    i = html.indexOf('{', i);
    for (; i < html.length; i++) {
        const c = html[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return html.slice(start, i);
}

/** 抠一个 class 声明（大括号配平） */
function extractClass(name) {
    const start = html.indexOf('class ' + name + ' ');
    if (start < 0) throw new Error('在 web/index.html 里找不到类: ' + name + '（重命名了？请同步更新本检查）');
    let depth = 0;
    let i = html.indexOf('{', start);
    for (; i < html.length; i++) {
        const c = html[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return html.slice(start, i);
}

/** 抠一个数字常量（形如 `const NAME = 4096;`） */
function extractNumberConst(name) {
    const m = new RegExp('const\\s+' + name + '\\s*=\\s*([0-9_]+)\\s*;').exec(html);
    if (!m) throw new Error('在 web/index.html 里找不到常量: ' + name + '（重命名了？请同步更新本检查）');
    return Number(m[1].replace(/_/g, ''));
}

const ctx = new Function('window', `
    const calls = [];
    const normalizeCalls = [];
    let nextPayload = { content: [{ type: 'text', text: '好的' }] };
    function setPayload(p) { nextPayload = p; }
    // 唯一的假实现：网络出口。其余全部来自 index.html 的真实代码。
    // 按端点回不同形状的成功响应 —— 三种格式的成功响应结构不一样，混用会让解析器抛 EMPTY_MODEL_OUTPUT。
    async function postJsonFromDevice(url, body, headers) {
        calls.push({ url, body, headers });
        if (/\\/chat\\/completions$/.test(url)) return { ok: true, payload: { choices: [{ message: { content: '好的' } }] } };
        if (/\\/responses$/.test(url)) return { ok: true, payload: { output_text: '好的' } };
        return { ok: true, payload: nextPayload };
    }
    async function throwProviderResponseError() { throw new Error('不该走到这里'); }
    const state = { settings: {} };
    ${extractFn('stripThinkTags')}
    ${extractFn('extractTextContent')}
    ${extractFn('normalizeChatReply').replace('function normalizeChatReply(', 'function realNormalizeChatReply(')}
    // 包一层记录入参：真实的 normalizeChatReply 只返回正文，看不到 reasoning 有没有被认出来
    function normalizeChatReply(content, reasoningContent = '') {
        normalizeCalls.push({ content, reasoningContent });
        return realNormalizeChatReply(content, reasoningContent);
    }
    // anthropicContentBlocks / convertOpenAIToAnthropicMessages / convertOpenAIToResponsesInput
    // 已随三个协议实现一起迁到 web/js/chat-providers.js（本文件下面会直接加载那个真模块），
    // 所以这里不再从 index.html 抠。
    const ANTHROPIC_MIN_MAX_TOKENS = ${extractNumberConst('ANTHROPIC_MIN_MAX_TOKENS')};
    ${extractFn('thinkingSuffixTokenFloor')}
    ${extractFn('resolveOutputTokenLimit')}
    ${extractFn('getChatBaseUrl')}
    ${extractFn('isDeepSeekOfficial')}
    // 思考开关/强度 → 各协议请求字段。这是真实实现，不是假的：
    // 本检查要断言"关思考时到底发了什么"，那必须是被测代码自己算出来的。
    ${extractFn('mapThinkingEffort')}
    ${extractFn('detectThinkingVendor')}
    ${extractFn('buildThinkingParams')}
    const THINKING_EFFORTS = Object.freeze(['low', 'medium', 'high']);
    // CHAT_API_FORMATS 只是格式白名单表，这里按真实定义给一份骨架（**新增格式时要同步**）
    const CHAT_API_FORMATS = Object.freeze({ 'openai-compatible': {}, 'openai-responses': {}, anthropic: {} });
    ${extractFn('getChatApiFormat')}
    ${extractFn('mergeLeadingSystemMessages')}
    ${extractFn('callChatAPI')}
    ${extractClass('ClientApiError')}
    // 本检查只关心"提示怎么展示"，不验证错误归一化 —— 直接透传即可
    function toClientApiError(error) { return error; }
    ${extractFn('getClientErrorPresentation')}
    return {
        callChatAPI, calls, setPayload, normalizeCalls, getClientErrorPresentation, ClientApiError,
        getChatBaseUrl, isDeepSeekOfficial, normalizeChatReply, postJsonFromDevice,
        throwProviderResponseError, extractTextContent, stripThinkTags, resolveOutputTokenLimit,
        ANTHROPIC_MIN_MAX_TOKENS, buildThinkingParams,
        last: () => calls[calls.length - 1],
        lastNormalize: () => normalizeCalls[normalizeCalls.length - 1],
    };
`);

// ===== 让真实模块跑起来：三种协议的实现已拆到 web/js/chat-providers.js =====
//
// 原来是把这个文件里的三个实现 + 两个转换器也一起抠出来执行。现在它们搬走了，
// 继续抠会抠不到 —— 而**这正是拆分想要的结果**：不再"从 HTML 里正则抠函数"，
// 而是直接加载真模块，测的就是线上真正跑的那份代码。
//
// 做法：
//   ① 先建一个空的 fakeWindow 对象
//   ② 用 new Function('window', ...) 跑 index.html 里抠出来的真实代码，拿到真实依赖
//   ③ 把依赖挂进 fakeWindow.ChatDeps
//   ④ 在 vm 里执行 chat-providers.js（它从 window.ChatDeps 取依赖）
//   ⑤ 把 ChatProviders 挂回 fakeWindow，让 callChatAPI 里的 window.ChatProviders 能用
const fakeWindow = {};
const raw = ctx(fakeWindow);

const providersSrc = readFileSync(path.join(ROOT, 'web', 'js', 'chat-providers.js'), 'utf8');
fakeWindow.ChatDeps = {
    ClientApiError: raw.ClientApiError,
    getChatBaseUrl: raw.getChatBaseUrl,
    isDeepSeekOfficial: raw.isDeepSeekOfficial,
    normalizeChatReply: raw.normalizeChatReply,
    postJsonFromDevice: raw.postJsonFromDevice,
    // providers 现在走 requestChatJson 而不是直接 postJsonFromDevice。
    // 本检查只验证"发出去的请求体形状"，不验证流式 —— 所以这里让 requestChatJson
    // 直接转发到那个假的 postJsonFromDevice，保持"只有网络出口是假的"这个性质。
    requestChatJson: async (endpoint, body, headers, opts) =>
        await raw.postJsonFromDevice(endpoint, body, headers, opts?.timeoutMs, opts?.signal),
    buildThinkingParams: raw.buildThinkingParams,
    throwProviderResponseError: raw.throwProviderResponseError,
    extractTextContent: raw.extractTextContent,
    stripThinkTags: raw.stripThinkTags,
    resolveOutputTokenLimit: raw.resolveOutputTokenLimit,
    ANTHROPIC_MIN_MAX_TOKENS: raw.ANTHROPIC_MIN_MAX_TOKENS,
};
{
    const sandbox = vm.createContext({
        window: fakeWindow, console, Error, Object, Array, Number, String, Math, RegExp, JSON,
    });
    vm.runInContext(providersSrc, sandbox);
}
if (!fakeWindow.ChatProviders) {
    console.error('chat-providers.js 没能挂上 window.ChatProviders —— 本检查无法继续');
    process.exit(1);
}

const { calls, setPayload, last, lastNormalize, getClientErrorPresentation, ClientApiError } = raw;
const callChatAPI = raw.callChatAPI;
// 三个实现直接从**真实模块**取（不再从 HTML 抠）
const { callAnthropicChat, callOpenAICompatibleChat, callOpenAIResponsesChat } = fakeWindow.ChatProviders;

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    const ok = a === b;
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
    if (!ok) console.log(`        got  = ${a}\n        want = ${b}`);
}
function atLeast(label, actual, floor) {
    const ok = Number(actual) >= floor;
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
    if (!ok) console.log(`        got  = ${actual}，需要 >= ${floor}`);
}
/** 该键应当**不存在**（不发这个字段 = 用服务商默认值） */
function absent(label, body, key) {
    const ok = !(key in body);
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
    if (!ok) console.log(`        got  = ${JSON.stringify(body[key])}，不该存在`);
}

const S = (c) => ({ role: 'system', content: c });
const U = (c) => ({ role: 'user', content: c });
const A = (c) => ({ role: 'assistant', content: c });
const msgs = [S('你是伊蕾娜。'), S('# 世界观\n魔法世界'), U('你好'), A('你好呀'), U('只回复OK')];

/** 走真实的 callChatAPI（下限判据就在那一层），返回真正发出去的那次请求 */
async function send(opts, settings = {}, format = 'anthropic') {
    await callChatAPI(msgs, opts, {
        apiKey: 'test-key', model: 'claude-sonnet-4-5', baseUrl: 'https://newapi.example.com',
        apiFormat: format, ...settings,
    });
    return last();
}

// ---------- 一、Anthropic 格式：下限是**无条件**的 ----------
// 阈值来自中转站的报错文案：max_tokens must be **greater than** 1024
console.log('\n— Anthropic 格式的 max_tokens 下限（无条件）—');
const main = await send({ maxTokens: 900 });           // 角色扮演主对话
atLeast('主对话（900）发出的 max_tokens > 1024', main.body.max_tokens, 1025);
const test8 = await send({ maxTokens: 8 });            // 「测试对话连接」按钮
atLeast('测试连接（8）发出的 max_tokens > 1024', test8.body.max_tokens, 1025);
const noOpt = await send({});
atLeast('不传 maxTokens 时 > 1024', noOpt.body.max_tokens, 1025);
const big = await send({ maxTokens: 32000 });
check('传了更大的值时不被压低', big.body.max_tokens, 32000);

// thinking 的预算和正文吃同一个额度：只满足 1025 的话正文一个 token 都不剩
const thinkingSuffix = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-thinking' });
atLeast('带 -thinking 后缀时给正文留出空间（>= 2048）', thinkingSuffix.body.max_tokens, 2048);
const budgetSuffix = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-thinking-3000' });
atLeast('-thinking-3000 时 max_tokens 必须大于该预算', budgetSuffix.body.max_tokens, 3001);
const bigBudget = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-thinking-8000' });
atLeast('-thinking-8000 时 max_tokens 必须大于该预算', bigBudget.body.max_tokens, 8001);

// ---------- 二、同一个坑跨格式：OpenAI 系只在模型名带后缀时才抬 ----------
// 约束在 new-api 侧是跨协议的（OpenAI → Claude 也走 RenderClaude），
// 所以判据必须提到 callChatAPI —— 否则用户换成 OpenAI 格式照样 400。
console.log('\n— 跨格式：模型名带 -thinking 后缀时同样保底 —');
const oaiThinking = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-thinking' }, 'openai-compatible');
atLeast('openai-compatible + -thinking → max_tokens > 1024', oaiThinking.body.max_tokens, 1025);
check('  并且模型名原样传给上游（判据只读名字，不改名字）', oaiThinking.body.model, 'claude-sonnet-4-5-thinking');
const oaiBudget = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-thinking-3000' }, 'openai-compatible');
atLeast('openai-compatible + -thinking-3000 → 大于该预算', oaiBudget.body.max_tokens, 3001);
const oaiNoMax = await send({}, { model: 'claude-sonnet-4-5-thinking' }, 'openai-compatible');
atLeast('openai-compatible + -thinking + 不传 maxTokens → 也补上下限', oaiNoMax.body.max_tokens, 1025);
const respThinking = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-thinking' }, 'openai-responses');
atLeast('openai-responses + -thinking → max_output_tokens > 1024', respThinking.body.max_output_tokens, 1025);

// 反过来更要紧：普通模型名**不能**被无故抬高 —— 那会把用户的输出预算悄悄改大
console.log('\n— 反向：普通模型名不许被动 —');
const oaiPlain = await send({ maxTokens: 900 }, {}, 'openai-compatible');
check('openai-compatible + 普通模型名 → 原样 900', oaiPlain.body.max_tokens, 900);
const oaiPlainNone = await send({}, {}, 'openai-compatible');
absent('openai-compatible + 普通模型名 + 不传 → 不发 max_tokens', oaiPlainNone.body, 'max_tokens');
const respPlain = await send({ maxTokens: 900 }, {}, 'openai-responses');
check('openai-responses + 普通模型名 → 原样 900', respPlain.body.max_output_tokens, 900);
const respPlainNone = await send({}, {}, 'openai-responses');
absent('openai-responses + 普通模型名 + 不传 → 不发 max_output_tokens', respPlainNone.body, 'max_output_tokens');

// `-nothinking` 是**显式关闭**思考，判据不能把它当 `-thinking` 命中
const nothinking = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-nothinking' }, 'openai-compatible');
check('-nothinking 不触发下限（它不是 -thinking）', nothinking.body.max_tokens, 900);
// 大小写：判据故意放宽（多抬一个上限是无害的），命中时不能漏
const upper = await send({ maxTokens: 900 }, { model: 'claude-sonnet-4-5-THINKING' }, 'openai-compatible');
atLeast('后缀大小写混写也认（宁可多抬，不能漏）', upper.body.max_tokens, 1025);
// DeepSeek 官方的老模型名会映射到当前模型（deepseek-chat 已由 deepseek-flash 承接），
// 但**不能**再换成 deepseek-reasoner —— 那个模型名属于"思考专用模型"时代，
// 现在思考由 thinking 字段控制。这条断言以前写的是"换成 reasoner"，是过时契约。
const ds = await send({ maxTokens: 900, thinking: true },
    { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }, 'openai-compatible');
check('DeepSeek 官方 + 老模型名 → 映射到当前模型', ds.body.model, 'deepseek-flash');
check('  且 max_tokens 不被抬（模型名没有 -thinking 后缀）', ds.body.max_tokens, 900);

// ---------- 二之二、思考开关与强度（本次适配的核心） ----------
//
// 背景：DeepSeek 现在的接口**默认开启思考**（官方《思考模式》文档：thinking mode
// is enabled by default, effort 默认 high）。这意味着"关掉开关"必须**显式**发
// disabled —— 不发字段不等于关，用户会白等几十秒、白花思考 token，
// 而界面上什么都看不到。这条是本次最容易漏、后果最隐蔽的一条。
console.log('\n— 思考开关与强度 —');
const dsOff = await send({ thinking: false }, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'openai-compatible');
check('DeepSeek 关思考 → 显式发 disabled（默认是开的，不发等于没关）',
    dsOff.body.thinking, { type: 'disabled' });
const dsOn = await send({ thinking: true }, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'openai-compatible');
check('DeepSeek 开思考 → 发 enabled', dsOn.body.thinking, { type: 'enabled' });
check('  medium 档不显式发 effort（用服务商默认）', 'reasoning_effort' in dsOn.body, false);
const dsLow = await send({ thinking: true, thinkingEffort: 'low' },
    { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'openai-compatible');
check('DeepSeek 低强度 → reasoning_effort: low', dsLow.body.reasoning_effort, 'low');
const dsHigh = await send({ thinking: true, thinkingEffort: 'high' },
    { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'openai-compatible');
check('DeepSeek 高强度 → reasoning_effort: high', dsHigh.body.reasoning_effort, 'high');

// Anthropic：用 reasoning.effort，**不能**用 thinking 字段
// （那个字段在 Claude 官方是 {type, budget_tokens}，同名不同义，发错会 400）
const anOff = await send({ thinking: false }, { baseUrl: 'https://api.anthropic.com' }, 'anthropic');
check('Anthropic 关思考 → reasoning.effort: none', anOff.body.reasoning, { effort: 'none' });
check('  ★ 且不发 thinking 字段（那是 Claude 官方 extended thinking，同名不同义）',
    'thinking' in anOff.body, false);
const anOn = await send({ thinking: true, thinkingEffort: 'low' }, { baseUrl: 'https://api.anthropic.com' }, 'anthropic');
check('Anthropic 开思考 → reasoning.effort 是档位名', anOn.body.reasoning, { effort: 'low' });
check('  低/高强度时补 output_config.effort', anOn.body.output_config, { effort: 'low' });

// ★ 开了思考就不能带 temperature：Anthropic 官方禁止（会 400）
const anTemp = await send({ thinking: true, temperature: 0.7 }, { baseUrl: 'https://api.anthropic.com' }, 'anthropic');
check('★ Anthropic 开思考时不带 temperature（带了会 400）', 'temperature' in anTemp.body, false);
const anTempOff = await send({ thinking: false, temperature: 0.7 }, { baseUrl: 'https://api.anthropic.com' }, 'anthropic');
check('  关思考时 temperature 照常带上', anTempOff.body.temperature, 0.7);

// Responses：只有 reasoning.effort，没有"关闭"取值
const rpOn = await send({ thinking: true, thinkingEffort: 'high' }, { baseUrl: 'https://api.openai.com/v1' }, 'openai-responses');
check('Responses 开思考 → reasoning.effort', rpOn.body.reasoning, { effort: 'high' });
const rpOff = await send({ thinking: false }, { baseUrl: 'https://api.openai.com/v1' }, 'openai-responses');
check('Responses 关思考 → 不发 reasoning（它没有 none 取值）', 'reasoning' in rpOff.body, false);

// ---------- 三、端点拼接 ----------
console.log('\n— 端点 —');
check('裸域名 → /v1/messages',
    (await send({}, { baseUrl: 'https://newapi.example.com' })).url,
    'https://newapi.example.com/v1/messages');
check('带 /v1 → 不重复拼',
    (await send({}, { baseUrl: 'https://newapi.example.com/v1' })).url,
    'https://newapi.example.com/v1/messages');
check('已经指向 /messages → 原样用',
    (await send({}, { baseUrl: 'https://newapi.example.com/v1/messages' })).url,
    'https://newapi.example.com/v1/messages');
check('结尾多余的斜杠被吃掉',
    (await send({}, { baseUrl: 'https://newapi.example.com/v1/' })).url,
    'https://newapi.example.com/v1/messages');
check('官方地址 → api.anthropic.com/v1/messages',
    (await send({}, { baseUrl: 'https://api.anthropic.com' })).url,
    'https://api.anthropic.com/v1/messages');
check('openai-compatible → /chat/completions',
    (await send({}, { baseUrl: 'https://newapi.example.com/v1' }, 'openai-compatible')).url,
    'https://newapi.example.com/v1/chat/completions');
check('openai-responses → /responses',
    (await send({}, { baseUrl: 'https://api.openai.com/v1' }, 'openai-responses')).url,
    'https://api.openai.com/v1/responses');

// ---------- 四、请求头 ----------
console.log('\n— 请求头 —');
check('Anthropic 用 x-api-key（不是 Authorization）', main.headers['x-api-key'], 'test-key');
check('Anthropic 带 anthropic-version', main.headers['anthropic-version'], '2023-06-01');
check('Anthropic 没混进 Authorization', Object.keys(main.headers).some((k) => /^authorization$/i.test(k)), false);
check('OpenAI 系用 Bearer', oaiPlain.headers.Authorization, 'Bearer test-key');

// ---------- 五、请求体形状 ----------
console.log('\n— 请求体 —');
check('system 提到顶层，且拼成一条', main.body.system, '你是伊蕾娜。\n\n# 世界观\n魔法世界');
check('messages 里不再有 system', main.body.messages.some((m) => m.role === 'system'), false);
check('messages 只有 user/assistant', main.body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
check('不带 thinking 字段（Anthropic 用 reasoning.effort，不是 Claude 的 thinking）', 'thinking' in main.body, false);
check('模型名原样传给上游', main.body.model, 'claude-sonnet-4-5');
check('带 -thinking 后缀时模型名原样传（由中转站解析）', thinkingSuffix.body.model, 'claude-sonnet-4-5-thinking');
check('没传 temperature 时不带上这个键', 'temperature' in main.body, false);
check('传了 temperature 时带上', (await send({ temperature: 0.7 })).body.temperature, 0.7);
// OpenAI 系两种格式也吃到同一份「开头连续 system 合并」（在 callChatAPI 里做的）
check('openai-compatible 的 system 也合并成一条',
    oaiPlain.body.messages.filter((m) => m.role === 'system').length, 1);
check('openai-responses 的 system 走 instructions',
    respPlain.body.instructions, '你是伊蕾娜。\n\n# 世界观\n魔法世界');

// ---------- 六、响应解析 ----------
// 中转站按模型名后缀开的 thinking 会把思考内容以 thinking block 返回，
// 正文在 text block 里 —— 混在一起会把思考过程当回复显示给用户。
console.log('\n— 响应解析 —');
const settings = { apiKey: 'test-key', model: 'claude-sonnet-4-5', baseUrl: 'https://newapi.example.com' };
setPayload({ content: [
    { type: 'thinking', thinking: '嗯……她在问天气。' },
    { type: 'text', text: '今天阳光很好呢。' },
] });
check('thinking block 归到 reasoning 而不是正文',
    (await callAnthropicChat(msgs, {}, settings), lastNormalize().reasoningContent),
    '嗯……她在问天气。');

setPayload({ content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] });
check('多个 text block 按顺序拼接', await callAnthropicChat(msgs, {}, settings), '第一段第二段');

setPayload({ content: [{ type: 'thinking', thinking: '想了很久' }] });
let thinkOnlyErr = null;
try { await callAnthropicChat(msgs, {}, settings); } catch (e) { thinkOnlyErr = e.code; }
check('只返回思考内容时抛 EMPTY_MODEL_OUTPUT（不给用户看空回复）', thinkOnlyErr, 'EMPTY_MODEL_OUTPUT');

setPayload({ content: [] });
let emptyErr = null;
try { await callAnthropicChat(msgs, {}, settings); } catch (e) { emptyErr = e.code; }
check('没有正文时抛 EMPTY_MODEL_OUTPUT', emptyErr, 'EMPTY_MODEL_OUTPUT');
setPayload({ content: [{ type: 'text', text: '好的' }] });

// ---------- 七、缺 Key 时的提示 ----------
console.log('\n— 错误路径 —');
let missingKey = null;
try { await callAnthropicChat(msgs, {}, { apiKey: '', model: 'claude-sonnet-4-5', baseUrl: 'https://x.com' }); }
catch (e) { missingKey = e.code; }
check('没填 Key 时给出 APP_KEY_MISSING', missingKey, 'APP_KEY_MISSING');
let oaiMissingKey = null;
try { await send({}, { apiKey: '' }, 'openai-compatible'); } catch (e) { oaiMissingKey = e.code; }
check('OpenAI 格式没填 Key 时也报 APP_KEY_MISSING', oaiMissingKey, 'APP_KEY_MISSING');

// ---------- 八、400 的提示要说清 -thinking 后缀 ----------
// 用户没开过思考，光看到 "manual Claude thinking" 只会更迷惑 —— 提示必须点破模型名后缀。
console.log('\n— 400 提示 —');
const present = (message, imageHint) =>
    getClientErrorPresentation(new ClientApiError('BAD_REQUEST', message, { imageHint })).message;
const thinking400 = present('max_tokens must be greater than 1024 for manual Claude thinking (request id: abc)');
check('max_tokens + thinking 的报错 → 点明 -thinking 后缀', /-thinking/.test(thinking400), true);
check('并给出可操作的下一步（去掉后缀）', /去掉/.test(thinking400), true);
check('不再混进图片那套说辞', /图片转述/.test(thinking400), false);

// 关键回归：这条提示必须**只**在真的相关时出现 —— 项目里有过"提示被写成无条件"的先例
const plain400 = present('System message must be at the beginning.');
check('普通 400 不提 -thinking', /-thinking/.test(plain400), false);
check('普通 400 不提图片转述', /图片转述/.test(plain400), false);
check('普通 400 走通用提示', /常见原因/.test(plain400), true);
const onlyMaxTokens = present('max_tokens is too large');
check('只提 max_tokens、不提 thinking 时不误判', /-thinking/.test(onlyMaxTokens), false);
check('真的带了图片时仍然提图片转述', /图片转述/.test(present('bad request', true)), true);
check('服务商的话本身在说图片时也提图片转述', /图片转述/.test(present('image too large')), true);

console.log(`\n对话请求形状检查：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
