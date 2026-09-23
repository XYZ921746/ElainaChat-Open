// 回归检查：本轮三件用户反馈。
//   1. 手机操作授权「每次运行只确认一次」并设为默认
//   2. Edge TTS（免费 provider，wss 协议，含 Sec-MS-GEC token）
//   3. 聊天发送按钮二态（AI 回复中变红色停止）+ 请求可中断
//
// 用法：node scripts/check-chat-stop-and-edge-tts.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const providers = readFileSync(path.join(ROOT, 'web', 'js', 'chat-providers.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, l, d) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; failures.push(l); console.log('  FAIL  ' + l + (d ? '  -> ' + d : '')); } };

function extractFn(src, name) {
    let start = src.indexOf('function ' + name + '(');
    if (start < 0) return null;
    const a = src.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (a) start -= a[0].length;
    let i = src.indexOf('{', src.indexOf('(', start));
    let d = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}') { d--; if (d === 0) return src.slice(start, i + 1); }
    }
}

// ============================================================ 1. 授权策略
console.log('=== 1. 授权策略：once 默认 ===');
{
    ok(/name="agentApproval" value="once"/.test(html), 'UI 有 once 选项');
    ok(/value="once"[^<]*> 每次运行只确认一次（推荐）/.test(html), 'once 标为推荐');
    ok(/agentApproval: 'once'/.test(html), '默认设置是 once');
    ok(!/agentApproval: 'always'/.test(html), '默认不再是 always');
    ok(/\['once', 'run', 'always', 'off'\]/.test(html), '合法性校验包含全部四档（含旧值 always 兼容）');
    ok(/\|\| 'once'\);/.test(html) || /\|\| 'once'\s*\)/.test(html), '读回落是 once');
    // once 语义：本轮确认过任何操作就放行
    const fn = html.slice(html.indexOf('async function requestApproval('), html.indexOf('function requestApprovalViaOverlay('));
    ok(/policy === 'once' && approvedThisRun\.size > 0/.test(fn), 'once 策略：本轮确认过任意操作就放行');
    ok(/approvedThisRun\.add\(action\)/.test(fn), '确认后记录（once 也靠这个 Set）');
    // dangerous 不受豁免
    ok(/if \(risk !== 'dangerous'\) \{/.test(fn), 'dangerous 不进入任何豁免分支');
}

