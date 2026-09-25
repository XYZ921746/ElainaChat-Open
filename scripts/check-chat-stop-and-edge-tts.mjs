// 回归检查：本轮三件用户反馈。
//   1. 手机操作授权「每次运行只确认一次」并设为默认
//   2. Edge TTS（免费 provider）—— 页面侧只验证"两条代合成路径接好了"；
//      协议实现（含 Sec-MS-GEC 对拍）在 server/edge-tts.mjs，由 check-edge-tts.mjs 覆盖
//   3. 聊天发送按钮二态（AI 回复中变红色停止）+ 请求可中断
//
// 用法：node scripts/check-chat-stop-and-edge-tts.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFrontend();
const providers = readFileSync(path.join(ROOT, 'web', 'js', 'chat-providers.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, l, d) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; failures.push(l); console.log('  FAIL  ' + l + (d ? '  -> ' + d : '')); } };

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
    // dangerous 不受豁免。
    //
    // 2026-09 起判据从 `risk !== 'dangerous'` 变成 `risk !== 'dangerous' && !mustAsk` ——
    // 因为新增了「电脑命令」：这一类在 AGENT_RISK 里是 sensitive（同类里既有 dir
    // 也有 del），危险与否只有服务端知道，靠 forceAsk 传进来。豁免分支必须**同时**
    // 排除 mustAsk，否则用户确认过一次任意敏感操作后，一条 del 会被静默执行。
    ok(/if \(risk !== 'dangerous' && !mustAsk\) \{/.test(fn),
        'dangerous / forceAsk 都不进入任何豁免分支');
    ok(/const mustAsk = opts\.forceAsk === true;/.test(fn), 'mustAsk 来自调用方的 forceAsk');
}

// ============================================================ 2. Edge TTS
console.log('\n=== 2. Edge TTS ===');
{
    ok(/<option value="edge">Edge TTS（免费，临时使用）<\/option>/.test(html), 'UI 有 edge 选项');
    ok(/ttsProvider: 'edge'/.test(html), '默认 TTS 是 edge');
    ok(/edgeTtsVoice: 'zh-CN-XiaoxiaoNeural'/.test(html), '默认音色');
    ok(/if \(provider === 'edge'\) return true;/.test(html), 'isTtsConfigured：edge 免配置直接可用');
    ok(/async function speakTextEdge\(/.test(html), '有 speakTextEdge 实现');
    // speakTextEdge 现在只负责「按平台选一条路 + 拿回 MP3」，协议实现**不在页面里**：
    //   · 安卓 → 原生插件 EdgeTtsPlugin（原生能自定义 WebSocket 头）
    //   · 电脑 → 本机后端 POST /api/tts/edge（Node 同样能自定义头）
    // 页面里原先那份浏览器直连实现（EDGE_TTS_WSS / Sec-MS-GEC / sha256Sync /
    // speech.config / Path:audio 帧解析）已删除 —— 它必然失败，因为 JS 的
    // `new WebSocket()` 不允许自定义请求头，微软端点会直接 403。
    // 协议本身的验证（含 GEC 与参考实现逐字节对拍）在 check-edge-tts.mjs，
    // 对象是真正在跑的那份实现 server/edge-tts.mjs。
    const fnStart = html.indexOf('async function speakTextEdge(');
    const fnEnd = html.indexOf('async function speakTextMinimax(');
    const fn = fnStart > 0 && fnEnd > fnStart ? html.slice(fnStart, fnEnd) : '';
    ok(fn.length > 0, '能切出 speakTextEdge 函数体');
    ok(/Capacitor\?\.Plugins\?\.EdgeTts/.test(fn), '安卓走原生 EdgeTtsPlugin（原生能自定义 WebSocket 头）');
    ok(fn.includes('/api/tts/edge'), '电脑版走本机后端 /api/tts/edge 代合成');
    ok(fn.includes('saveCachedTtsAudio'), '合成结果写缓存');
    // 死代码必须真的清掉，别又长回来（浏览器里连不了微软端点）
    ok(!/edgeTtsSecMsGec|EDGE_TTS_WSS|sha256Sync/.test(html),
        '★ 页面里不再残留浏览器直连的 WebSocket 协议实现（那套必然 403）');
    // 分发
    ok(/provider === 'edge'\s*\?\s*speakTextEdge/.test(html), 'speakText 分发包含 edge');
}

// 第 3 节（Sec-MS-GEC 算法端到端对拍）已移除。
//
// 它原来对拍的是 **index.html 里那份浏览器直连实现**的 edgeTtsSecMsGec / sha256Sync。
// 那两个函数连同整段协议实现已被删除（浏览器 `new WebSocket()` 不允许自定义请求头，
// 微软端点必然 403 —— 现在改由原生插件与本机后端代合成）。
//
// 这个算法本身仍然必须验证，但它现在住在 server/edge-tts.mjs，
// 由 **scripts/check-edge-tts.mjs 第 4 节**做同样的逐字节对拍（对象是真正在跑的实现）。
// 在这里再对拍一次已无对象可对，只会变成永远通过的空断言。

// ============================================================ 4. 停止按钮 + 可中断
console.log('\n=== 3. 聊天停止按钮 ===');
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
    // 图标二态（DSH 式：同一位置一个图标槽，箭头↔暂停）
    ok(/composer-state-icon/.test(html), '有统一的图标槽（不是两个图标叠着切 hidden）');
    ok(/COMPOSER_ARROW_SVG/.test(html) && /COMPOSER_PAUSE_SVG/.test(html), '箭头与暂停两套 SVG');
    ok(/function swapStopIcons/.test(html), 'swapStopIcons 切换图标');
    ok(/is-stopping/.test(html), '有 is-stopping 样式类');
    ok(!/#ef4444 !important/.test(html), '停止态不做红色突跳（颜色统一，DSH 式）');
    // 设置迁移：老用户的 always 要迁到 once
    ok(/settingsVersion/.test(html), '有 settingsVersion 迁移标记');
    ok(/agentApproval === 'always'\)\s*\{[\s\S]{0,120}agentApproval = 'once'/.test(html), '迁移逻辑：旧默认 always → once');
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
