/**
 * 回归检查：获取模型列表（`GET <base>/models`）。
 *
 * 背景（真实问题）：界面上一直写着「Anthropic 格式下获取模型不可用」，理由是
 * "它的模型列表接口与 OpenAI 不同"。**这是错的** ——
 * Anthropic 有 Models API：`GET /v1/models`，返回 `{ data: [{ id, display_name, … }] }`，
 * 和 OpenAI 的 `{ data: [{ id }] }` **同构**，解析逻辑本来就能共用。
 *
 * 真正的故障只有一个：**地址拼错了**。
 *   Anthropic 的 Base URL 惯例上不带版本段（默认 `https://api.anthropic.com`），
 *   而它的 Models API 在 `/v1/models` —— 代码直接拼 `/models`，于是 404，
 *   再被上层翻译成"该服务不支持 /models"。
 *
 * 所以本检查的核心不是"能不能解析"，而是**地址拼接规则**，以及一条容易被未来重构破坏的不变量：
 *   `模型列表地址 == 对话地址把 /messages 换成 /models`
 * （一旦不一致，就会出现"对话能通、获取模型 404"这种最费解的现象）。
 *
 * 做法：抠出 index.html 里的真实函数体，只把网络出口换成假的。
 * 2026-09 更新：三种协议的实现已拆到 web/js/chat-providers.js（开发文档 8.33），
 * 本检查相应改成**直接加载那个真模块**来测 callAnthropicChat。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

/** 按函数名抠出完整函数声明；`async` 前缀必须一起带上，否则里面的 await 会语法错误 */
function extractFn(name) {
    let start = html.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('在 web/index.html 里找不到函数: ' + name + '（重命名了？请同步更新本检查）');
    const asyncMatch = html.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (asyncMatch) start -= asyncMatch[0].length;
    // **先跳过参数表**：`opts = {}` 这类默认值里就有大括号，直接找第一个 `{` 会抠出半截函数
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

function extractNumberConst(name) {
    const m = new RegExp('const\\s+' + name + '\\s*=\\s*([0-9_]+)\\s*;').exec(html);
    if (!m) throw new Error('在 web/index.html 里找不到常量: ' + name + '（重命名了？请同步更新本检查）');
    return Number(m[1].replace(/_/g, ''));
}

const rawCtxFactory = new Function('window', `
    // 两个假实现：GET 出口（获取模型）与 POST 出口（对话，用来对拍地址）
    const getCalls = [];
    let queued = [];
    function setGetResults(list) { queued = list.slice(); }
    /** 清空已发出的请求记录 —— 断言"这次一共打了几次"前必须先清，否则是累计值 */
    function resetGetCalls() { getCalls.length = 0; }
    async function getJsonFromDevice(url, headers, timeoutMs) {
        getCalls.push({ url, headers, timeoutMs });
        if (!queued.length) return { ok: true, status: 200, payload: { data: [] } };
        const next = queued.shift();
        if (next instanceof Error) throw next;
        return next;
    }
    const postCalls = [];
    async function postJsonFromDevice(url, body, headers) {
        postCalls.push({ url, body, headers });
        return { ok: true, payload: { content: [{ type: 'text', text: '好的' }] } };
    }
    async function throwProviderResponseError() { throw new Error('不该走到这里'); }
    function toClientApiError(error) { return error; }
    const state = { settings: {} };
    // 假 DOM / 假弹窗：populateModelSelect 用到 document.createElement 和 showCustomAlert
    const alertMessages = [];
    function showCustomAlert(msg) { alertMessages.push(String(msg)); }
    const document = {
        createElement() { return { value: '', textContent: '' }; },
    };
    ${extractFn('stripThinkTags')}
    ${extractFn('extractTextContent')}
    ${extractFn('normalizeChatReply')}
    // anthropicContentBlocks / convertOpenAIToAnthropicMessages / callAnthropicChat
    // 已迁到 web/js/chat-providers.js（见开发文档 8.33）—— 不再从 index.html 抠，
    // 改为在下面直接加载那个真模块（测的就是线上跑的那份）。
    const ANTHROPIC_MIN_MAX_TOKENS = ${extractNumberConst('ANTHROPIC_MIN_MAX_TOKENS')};
    ${extractFn('thinkingSuffixTokenFloor')}
    ${extractFn('resolveOutputTokenLimit')}
    ${extractFn('getChatBaseUrl')}
    ${extractClass('ClientApiError')}
    ${extractFn('modelsEndpointFor')}
    ${extractFn('parseModelList')}
    ${extractFn('fetchModelList')}
    ${extractFn('populateModelSelect')}
    function lastGet() { return getCalls[getCalls.length - 1]; }
    function lastPost() { return postCalls[postCalls.length - 1]; }
    return {
        modelsEndpointFor, parseModelList, fetchModelList, populateModelSelect,
        ClientApiError,
        // 下面这些是 chat-providers.js 需要的依赖（它已拆成独立模块，见开发文档 8.33）。
        // 注意只导出**本环境里真实存在**的：
        //   · postJsonFromDevice / throwProviderResponseError 是本文件里的假实现
        //   · isDeepSeekOfficial 本检查用不到（callAnthropicChat 不依赖它），
        //     本环境也没定义 —— 所以不导出，否则会 ReferenceError。
        getChatBaseUrl, normalizeChatReply, postJsonFromDevice,
        throwProviderResponseError, extractTextContent, stripThinkTags,
        resolveOutputTokenLimit, ANTHROPIC_MIN_MAX_TOKENS,
        setGetResults, resetGetCalls, getCalls, postCalls, lastGet, lastPost,
        alertMessages,
    };
`);

// ===== 加载真实的 chat-providers.js（三种协议的实现都在那边）=====
// 原来是把 callAnthropicChat 从 index.html 里抠出来执行；它搬走后改为直接加载真模块。
const fakeWindow = {};
const ctx = rawCtxFactory(fakeWindow);
fakeWindow.ChatDeps = {
    ClientApiError: ctx.ClientApiError,
    getChatBaseUrl: ctx.getChatBaseUrl,
    normalizeChatReply: ctx.normalizeChatReply,
    postJsonFromDevice: ctx.postJsonFromDevice,
    throwProviderResponseError: ctx.throwProviderResponseError,
    extractTextContent: ctx.extractTextContent,
    stripThinkTags: ctx.stripThinkTags,
    resolveOutputTokenLimit: ctx.resolveOutputTokenLimit,
    ANTHROPIC_MIN_MAX_TOKENS: ctx.ANTHROPIC_MIN_MAX_TOKENS,
};
{
    const providersSrc = readFileSync(path.join(ROOT, 'web', 'js', 'chat-providers.js'), 'utf8');
    const sandbox = vm.createContext({
        window: fakeWindow, console, Error, Object, Array, Number, String, Math, RegExp, JSON,
    });
    vm.runInContext(providersSrc, sandbox);
}
if (!fakeWindow.ChatProviders) {
    console.error('chat-providers.js 没能挂上 window.ChatProviders');
    process.exit(1);
}
ctx.callAnthropicChat = fakeWindow.ChatProviders.callAnthropicChat;

const {
    modelsEndpointFor, parseModelList, fetchModelList, populateModelSelect,
    callAnthropicChat, ClientApiError,
    setGetResults, resetGetCalls, getCalls, postCalls, lastGet, lastPost,
    alertMessages,
} = ctx;

/**
 * 造一个最小的假 DOM，够 populateModelSelect 用。
 * `input.value` 是可观察的核心 —— 真正发给服务商的是它，不是下拉框。
 */
function fakeForm(inputValue = '') {
    const options = [];
    return {
        input: { value: inputValue },
        select: {
            classList: { removed: [], remove(c) { this.removed.push(c); } },
            appendChild(o) { options.push(o); },
            set innerHTML(v) { if (v === '') options.length = 0; },
            value: '',
            onchange: null,
        },
        options,
        btn: { textContent: '🔄 获取模型' },
    };
}

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
function has(label, actual, needle) {
    const ok = String(actual ?? '').includes(needle);
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
    if (!ok) console.log(`        got  = ${JSON.stringify(actual)}，应包含 ${JSON.stringify(needle)}`);
}
function throws(label, fn, expect) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    const ok = Boolean(err) && (expect ? String(err.message).includes(expect) : true);
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
    if (!ok) console.log(`        got  = ${err ? err.message : '（没抛错）'}，应包含 ${JSON.stringify(expect || '任何错误')}`);
}