// ============================================================ 2. Edge TTS
console.log('\n=== 2. Edge TTS ===');
{
    ok(/<option value="edge">Edge TTS（免费，临时使用）<\/option>/.test(html), 'UI 有 edge 选项');
    ok(/ttsProvider: 'edge'/.test(html), '默认 TTS 是 edge');
    ok(/edgeTtsVoice: 'zh-CN-XiaoxiaoNeural'/.test(html), '默认音色');
    ok(/if \(provider === 'edge'\) return true;/.test(html), 'isTtsConfigured：edge 免配置直接可用');
    ok(/async function speakTextEdge\(/.test(html), '有 speakTextEdge 实现');
    // 常量区 + 函数体一起切（speakTextEdge 引用了 EDGE_TTS_WSS/TOKEN 等常量）
    const constStart = html.indexOf('const EDGE_TTS_WSS');
    const fnStart = html.indexOf('async function speakTextEdge(');
    const fnEnd = html.indexOf('async function speakTextMinimax(');
    const fn = constStart > 0 && fnEnd > fnStart ? html.slice(Math.min(constStart, fnStart), fnEnd) : '';
    ok(fn.includes('speech.platform.bing.com'), '用微软朗读端点');
    ok(fn.includes('Sec-MS-GEC'), '带 Sec-MS-GEC token（没有会 403）');
    ok(fn.includes('Path:speech.config'), '先发 speech.config');
    ok(fn.includes('Path:ssml'), '再发 ssml');
    ok(/Path:audio/.test(fn), '解析二进制音频帧');
    ok(/turn\.end/.test(fn), '识别合成结束');
    ok(fn.includes('saveCachedTtsAudio'), '合成结果写缓存');
    ok(/edgeTtsSecMsGec[\s\S]{0,600}BigInt/.test(html), 'GEC 时间计算用 BigInt（Number 会丢精度 → token 错 → 403）');
    // 分发
    ok(/provider === 'edge'\s*\?\s*speakTextEdge/.test(html), 'speakText 分发包含 edge');
}

// GEC 算法端到端：跑真实代码对拍 Python 版的已知值
console.log('\n=== 3. Sec-MS-GEC 算法（端到端）===');
{
    // 常量按字面量匹配出三条 + 函数用配对提取（不能按固定长度切 —— 会切在函数中间）
    function extractConst(src, name) {
        const m = src.match(new RegExp('const ' + name + " = '([^']+)'"));
        return m ? `const ${name} = '${m[1]}';` : '';
    }
    const code = [
        extractConst(html, 'EDGE_TTS_WSS'),
        extractConst(html, 'EDGE_TTS_TOKEN'),
        extractConst(html, 'EDGE_TTS_CHROMIUM_FULL'),
        extractFn(html, 'sha256Sync'),
        extractFn(html, 'edgeSha256Hex'),
        extractFn(html, 'edgeTtsSecMsGec'),
        'globalThis.__gec = edgeTtsSecMsGec;',
    ].filter(Boolean).join('\n');
    const sandbox = { Math, Date, console, String, Number, Array, BigInt, globalThis: {} };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    // 用固定时间测：2026-01-01 00:00:00 UTC = 1767225600
    const fixed = vm.runInContext(`
        (function(){
            const real = Date.now;
            Date.now = () => 1767225600000;
            try { return edgeTtsSecMsGec(); } finally { Date.now = real; }
        })()
    `, sandbox);
    // Python 对拍：ticks = (1767225600 + 11644473600) // 300 * 300 * 10_000_000
    //              sha256(f"{ticks}6A5AA1D4EAFF4E9FB37E23D68491D6F4").hex().upper()
    const crypto = await import('node:crypto');
    let ticks = BigInt(1767225600 + 11644473600);
    ticks -= ticks % 300n;
    ticks *= 10000000n;
    const expected = crypto.createHash('sha256').update(ticks.toString() + '6A5AA1D4EAFF4E9FB37E23D68491D6F4').digest('hex').toUpperCase();
    ok(fixed === expected, 'GEC 值与参考实现一致', `got ${fixed?.slice(0, 12)}… want ${expected.slice(0, 12)}…`);
    ok(typeof fixed === 'string' && /^[0-9A-F]{64}$/.test(fixed), 'GEC 是 64 位大写 hex');
}

// ============================================================ 4. 停止按钮 + 可中断
console.log('\n=== 4. 聊天停止按钮 ===');
{
    ok(/onclick="handleComposerButtonClick\(\)"/.test(html), '发送按钮走统一入口（不再直连 handleTextSubmit）');
    ok(/function handleComposerButtonClick\(\)/.test(html), '有统一入口函数');
    ok(/function stopAiReply\(\)/.test(html), '有 stopAiReply');
    ok(html.includes('activeReplyAborts'), '有本轮回复的中断器表');
    ok(/replyAbort = new AbortController\(\)/.test(html), '每轮回复创建 AbortController');
    ok(/signal: replyAbort\.signal/.test(html), 'signal 传给 callAI');
    ok(/signal: options\.signal/.test(html), 'callAI 透传给 callChatAPI');
    ok(/async function postJsonFromDevice\(url, body, headers = \{\}, timeoutMs = 120000, signal = null\)/.test(html),
        'postJsonFromDevice 收 signal');
    ok(/Promise\.race\(\[run, abortPromise\]\)/.test(html), 'abort 用 race 立即砍掉等待');
    // 图标二态
    ok(/class="stop-icon w-3\.5 h-3\.5 hidden"/.test(html) || /stop-icon[^>]*hidden/.test(html), '有停止图标（默认隐藏）');
    ok(/is-stopping/.test(html), '有 is-stopping 样式类');
    ok(/#initialSendBtn\.is-stopping/.test(html) || /\.is-stopping\s*\{/.test(html), '停止态有红色样式');
    // busy 时按钮可见
    ok(/busy \|\| Boolean\(elements\.initialTextInput\.value\.trim\(\)\)/.test(html), 'busy 时按钮强制可见');
    // 停止时安静收尾
    ok(/回复已被用户停止，安静收尾/.test(html), '停止后不弹错误框');
    ok(/stopActiveVoicePlayback\(\)/.test(html.replace(/async function stopActiveVoicePlayback[\s\S]*?\n        \}/, '')) ||
       /void stopActiveVoicePlayback\(\);/.test(html), '停止时同步停掉语音');
    // providers 透传
    ok((providers.match(/opts\.signal/g) || []).length >= 3, '三种协议都透传 signal');
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：' + failures.join('、'));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
