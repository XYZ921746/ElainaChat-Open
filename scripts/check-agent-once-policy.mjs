// 一次性：复现真实时序的验证 —— 模拟"AI 续跑间隔超过 600ms"下 once 策略是否还弹。
//
// 之前测试假在哪里：同步连调两次 requestApproval，中间没有间隔，
// endRun/beginRun 根本没机会跑 —— 所以测出"通过"，用户实测却是每步一弹。
// 这次严格按真实时序：第 1 步执行完 → 等 900ms（> 600ms 定时器，endRun 会跑）
// → 第 2 步进来触发 beginRun → 若还弹确认就是 bug。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d ? '  -> ' + d : '')); } };

// 抠 agentRuntime 的完整 IIFE（从 const agentRuntime 到 window.agentRuntime =）
const rtStart = html.indexOf('const agentRuntime = (function ()');
const rtEnd = html.indexOf('window.agentRuntime = agentRuntime;');
if (rtStart < 0 || rtEnd < 0) { console.error('抠不到 agentRuntime'); process.exit(1); }
let rtSrc = html.slice(rtStart, rtEnd);

// 沙箱依赖
const state = { settings: { agentApproval: 'once', agentPhoneEnabled: true } };
let resolveModal = null;   // 应用内弹窗的"人工点按"由测试脚本代替
const sandbox = {
    console,
    state,
    document: {
        getElementById: () => null,   // render() 里的元素拿不到 → 内部直接 return，安全
        querySelectorAll: () => [],
    },
    AGENT_RISK: {
        '手机状态': 'safe', '手机查看界面': 'safe', '手机截图': 'safe', '手机等待': 'safe',
        '手机点击': 'sensitive', '手机滑动': 'sensitive', '手机输入': 'sensitive',
        '手机按键': 'sensitive', '手机打开': 'sensitive', '手机命令': 'dangerous',
    },
    showCustomModal: () => new Promise((resolve) => { resolveModal = resolve; }),
    DOMException, AbortController,
    Set, Map, Promise, Date, Number, String, Boolean, Error, setTimeout, clearTimeout,
    requestApprovalViaOverlay: () => Promise.resolve(null),   // 无悬浮窗 → 走应用内弹窗
    deviceBridge: () => null,
    window: {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// requestStop 里引用了 elements —— 沙箱里没有，换成安全占位
rtSrc = rtSrc.replace('elements.customModalCancelBtn?.click()', 'null');

vm.runInContext(rtSrc + '\nwindow.agentRuntime = agentRuntime;', sandbox);
const rt = sandbox.window.agentRuntime;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 模拟一步真实操作：setStep → requestApproval（beginBatch/beginRun 由外层控制，
 *  与真实流程一致：beginBatch 每条 AI 回复一次，beginRun 在续跑里按需调用） */
async function doStep(label) {
    if (!rt.isRunning()) rt.beginRun();
    rt.setStep(1, label);
    const p = rt.requestApproval(label, label + ' 测试');
    // 轮询等弹窗出现（showCustomModal 被 stub，resolveModal 有值即表示弹了）
    let waited = 0;
    while (!resolveModal && waited < 2000) { await sleep(20); waited += 20; }
    const askedConfirmation = Boolean(resolveModal);
    if (resolveModal) { const r = resolveModal; resolveModal = null; r(true); }   // 自动点"允许"
    const allowed = await p;
    return { askedConfirmation, allowed };
}

console.log('=== 真实时序复现：一批（一条 AI 回复）里多步，步间隔 >600ms ===\n');

// 批次开始（真实流程：handleUserInput 里调一次）
rt.beginBatch();
if (!rt.isRunning()) rt.beginRun();

// 第 1 步：本轮第一次 → 应该弹确认
const s1 = await doStep('手机点击');
ok(s1.askedConfirmation === true, '第 1 步：弹了确认（本轮第一次，符合预期）');
ok(s1.allowed === true, '第 1 步：允许后放行');

// 模拟 AI 续跑间隔（> 600ms 的 phoneRunEndTimer）
// 真实入口在 finally 里 600ms 后 endRun；下一步进来时 beginRun 重新开跑
await sleep(900);

// 第 2 步：once 策略下必须直接放行 —— 修复前这里会再弹一次
const s2 = await doStep('手机滑动');
ok(s2.askedConfirmation === false, '第 2 步：不再弹确认（续跑间隔后依旧放行 —— 这就是修复点）',
   s2.askedConfirmation ? '仍然弹了确认！' : '');
ok(s2.allowed === true, '第 2 步：直接放行执行');

// 再隔更久（模拟 AI 想了很久）→ 仍然不该弹
await sleep(1200);
const s3 = await doStep('手机输入');
ok(s3.askedConfirmation === false, '第 3 步（隔 1.2 秒）：依然不弹');

// 新的一条 AI 回复 = 新批次（beginBatch）→ 应该**重新**确认
rt.beginBatch();
rt.endRun();
const s4 = await doStep('手机点击');
ok(s4.askedConfirmation === true, '新批次（新一条 AI 回复）：重新确认（语义正确）');

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
