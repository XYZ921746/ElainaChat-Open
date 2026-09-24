// 回归检查：AI 手机操作的系统悬浮窗（打破"每步都要切回应用确认"的死循环）。
//
// 为什么需要：这是个**只有在真机上才会暴露**的交互缺陷 ——
//   AI 点击目标 App 的按钮
//     → 弹授权框（在 ElainaChat 内部）
//     → 用户切回 ElainaChat 点「允许」
//     → 切回来这一步把目标 App 切到后台，那次点击落到错的位置或直接失败
//     → AI 重试 → 又弹窗 … 死循环
// 修法是在原生层加系统悬浮窗（SYSTEM_ALERT_WINDOW / TYPE_APPLICATION_OVERLAY），
// 并让前端的授权流程**优先走悬浮窗、不可用时回退应用内弹窗**。
//
// 这个检查盯住三件事：
//   1. 原生侧：权限声明、悬浮窗类、插件方法是否齐备
//   2. 前端侧：授权流程是否**先试悬浮窗再回退**（不能只留一条路）
//   3. 生命周期：开跑时显示、结束/停止时收起（否则浮层会一直挂在屏幕上）
//
// 全程只读源码，不连真机、不触发任何下载。
//
// 用法：node scripts/check-agent-overlay.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label, detail) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

