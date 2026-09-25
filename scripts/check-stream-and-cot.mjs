// 回归检查：流式输出 + 思考模式适配 + 回合过程（思维链 / 工具调用）展示。
//
// 这三件事是一个整体，所以放一个检查里 —— 它们共享同一条链路：
//   思考开关/强度 → 请求参数 → 流式增量 → 回合过程区（思考行 + 工具调用行 + 总览）
// 拆成三个文件会让"参数发出去了但界面不显示"这种跨层断裂漏检。
//
// 盯住的关键契约（都是踩过或极易踩的坑）：
//
//   ① DeepSeek 现在**服务端默认开启思考**。所以"关掉开关"必须显式发
//      `thinking:{type:'disabled'}` —— 不发字段不等于关，用户会白等几十秒、
//      白花思考 token，而界面上什么都看不到。这条最隐蔽。
//
//   ② 工具调用行**不受思考开关影响**（用户明确要求："思考模式关闭的情况下
//      思维链还是要显示工具调用的"）。关掉思考只是不显示"思考"那一行，
//      不能连"AI 改了哪个文件"也一起藏掉。
//
//   ③ 过程行默认**折叠**。这是聊天应用，正文才是主角；思考动辄上千字，
//      默认展开会把对话顶出屏幕。但摘要行必须常驻 —— 折叠不等于藏起来。
//
//   ④ 流式失败要能**退回非流式**。中转站可能把 SSE 缓冲掉、上游可能不支持
//      stream、APK 原生层根本没有流通道。任一条路断了都不能让用户发不出消息。
//
//   ⑤ 已经吐出内容之后**不能**再回退重试 —— 否则用户会看到内容闪一下、
//      或者同一段话出现两遍。
//
// 用法：node scripts/check-stream-and-cot.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readFrontend } from './frontend-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFrontend();
const core = readFileSync(path.join(ROOT, 'web', 'js', 'app-01-core.js'), 'utf8');
const ui = readFileSync(path.join(ROOT, 'web', 'js', 'app-04-ui.js'), 'utf8');
const voice = readFileSync(path.join(ROOT, 'web', 'js', 'app-05-voice.js'), 'utf8');
const settings = readFileSync(path.join(ROOT, 'web', 'js', 'app-06-settings.js'), 'utf8');
const init = readFileSync(path.join(ROOT, 'web', 'js', 'app-07-init.js'), 'utf8');
const streamSrc = readFileSync(path.join(ROOT, 'web', 'js', 'chat-stream.js'), 'utf8');
const providers = readFileSync(path.join(ROOT, 'web', 'js', 'chat-providers.js'), 'utf8');
const indexHtml = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

// ============================================================ 1. 接线
console.log('=== 1. 脚本接线与加载顺序 ===');
ok(/<script src="\/js\/chat-stream\.js"><\/script>/.test(indexHtml), 'index.html 引入 chat-stream.js');
{
    const coreIdx = indexHtml.indexOf('/js/app-01-core.js');
    const streamIdx = indexHtml.indexOf('/js/chat-stream.js');
    ok(coreIdx > 0 && streamIdx > coreIdx, 'chat-stream.js 排在 app-01-core.js 之后');
    ok(streamIdx < indexHtml.indexOf('/js/app-02-data.js'), 'chat-stream.js 排在 app-02-data.js 之前');
}
ok(/window\.ChatStream\s*=/.test(streamSrc), 'chat-stream.js 挂到 window.ChatStream（非模块脚本，跨文件必须走 window）');
ok(/requestChatJson/.test(core) && /requestChatJson,/.test(core), 'core 把 requestChatJson 挂进 window.ChatDeps');
ok(/buildThinkingParams,/.test(core), 'core 把 buildThinkingParams 挂进 window.ChatDeps');

// ============================================================ 2. 思考参数
console.log('\n=== 2. 思考参数（各家真实字段）===');
// 从真实实现里取函数来实跑，而不是只做正则匹配 —— 正则会匹配注释里的假代码
function extractFn(name, src = core) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('找不到函数 ' + name);
    let i = src.indexOf('(', start), paren = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') paren++;
        else if (src[i] === ')') { paren--; if (paren === 0) { i++; break; } }
    }
    let depth = 0;
    i = src.indexOf('{', i);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}
const buildThinkingParams = new Function('isDeepSeekOfficial', `
    const THINKING_EFFORTS = Object.freeze(['low', 'medium', 'high']);
    ${extractFn('mapThinkingEffort')}
    ${extractFn('detectThinkingVendor')}
    ${extractFn('buildThinkingParams')}
    return buildThinkingParams;
`)((url) => /api\.deepseek\.com/i.test(String(url || '')));