// ---------- 一、地址拼接（这次故障的真因）----------
console.log('\n— 地址拼接 —');
check('Anthropic 官方裸域名 → /v1/models（原来拼成 /models，404）',
    modelsEndpointFor('https://api.anthropic.com', 'anthropic'),
    'https://api.anthropic.com/v1/models');
check('Anthropic 已带 /v1 → 不重复拼',
    modelsEndpointFor('https://api.anthropic.com/v1', 'anthropic'),
    'https://api.anthropic.com/v1/models');
check('Anthropic 结尾多余斜杠被吃掉',
    modelsEndpointFor('https://api.anthropic.com/v1/', 'anthropic'),
    'https://api.anthropic.com/v1/models');
check('Anthropic 粘了完整 /v1/messages → 剥掉再拼',
    modelsEndpointFor('https://api.anthropic.com/v1/messages', 'anthropic'),
    'https://api.anthropic.com/v1/models');
check('Anthropic 已经指向 /v1/models → 原样用',
    modelsEndpointFor('https://api.anthropic.com/v1/models', 'anthropic'),
    'https://api.anthropic.com/v1/models');
check('Anthropic 中转站裸域名 → /v1/models（和对话的 /v1/messages 对齐）',
    modelsEndpointFor('https://newapi.gay', 'anthropic'),
    'https://newapi.gay/v1/models');