const JAVA_DIR = path.join(ROOT, 'android-app', 'android', 'app', 'src', 'main', 'java', 'com', 'elainachat', 'opensource');
const OVERLAY_JAVA = path.join(JAVA_DIR, 'ElainaOverlay.java');
const PLUGIN_JAVA = path.join(JAVA_DIR, 'ElainaShellPlugin.java');
const MANIFEST = path.join(ROOT, 'android-app', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const html = readFrontend();

// ============================================================ 1. 原生：权限声明
console.log('=== 1. 原生：权限声明 ===');
{
    const mf = readFileSync(MANIFEST, 'utf8');
    ok(mf.includes('android.permission.SYSTEM_ALERT_WINDOW'),
        'AndroidManifest 声明了 SYSTEM_ALERT_WINDOW（悬浮窗权限）');
}

// ============================================================ 2. 原生：悬浮窗实现
console.log('\n=== 2. 原生：ElainaOverlay 实现 ===');
ok(existsSync(OVERLAY_JAVA), 'ElainaOverlay.java 存在');
if (existsSync(OVERLAY_JAVA)) {
    const src = readFileSync(OVERLAY_JAVA, 'utf8');

    // 窗口类型：Android 8+ 必须用 TYPE_APPLICATION_OVERLAY
    ok(src.includes('TYPE_APPLICATION_OVERLAY'),
        '用 TYPE_APPLICATION_OVERLAY（Android 8+ 的悬浮窗类型）');
    ok(src.includes('canDrawOverlays'),
        '用 Settings.canDrawOverlays 检测权限');
    ok(src.includes('ACTION_MANAGE_OVERLAY_PERMISSION'),
        '用 ACTION_MANAGE_OVERLAY_PERMISSION 跳系统授权页');

    // 关键：不能持有 Activity —— 否则应用退到后台浮层就没了（而"随时能停"正需要它在后台也在）
    ok(!/extends\s+Activity|Activity\s+\w+\s*;/.test(src.replace(/getApplicationContext/g, '')),
        '不持有 Activity（挂在 ApplicationContext 上，应用退到后台浮层仍在）');

    // 必须有的四个能力
    ok(/static\s+void\s+show\s*\(/.test(src), '提供 show()（显示浮层）');
    ok(/static\s+void\s+hide\s*\(/.test(src), '提供 hide()（收起浮层）');
    ok(/static\s+void\s+askApproval\s*\(/.test(src), '提供 askApproval()（就地确认）');
    ok(/static\s+boolean\s+isShowing\s*\(/.test(src), '提供 isShowing()（状态查询）');

    // 浮层上必须有停止按钮
    ok(src.includes('停止'), '浮层上有「停止」按钮');
    ok(src.includes('允许') && src.includes('拒绝'), '浮层上有「允许 / 拒绝」按钮');

    // 不能被触摸穿透（否则浮层挡住的区域点不到目标应用）
    ok(src.includes('FLAG_NOT_FOCUSABLE'),
        '带 FLAG_NOT_FOCUSABLE（不抢焦点，目标应用照常收到输入）');
}

// ============================================================ 3. 原生：插件方法
console.log('\n=== 3. 原生：插件暴露的方法 ===');
{
    const src = readFileSync(PLUGIN_JAVA, 'utf8');
    for (const m of ['overlayStatus', 'requestOverlay', 'showOverlay', 'updateOverlay', 'askOverlayApproval', 'hideOverlay']) {
        ok(new RegExp('public\\s+void\\s+' + m + '\\s*\\(\\s*PluginCall').test(src),
            '插件暴露 ' + m + '()');
    }
    // 两个事件要能送回前端
    ok(src.includes('notifyListeners("overlayStop"'), '点停止时发 overlayStop 事件');
    ok(src.includes('notifyListeners("overlayApproval"'), '点允许/拒绝时发 overlayApproval 事件');
}

// ============================================================ 4. 前端：授权流程
console.log('\n=== 4. 前端：授权流程（先悬浮窗、后回退）===');
{
    // requestApprovalViaOverlay 必须存在，且 requestApproval 会调它
    ok(/function\s+requestApprovalViaOverlay\s*\(/.test(html), '有 requestApprovalViaOverlay()');
    ok(/await\s+requestApprovalViaOverlay\s*\(/.test(html), 'requestApproval 里真的调了它');

    // 关键：浮层不可用时必须**回退**到应用内弹窗，不能静默拒绝
    const fnStart = html.indexOf('async function requestApproval(');
    const fnEnd = html.indexOf('function requestApprovalViaOverlay(');
    ok(fnStart > 0 && fnEnd > fnStart, '能定位 requestApproval 函数体');
    if (fnStart > 0 && fnEnd > fnStart) {
        const body = html.slice(fnStart, fnEnd);
        ok(/ok\s*===\s*null/.test(body) || /===\s*null/.test(body),
            '识别"浮层不可用"的返回值（null）');
        ok(/showCustomModal\s*\(/.test(body),
            '浮层不可用时回退到应用内弹窗（不是静默拒绝）');
    }
}

// ============================================================ 5. 前端：生命周期
console.log('\n=== 5. 前端：浮层生命周期 ===');
{
    ok(/rt\.showOverlay\s*\(/.test(html), '开始操作时显示浮层');
    ok(/rt\.hideOverlay\s*\(/.test(html), '结束/停止时收起浮层');

    // 显示浮层的位置应该在 beginRun 附近（一次运行只开一次，不是每一步）
    const beginRunIdx = html.indexOf('rt.beginRun()');
    const showIdx = html.indexOf('rt.showOverlay(');
    ok(beginRunIdx > 0 && showIdx > beginRunIdx && showIdx - beginRunIdx < 900,
        '显示浮层紧跟在 beginRun 之后（一次运行开一次，不是每步都开）');

    // 停止时要收起
    ok(/requestStop[\s\S]{0,300}hideOverlay/.test(html) || /hideOverlay[\s\S]{0,200}requestStop/.test(html),
        '停止流程里会收起浮层');
}

// ============================================================ 6. 前端：权限引导
console.log('\n=== 6. 前端：权限引导（必须主动请求，不能只写句话）===');
{
    ok(html.includes('overlayEnableBtn'), '设置里有「开启悬浮窗」按钮');
    ok(html.includes('overlayStatusText'), '设置里有权限状态显示');
    ok(/function\s+refreshOverlayStatus\s*\(/.test(html), '有 refreshOverlayStatus()');
    ok(/function\s+enableOverlay\s*\(/.test(html), '有 enableOverlay()（跳系统设置）');
    ok(/need-permission/.test(html), '识别"需要授权"');

    // ★ 用户反馈过"应用不主动请求悬浮窗权限"。之前只 insertAgentResult 一句提示，
    // 用户得自己去设置里找三步。现在必须在操作流程里**主动弹确认框并可一键跳转**。
    const runStart = html.indexOf('async function runAgentPhoneOperation(');
    const runEnd = html.indexOf('// ===== 实现方式（后端选择）=====', runStart);
    const runBody = runStart > 0 && runEnd > runStart ? html.slice(runStart, runEnd) : '';
    ok(/showCustomModal\s*\(/.test(runBody),
        '操作流程里主动弹确认框（不只是写一句提示）');
    ok(/enableOverlay\s*\(\s*\{\s*quiet/.test(runBody),
        '用户点「去开启」后直达系统设置');
    ok(/overlayPromptDeclined/.test(html),
        '用户拒绝过就不再打扰（避免每次都拦）');

    // enableOverlay 在操作流程里要静默，否则说明框会叠在用户眼前
    ok(/function\s+enableOverlay\s*\(\s*opts\s*\)/.test(html) || /function\s+enableOverlay\s*\(\s*\w/.test(html),
        'enableOverlay 支持参数（供静默跳转用）');
}

// ============================================================ 7. 停止时必须了结等待中的确认
console.log('\n=== 7. 停止时不能挂住（曾漏掉的真 bug）===');
{
    // 坑：用户点「停止」而不是「允许/拒绝」时，requestApprovalViaOverlay 里那个
    // Promise 的 resolve 存在 overlayApprovalPending 里，没人调 → await 永远挂住。
    // 表现是"点了停止没反应"—— 而这恰恰是最需要它立刻停的时刻。
    // 所以 requestStop 与 overlayStop 两条路都要 pending(false)。
    const stopFn = html.slice(html.indexOf('function requestStop(reason)'), html.indexOf('function assertNotStopped()'));
    ok(/overlayApprovalPending/.test(stopFn), 'requestStop 里了结了等待中的浮层确认');
    ok(/pending\(false\)/.test(stopFn), '以"未允许"结束那个 Promise');

    const listener = html.slice(html.indexOf("addListener('overlayStop'"), html.indexOf("addListener('overlayApproval'"));
    ok(/overlayApprovalPending/.test(listener), '浮层「停止」回调里也了结了它');
    ok(/pending\(false\)/.test(listener), '同样以"未允许"结束');
}

// ============================================================ 8. 风险分级仍然生效
console.log('\n=== 8. 安全性没被破坏 ===');
{
    // dangerous 操作必须**无条件**询问（不受 agentApproval 策略影响）
    const start = html.indexOf('async function requestApproval(');
    const end = html.indexOf('function requestApprovalViaOverlay(');
    const body = start > 0 ? html.slice(start, end) : '';
    ok(/risk\s*!==\s*'dangerous'/.test(body), 'dangerous 操作不受"不询问"策略影响（仍然必问）');
    ok(/AGENT_RISK/.test(html), '风险分级表仍在使用');
}

// ============================================================ 9. 副屏监视窗
console.log('\n=== 9. 副屏监视窗（模块后端的"看画面"） ===');
{
    // 用途：AI 用「模块」后端时跑在独立虚拟副屏上，物理主屏看不到 ——
    // 这个窗口把副屏画面搬进应用，让用户知道 AI 在点什么。
    ok(/id="screenWatchPanel"/.test(html), '有副屏监视窗 DOM');
    ok(/id="screenWatchImg"/.test(html), '有画面元素');
    ok(/id="screenWatchPowerBtn"/.test(html), '有副屏启停按钮');
    ok(/function openScreenWatch\(/.test(html) && /function closeScreenWatch\(/.test(html),
        '有打开/关闭函数');
    ok(/SCREEN_WATCH_INTERVAL/.test(html), '有自动刷新间隔常量');

    // 入口只在「模块」后端时出现 —— 无障碍/Shizuku 在物理屏上操作，用户本来就看得见
    const renderFn = html.slice(html.indexOf('function render()'), html.indexOf('function beginBatch()'));
    ok(/agentWatchBtn/.test(renderFn), '运行状态条里的「看画面」按钮由 render 控制');
    ok(/__lastAgentBackend/.test(renderFn), '按**实际**用过的后端决定是否显示（"自动"模式下也要能判断）');
    ok(/useModule/.test(renderFn), '只在模块后端时才显示');
    ok(/running && useModule/.test(renderFn), '任务结束后按钮要收起来');

    // 生命周期：定时器必须能被停掉，否则关掉窗口后还在每 1.5 秒打原生层
    const closeFn = html.slice(html.indexOf('function closeScreenWatch()'), html.indexOf('// ==================== 日志设置'));
    ok(/screenWatchStopAuto\(\)/.test(closeFn), '★ 关闭监视窗时停掉自动刷新（否则后台一直轮询原生层）');

    // ★ 与设置面板的互斥：两者同为 z-index 100002 层，同时开着就由 DOM 顺序决定谁在上面。
    //   CSS 注释一直声称"打开监视窗前会先关掉设置"，但实现漏了这一步（已修）。
    const openFn = html.slice(html.indexOf('function openScreenWatch()'), html.indexOf('function closeScreenWatch()'));
    // 断言"真的会执行"，不能只断言字符串出现过 —— `false && closeSettingsPanel()` 也能匹配到
    // 名字，那种写法等于没关（变异测试抓到过这个假阳性）。
    ok(/if \(typeof closeSettingsPanel === 'function'\) closeSettingsPanel\(\);/.test(openFn),
        '★ 打开监视窗前先关掉设置面板（同为 100002 层，否则层叠顺序不确定）');

    // 授权确认框必须盖得住监视窗 —— 否则 AI 的确认弹窗被画面挡住，用户点不到
    ok(/#customModal \{ z-index: 100003 !important; \}/.test(html),
        '确认框层级（100003）高于监视窗（100002）');
    ok(/#screenWatchPanel \{ z-index: 100002 !important; \}/.test(html),
        '监视窗层级显式声明为 100002');
}

// ============================================================ 10. 原生侧：副屏接口
console.log('\n=== 10. 原生：副屏监视接口 ===');
{
    const plugin = readFileSync(PLUGIN_JAVA, 'utf8');
    ok(/public void liveFrame\(PluginCall call\)/.test(plugin), '原生有 liveFrame 方法（取副屏当前帧）');
    ok(/public void moduleDisplay\(PluginCall call\)/.test(plugin), '原生有 moduleDisplay 方法（副屏启停）');
    ok(/imageBase64/.test(plugin), 'liveFrame 回传 base64 画面');
    // 前端调用的方法名必须与原生一致 —— 拼错不会报错，只会静默失效
    ok(/typeof plugin\.liveFrame !== 'function'/.test(html), '前端按 liveFrame 调用（方法名与原生一致）');
    ok(/typeof plugin\.moduleDisplay !== 'function'/.test(html), '前端按 moduleDisplay 调用（方法名与原生一致）');
    ok(/plugin\.liveFrame\(\)/.test(html), 'liveFrame 被真正调用（不只是存在性检查）');
    ok(/plugin\.moduleDisplay\(\{\s*op:/.test(html), 'moduleDisplay 带上 op 参数（start / stop）');
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：' + failures.join('、'));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