const ds = (enabled, effort) => buildThinkingParams(enabled, effort, 'openai-compatible',
    { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' });

// ★ 最关键的一条：关必须显式关
ok(JSON.stringify(ds(false)) === JSON.stringify({ thinking: { type: 'disabled' } }),
    '★ DeepSeek 关思考 → 显式 thinking.type=disabled（服务端默认是开的）', JSON.stringify(ds(false)));
ok(JSON.stringify(ds(true)) === JSON.stringify({ thinking: { type: 'enabled' } }),
    'DeepSeek 开思考 → thinking.type=enabled', JSON.stringify(ds(true)));
ok(ds(true, 'low').reasoning_effort === 'low', 'DeepSeek 低强度 → reasoning_effort=low');
ok(ds(true, 'high').reasoning_effort === 'high', 'DeepSeek 高强度 → reasoning_effort=high');
ok(!('reasoning_effort' in ds(true, 'medium')),
    'DeepSeek medium = 不指定强度（交给服务商默认，不替用户决定花多少 token）');
// DeepSeek 只认 low/high/max：medium 不能硬塞成 high，否则用户以为选了中间档
ok(!('reasoning_effort' in ds(true, 'medium')), '★ medium 不被静默改成 high');

// Anthropic：用 reasoning.effort，绝不能用 thinking 字段
const an = (enabled, effort) => buildThinkingParams(enabled, effort, 'anthropic',
    { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' });
ok(JSON.stringify(an(false)) === JSON.stringify({ reasoning: { effort: 'none' } }),
    'Anthropic 关思考 → reasoning.effort=none', JSON.stringify(an(false)));
ok(!('thinking' in an(true)),
    '★ Anthropic 不发 thinking 字段（那是 Claude 官方 extended thinking，同名不同义，发错会 400）');
ok(an(true, 'low').output_config?.effort === 'low', 'Anthropic 显式档位时补 output_config.effort');

// Responses：只有 reasoning.effort，没有"关闭"取值
const rp = (enabled, effort) => buildThinkingParams(enabled, effort, 'openai-responses',
    { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' });
ok(!('reasoning' in rp(false)), 'Responses 关思考 → 不发 reasoning（它没有 none 取值）');
ok(rp(true, 'high').reasoning?.effort === 'high', 'Responses 开思考 → reasoning.effort');

// 开关关着时**任何格式都不该**冒出强度字段
for (const [fmt, name] of [['openai-compatible', 'OpenAI 兼容'], ['anthropic', 'Anthropic'], ['openai-responses', 'Responses']]) {
    const p = buildThinkingParams(false, 'high', fmt, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
    const flat = JSON.stringify(p);
    ok(!/reasoning_effort|output_config/.test(flat), `关思考时 ${name} 不带强度字段`, flat);
}

// 三个 provider 都真的把思考参数发进请求体
console.log('\n— provider 接线 —');
for (const [fn, fmt] of [['callOpenAICompatibleChat', 'openai-compatible'], ['callAnthropicChat', 'anthropic'], ['callOpenAIResponsesChat', 'openai-responses']]) {
    const body = providers.slice(providers.indexOf('async function ' + fn));
    const seg = body.slice(0, body.indexOf('\n    }'));
    ok(new RegExp(`buildThinkingParams\\(opts\\.thinking, opts\\.thinkingEffort, '${fmt}'`).test(seg),
        `${fn} 传入思考参数（格式 ${fmt}）`);
}
// 老逻辑是「thinking 开着 + 模型名是 deepseek-chat → 换成 deepseek-reasoner」。
// 现在思考由 thinking 字段控制，模型名不该再被换成一个思考专用模型。
// 断言行为而不是文本：deepseek-reasoner 仍然可以作为**输入**被识别（老用户设置里存着它），
// 但它不能是**输出** —— 那正是要取消的行为。
{
    const legacy = new Function(`
        ${extractFn('legacyDeepSeekModel', providers)}
        return legacyDeepSeekModel;
    `)();
    ok(legacy('deepseek-chat', true) !== 'deepseek-reasoner',
        '★ thinking 开着时不再把 deepseek-chat 换成 deepseek-reasoner', legacy('deepseek-chat', true));
    ok(legacy('deepseek-reasoner', true) === 'deepseek-flash',
        '老用户存着 deepseek-reasoner → 映射到当前模型 deepseek-flash');
    ok(legacy('deepseek-v4-pro', true) === 'deepseek-v4-pro',
        '★ 用户明确选的 deepseek-v4-pro 不被降级（那是花他的钱还改他的选择）');
    ok(legacy('deepseek-flash', false) === 'deepseek-flash',
        '当前模型名原样透传');
    ok(legacy('gpt-4.1-mini', true) === 'gpt-4.1-mini',
        '非 DeepSeek 模型名完全不受影响');
}

// ============================================================ 3. 流式解析
console.log('\n=== 3. 流式增量解析（三种协议实跑）===');
const sandbox = { window: {}, TextDecoder, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(streamSrc, sandbox);
const CS = sandbox.window.ChatStream;
ok(Boolean(CS), 'chat-stream.js 能在假环境加载并导出 ChatStream');

function sseResponse(text) {
    const bytes = new TextEncoder().encode(text);
    let sent = false;
    return {
        headers: { get: () => 'text/event-stream' },
        body: {
            getReader: () => ({
                async read() {
                    if (sent) return { done: true, value: undefined };
                    sent = true;
                    return { done: false, value: bytes };
                },
                releaseLock() {},
            }),
        },
    };
}

if (CS) {
    // OpenAI 兼容：正文与 reasoning_content 交错
    {
        const sse = 'data: {"choices":[{"delta":{"reasoning_content":"想想"}}]}\n\n'
            + 'data: {"choices":[{"delta":{"content":"你"}}]}\n\n'
            + 'data: {"choices":[{"delta":{"content":"好"}}]}\n\n'
            + 'data: [DONE]\n\n';
        const r = await CS.consumeStream(sseResponse(sse), 'openai-compatible');
        ok(r.text === '你好', 'openai-compatible：正文增量拼回完整正文', r.text);
        ok(r.reasoning === '想想', 'openai-compatible：reasoning_content 单独归到 reasoning');
        ok(r.payload?.choices?.[0]?.message?.content === '你好',
            '★ 合成结果与非流式响应**同构**（provider 的解析代码一行都不用改）');
    }
    // Anthropic
    {
        const sse = 'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"嗯"}}\n\n'
            + 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"晴天"}}\n\n';
        const r = await CS.consumeStream(sseResponse(sse), 'anthropic');
        ok(r.text === '晴天' && r.reasoning === '嗯', 'anthropic：thinking_delta 与 text_delta 分流正确');
        ok(r.payload?.content?.some((b) => b.type === 'thinking'), 'anthropic：合成 thinking block');
    }
    // Responses
    {
        const sse = 'data: {"type":"response.reasoning_summary_text.delta","delta":"摘要"}\n\n'
            + 'data: {"type":"response.output_text.delta","delta":"答复"}\n\n';
        const r = await CS.consumeStream(sseResponse(sse), 'openai-responses');
        ok(r.text === '答复' && r.reasoning === '摘要', 'openai-responses：摘要与正文分流正确');
    }
    // 多字节字符被网络分块切断
    {
        const full = 'data: {"choices":[{"delta":{"content":"中文"}}]}\n\n';
        const bytes = new TextEncoder().encode(full);
        const cut = bytes.indexOf(0xe4) + 1;
        let step = 0;
        const resp = {
            headers: { get: () => 'text/event-stream' },
            body: {
                getReader: () => ({
                    async read() {
                        step++;
                        if (step === 1) return { done: false, value: bytes.slice(0, cut) };
                        if (step === 2) return { done: false, value: bytes.slice(cut) };
                        return { done: true, value: undefined };
                    },
                    releaseLock() {},
                }),
            },
        };
        const r = await CS.consumeStream(resp, 'openai-compatible');
        ok(r.text === '中文', '★ UTF-8 跨块截断不产生乱码（TextDecoder 必须带 {stream:true}）', r.text);
    }
    ok(CS.withStreamFlag({ model: 'm' }, 'openai-compatible', true).stream === true,
        'withStreamFlag 打开时加 stream: true');
    ok(!('stream' in CS.withStreamFlag({ model: 'm' }, 'openai-compatible', false)),
        'withStreamFlag 关闭时**不发** stream 字段（部分服务商对 stream:false 处理不同）');
}

// ============================================================ 4. 流式接线与回退
console.log('\n=== 4. 流式接线与回退 ===');
ok(/async function requestChatJson\(/.test(core), 'core 提供 requestChatJson 统一出口');
ok(/sawDelta/.test(core), '★ 记录"有没有真的吐出过内容"');
ok(/if \(sawDelta\) throw error;/.test(core),
    '★ 已吐内容后不回退重试（否则内容闪一下 / 出现两遍）');
ok(/if \(error\?\.name === 'AbortError'\) throw error;/.test(core),
    '★ 用户主动停止不算失败，不回退（否则停止按钮会立刻再发一次）');
ok(/getNativeByokHttpPlugin\(\)\?\.post/.test(core),
    '★ APK 原生层没有流通道 → 直接走非流式（静默降级）');
ok(/text\\\/event-stream/i.test(core) || /text\/event-stream/.test(core),
    '★ 不是 SSE 就按普通响应处理（上游 400/401 的错误体都是普通 JSON）');
ok(/relayError/.test(core), '保留中转错误归一化（relayError）');

// 三个 provider 都走 requestChatJson，且都传了 onDelta
for (const fn of ['callOpenAICompatibleChat', 'callAnthropicChat', 'callOpenAIResponsesChat']) {
    const seg = providers.slice(providers.indexOf('async function ' + fn));
    const body = seg.slice(0, seg.indexOf('\n    }'));
    ok(/await requestChatJson\(/.test(body), `${fn} 走 requestChatJson（统一决定流式/非流式）`);
    ok(/onDelta: opts\.onDelta/.test(body), `${fn} 把 onDelta 透传下去`);
    ok(/signal: opts\.signal/.test(body), `${fn} 把 signal 透传下去（停止按钮）`);
}

// postJsonFromDevice 的 5 参签名被另一个检查盯着，这里确认没有加第 6 个形参
ok(/async function postJsonFromDevice\(url, body, headers = \{\}, timeoutMs = 120000, signal = null\)/.test(core),
    'postJsonFromDevice 签名保持 5 个形参（不再有"第 6 个实参被静默丢弃"的 bug）');
ok(/async function fetchWithTimeout\(url, options, timeoutMs, signal = null\)/.test(voice),
    'fetchWithTimeout 显式收外部 signal（不再被 options.signal 覆盖掉）');

// ============================================================ 5. 回合过程 UI
console.log('\n=== 5. 回合过程（思考行 + 工具调用行 + 总览）===');
ok(/function createTurnTrace|function beginTurnTrace/.test(ui), 'ui 提供回合过程记录');
ok(/function recordTurnTool/.test(ui), 'ui 提供工具调用记录入口');
ok(/function renderTurnProcess/.test(ui), 'ui 提供过程区渲染');
ok(/function toggleProcessRow/.test(ui), '过程行可展开/折叠');
ok(/class="process-row-head"/.test(ui) && /aria-expanded/.test(ui),
    '过程行用 button + aria-expanded（可键盘操作、可被读屏识别）');

// ★ 折叠是默认状态：CSS 里 body 默认 display:none，只有 .is-open 才显示
ok(/\.process-row-body\s*\{\s*display:\s*none;/.test(indexHtml),
    '★ 过程行详情默认折叠（CSS 默认 display:none）');
ok(/\.process-row\.is-open \.process-row-body\s*\{\s*display:\s*block;/.test(indexHtml),
    '展开时才显示详情');

// ★ 工具调用行不受思考开关影响
ok(/const showReasoning = Boolean\(state\.settings\.thinkingMode\);/.test(ui),
    '思考行由思考开关控制');
ok(/for \(const t of trace\.tools\)/.test(ui),
    '★ 工具调用行**无条件**渲染（不受 thinkingMode 影响）');
{
    // 工具行渲染那段里不能出现 thinkingMode 判断 —— 那正是用户明确要求的行为
    const seg = ui.slice(ui.indexOf('for (const t of trace.tools)'));
    const body = seg.slice(0, seg.indexOf('host.innerHTML'));
    ok(!/thinkingMode/.test(body), '★ 工具调用行的渲染代码里没有 thinkingMode 判断');
}

// 每回合总览
ok(/turn-summary/.test(ui) && /summaryBits/.test(ui), '有「每回合总览」行（做过什么、成了几个）');
ok(/已思考/.test(ui), '总览里体现"已思考"');
ok(/个操作完成|操作完成/.test(ui), '总览里体现操作完成数量');

// 状态可视化
ok(/data-state="\$\{escapeHtml\(state/.test(ui), '过程行带 data-state（运行中/成功/失败/已停止）');
for (const s of ['running', 'ok', 'error', 'stopped']) {
    ok(new RegExp(`process-row\\[data-state="${s}"\\]`).test(indexHtml), `状态 ${s} 有独立视觉`);
}
ok(/processStateLabel/.test(ui) && /运行中/.test(ui) && /失败/.test(ui),
    '状态有中文文案（不只靠颜色，色盲用户也能分辨）');

// 增量渲染合并
ok(/scheduleTurnProcessRender/.test(ui) && /requestAnimationFrame/.test(ui),
    '★ 流式增量按帧合并渲染（逐 token 重建 DOM 会明显卡顿）');

// ============================================================ 6. 流式正文预览
console.log('\n=== 6. 流式正文预览 ===');
ok(/function renderStreamingReplyPreview/.test(voice), '有流式正文预览渲染');
ok(/function removeStreamingReplyPreview/.test(voice), '预览可被收掉');
ok(/onDelta: \(chunk\) =>/.test(voice), '发送流程接了 onDelta 回调');
ok(/chunk\.kind === 'reasoning'/.test(voice), '思考增量归到思考行');
ok(/beginTurnTrace\(message\.id\)/.test(voice), '每轮回复开启一个回合记录');
ok(/finishTurnTrace\(\)/.test(voice), '回复完成时收尾回合记录');
// ★ 最终内容必须走原来的完整路径（标签剥离、任务抽取要作用在完整文本上）
ok(/const rawResponse = await callAI\(message\.text, aiRequestOptions\)/.test(voice),
    '★ 仍以 callAI 的**完整**返回值作为正文来源（流式只负责先让用户看见）');
{
    const fin = voice.slice(voice.indexOf('} finally {', voice.indexOf('const rawResponse = await callAI')));
    ok(/removeStreamingReplyPreview\(\)/.test(fin.slice(0, 400)),
        '★ finally 里收掉预览（失败/停止路径也要清干净，否则留下幽灵气泡）');
}

// ============================================================ 7. 设置界面
console.log('\n=== 7. 思考开关已移到「设置 → 对话」===');
ok(/id="settingThinkingMode"/.test(indexHtml), '设置里有思考开关');
ok(/id="settingThinkingEffort"/.test(indexHtml), '设置里有思考强度');
for (const v of ['low', 'medium', 'high']) {
    ok(new RegExp(`<option value="${v}">`).test(indexHtml), `强度档位含 ${v}`);
}
ok(/THINKING_EFFORTS/.test(core) && /THINKING_EFFORTS/.test(settings),
    'THINKING_EFFORTS 白名单被设置读写两侧共用');
// ★ 从输入框菜单里彻底移走（否则同一个设置有两个入口，会互相不同步）
ok(!/id="composerThinkingToggle"/.test(indexHtml), '★ 输入框菜单里的思考开关已移除');
ok(!/id="initialComposerThinkingToggle"/.test(indexHtml), '★ 首屏菜单里的思考开关也已移除');
ok(!/syncComposerThinkingToggles/.test(core + voice + init),
    '★ 旧的菜单同步函数已删除（没有残留调用）');
ok(!/MiniMax 请求，默认关闭/.test(indexHtml), '★ 旧的错误提示文案（"MiniMax 请求"）已删除');
// 设置读写接线
ok(/settingThinkingMode: document\.getElementById\('settingThinkingMode'\)/.test(core),
    'elements 映射里有 settingThinkingMode');
ok(/settingThinkingEffort: document\.getElementById\('settingThinkingEffort'\)/.test(core),
    'elements 映射里有 settingThinkingEffort');
ok(/thinkingMode: elements\.settingThinkingMode\.checked/.test(settings),
    'saveSettings 落盘思考开关');
ok(/thinkingEffort: THINKING_EFFORTS\.includes\(elements\.settingThinkingEffort\.value\)/.test(settings),
    'saveSettings 落盘思考强度（并做白名单校验）');
ok(/thinkingEffort: 'medium'/.test(core), 'DEFAULT_SETTINGS 有 thinkingEffort 默认值');
ok(/syncThinkingModeControls\(\)/.test(settings), 'fillSettingsForm 回填思考控件');
ok(/elements\.settingThinkingMode\.addEventListener\('change'/.test(init),
    '思考开关改动即持久化');
ok(/elements\.settingThinkingEffort\.addEventListener\('change'/.test(init),
    '思考强度改动即持久化');
ok(/updateThinkingModeHint/.test(voice) && /id="thinkingModeHint"/.test(indexHtml),
    '有动态说明（告诉用户当前档位对当前服务商意味着什么）');
// 请求侧接线
ok(/thinkingEffort: state\.settings\.thinkingEffort/.test(readFileSync(path.join(ROOT, 'web', 'js', 'app-02-data.js'), 'utf8')),
    'callAI 把思考强度带进请求');

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);