check('OpenAI 兼容 + 裸域名 → /models（**不加** /v1，与对话地址规则一致）',
    modelsEndpointFor('https://api.deepseek.com', 'openai-compatible'),
    'https://api.deepseek.com/models');
check('OpenAI 兼容 + /v1 → /v1/models',
    modelsEndpointFor('https://api.openai.com/v1', 'openai-compatible'),
    'https://api.openai.com/v1/models');
check('OpenAI 兼容 粘了 /chat/completions → 剥掉',
    modelsEndpointFor('https://api.siliconflow.cn/v1/chat/completions', 'openai-compatible'),
    'https://api.siliconflow.cn/v1/models');
check('Responses 粘了 /responses → 剥掉',
    modelsEndpointFor('https://api.openai.com/v1/responses', 'openai-responses'),
    'https://api.openai.com/v1/models');
throws('没填 Base URL → 明确报"请先填写"', () => modelsEndpointFor('', 'anthropic'), '请先填写');

// 核心不变量：模型列表地址必须和**对话**地址同源（只差最后一段）
// 破坏它就会出现"对话能通、获取模型 404"这种最费解的现象。
console.log('\n— 不变量：与对话地址同源 —');
async function chatEndpoint(baseUrl) {
    await callAnthropicChat([{ role: 'user', content: 'hi' }], {}, { apiKey: 'k', model: 'claude-sonnet-4-5', baseUrl });
    return lastPost().url;
}
for (const base of ['https://api.anthropic.com', 'https://api.anthropic.com/v1', 'https://newapi.gay', 'https://newapi.gay/v1/']) {
    const chat = await chatEndpoint(base);
    check(`${base} → 模型地址 == 对话地址换掉末段`,
        modelsEndpointFor(base, 'anthropic'),
        chat.replace(/\/messages$/, '/models'));
}

// ---------- 二、认证头与请求 ----------
console.log('\n— 认证头 —');
setGetResults([{ ok: true, status: 200, payload: { data: [{ id: 'claude-sonnet-4-5' }] } }]);
await fetchModelList('https://api.anthropic.com', 'sk-ant-test', 'anthropic');
check('Anthropic 用 x-api-key（不是 Bearer）', lastGet().headers['x-api-key'], 'sk-ant-test');
check('Anthropic 带 anthropic-version', lastGet().headers['anthropic-version'], '2023-06-01');
check('Anthropic 不混进 Authorization', 'Authorization' in lastGet().headers, false);
has('Anthropic 带 limit=1000（默认只回 20 条，不指定会静默截断）', lastGet().url, 'limit=1000');
check('走设备层（GET 出口），不是裸 fetch', getCalls.length >= 1, true);

setGetResults([{ ok: true, status: 200, payload: { data: [{ id: 'deepseek-chat' }] } }]);
await fetchModelList('https://api.deepseek.com', 'sk-test', 'openai-compatible');
check('OpenAI 兼容用 Bearer', lastGet().headers.Authorization, 'Bearer sk-test');
check('OpenAI 兼容不带 anthropic-version', 'anthropic-version' in lastGet().headers, false);
check('OpenAI 兼容不加 limit 参数（不是所有服务都认）', lastGet().url, 'https://api.deepseek.com/models');

// ---------- 三、响应解析 ----------
console.log('\n— 响应解析 —');
check('Anthropic 的 data[].id（display_name 不参与取值）',
    parseModelList({ data: [
        { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5' },
        { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
    ] }),
    ['claude-haiku-4-5', 'claude-opus-5']);
check('OpenAI 的 data[].id',
    parseModelList({ data: [{ id: 'gpt-4.1-mini' }, { id: 'gpt-4.1' }] }),
    ['gpt-4.1', 'gpt-4.1-mini']);
check('data 里混着裸字符串也认',
    parseModelList({ data: ['b-model', { id: 'a-model' }] }),
    ['a-model', 'b-model']);
check('没有 id 的条目被过滤掉', parseModelList({ data: [{ id: 'ok' }, {}, { id: '' }, null] }), ['ok']);
check('没有 data 字段 → 空数组（不抛错）', parseModelList({}), []);
check('payload 为 null → 空数组', parseModelList(null), []);
check('结果按字母序（下拉框里好找）', parseModelList({ data: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] }), ['a', 'b', 'c']);

// ---------- 四、Anthropic 失败后退一步重试 ----------
// 第三方中转（new-api 系）的 /v1/models 常常只认 Bearer，不认 x-api-key。
console.log('\n— Anthropic 的认证降级 —');
resetGetCalls();
setGetResults([
    { ok: false, status: 401, payload: { error: { message: 'authentication_error' } } },
    { ok: true, status: 200, payload: { data: [{ id: 'claude-sonnet-4-5' }] } },
]);
check('401 后换 Bearer 再试一次并成功',
    await fetchModelList('https://newapi.gay', 'sk-test', 'anthropic'),
    ['claude-sonnet-4-5']);
check('  第二次请求用的是 Bearer', lastGet().headers.Authorization, 'Bearer sk-test');
check('  总共发了 2 次请求', getCalls.length, 2);

setGetResults([
    { ok: false, status: 404, payload: null },
    { ok: true, status: 200, payload: { data: [{ id: 'claude-opus-5' }] } },
]);
check('404 也会退一步重试（有些中转根本没有 Anthropic 风格的路由）',
    await fetchModelList('https://newapi.gay', 'sk-test', 'anthropic'),
    ['claude-opus-5']);

resetGetCalls();
setGetResults([{ ok: false, status: 500, payload: { error: { message: 'upstream busy' } } }]);
let serverErr = null;
try { await fetchModelList('https://newapi.gay', 'sk-test', 'anthropic'); } catch (e) { serverErr = e.message; }
check('5xx 不重试（换一条路也一样失败，别白打一次请求）', getCalls.length, 1);
has('  并把上游的原话透出来', serverErr, 'upstream busy');

resetGetCalls();
setGetResults([{ ok: false, status: 401, payload: { error: { message: 'invalid x-api-key' } } }]);
let bothFail = null;
try { await fetchModelList('https://api.anthropic.com', 'bad-key', 'anthropic'); } catch (e) { bothFail = e.message; }
check('两条路都失败时发了 2 次', getCalls.length, 2);
has('  报错保留**第一次**的原因（Anthropic 风格那条更可能是真相）', bothFail, 'invalid x-api-key');

resetGetCalls();
setGetResults([new Error('Failed to fetch')]);
let thrown = null;
try { await fetchModelList('https://api.anthropic.com', 'sk-test', 'anthropic'); } catch (e) { thrown = e.message; }
check('网络层直接抛错时不重试（连不上，换条路也一样）', getCalls.length, 1);
has('  原样把错误抛出去', thrown, 'Failed to fetch');

// 反向：OpenAI 系**不该**有第二次尝试
resetGetCalls();
setGetResults([{ ok: false, status: 401, payload: { error: { message: 'invalid key' } } }]);
try { await fetchModelList('https://api.deepseek.com', 'bad', 'openai-compatible'); } catch {}
check('OpenAI 系 401 只发 1 次（没有"换认证头"这条路）', getCalls.length, 1);

// ---------- 五、200 但空列表 ----------
console.log('\n— 空列表 —');
resetGetCalls();
setGetResults([{ ok: true, status: 200, payload: { data: [] } }]);
let empty = null;
try { await fetchModelList('https://api.anthropic.com', 'sk-test', 'anthropic'); } catch (e) { empty = e.message; }
has('200 + data 为空 → 说清"data 为空"', empty, 'data 为空');
has('  并给出实际请求的地址（便于用户自查）', empty, '/v1/models');
check('  200 不该被当成"认证问题"去重试', getCalls.length, 1);

// ---------- 五之二、200 却拿回 HTML 首页（地址少版本段的典型症状）----------
//
// 真实故障：Base URL 填 `https://newapi.gay`（少 /v1）时，`/models` 打到了站点首页，
// 返回 200 + text/html。旧代码解析不出 data，报"可能该服务不支持 /models" ——
// 把人引向完全错误的方向（实测 /v1/models 才是真接口，只是缺 Key 才 401）。
console.log('\n— 200 但返回 HTML（少版本段）—');
resetGetCalls();
setGetResults([{
    ok: true, status: 200,
    payload: null,
    rawText: '<!doctype html>\n<html lang="en"><head><title>New API</title></head></html>',
}]);
let htmlCase = null;
try { await fetchModelList('https://newapi.gay', 'sk-test', 'openai-compatible'); } catch (e) { htmlCase = e.message; }
has('200 + HTML → 点明"返回的是网页，不是 API 响应"', htmlCase, '网页');
has('  并建议补上 /v1', htmlCase, '/v1');
has('  且写出实际请求的地址', htmlCase, 'newapi.gay/models');

// 200 但返回的不是 JSON（非 HTML 的其它脏数据）
resetGetCalls();
setGetResults([{ ok: true, status: 200, payload: null, rawText: 'not json at all' }]);
let badJson = null;
try { await fetchModelList('https://newapi.gay/v1', 'sk-test', 'openai-compatible'); } catch (e) { badJson = e.message; }
has('200 + 非 JSON → 报"不是有效 JSON"并附原文开头', badJson, '不是有效 JSON');
has('  原文开头被带出来（便于判断到底拿到了什么）', badJson, 'not json at all');

// ---------- 六、拉到列表之后要真的填进模型名输入框 ----------
//
// 真实故障：Anthropic 下「获取模型」能成功拉到列表，但**模型名输入框没被填上**，
// 于是下拉框出现了、真正发出去的却还是切格式时自动填的预设名（如
// `claude-sonnet-4-20250514`）—— 那个名字往往不在真实列表里，一对话就 404。
//
// 根因：populateModelSelect 只填了 <select>，从没给 <input> 赋值；
// 而 readProviderSettingsForm 读的是 **input** 的值。两者脱节，功能等于没生效。
//
// 为什么以前没被发现：本检查只覆盖了 fetchModelList / parseModelList（"能不能拉到"），
// 没有覆盖"拉到之后有没有回填"。
console.log('\n— 拉到列表后回填输入框 —');
// 各格式的预设模型名（与 index.html 的 CHAT_API_FORMATS 对应）
const PRESET_MODELS = ['deepseek-chat', 'gpt-4.1-mini', 'claude-sonnet-4-20250514'];

// 真实故障场景：Anthropic 切格式时自动填了预设名，而它不在真实列表里
{
    const form = fakeForm('claude-sonnet-4-20250514');
    setGetResults([{ ok: true, status: 200, payload: { data: [
        { id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' },
    ] } }]);
    await populateModelSelect({
        btn: form.btn, input: form.input, select: form.select,
        baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-x', apiFormat: 'anthropic',
        defaultModels: PRESET_MODELS,
    });
    check('下拉框被填上了', form.options.map(o => o.value), ['claude-haiku-4-5', 'claude-opus-5']);
    check('下拉框显示出来（不再 hidden）', form.select.classList.removed.includes('hidden'), true);
    check('输入框被覆盖成列表里的真实模型',
        ['claude-haiku-4-5', 'claude-opus-5'].includes(form.input.value), true);
    check('  不能还是那个不在列表里的预设名',
        form.input.value === 'claude-sonnet-4-20250514', false);
}

// 用户手填的名字**在列表里**时不该被覆盖 —— 尊重用户的选择
{
    const form = fakeForm('claude-opus-5');
    setGetResults([{ ok: true, status: 200, payload: { data: [
        { id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' },
    ] } }]);
    await populateModelSelect({
        btn: form.btn, input: form.input, select: form.select,
        baseUrl: 'https://api.anthropic.com', apiKey: 'k', apiFormat: 'anthropic',
        defaultModels: PRESET_MODELS,
    });
    check('用户已填且存在于列表 → 保留用户的选择', form.input.value, 'claude-opus-5');
    check('  下拉框同步选中该项', form.select.value, 'claude-opus-5');
}

// 用户手填的名字**不在列表里**、且不是预设值（中转站的私有别名）→ 不覆盖。
// 这是刻意与"预设名"区别对待的：预设名是应用自己填的，别名是用户故意填的。
{
    const form = fakeForm('my-custom-alias');
    setGetResults([{ ok: true, status: 200, payload: { data: [{ id: 'claude-opus-5' }] } }]);
    await populateModelSelect({
        btn: form.btn, input: form.input, select: form.select,
        baseUrl: 'https://newapi.gay', apiKey: 'k', apiFormat: 'anthropic',
        defaultModels: PRESET_MODELS,
    });
    check('用户手填的别名不在列表里 → 不覆盖输入框', form.input.value, 'my-custom-alias');
    check('  下拉框选中列表第一项（点一下就能换过去）', form.select.value, 'claude-opus-5');
}

// 输入框为空时应该填上，否则"拉到了但没选"依然用不了
{
    const form = fakeForm('');
    setGetResults([{ ok: true, status: 200, payload: { data: [{ id: 'claude-opus-5' }] } }]);
    await populateModelSelect({
        btn: form.btn, input: form.input, select: form.select,
        baseUrl: 'https://api.anthropic.com', apiKey: 'k', apiFormat: 'anthropic',
        defaultModels: PRESET_MODELS,
    });
    check('输入框为空 → 填上列表第一项', form.input.value, 'claude-opus-5');
}

// 手动选下拉框时要同步进输入框（原有行为，别在修 bug 时弄丢）
{
    const form = fakeForm('');
    setGetResults([{ ok: true, status: 200, payload: { data: [{ id: 'a-model' }, { id: 'b-model' }] } }]);
    await populateModelSelect({
        btn: form.btn, input: form.input, select: form.select,
        baseUrl: 'https://api.anthropic.com', apiKey: 'k', apiFormat: 'anthropic',
        defaultModels: PRESET_MODELS,
    });
    form.select.value = 'b-model';
    form.select.onchange();
    check('手动选下拉框 → 同步进输入框', form.input.value, 'b-model');
}

// 边界：预设名**恰好有效**时必须保留，不能被换成列表第一项。
// 这是"预设名"与"真实列表"两个条件同时成立的情况 —— 判断顺序写反就会在这里翻车。
{
    const form = fakeForm('claude-sonnet-4-20250514');
    setGetResults([{ ok: true, status: 200, payload: { data: [
        { id: 'claude-haiku-4-5' }, { id: 'claude-sonnet-4-20250514' },
    ] } }]);
    await populateModelSelect({
        btn: form.btn, input: form.input, select: form.select,
        baseUrl: 'https://api.anthropic.com', apiKey: 'k', apiFormat: 'anthropic',
        defaultModels: PRESET_MODELS,
    });
    check('预设名恰好存在于列表 → 保留它（不越权换成第一项）',
        form.input.value, 'claude-sonnet-4-20250514');
    check('  下拉框同步选中该项', form.select.value, 'claude-sonnet-4-20250514');
}

// 失败时不能改动输入框，也不能让按钮卡在"获取中"
{
    const form = fakeForm('keep-me');
    setGetResults([{ ok: false, status: 401, payload: { error: { message: 'bad key' } } }]);
    await populateModelSelect({
        btn: form.btn, input: form.input, select: form.select,
        baseUrl: 'https://api.anthropic.com', apiKey: 'bad', apiFormat: 'anthropic',
        defaultModels: PRESET_MODELS,
    });
    check('失败时输入框原样不动', form.input.value, 'keep-me');
    check('失败时按钮文案恢复', form.btn.textContent, '🔄 获取模型');
    check('失败时给出提示', alertMessages.length > 0, true);
}

console.log(`\n获取模型列表检查：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
