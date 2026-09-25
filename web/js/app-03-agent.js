/* ========================================================================
 * AI Agent：标签入口 / 运行时 / 手机操作 / 四种后端 / 续跑 / 定时任务
 *
 * 本文件由 web/index.html 的主脚本按分区拆分而来（保持原始加载顺序）。
 * 拆分前提：主脚本是全局作用域，拆分后各文件共享同一全局词法环境，
 * 因此顶层 function / const / let 互相可见，调用点无需修改。
 *
 * 包含分区：
 *   · AI Agent 操作入口
 *   · AI Agent 运行时
 *   · 系统悬浮窗的生命周期
 *   · 手机操作
 *   · 实现方式（后端选择）
 *   · Agent 自动续跑
 *   · 自然语言触发表情
 *   · 自然语言触发文件写入（已移除）
 *   · AI 定时任务（未来任务）
 * ======================================================================== */

// ===== AI Agent 操作入口：LLM 回复中的 [操作:xxx] 标签触发 =====
window.agentActions = {
    openVideoCall() { if (window.Live2DCall) window.Live2DCall.open(); },
    closeVideoCall() { if (window.Live2DCall) window.Live2DCall.close(); },
    organizeMemory() { void runManualMemorySummary(); },
    setLive2dBackground(v) { if (window.Live2DCall) window.Live2DCall.setBackground(v); },
    // 文件操作：解析 [操作:列出文件/查看文件/保存文件 …] 并执行（权限模式见设置）
    agentFileOperation(raw) {
        const permission = state.settings.agentPermission || 'app';
        const text = String(raw || '').trim();
        // 删除/改名类操作一律拒绝：文件操作接口本身就没有这两个动作（只有列出/读取/写入）。
        // 注意这不等于"不能覆盖" —— 覆盖一个已存在的文件走的是「保存文件」标签，
        // 由服务端的覆盖闸门 + 用户确认把关（见 confirmAgentOverwrite）。
        if (/删除|删掉|移除|重命名|改名|移动文件/.test(text)) {
            insertAgentResult('该操作不可用：文件操作只有「列出 / 读取 / 保存」三种，没有删除或改名。'
                + '需要删改已有的文件请手动操作；在「允许操作电脑」模式下也可以改用 [操作:电脑命令 …]，'
                + '但那会让你确认一次。');
            return;
        }
        let action = 'ls';
        let rest = text;
        if (/列出文件|列出目录|查看文件夹/.test(text)) { action = 'ls'; rest = text.replace(/列出文件|列出目录|查看文件夹/, '').trim(); }
        else if (/查看文件|读取文件|读文件/.test(text)) { action = 'read'; rest = text.replace(/查看文件|读取文件|读文件/, '').trim(); }
        else if (/保存文件|写入文件|写文件|创建文件/.test(text)) { action = 'write'; rest = text.replace(/保存文件|写入文件|写文件|创建文件/, '').trim(); }
        else { void doAgentFile('ls', { path: undefined }, permission); return; }

        // 去掉 AI 可能带的介词（到/在/至/保存到 等）与多余空格
        rest = rest.replace(/^(?:到|在|至|于|保存到|写入到|文件)\s*/, '').trim();

        if (action === 'write') {
            const sep = rest.indexOf('|');
            let path, content;
            if (sep >= 0) {
                path = rest.slice(0, sep).trim();
                content = rest.slice(sep + 1).trim();
            } else {
                // 无 |：路径 = 第一个 token（支持引号包裹），内容 = 剩余部分
                const m = rest.match(/^"([^"]+)"\s*([\s\S]*)$/) || rest.match(/^'([^']+)'\s*([\s\S]*)$/) || rest.match(/^(\S+)\s*([\s\S]*)$/) || [null, rest, ''];
                path = (m[1] || '').trim();
                content = (m[2] || '').trim();
            }
            path = path.replace(/^["']|["']$/g, '').trim();
            void doAgentFile('write', { path, content }, permission);
        } else {
            rest = rest.replace(/^["']|["']$/g, '').trim();
            void doAgentFile(action, { path: rest || undefined }, permission);
        }
    },
    // 手机操作：[操作:手机点击 500 800] 等。
    // 「停止检查 + 敏感操作授权」由 agentRuntime 统一处理（见 runAgentPhoneOperation）。
    agentPhoneOperation(raw) {
        void runAgentPhoneOperation(raw);
    },
    // 电脑命令：[操作:电脑命令 dir] 等（第二阶段 ④）。
    // 只在「允许操作电脑」模式下可用；危险命令由服务端判定后再问用户
    // （见 doAgentCommand 与 server/pc-command.mjs）。
    agentCommandOperation(raw) {
        const text = String(raw || '').trim();
        // 剥掉触发前缀，剩下的就是命令原文
        const command = text.replace(/^(?:电脑命令|执行命令|运行命令|电脑执行)\s*/, '').trim();
        if (!command) {
            insertAgentResult('没有给出要执行的命令。请用 [操作:电脑命令 <命令>] 的格式。');
            return;
        }
        void doAgentCommand(command, state.settings.agentPermission || 'app');
    }
};


// ===== AI Agent 运行时：可随时停止 + 敏感操作需用户授权 =====
// 设计：
//  1. 停止是「请求式」——设置标志、中断在途请求、关掉等待中的确认弹窗，
//     再由各执行点调用 assertNotStopped() 主动退出。不强杀，避免留下半完成状态。
//  2. 授权按风险分级：safe 不问 / sensitive 可配置 / dangerous 必问。
//     被拒绝不静默失败，回灌给模型让它换方式。
const AGENT_RISK = {
    '手机状态': 'safe',
    '手机查看界面': 'safe',
    '手机截图': 'safe',
    '手机等待': 'safe',
    '手机点击': 'sensitive',
    '手机滑动': 'sensitive',
    '手机输入': 'sensitive',
    '手机按键': 'sensitive',
    '手机打开': 'sensitive',
    '手机命令': 'dangerous',
    // 电脑命令：危险的那部分由**服务端**再判一次并强制授权（见 server/pc-command.mjs），
    // 这里标 sensitive 是让"安全命令"不打扰用户、危险命令走同一条授权 UI。
    // 访问文件夹外：调用时一律带 forceAsk，所以这里的档位只是兜底（不会被豁免吞掉）。
    '访问文件夹外': 'sensitive',
    // 为什么不在前端也标 dangerous：前端标了会把 `dir` 这种也变成每次必问，
    // 而真正的危险判定要穷举命令语义，只有服务端那份规则表是权威。
    '电脑命令': 'sensitive'
};

const agentRuntime = (function () {
    let running = false;
    let stopRequested = false;
    let halted = false;          // 本批次已被用户停止：拒绝后续动作，直到下一批开始
    let stopReason = '';
    let step = 0;
    let currentAction = '';
    const approvedThisRun = new Set();   // 策略为 run 时，本次运行内已授权的动作
    const aborters = new Set();          // 在途请求的 AbortController
    let approvalOpen = false;

    // ---- 系统悬浮窗（APK 独有）----
    // 浮层上常驻「停止」，需要确认时出现「允许 / 拒绝」。
    // 它的价值在于：AI 操作的是**别的 App**，用户不用切回 ElainaChat 就能操作 ——
    // 切回来会把目标 App 切到后台，那次操作就失败了（死循环的根源）。
    let overlayListenerReady = false;
    let overlayApprovalPending = null;   // 等待浮层回应的 resolve 函数

    const barEl = () => document.getElementById('agentRunBar');
    const textEl = () => document.getElementById('agentRunText');
    const stepEl = () => document.getElementById('agentRunStep');
    const stopBtnEl = () => document.getElementById('agentStopBtn');

    function render() {
        const b = barEl();
        if (!b) return;
        b.classList.toggle('hidden', !running);
        b.classList.toggle('flex', running);
        b.classList.toggle('is-stopping', stopRequested);
        const t = textEl();
        if (t) t.textContent = stopRequested ? '正在停止' : (currentAction ? 'AI 正在操作' : 'AI 正在思考');
        const s = stepEl();
        if (s) s.textContent = running ? ('第 ' + step + ' 步' + (currentAction ? ' · ' + currentAction : '')) : '';
        const btn = stopBtnEl();
        if (btn) { btn.disabled = stopRequested; btn.textContent = stopRequested ? '停止中' : '停止'; }
        // 「看画面」只在**任务进行中且用模块后端**时出现 ——
        // 模块的价值就是独立副屏，只有那条路才有"画面"可看；
        // 无障碍/Shizuku 是在物理屏上操作，用户本来就看得见。
        const watch = document.getElementById('agentWatchBtn');
        if (watch) {
            // lastUsedBackendId 定义在 IIFE 外（手机操作执行层里），用 window 桥接读
            const used = String(window.__lastAgentBackend || '');
            const useModule = (typeof currentBackendId === 'function' && currentBackendId() === 'module')
                || used === 'module';
            watch.classList.toggle('hidden', !(running && useModule));
        }
    }

    /** 每条 AI 回复的处理入口调用一次：开启新批次，解除上一批留下的停止状态 */
    function beginBatch() {
        halted = false;
        // 「每次运行只确认一次」的"本轮"以**批次**为单位，不是 beginRun ——
        //
        // 真机实测发现的坑：AI 的每一步之间有"续跑间隔"（模型要生成下一步），
        // 间隔一超过 phoneRunEndTimer 的 600ms，endRun 就把 running 置 false；
        // 下一步进来时 beginRun 重新开跑并把 approvedThisRun 清空 ——
        // 于是**每一步都变成"本轮第一次"**，用户看到的还是每步一确认，
        // 策略等于没改（这正是用户反复反馈的现象，同步测试根本测不出来）。
        // 批次只在新的一条 AI 回复时由 beginBatch 重置，才是用户心智里的"一次运行"。
        if (String(state.settings.agentApproval || 'once') === 'once') {
            approvedThisRun.clear();
        }
    }

    function beginRun() {
        running = true;
        stopRequested = false;
        stopReason = '';
        step = 0;
        currentAction = '';
        // once 策略下**不清**已确认记录（在 beginBatch 里清）——
        // run 会因续跑间隔反复启停，clear 放这里等于每步都重置。
        // run / always 策略保持原行为（run 按 action 名去重也跨步，同样不该被
        // endRun/re-begRun 冲掉 —— 但为了不改变既有行为，只在 once 生效的新语义里动）。
        if (String(state.settings.agentApproval || 'once') !== 'once') {
            approvedThisRun.clear();
        }
        render();
    }

    function endRun() {
        running = false;
        stopRequested = false;
        aborters.clear();
        currentAction = '';
        render();
    }

    function requestStop(reason) {
        if (!running || stopRequested) return false;
        stopRequested = true;
        halted = true;              // 粘性：本批次后续动作一律拒绝，避免停止后又自己重启
        stopReason = String(reason || '用户停止');
        for (const c of aborters) { try { c.abort(); } catch (e) { /* 忽略 */ } }
        aborters.clear();
        // 关掉正在等待的确认弹窗（按「拒绝」处理）
        if (approvalOpen) {
            // 应用内弹窗这条路：点它的「取消」
            try { elements.customModalCancelBtn?.click(); } catch (e) { /* 忽略 */ }
            // 悬浮窗这条路：把它等着的那个 Promise 了结掉。
            // 两条路都要关 —— 只关其中一条会让另一种情况下的 await 永远挂住。
            const pending = overlayApprovalPending;
            overlayApprovalPending = null;
            if (pending) pending(false);
        }
        render();
        return true;
    }

    function assertNotStopped() {
        if (!stopRequested) return;
        const err = new Error(stopReason || '已停止');
        err.agentAborted = true;
        throw err;
    }

    /** 把在途请求的 controller 交给运行时，停止时统一中断 */
    function track(controller) {
        if (controller && typeof controller.abort === 'function') aborters.add(controller);
        return controller;
    }

    function riskOf(action) { return AGENT_RISK[action] || 'sensitive'; }

    /**
 * 敏感操作授权。返回 true 表示可以执行。
 *
 * @param {string} action 操作名（决定风险级别）
 * @param {string} detail 给用户看的具体内容
 * @param {object} [opts] { forceAsk: true } —— 无视"已确认豁免"，这一条必须问
 */
    async function requestApproval(action, detail, opts = {}) {
        const risk = riskOf(action);
        if (risk === 'safe') return true;
        if (stopRequested) return false;
        const policy = state.settings.agentApproval || 'once';
        // ★ forceAsk：调用方已经知道这一条**具体**是危险的（例如服务端判定某条
        //   电脑命令为 dangerous）。操作名本身是 sensitive 不够 —— 因为
        //   「电脑命令」这一类里既有 `dir` 也有 `del`，只有服务端知道这一次是哪一种。
        //
        //   为什么必须绕过豁免：豁免是按**操作名**记的（once 策略下"确认过一次就
        //   全放行"）。若不绕过，用户确认过一次任意敏感操作之后，一条 `del` 就会
        //   静默执行 —— 直接违背"危险系统命令执行前需授权"。
        const mustAsk = opts.forceAsk === true;
        if (risk !== 'dangerous' && !mustAsk) {
            if (policy === 'off') return true;
            // 「每次运行只确认一次」：只要这一轮里用户确认过**任何**敏感操作，
            // 后面的点击/滑动/输入都直接放行 —— 停止靠悬浮窗，不靠反复确认。
            if (policy === 'once' && approvedThisRun.size > 0) return true;
            // 「每类操作各确认一次」：同名操作（手机点击/手机滑动/...）只问第一次
            if (policy === 'run' && approvedThisRun.has(action)) return true;
        }
        const askRisk = mustAsk ? 'dangerous' : risk;
        const lines = ['AI 想执行：' + action];
        if (detail) lines.push('', detail);
        lines.push('', askRisk === 'dangerous'
            ? '这是可以执行任意系统命令的操作，风险很高，请确认你信任当前对话里出现的内容。'
            : '该操作会改变手机状态。拒绝后 AI 会收到通知并尝试别的方式，不会卡住。');
        if (askRisk !== 'dangerous' && (policy === 'always' || policy === 'run')) {
            lines.push('', '（想减少打扰：设置 → 能力 → 手机操作，把确认策略改为「每次运行只确认一次」）');
        }

        // ★ 优先走**系统悬浮窗**确认。
        //
        // 为什么：AI 操作的是别的 App，而应用内弹窗要用户切回 ElainaChat 才看得到 ——
        // 切回来这一步会把目标 App 切到后台，那次操作就落到错的位置或直接失败，
        // AI 重试又弹窗，形成死循环。悬浮窗浮在目标 App 之上，用户不离开当前界面
        // 就能点「允许 / 拒绝」。
        //
        // 悬浮窗不可用（没授权 / 没显示）时**回退到应用内弹窗** ——
        // 不能因为浮层不可用就静默拒绝，那会让功能看起来"坏了"。
        approvalOpen = true;
        let ok = false;
        try {
            ok = await requestApprovalViaOverlay(action, detail);
        } catch (e) { ok = false; }
        if (ok === null) {
            // 悬浮窗这条路走不通 → 应用内弹窗
            try {
                ok = await showCustomModal({
                    title: askRisk === 'dangerous' ? '危险操作确认' : '敏感操作确认',
                    message: lines.join('\n'),
                    confirmText: '允许这次',
                    cancelText: '拒绝'
                });
            } catch (e) { ok = false; }
        }
        approvalOpen = false;
        if (!ok) return false;
        // 「每次运行只确认一次」：记下任意一个 action 就代表"本轮已确认"（用 size 判断）。
        // 「每类各一次」：按 action 名记。
        approvedThisRun.add(action);
        return !stopRequested;   // 用户可能在弹窗期间点了停止
    }

    /**
     * 通过系统悬浮窗请求确认。
     *
     * @returns true/false = 用户在浮层上做出了选择；**null = 浮层不可用，调用方应回退到应用内弹窗**
     */
    function requestApprovalViaOverlay(action, detail) {
        const plugin = deviceBridge();
        // 只有安卓版、且原生层提供了这个方法、且浮层正在显示时才走这条路
        if (!plugin || typeof plugin.askOverlayApproval !== 'function') return Promise.resolve(null);
        if (!overlayListenerReady) return Promise.resolve(null);

        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                overlayApprovalPending = null;
                resolve(value);
            };
            // 与"停止"竞争：用户可能在浮层上直接点停止而不是允许/拒绝
            overlayApprovalPending = finish;

            plugin.askOverlayApproval({ action: detail ? (action + ' —— ' + detail) : action })
                .then((res) => {
                    if (res && res.fallback) finish(null);      // 浮层不在 → 回退
                    else if (res && res.ok === false) finish(null);
                    // ok=true 时等原生发 overlayApproval 事件
                })
                .catch(() => finish(null));
        });
    }

    function setStep(n, action) {
        step = Number(n) || 0;
        currentAction = String(action || '');
        render();
        // 同步到系统悬浮窗：用户切到别的 App 时，这里是他唯一能看到进度的位置
        updateOverlayStep();
        // 记进副屏监视窗的「最近动作」（setStep 在 IIFE 里，用 window 上的钩子跨作用域）
        if (typeof window.__screenWatchNote === 'function') {
            window.__screenWatchNote(action);
        }
    }


    // ==================== 系统悬浮窗的生命周期 ====================

    /** 取原生设备层。与外面那个 deviceBridge 同样的逻辑，这里内联一份避免依赖定义顺序 */
    function nativeBridge() {
        if (window.ElainaDevice) return window.ElainaDevice;
        const p = window.Capacitor?.Plugins?.ElainaDevice;
        if (p) { window.ElainaDevice = p; return p; }
        return null;
    }

    /** 挂一次原生事件监听（悬浮窗上的「停止」「允许/拒绝」由它送进来） */
    function ensureOverlayListener() {
        if (overlayListenerReady) return;
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.addListener !== 'function') return;
        overlayListenerReady = true;

        // 用户在浮层上点了「停止」→ 等同于点了应用内的停止
        plugin.addListener('overlayStop', () => {
            requestStop('用户在悬浮窗上点了停止');
            // ★ 必须把"正在等确认"的那个 Promise 也了结掉。
            // 否则用户点停止（而不是允许/拒绝）时，requestApproval 会永远 await 下去 ——
            // 表现是"点了停止没反应"，而这正是用户最需要它立刻停的时刻。
            const pending = overlayApprovalPending;
            overlayApprovalPending = null;
            if (pending) pending(false);
        });

        // 用户在浮层上点了「允许 / 拒绝」
        plugin.addListener('overlayApproval', (data) => {
            const pending = overlayApprovalPending;
            overlayApprovalPending = null;
            if (pending) pending(Boolean(data && data.allowed));
        });
    }

    /** AI 开始操作手机时显示浮层。没有权限时返回 false（调用方会引导用户去开）。 */
    async function showOverlay(text) {
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.showOverlay !== 'function') return false;
        ensureOverlayListener();
        try {
            const res = await plugin.showOverlay({ text: text || 'AI 正在操作手机' });
            if (res && res.needPermission) return 'need-permission';
            return Boolean(res && res.ok);
        } catch (e) {
            return false;
        }
    }

    function updateOverlayStep() {
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.updateOverlay !== 'function') return;
        const label = stopRequested
            ? '正在停止…'
            : ('第 ' + step + ' 步' + (currentAction ? ' · ' + currentAction : ''));
        try { void plugin.updateOverlay({ text: label }); } catch (e) { /* 浮层没了就忽略 */ }
    }

    function hideOverlay() {
        const plugin = nativeBridge();
        if (!plugin || typeof plugin.hideOverlay !== 'function') return;
        try { void plugin.hideOverlay(); } catch (e) { /* 忽略 */ }
    }

    return {
        beginBatch, beginRun, endRun, requestStop, assertNotStopped, track, requestApproval, setStep, render,
        isRunning: () => running,
        isStopRequested: () => stopRequested,
        isHalted: () => halted,
        getStep: () => step,
        riskOf,
        // 悬浮窗
        showOverlay,
        hideOverlay,
        ensureOverlayListener
    };
})();

window.agentRuntime = agentRuntime;

document.getElementById('agentStopBtn')?.addEventListener('click', () => {
    if (agentRuntime.requestStop('用户点了停止')) {
        // 停止后收起悬浮窗（否则它会一直挂在屏幕上，用户以为还在跑）
        if (agentRuntime.hideOverlay) agentRuntime.hideOverlay();
        insertAgentResult('已停止：用户手动中止了 AI 的手机操作，后续动作没有执行。如需继续，请重新告诉 AI 要做什么，或让它先说明刚才做到哪一步。');
    }
});


// ===== 手机操作：解析 [操作:手机xxx …] → 停止检查 → 授权 → 执行 → 回灌 =====
// 原生设备层由 ElainaShellPlugin 提供（@CapacitorPlugin name="ElainaDevice"）。
// Capacitor 注册原生插件后会往页面注入 window.Capacitor.Plugins.ElainaDevice，
// 这里给它挂一个 window.ElainaDevice 别名，让执行层不用关心它从哪来。
// 网页版上这个别名是空的，执行时会明确提示「设备能力还没接入」。
// 设计详见 手机Agent设计.md。
function deviceBridge() {
    if (window.ElainaDevice) return window.ElainaDevice;
    const nativePlugin = window.Capacitor?.Plugins?.ElainaDevice;
    if (nativePlugin) {
        window.ElainaDevice = nativePlugin;
        return nativePlugin;
    }
    return null;
}
// 提前挂一次（正常时序下此时已经注入完毕），拿不到也不影响后续按需获取
void deviceBridge();
const AGENT_PHONE_OPS = [
    '手机查看界面', '手机状态', '手机截图', '手机等待',
    '手机点击', '手机滑动', '手机输入', '手机按键', '手机打开', '手机命令'
];

let phoneOpsInFlight = 0;
let phoneRunEndTimer = null;
// 最近一次手机操作**实际**用的后端（原生在结果里回报）。
// 运行状态条的「看画面」按钮靠它判断该不该出现 —— 只有模块后端有副屏画面。
let lastUsedBackendId = '';
// 悬浮窗权限提示：用户明确点过「这次不用」就别每次都拦（那会变成新的打扰）
let overlayPromptDeclined = false;

function parsePhoneOperation(text) {
    const s = String(text || '').trim();
    for (const action of AGENT_PHONE_OPS) {
        if (s.startsWith(action)) return { action, args: s.slice(action.length).trim() };
    }
    return null;
}

function describePhoneOperation(parsed) {
    const a = parsed.args;
    switch (parsed.action) {
        case '手机点击': return a ? '点击坐标：' + a : '点击（没有给出坐标）';
        case '手机滑动': return a ? '滑动：' + a : '滑动（没有给出坐标）';
        case '手机输入': return a ? '要输入的文字：' + a : '输入（没有给出文字）';
        case '手机按键': return a ? '按键：' + a : '按键（没有给出键名）';
        case '手机打开': return a ? '要打开的应用：' + a : '打开应用（没有给出包名）';
        case '手机等待': return a ? '等待 ' + a + ' 毫秒' : '等待';
        case '手机命令': return '要执行的命令：' + a;
        case '手机截图': return '截取当前屏幕画面';
        case '手机查看界面': return '读取当前界面的控件树';
        case '手机状态': return '查询设备与后端状态';
        default: return '';
    }
}

async function execPhoneOperation(parsed) {
    const dev = deviceBridge();
    if (!dev || typeof dev.exec !== 'function') {
        throw new Error('设备能力还没接入：这个版本里没有手机操作的原生插件，这一步没有真正执行。'
            + '（网页版就是这样，请用带原生设备层的 APK）');
    }
    const res = await dev.exec({
        action: parsed.action,
        args: parsed.args,
        // 把用户选的实现方式带下去。原生侧优先用它；它不可用时明确报错，
        // 而不是偷偷换成另一种 —— 否则用户以为在走 root，实际走的是无障碍，没法排查。
        backend: currentBackendId()
    });
    let text = (res && (res.text || res.message)) || (parsed.action + ' 完成');
    // 记下**实际**用的后端（原生会回报 res.backend）。
    // 用途：只有模块后端才有"副屏画面"可看 —— 运行状态条上的「看画面」按钮
    // 据此显示/隐藏。不记这个的话，用户选的是"自动"，就无从判断走没走模块。
    if (res && res.backend) {
        lastUsedBackendId = String(res.backend);
        // render() 在 agentRuntime 的 IIFE 里，读不到这个变量 —— 桥到 window
        window.__lastAgentBackend = lastUsedBackendId;
    }
    // 截图：原生把图片以 base64 带回来。交给已配置的视觉模型看一眼，
    // 把「屏幕上是什么」变成文字回灌给主模型 —— 与「图片理解」复用同一条链路。
    if (res && res.imageBase64 && parsed.action === '手机截图') {
        text = await describePhoneScreenshot(res, text);
    }
    return text;
}

/** 把手机截图交给视觉模型转述。没配视觉模型时如实说明，不静默吞掉。 */
async function describePhoneScreenshot(res, fallbackText) {
    const dataUrl = 'data:' + (res.imageMime || 'image/jpeg') + ';base64,' + res.imageBase64;
    const hasVision = Boolean(
        String(state.settings.visionBaseUrl || '').trim() && String(state.settings.visionModel || '').trim()
    );
    if (!hasVision) {
        return fallbackText + '\n（没有配置视觉模型，所以我拿不到画面内容。'
            + '在「设置 → 视觉」填一个多模态模型后我就能看见屏幕了；或者改用「手机查看界面」直接读控件树。）';
    }
    try {
        const described = await describeImageWithVision(
            '这是我手机当前的屏幕截图。请简短回答三点：'
            + '1) 这是什么界面（哪个应用、什么页面）；'
            + '2) 界面上有哪些可点的按钮和输入框，各自大致在什么位置（用「上方/中间/下方 + 左/中/右」描述）；'
            + '3) 屏幕上有没有明显的文字提示或弹窗。只描述你确实看到的，不要猜。',
            dataUrl
        );
        if (!described || !described.trim()) return fallbackText;
        return fallbackText + '\n\n【画面内容】\n' + described.trim();
    } catch (err) {
        const reason = String(err?.message || err || '');
        console.error('[Agent] 手机截图转述失败:', err);
        return fallbackText + '\n（截图拿到了，但视觉模型没能看：' + reason.slice(0, 200) + '）';
    }
}

async function runAgentPhoneOperation(raw) {
    const rt = window.agentRuntime;
    if (!rt) { insertAgentResult('手机操作不可用：Agent 运行时没有初始化。'); return; }
    const parsed = parsePhoneOperation(raw);
    if (!parsed) {
        insertAgentResult('无法识别的手机操作：' + String(raw || '').trim()
            + '\n可用写法：手机状态 / 手机查看界面 / 手机截图 / 手机点击 x y / 手机滑动 x1 y1 x2 y2 [时长] / 手机输入 文字 / 手机按键 返回|主页|回车 / 手机打开 包名 / 手机等待 毫秒');
        return;
    }
    // 还没选实现方式 → 手机操作不可用（与「设置 → 能力 → 手机操作」里的状态提示一致）
    if (!currentBackendId()) {
        insertAgentResult('已跳过：还没有选择「实现方式」，AI 现在不能操作手机。'
            + '请到「设置 → 能力 → 手机操作」点「选择实现方式」选一种。');
        return;
    }
    // 总开关关掉时直接拒绝（设置 → 能力 → 手机操作）
    if (state.settings.agentPhoneEnabled === false) {
        insertAgentResult('已跳过：手机操作总开关是关闭的。需要时请在 设置 → 能力 → 手机操作 里打开「允许 AI 操作手机」。');
        return;
    }
    // 本批次已被用户停止：不再执行任何动作。这是「停止」能拦住后续步骤的关键——
    // 否则每一步都会重新 beginRun 把停止标志清掉，等于没停。
    if (rt.isHalted && rt.isHalted()) {
        insertAgentResult('已停止：用户中止了本次操作，这一步（' + parsed.action + '）没有执行。');
        return;
    }
    phoneOpsInFlight += 1;
    clearTimeout(phoneRunEndTimer);
    if (!rt.isRunning()) {
        rt.beginRun();
        // ★ 这一步是"不用切回应用就能停"的关键：操作开始时把系统悬浮窗显示出来。
        // 它浮在目标 App 之上，用户在当前界面就能看到进度、随时点停止。
        // 这一步**不阻塞**：拿不到权限只是少了个便利，操作照常进行（回退到应用内确认）。
        if (rt.showOverlay) {
            void rt.showOverlay('AI 正在操作手机').then(async (ok) => {
                if (ok !== 'need-permission') return;
                // 没有权限 → 主动引导去开，而不是只在对话里写一句话。
                //
                // 之前只 insertAgentResult 一句提示，结果是：用户要自己在设置里找到
                // 「手机操作」、再点「开启悬浮窗」、再跳系统设置 —— 三步都不在眼前，
                // 于是实际表现就是"应用从不主动请求悬浮窗权限"。
                // 这里改成：弹一个确认框，用户点「去开启」就直接跳系统设置页。
                //
                // 只问一次：用户明确拒绝过就别每次都拦（那会变成新的打扰）。
                // 但**跳去授权后回来**要允许再问 —— 因为那时他可能还没开成功。
                if (overlayPromptDeclined) return;
                const go = await showCustomModal({
                    title: '需要悬浮窗权限',
                    message: 'AI 正在操作手机。\n\n'
                        + '没有悬浮窗权限时，每一步确认都要你切回本应用来点 ——\n'
                        + '而切回来会让被操作的应用退到后台，那一步操作就可能失败，\n'
                        + 'AI 只能重试，看起来像卡住了。\n\n'
                        + '开了之后屏幕上会浮一个小条：随时点停止、需要确认时就地允许，\n'
                        + '全程不用切回本应用。\n\n'
                        + '现在去系统设置里打开「显示在其他应用上层」？',
                    confirmText: '去开启',
                    cancelText: '这次不用',
                }).catch(() => false);
                if (go) {
                    await enableOverlay({ quiet: true });   // 跳系统设置（不再叠说明框）
                } else {
                    overlayPromptDeclined = true;
                }
            });
        }
    }
    try {
        rt.assertNotStopped();
        rt.setStep(rt.getStep() + 1, parsed.action);
        // 过程记录：把这一步记进回合过程区（对话里那条可折叠的"工具调用行"）。
        // 记的是**用户能看懂的事实**：做了什么、参数是什么、结果如何。
        // 这些记录与思考开关无关 —— 关掉思考也照样显示。
        const traceItem = recordTurnTool({
            kind: 'phone',
            title: '手机 · ' + parsed.action,
            summary: describePhoneOperation(parsed),
            args: parsed.args ? JSON.stringify(parsed.args) : '',
            state: 'running'
        });
        // safe 直接放行；sensitive 按设置里的策略询问；dangerous 必问
        const allowed = await rt.requestApproval(parsed.action, describePhoneOperation(parsed));
        if (!allowed) {
            updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许这一步' });
            insertAgentResult('已跳过「' + parsed.action + '」：用户没有允许这一步。请换一种方式，或先向用户说明为什么要这么做。');
            return;
        }
        rt.assertNotStopped();
        // 这一步真的执行了 → 让 AI 接着决定下一步（见 insertAgentResult 的说明）
        const opResult = await execPhoneOperation(parsed);
        updateTurnTool(traceItem, { state: 'ok', result: opResult });
        insertAgentResult(opResult, { continueLoop: true });
    } catch (err) {
        if (err && err.agentAborted) {
            insertAgentResult('已停止：用户中止了操作，剩余步骤没有执行。');
        } else {
            insertAgentResult('手机操作失败：' + ((err && err.message) || err));
        }
    } finally {
        phoneOpsInFlight -= 1;
        if (phoneOpsInFlight <= 0) {
            clearTimeout(phoneRunEndTimer);
            // 一批操作处理完再收起状态条；若紧接着又来新操作会重新计时
            phoneRunEndTimer = setTimeout(() => {
                if (phoneOpsInFlight <= 0) {
                    rt.endRun();
                    // 悬浮窗与状态条同进退：操作结束就收起，别留在屏幕上碍事
                    if (rt.hideOverlay) rt.hideOverlay();
                }
            }, 600);
        }
    }
}


// ===== 实现方式（后端选择）=====
// 四种执行方式，能力与门槛不同。入口在「设置 → 能力 → 手机操作」里（不在侧边栏：
// 手机上侧边栏一收起，那里就进不去了），面板本身是一个独立弹窗（#backendPanel）。
// 状态由原生层 ElainaDevice.status() 提供；网页版没有原生层，统一显示「需要在 APK 里使用」。
// 设计详见 手机Agent设计.md 第三、六节。
const AGENT_BACKENDS = [
    {
        id: 'accessibility', name: '无障碍', tag: '免 root',
        desc: '用系统自带的无障碍服务点击、输入、读取界面。不用装任何东西，门槛最低；中文输入也只有它能可靠做到。',
        need: '系统设置 → 无障碍里开启本应用的服务'
    },
    {
        id: 'shizuku', name: 'Shizuku', tag: '免 root',
        desc: '借 Shizuku 把本应用提到 adb 级别的权限，能力接近 root，但不用 root 手机。',
        need: '装好 Shizuku 并启动服务，再给本应用授权'
    },
    {
        id: 'root', name: 'Root', tag: '需要 root',
        desc: '应用直接以 root 身份执行命令，不依赖电脑。',
        need: '手机已 root（KernelSU / Magisk / APatch），并给本应用授权一次'
    },
    {
        id: 'module', name: '模块', tag: '需要 KernelSU',
        desc: '刷入系统模块，后台静默操作：不抢前台、不被后台清理打断，能力最强。',
        need: '刷入 KernelSU 模块（本机 3070 端口有服务）'
    }
];

// 每个实现方式对应的「去设置 / 请求权限」引导。
// plugin/method 指向原生插件 ElainaDevice 上的真实方法：在场就真跳转 / 真弹授权框，
// 返回的说明（比如"没能拿到 root 权限，原因是…"）会直接展示给用户；
// 插件不在（网页版）时退化成下面的说明文字。代码只有一份，两种情况都给出可执行的下一步。
const AGENT_BACKEND_SETUP = {
    accessibility: {
        label: '去开启无障碍',
        plugin: 'ElainaDevice', method: 'openAccessibilitySettings',
        guide: [
            '1. 打开系统的「设置 → 无障碍」（部分机型叫「辅助功能」）',
            '2. 在已安装的服务里找到「ElainaChat Open 手机操作」',
            '3. 打开开关并按提示确认',
            '',
            '各厂商路径：小米在「更多设置 → 无障碍」；华为 / 荣耀在「辅助功能 → 无障碍」；OPPO / 一加在「系统设置 → 无障碍」。'
        ].join('\n')
    },
    shizuku: {
        label: '请求 Shizuku 授权',
        plugin: 'ElainaDevice', method: 'requestShizuku',
        guide: [
            'Shizuku 能让本应用获得 adb 级别的能力，接近 root，但不需要手机真的 root。',
            '',
            '1. 安装 Shizuku 应用（开源，应用商店或 GitHub 都有）',
            '2. 打开 Shizuku 并启动服务：已 root 的手机可以直接在 Shizuku 里点「启动」；'
            + '没有 root 的话，Shizuku 会让你用电脑通过 adb 启动一次（手机开「无线调试」也可以，不用数据线）',
            '3. 回到本应用，点「请求 Shizuku 授权」，在弹框里点「允许」',
            '',
            '注意：非 root 情况下每次重启手机都要手动启动一次 Shizuku，这是系统限制，不是应用的问题。'
        ].join('\n')
    },
    root: {
        label: '请求 root 授权',
        plugin: 'ElainaDevice', method: 'requestRoot',
        guide: [
            '1. 确认手机已经 root（KernelSU / Magisk / APatch 之一）',
            '2. 点这个按钮会发起一次 su 请求，管理器会弹出授权框，选「允许」并勾选「记住选择」',
            '3. 回来点「重新检测」，状态会变成「已授权」',
            '',
            '注意：root 授权等于把整台手机的控制权交给本应用。请确认你信任当前安装的版本，'
            + '并且只在自己手动触发的场景下使用。'
        ].join('\n')
    },
    module: {
        label: '怎么刷模块',
        guide: [
            '模块方式需要先在手机上刷入 KernelSU 模块，它会提供一个本地服务（默认 127.0.0.1:3070）。',
            '',
            '1. 确认手机已刷 KernelSU 并装好管理器',
            '2. 刷入模块后重启手机',
            '3. 回来点「重新检测」，状态会变成「已就绪」',
            '',
            '刷上之后 AI 可以后台静默操作手机，不抢占你正在用的界面，是几种方式里体验最好的。',
            '如果模块用的不是 3070 端口，需要改网关地址（目前只能改代码里的默认值）。'
        ].join('\n')
    }
};

const backendStatus = {};   // id -> { state, text }

/** 当前选定的实现方式；空字符串表示还没选过 */
function currentBackendId() {
    const id = state.settings.agentBackend || '';
    return AGENT_BACKENDS.some((b) => b.id === id) ? id : '';
}

function backendNameOf(id) {
    const found = AGENT_BACKENDS.find((b) => b.id === id);
    return found ? found.name : '';
}

/**
 * 注入系统提示词的「手机操作」能力说明。
 *
 * 为什么必须有这一段：整个执行链路（标签解析 → 停止检查 → 授权 → 原生 exec → 结果回灌）
 * 早就是通的，但**提示词里从来没有告诉过模型它有能力操作手机** ——
 * LIVE2D_TAG_GUIDE 的【操作标签】只列了 7 个应用内操作，一个 `手机*` 都没有。
 * 模型不知道标签存在，就永远不会输出它，用户看到的现象正是"AI 好像不能操作手机"。
 *
 * 分三档，避免"告诉了却做不到"：
 *   · 没有原生设备层（网页版）→ 不注入。用户界面上也没有这块设置，提了只会让模型空谈。
 *   · 有设备层但没选实现方式 / 总开关关着 → 注入"未启用"说明，并**明确禁止输出标签**
 *     （那些标签会被 runAgentPhoneOperation 直接拒绝）。这样模型会去引导用户开设置，
 *     而不是编造"我操作好了"。
 *   · 可用 → 注入完整能力清单 + 工作方式 + 反幻觉约束。
 */
function agentPhoneSkillText() {
    if (!deviceBridge()) return '';
    const backend = currentBackendId();
    const enabled = state.settings.agentPhoneEnabled !== false;
    if (!backend || !enabled) {
        return '# Agent Skill：手机操作（当前未启用）\n'
            + '这台设备支持手机操作，但用户还没有在「设置 → 能力 → 手机操作」里选好「实现方式」'
            + (enabled ? '' : '，或「允许 AI 操作手机」总开关是关闭的') + '。\n'
            + '因此你现在**不能**操作手机，也**不要**输出 [操作:手机…] 标签（会被系统直接拒绝，等于白说）。\n'
            + '如果用户希望你操作手机，请如实说明还没有启用，并引导他去「设置 → 能力 → 手机操作」'
            + '点「选择实现方式」选一种（无障碍门槛最低），并确认「允许 AI 操作手机」已勾选。';
    }
    // 能力清单必须按实现方式区分：无障碍**做不到**「手机打开」与「手机命令」
    // （原生层会明确回失败）。提示词里把它俩写成通用能力，就会造成"说了却做不到"，
    // 模型反复尝试、用户看到一连串失败 —— 这正是本次要避免的那类问题。
    const isAccessibility = backend === 'accessibility';
    const lines = [
        '# Agent Skill：手机操作（当前方式：' + backendNameOf(backend) + '）',
        '你可以操作这台安卓手机：读取界面、点击、滑动、输入文字、按键'
            + (isAccessibility ? '、截图' : '、打开应用、截图、执行命令') + '。',
        '可用标签（写在回复正文里，标签不会显示给用户）：',
        '· [操作:手机状态] —— 查询设备与当前后端状态',
        '· [操作:手机查看界面] —— 读取当前屏幕的控件树（含控件文字与可点击坐标）',
        '· [操作:手机截图] —— 截屏（需在「设置 → 视觉」配好多模态模型，否则拿不到画面内容）',
        '· [操作:手机点击 x y] —— 点击坐标，例如 [操作:手机点击 540 1200]',
        '· [操作:手机滑动 x1 y1 x2 y2 [时长毫秒]] —— 例如 [操作:手机滑动 540 1600 540 800 300]',
        '· [操作:手机输入 文字] —— 向当前获得焦点的输入框输入文字',
        '· [操作:手机按键 返回|主页|回车|菜单|音量上|音量下] —— 按系统键',
        '· [操作:手机等待 毫秒] —— 等界面加载完再继续',
    ];
    if (isAccessibility) {
        // 无障碍的能力边界：启动应用与任意命令都做不到。
        // 明说边界，模型才会去用"点击桌面图标"这类可行路径，而不是反复撞墙。
        lines.push('· ⛔ 当前方式**不支持** [操作:手机打开]（启动应用）与 [操作:手机命令]（任意命令）'
            + ' —— 无障碍方式做不到这两件事。');
        lines.push('  要启动某个应用，请先用 [操作:手机查看界面] 找到它的图标，再点击图标坐标；'
            + '或请用户到「设置 → 能力 → 手机操作」换成 Shizuku / Root / 模块 方式。');
        lines.push('· 按键也只支持「返回 / 主页 / 最近任务」三个，其它按键需要换实现方式。');
    } else {
        lines.push('· [操作:手机打开 包名] —— 启动应用，例如 [操作:手机打开 com.tencent.mm]');
        lines.push('· [操作:手机命令 命令] —— 执行系统命令（危险，每次都会单独询问用户）');
    }
    lines.push(
        '',
        '【工作方式】',
        '1. 不知道屏幕上有什么时，先 [操作:手机查看界面] 读控件树，**不要凭猜测点坐标**。',
        '2. 控件树里的坐标就是屏幕绝对坐标，可直接用于 [操作:手机点击 x y]。',
        '3. 要输入中文：先点击输入框让它获得焦点，再用 [操作:手机输入 文字]。',
        '4. 每一步的结果会以「【AI 操作结果】」回灌给你，据此决定下一步；界面没变化就换个方式，不要重复同一步。',
        '5. 点击/滑动/输入/打开应用都会弹窗询问用户，用户可能拒绝 —— 被拒绝时如实说明并换个思路。',
        '6. 若某一步回灌了「不支持」，说明那是当前实现方式的能力边界，'
            + '**不要重复尝试**，改用别的方式或如实告诉用户需要换实现方式。',
        '7. ⚠️ 只有输出 [操作:…] 标签才会真正执行。**绝不编造**"我已经点了/已经打开了/操作成功"；',
        '   没有标签就是没执行，执行结果一律以系统回灌的「【AI 操作结果】」为准。'
    );
    return lines.join('\n');
}

/**
 * 注入系统提示词的「电脑命令」能力说明（第二阶段 ④）。
 *
 * 为什么必须有这一段：和手机操作同一个坑 —— 执行链路早就通了，
 * 但提示词里不告诉模型标签存在，它就永远不会输出，用户看到的现象是
 * "AI 好像不能执行命令"。而**只在全权限模式下注入**：限制模式下能力被
 * 服务端直接拒绝，说了只会让模型反复尝试然后失败。
 *
 * 提示词里必须写清「危险命令会先问用户」—— 否则模型会以为自己被静默拒绝，
 * 或者反过来编造"命令已执行"。这是 agentPhoneSkillText 里同一条反幻觉约束。
 */
function agentCommandSkillText() {
    if ((state.settings.agentPermission || 'app') !== 'computer') return '';
    // APK 没有本机服务端（没有 /api/agent/exec），注入了也执行不了。
    // 必须用 IS_NATIVE_APP 而不是看协议 —— Capacitor 的 androidScheme 是 https，
    // 按协议判断会把 APK 当成网页版，于是注入一个用不了的能力（模型反复失败）。
    if (IS_NATIVE_APP) return '';
    return [
        '# Agent Skill：电脑命令（当前：允许操作电脑）',
        '你可以在这台电脑上执行 PowerShell / cmd 命令：',
        '· [操作:电脑命令 <命令>] —— 例如 [操作:电脑命令 dir]、[操作:电脑命令 git status]',
        '',
        '【工作方式】',
        '1. 普通命令（查看目录、读系统信息、跑 git / node 等）会**直接执行**，结果立刻回灌给你。',
        '2. ⚠️ **危险命令会让用户确认一次**（删除文件、改注册表、关机、下载并执行、提权等）。'
            + '每个对话里第一次遇到危险命令时询问，用户同意后该对话内后续的危险命令不再重复问。'
            + '用户可能拒绝 —— 被拒绝时如实说明并换个更安全的思路，不要反复重试同一条命令。',
        '3. 命令输出较长时会被截断，需要看别的部分就换一条更精确的命令（例如加过滤条件）。',
        '4. ⚠️ 只有输出 [操作:电脑命令 …] 标签才会真正执行。**绝不编造**"我已经执行了/命令输出是…"；',
        '   执行结果一律以系统回灌的「【AI 操作结果】」为准。',
        '5. 不确定命令的写法时，先用 [操作:电脑命令 <命令> --help] 或 [操作:电脑命令 where <程序名>] 探一下，'
            + '不要凭猜测拼一条可能破坏系统的命令。',
        '6. ⚠️ 删除类命令（del / Remove-Item / rmdir 等）**不可撤销**。执行前先确认你删的确实是目标，'
            + '能用更保守的写法（先列目录确认、只删明确的那一个文件）就不要用通配符。',
    ].join('\n');
}

/**
 * 刷新「设置 → 手机操作」里那块实现方式的显示。
 *
 * 注意：这里**只更新文字和徽标，不禁用任何东西**。
 * 实现方式只是"AI 走哪条路"的选择，下面的总开关和确认策略跟它无关，
 * 没选实现方式也照样能改 —— 把设置锁住只会让人以为坏了。
 */
function syncBackendSummary() {
    const chosen = currentBackendId();
    const summary = document.getElementById('settingBackendSummary');
    const badge = document.getElementById('settingBackendBadge');
    const bridge = document.getElementById('settingBackendBridge');
    if (badge) badge.innerHTML = chosen ? backendStatusBadge(backendStatus[chosen]) : '';
    if (bridge) {
        // 这一行是拿来回答"为什么检测不到"的：是原生层没接上，还是还没授权
        if (deviceBridge()) {
            const info = backendDeviceInfo;
            bridge.textContent = '原生设备层：已连接'
                + (info && info.model ? `（${info.model} / Android ${info.android}）` : '');
            bridge.style.color = '#059669';
        } else {
            bridge.textContent = '原生设备层：不在（当前是网页版，手机操作只能在安卓版 App 里用）';
            bridge.style.color = '#b45309';
        }
    }
    if (!summary) return;
    if (!chosen) {
        summary.textContent = '还没有选择实现方式，AI 现在不能操作手机。点下面的「选择实现方式」选一种。';
        summary.style.color = '#b45309';
        return;
    }
    const st = backendStatus[chosen];
    const ready = st && st.state === 'ready';
    const checking = !st || st.state === 'checking';
    const stateWord = checking ? '检测中' : (ready ? '已就绪' : '现在还不能用');
    const detail = st && st.text ? '：' + st.text : '';
    summary.textContent = '当前实现方式：' + backendNameOf(chosen) + '（' + stateWord + detail + '）';
    summary.style.color = ready ? '#059669' : '#b45309';
}

/**
 * 设备状态只问原生一次，四个后端共用 —— 否则 status() 会被连问四遍，
 * 而它内部要 ping Shizuku、连一次 3070 网关，四遍纯属浪费。
 */
let backendStatusCache = null;
let backendDeviceInfo = null;

async function fetchDeviceStatus(force) {
    const dev = deviceBridge();
    if (!dev || typeof dev.status !== 'function') return null;
    if (backendStatusCache && !force) return backendStatusCache;
    try {
        const st = await dev.status();
        backendStatusCache = st || {};
        backendDeviceInfo = {
            model: backendStatusCache.model || '',
            android: backendStatusCache.android || ''
        };
        return backendStatusCache;
    } catch (e) {
        console.warn('[Agent] 原生设备层状态查询失败:', e);
        backendStatusCache = null;
        return null;
    }
}

/** 探测某个后端当前是否可用 */
async function detectBackend(id) {
    // 原生设备层在场时，直接问它 —— 这是唯一准的来源（它能真的试 su、ping Shizuku）。
    const dev = deviceBridge();
    if (dev && typeof dev.status === 'function') {
        const st = await fetchDeviceStatus(false);
        if (st) {
            const item = st[id];
            if (item) {
                const detail = String(item.detail || '');
                return item.available
                    ? { state: 'ready', text: detail || '已就绪' }
                    : { state: 'unavailable', text: detail || '不可用' };
            }
            return { state: 'unavailable', text: '这个版本里没有这种实现方式' };
        }
        // 走到这里说明原生层在场但 status() 没回答。
        // 别说成"网页版"——那会把人引到完全错的方向，如实报错。
        return { state: 'unavailable', text: '原生设备层没有响应，重启一下应用再试' };
    }
    // 网页版没有原生层。只有「模块」能真探测：它的网关在本机 3070，
    // no-cors 的 fetch 读不到响应内容，但"有没有响应"足够判断它在不在。
    if (id === 'module') {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 1500);
            await fetch('http://127.0.0.1:3070/api/status', { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
            clearTimeout(timer);
            return { state: 'ready', text: '已就绪' };
        } catch (e) {
            return { state: 'unavailable', text: '未检测到' };
        }
    }
    // 网页版没有原生层，几种实现方式都探测不了，也不需要探测：
    // 「手机操作」只在安卓版 App 里可用（浏览器没有点击/输入屏幕的能力）。
    return { state: 'pending', text: '需要在安卓版 App 里使用' };
}

function backendStatusBadge(st) {
    const map = {
        ready: ['已就绪', 'color:#059669;background:#ecfdf5'],
        unavailable: ['不可用', 'color:#b45309;background:#fffbeb'],
        pending: ['仅 APK', 'color:#818cf8;background:#eef2ff'],
        checking: ['检测中', 'color:#818cf8;background:#eef2ff']
    };
    const pair = map[st && st.state] || map.checking;
    return '<span style="' + pair[1] + ';font-size:10px;padding:2px 7px;border-radius:7px;white-space:nowrap">' + pair[0] + '</span>';
}

/** 后端返回的说明文字直接来自原生层，插进 HTML 前统一转义 */
function escapeBackendText(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderBackendList() {
    const box = document.getElementById('backendList');
    if (!box) return;
    const cur = currentBackendId();
    const tip = cur ? '' :
        '<p class="text-[11px] leading-relaxed mb-2" style="color:#b45309;background:#fffbeb;border:1px solid #fef3c7;border-radius:12px;padding:8px 12px">还没有选择实现方式，AI 现在不能操作手机。选一种即可启用（需要该方式在你这台设备上可用）。</p>';
    box.innerHTML = tip + AGENT_BACKENDS.map((b) => {
        const active = b.id === cur;
        const setup = AGENT_BACKEND_SETUP[b.id];
        const st = backendStatus[b.id];
        // 状态说明来自原生层（"还没授权，点「请求 root 授权」"这种），
        // 必须显示出来 —— 手机上没法 hover，只给个"不可用"用户不知道该做什么
        const detail = (st && st.state !== 'checking' && st.text) ? escapeBackendText(st.text) : '';
        const detailColor = (st && st.state === 'ready') ? '#059669' : '#b45309';
        // 用 div 而不是 button：卡片里还要放「去设置」按钮，而 button 不能嵌套 button
        return '<div data-backend="' + b.id + '" role="button" tabindex="0"'
            + ' class="w-full text-left rounded-2xl border px-4 py-3 transition cursor-pointer"'
            + ' style="border-color:' + (active ? '#f9a8d4' : '#e4e4f7') + ';background:' + (active ? 'rgba(253,242,248,.7)' : 'rgba(255,255,255,.7)') + '">'
            + '<div class="flex items-center gap-2">'
            + '<span class="text-sm font-semibold text-indigo-950">' + b.name + '</span>'
            + '<span style="font-size:10px;color:#818cf8;background:#eef2ff;padding:2px 6px;border-radius:7px;white-space:nowrap">' + b.tag + '</span>'
            + '<span class="ml-auto">' + backendStatusBadge(st) + '</span>'
            + '</div>'
            + (detail ? '<p class="text-[11px] mt-1 leading-relaxed" style="color:' + detailColor + '">' + detail + '</p>' : '')
            + '<p class="text-[11px] text-indigo-400 mt-1 leading-relaxed">' + b.desc + '</p>'
            + '<div class="flex items-center gap-2 mt-1">'
            + '<span class="text-[11px] text-indigo-300 leading-relaxed flex-1">需要：' + b.need + '</span>'
            + (setup ? '<button type="button" data-backend-setup="' + b.id + '" class="btn-secondary text-[11px] flex-shrink-0" style="padding:3px 10px">' + setup.label + '</button>' : '')
            + '</div>'
            + (active ? '<p class="text-[11px] font-semibold mt-1" style="color:#db2777">当前使用</p>' : '')
            + '</div>';
    }).join('');
    box.querySelectorAll('[data-backend]').forEach((el) => {
        const id = el.getAttribute('data-backend');
        el.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('[data-backend-setup]')) return;   // 点设置按钮不算选中
            selectBackend(id);
        });
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectBackend(id); }
        });
    });
    box.querySelectorAll('[data-backend-setup]').forEach((el) => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            void openBackendSetup(el.getAttribute('data-backend-setup'));
        });
    });
    const curEl = document.getElementById('backendCurrent');
    if (curEl) curEl.textContent = cur ? backendNameOf(cur) : '尚未选择';
}

function selectBackend(id) {
    if (!AGENT_BACKENDS.some((b) => b.id === id)) return;
    state.settings.agentBackend = id;
    persistSettings();
    syncBackendSummary();
    renderBackendList();
    console.log('[Agent] 实现方式已选为:', id);
    // 选了但还没就绪时提醒一句：直接告诉用户该点哪个按钮去授权。
    // 否则他会在对话里试半天，最后收到一句"你还不能用"的回灌。
    const st = backendStatus[id];
    // 只提醒"已经确定不可用"的情况。
    // checking 是面板刚打开、原生状态还没回来的窗口，这时候弹
    // 「它现在还不能用：检测中」纯属误报 —— 用户刚点完就被自己的界面否掉。
    if (st && st.state !== 'ready' && st.state !== 'checking') {
        const setupLabel = (AGENT_BACKEND_SETUP[id] || {}).label || '去设置';
        void showCustomAlert(
            '已选择「' + backendNameOf(id) + '」，但它现在还不能用：' + (st.text || '状态未知') +
            '\n\n点这张卡片右侧的「' + setupLabel + '」完成授权，然后点「重新检测」。',
            '还需要一步'
        );
    }
}

/**
 * 「去设置 / 请求权限」：原生插件在场就走真跳转（打开无障碍设置页、弹 root 授权框），
 * 并把原生返回的说明展示出来；否则弹出该方式的操作说明。
 * 网页版和 APK 两种情况都能给出可执行的下一步。
 */
async function openBackendSetup(id) {
    const cfg = AGENT_BACKEND_SETUP[id];
    if (!cfg) return;
    if (cfg.plugin && cfg.method) {
        const plugin = window.Capacitor?.Plugins?.[cfg.plugin]
            || (cfg.plugin === 'ElainaDevice' ? deviceBridge() : null);
        if (plugin && typeof plugin[cfg.method] === 'function') {
            try {
                const res = await plugin[cfg.method]();
                // 原生返回的文字必须展示：比如"没能拿到 root 权限：Permission denied"，
                // 那正是用户下一步该做什么的依据，吞掉的话这个按钮就等于没用
                const message = (res && res.text) ? String(res.text) : cfg.guide;
                await showCustomAlert(message, cfg.label);
                void refreshBackendStatus();
                return;
            } catch (e) {
                console.warn('[Agent] 原生设置跳转失败，改用说明:', e);
            }
        }
    }
    await showCustomAlert(cfg.guide, cfg.label);
}

async function refreshBackendStatus() {
    // 必须先把原生状态缓存清掉。
    // 否则「重新检测」只是把界面重置成"检测中"，再拿回同一份旧数据 —— 看起来刷新了，其实没有。
    // 而授权流程恰恰是「点授权 → 点重新检测 → 状态变已就绪」，
    // 不清缓存这一步就永远是空的，用户会以为授权没成功。
    backendStatusCache = null;
    AGENT_BACKENDS.forEach((b) => { backendStatus[b.id] = { state: 'checking', text: '检测中' }; });
    renderBackendList();
    syncBackendSummary();
    await Promise.all(AGENT_BACKENDS.map(async (b) => { backendStatus[b.id] = await detectBackend(b.id); }));
    renderBackendList();
    syncBackendSummary();
}

function openBackendPanel() {
    const el = document.getElementById('backendPanel');
    if (!el) return;
    el.classList.remove('hidden');
    el.classList.add('flex');
    // 层级（100002，盖在设置之上）写在样式表的 #backendPanel 规则里，
    // 这里不设 style.zIndex —— .modal-overlay 上的 !important 会让内联值失效
    renderBackendList();
    void refreshBackendStatus();
}

function closeBackendPanel() {
    const el = document.getElementById('backendPanel');
    if (!el) return;
    el.classList.add('hidden');
    el.classList.remove('flex');
    // 关掉面板时刷新一次：用户可能刚在里面选了一种方式
    syncBackendSummary();
}

// 入口在「设置 → 手机操作」里（不在侧边栏 —— 手机上侧边栏收起后那里进不去）
document.getElementById('settingBackendChooseBtn')?.addEventListener('click', openBackendPanel);
document.getElementById('settingBackendRefreshBtn')?.addEventListener('click', () => { void refreshBackendStatus(); });
document.getElementById('backendRefresh')?.addEventListener('click', () => { void refreshBackendStatus(); });
syncBackendSummary();
// 预热「这台电脑的真实位置」（桌面/文档/下载…）。服务端要起一次 PowerShell 读注册表，
// 大约一两秒；提前拉一次，用户真让 AI 操作文件时提示词里就已经带着真实路径了。
void detectAgentRoots();
document.getElementById('backendPanelClose')?.addEventListener('click', closeBackendPanel);
document.getElementById('backendPanel')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'backendPanel') closeBackendPanel();
});

// 覆盖已有文件 = 修改，需要用户同意一次。
//
// 为什么按「同一对话」而不是「同一路径」记：
//   · 按路径记（旧做法）等于每个新路径都要打断一次 —— AI 改十个文件就弹十次，
//     用户很快就会条件反射地点"允许"，确认形同虚设；
//   · 按对话记的语义是"这个会话里我信任它做修改"，一次说清、后续不打扰，
//     换一个对话重新问 —— 与新对话可能换了语境、换了角色卡这一点对齐。
//
// 与删除类命令共用同一条语义（见 confirmAgentDangerousCommand）：两者都是"不可逆的改动"。
const agentDestructiveScope = { convId: null, write: false, execDanger: false };

/** 当前对话 id（拿不到就退回一个空串，等价于"每次都问"） */
function agentScopeKey() {
    try {
        const conv = getCurrentConversation();
        return conv && conv.id ? String(conv.id) : '';
    } catch { return ''; }
}

/**
 * 检查是否已在本对话内授权过某类不可逆操作；换了对话自动清空。
 * @param {'write'|'execDanger'} kind
 */
function agentDestructiveApproved(kind) {
    const key = agentScopeKey();
    // 对话切换 → 作废旧授权。不能只看"key 变了"就重置后放行，
    // 所以这里只清空、不置位，由调用方在用户同意时才置位。
    if (agentDestructiveScope.convId !== key) {
        agentDestructiveScope.convId = key;
        agentDestructiveScope.write = false;
        agentDestructiveScope.execDanger = false;
    }
    return agentDestructiveScope[kind] === true;
}

/** 记下"本对话内已授权该类操作" */
function agentMarkDestructiveApproved(kind) {
    agentDestructiveScope.convId = agentScopeKey();
    agentDestructiveScope[kind] = true;
}

/**
 * 危险电脑命令的确认（删除 / 格式化 / 改注册表 / 关机 / 下载并执行…）。
 *
 * 语义与覆盖确认一致：**同一对话内只问一次**。
 *   · 旧行为是每条危险命令都弹（forceAsk）—— AI 清理一批临时文件要弹七八次，
 *     用户从"看清内容再决定"退化成"闭眼点允许"，最后那道闸反而没了；
 *   · 现在改成一次问清、本对话内不再打扰，并在弹窗里把**后果**说明白
 *     （删除不可恢复），把判断放在"是否开启全权限"和"这一次"两个点上。
 *
 * ★ 服务端仍是权威：不带 approved:true 的请求一律 403（见 agentExec）。
 *   所以"本对话已授权"这个状态只影响**问不问**，不影响"服务端卡不卡"。
 */
async function confirmAgentDangerousCommand(command, reasonList) {
    if (agentDestructiveApproved('execDanger')) return true;
    const reasons = Array.isArray(reasonList) && reasonList.length
        ? reasonList.join('、')
        : '可能改变系统状态';
    const detail = 'AI 想执行一条危险命令：\n\n' + command + '\n\n风险：' + reasons
        + '\n\n⚠️ 这类命令可能**不可撤销**（删除的文件、改掉的注册表、关掉的进程都不会自己回来）。'
        + '\n请确认命令内容确实是你想要的。同意后，本对话内后续的危险命令不再重复询问。';
    let ok = false;
    try {
        ok = await agentRuntime.requestApproval('电脑命令', detail, { forceAsk: true });
    } catch { ok = false; }
    if (ok) agentMarkDestructiveApproved('execDanger');
    return ok;
}

/**
 * 覆盖已有文件的确认（服务端回 needOverwrite 后由前端问一次）。
 *
 * ★ 服务端是权威：不带 overwrite:true 的请求拿不到覆盖能力，
 *   所以"问不问"可以被前端优化，但"能不能覆盖"始终由服务端说了算。
 */
async function confirmAgentOverwrite(path) {
    if (agentDestructiveApproved('write')) return true;
    const target = String(path || '').trim();
    const detail = 'AI 想写入一个**已经存在**的文件，这会覆盖它原有的内容：\n\n' + target
        + '\n\n覆盖后原内容无法恢复。同意后，本对话内后续的写入/修改不再重复询问。\n'
        + '（想彻底关掉：设置 → 能力 → 「AI 操作电脑」改回「限制：仅应用文件夹内操作」）';
    let ok = false;
    try {
        ok = await agentRuntime.requestApproval('覆盖已有文件', detail, { forceAsk: true });
    } catch { ok = false; }
    if (ok) agentMarkDestructiveApproved('write');
    return ok;
}

// 越界申请：限制模式（仅应用文件夹）下 AI 要碰 web/ 之外的位置时，
// 由用户就**这一次**决定是否放行，而不是要求他去设置页把全局权限改成「允许操作电脑」。
//
// 为什么不做成"全局模式切换"：越界往往是**一次性**的（读一个下载目录里的文件）。
// 让用户为了这一次去改全局设置，他改完多半忘了改回来 —— 结果是限制模式被永久关掉，
// 比"就这一次放行"危险得多。所以这里只批这一次，且同一路径只问一次（同一轮内）。
//
// ★ 服务端仍会独立校验：只有本机（127.0.0.1）请求的 allowOutside 才被接受，
//   局域网设备即使伪造 allowOutside=true 也会拿到 403（见 resolveAgentPathEx）。
const agentEscalationApproved = new Set();
async function confirmAgentEscalation(path) {
    const target = String(path || '').trim();
    if (!target) return false;
    if (agentEscalationApproved.has(target)) return true;
    const detail = 'AI 想访问应用文件夹之外的位置：\n\n' + target
        + '\n\n只放行这一次（同一路径本轮不再重复询问）。\n'
        + '如果你希望它长期能操作电脑，可在「设置 → 能力 → AI 操作电脑」切到「允许操作电脑」。';
    let ok = false;
    // 优先走统一的授权 UI（APK 上是系统悬浮窗，网页版回退到应用内弹窗）
    try {
        ok = await agentRuntime.requestApproval('访问文件夹外', detail, { forceAsk: true });
    } catch { ok = false; }
    if (ok) agentEscalationApproved.add(target);
    return ok;
}

// 执行 Agent 文件操作并把结果回填对话（AI 能看到/用户能看到）
async function doAgentFile(action, { path, content } = {}, permission) {
    // 过程记录：文件操作是用户最关心的"AI 到底动了什么"。
    // 记下路径与动作，结果出来后再回填（成功/失败 + 摘要）。
    const kindMap = { ls: 'search', read: 'read', write: 'write' };
    const titleMap = { ls: '列出文件', read: '读取文件', write: '写入文件' };
    const traceItem = recordTurnTool({
        kind: kindMap[action] || 'file',
        title: titleMap[action] || ('文件 · ' + action),
        summary: path || '（未提供路径）',
        args: action === 'write' && content ? `路径：${path}\n内容长度：${String(content).length} 字` : (path || ''),
        state: 'running'
    });
    try {
        let result;
        if (action === 'write') {
            // 必须用**同源 fetch**，不能用 postJsonFromDevice。
            //
            // postJsonFromDevice 是给"外部服务商"用的：它会走本机中转
            // （/api/relay，用来绕开 CORS）。而 /api/agent/write 是**同源本地接口**，
            // 把相对路径交给中转 → 中转的 `new URL('/api/agent/write')` 解析失败 →
            // 报「目标地址无效」，写入**永远不可能成功**。
            //
            // 真实故障：日志里能看到 `[Relay] [WARN] 目标地址无效：/api/agent/write`，
            // 而 ls / read 走的是同源 fetch 所以正常 —— 表现为"读取能用、写入不行"。
            const send = async ({ allowOutside, overwrite }) => {
                const res = await fetch('/api/agent/write', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ permission, path, content, allowOutside, overwrite })
                });
                const r = await res.json();
                // 同源 fetch 不像 postJsonFromDevice 那样带 rawText，补一份便于错误提示
                if (!r.rawText) r.rawText = JSON.stringify(r);
                if (!('ok' in r)) r.ok = res.ok;
                return r;
            };
            // ★ 两个授权旗标要用**局部变量**记住，不能从响应里读。
            //   服务端不会把 allowOutside 回显在响应里，写成 `result.allowOutside` 永远是
            //   undefined —— 那样"越界 + 覆盖"同时发生时，第二次重发会丢掉 allowOutside，
            //   于是被 403 打回，用户批准了却依然失败。
            let allowOutside = false;
            result = await send({ allowOutside, overwrite: false });
            // ① 越界（限制模式下碰 web/ 之外）→ 申请一次，批准后带 allowOutside 重发
            if (result.needEscalation) {
                if (!await confirmAgentEscalation(path)) {
                    updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许访问应用文件夹外的位置' });
                    insertAgentResult('已取消：没有获得访问该位置的许可。\n目标：' + (path || '（未提供路径）'));
                    return;
                }
                allowOutside = true;
                result = await send({ allowOutside, overwrite: false });
            }
            // ② 覆盖已有文件 → 申请一次，批准后带 overwrite 重发。
            //    与 ① 是**两件独立的事**（能不能去那个位置 / 能不能改那个文件），
            //    所以刻意不是 else-if，且重发时两条旗标都要如实带上。
            if (result.needOverwrite) {
                if (!await confirmAgentOverwrite(path)) {
                    updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许覆盖这个文件' });
                    insertAgentResult('已取消写入：目标文件已存在，而你没有允许覆盖它。\n'
                        + '目标：' + (path || '（未提供路径）')
                        + '\n（想保留原文件的话，可以让 AI 换一个新文件名保存。）');
                    return;
                }
                result = await send({ allowOutside, overwrite: true });
            }
        } else {
            const buildQuery = (allowOutside) => 'permission=' + encodeURIComponent(permission)
                + (path ? '&path=' + encodeURIComponent(path) : '')
                + (allowOutside ? '&allowOutside=1' : '');
            const send = async (allowOutside) => await (await fetch(`/api/agent/${action}?${buildQuery(allowOutside)}`)).json();
            result = await send(false);
            if (result.needEscalation && await confirmAgentEscalation(path)) {
                result = await send(true);
            }
        }
        // 错误信息：后端返回 payload.message / rawText（修复"未知错误"）
        const errMsg = (() => {
            const msg = result?.payload?.message || result?.message || '';
            if (msg) return String(msg);
            const raw = String(result?.rawText || '');
            if (raw && !raw.startsWith('{')) return raw.slice(0, 200);
            try { const j = JSON.parse(raw); return String(j?.message || j?.error || '') || raw.slice(0, 200); } catch { return raw.slice(0, 200); }
        })() || '未知错误';
        if (result.ok) {
            let resultText;
            if (action === 'ls') {
                // 「（链接）」标记 Windows 的 junction（`All Users`、`My Documents` 这类）。
                // 它们既不是普通文件夹也不是文件，不标出来会让人以为列表列错了。
                const lines = (result.entries || []).map(e => {
                    const icon = e.type === 'dir' ? '📁 ' : '📄 ';
                    return icon + e.name + (e.link ? '（链接）' : '');
                });
                resultText = `目录内容（${result.path || ''}）：\n` + lines.join('\n');
            } else if (action === 'read') {
                resultText = `文件内容（${result.path || ''}）：\n${result.content || '（空文件）'}`;
            } else {
                resultText = `✅ 已保存到：${result.path || path}`;
            }
            insertAgentResult(resultText, { continueLoop: true });
            updateTurnTool(traceItem, {
                state: 'ok',
                // 结果摘要截断：过程行展开区有 max-height，但整篇文件内容塞进去
                // 会让 DOM 变得很重（几万字的文件每次重绘都要 escape 一遍）
                result: resultText.length > 4000 ? resultText.slice(0, 4000) + '\n…（已截断）' : resultText
            });
            agentConsecutiveFailures = 0; // 成功了就把重试预算还回去
        } else {
            // 失败：把原因交给 AI，让它以角色口吻自然解释（不直接甩原始错误）
            updateTurnTool(traceItem, { state: 'error', result: errMsg });
            agentConsecutiveFailures += 1;
            await explainAgentFailure(errMsg);
        }
    } catch (err) {
        updateTurnTool(traceItem, { state: 'error', result: err.message || String(err) });
        agentConsecutiveFailures += 1;
        await explainAgentFailure(err.message || String(err));
    }
}

/**
 * 执行 AI 请求的电脑命令（[操作:电脑命令 …]）。
 *
 * 权限双模式在这里的落点：
 *   · app（限制）      → 不发请求，直接回灌"限制模式不支持"，并告诉 AI 去哪开。
 *   · computer（全权限）→ 发请求；服务端判为危险时回 needApproval，
 *                          这时才弹确认框，用户同意后带 approved:true 重发。
 *
 * ★ 为什么危险判定要"先问服务端、再问用户"，而不是前端自己判：
 *   前端判会把规则抄一份（两份规则必然走样），而且服务端无论如何都要再判一次
 *   （前端可绕过）。让服务端当唯一权威，前端只负责"把服务端的判定转成一次点击"。
 */
async function doAgentCommand(command, permission) {
    const traceItem = recordTurnTool({
        kind: 'command',
        title: '执行命令',
        summary: command,
        args: command,
        state: 'running'
    });

    if (permission !== 'computer') {
        const msg = '限制模式（仅应用文件夹）下不能执行电脑命令。如需执行，请在设置 → 能力 → '
            + '「AI 操作电脑」里切换到「允许操作电脑」，并在本机（127.0.0.1）打开页面。';
        updateTurnTool(traceItem, { state: 'stopped', result: msg });
        insertAgentResult(msg);
        return;
    }
    // APK 没有本机服务端，/api/agent/exec 不存在 —— 直接如实说明，不要去发一个必然失败的请求
    if (IS_NATIVE_APP) {
        const msg = '当前是安卓 App，没有本机服务端，无法执行电脑命令。'
            + '请在电脑上运行本应用（node web/serve.mjs）后用浏览器打开。';
        updateTurnTool(traceItem, { state: 'stopped', result: msg });
        insertAgentResult(msg);
        return;
    }

    try {
        const send = (approved) => fetch('/api/agent/exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ permission, command, approved })
        }).then(r => r.json());

        let result = await send(false);

        // 服务端判定为危险 → 现在才问用户（安全命令已经在上面执行完了，不打扰）
        if (result && result.needApproval) {
            if (!await confirmAgentDangerousCommand(command, result.reasons)) {
                updateTurnTool(traceItem, { state: 'stopped', result: '用户没有允许执行这条命令' });
                insertAgentResult('已跳过这条命令：用户没有允许。请换一种更安全的方式，或先向用户说明为什么要执行它。');
                return;
            }
            updateTurnTool(traceItem, { state: 'running', result: '用户已允许，正在执行…' });
            result = await send(true);
        }

        if (result && result.ok) {
            const text = String(result.text || '').trim() || '（命令已执行，没有输出）';
            insertAgentResult('命令执行结果：\n' + text, { continueLoop: true });
            updateTurnTool(traceItem, {
                state: 'ok',
                result: text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断）' : text
            });
            agentConsecutiveFailures = 0;
        } else {
            const errMsg = String(result?.message || result?.text || result?.stderr || '命令执行失败');
            updateTurnTool(traceItem, { state: 'error', result: errMsg });
            agentConsecutiveFailures += 1;
            await explainAgentFailure(errMsg);
        }
    } catch (err) {
        updateTurnTool(traceItem, { state: 'error', result: err.message || String(err) });
        agentConsecutiveFailures += 1;
        await explainAgentFailure(err.message || String(err));
    }
}

// 连续失败计数：AI 解释完失败原因后，允许它**自动重试一次**。
// 为什么需要：最常见的失败是「AI 猜错了路径」（例如桌面被移动过），而失败原因里
// 已经带着真实路径（见 serve.mjs 的 shellFolderHint）—— 它本来就能自己纠正，
// 却因为「解释失败」这条路径不执行标签而只能干等着用户说"继续"。
// 必须限次：否则「失败 → 解释 → 重试 → 再失败」会变成无限循环，一次误判就能刷光额度。
let agentConsecutiveFailures = 0;
const AGENT_FAILURE_MAX_RETRY = 1;

// 操作失败 → AI 以角色身份自然向用户解释原因与建议（像正常对话一样）
async function explainAgentFailure(reason) {
    const conv = getCurrentConversation();
    // 失败原因里可能带着「这台电脑的真实位置」那段提示（serve.mjs 的 shellFolderHint），
    // 原来截到 300 字会把它切掉一半，AI 就拿不到纠正所需的路径了。
    const shortReason = String(reason).slice(0, 600);
    if (!conv) { showCustomAlert('操作失败：' + shortReason, 'AI 操作结果'); return; }
    const canRetry = agentConsecutiveFailures <= AGENT_FAILURE_MAX_RETRY;
    const prompt = `（系统内部通知：刚才你尝试执行的文件操作失败了，原因：${shortReason}。`
        + '请以你的角色身份，用自然、真诚的口吻向用户解释为什么无法完成这个操作，并给出可行的解决办法建议'
        + '（例如检查 Agent 权限模式、路径是否正确、服务是否可用等）。不要提及"系统通知""标签"等词，'
        + '就像你真的尝试过并遇到问题一样，自然地说明和道歉。）'
        + (canRetry ? '\n（如果上面的原因里已经给出了正确的位置，请在解释的同时**直接用正确的路径重新发起一次操作**'
            + ' —— 照常输出 [操作:…] 标签，标签不会显示给用户。不要只是道歉。）' : '');
    let raw;
    try {
        raw = await callAI(prompt);
    } catch (e) {
        // 模型偶尔只回思考内容（EMPTY_MODEL_OUTPUT，思考型模型在"系统内部通知"这种
        // 元提示上尤其容易这样），原样重试一次基本就好；再失败就只把原因显示出来，
        // 不要把「（AI 解释失败：模型只返回了思考内容…）」这种嵌套文案甩给用户。
        if (e instanceof ClientApiError && e.code === 'EMPTY_MODEL_OUTPUT') {
            try { raw = await callAI(prompt); } catch { raw = ''; }
        } else {
            raw = '';
        }
    }
    const text = window.ElainaTags ? window.ElainaTags.strip(raw || '') : (raw || '');
    const wantsRetry = canRetry && /\[操作[:：]/.test(raw || '');
    if (text) {
        const aiMessage = { id: generateId(), role: 'ai', text, timestamp: new Date().toLocaleTimeString() };
        conv.messages.push(aiMessage);
        saveConversations();
        if (state.currentConversationId === conv.id) renderMessage(aiMessage);
    } else if (!wantsRetry) {
        // 一句可见回复都没拿到，而且也没有重试 —— 至少把原因摆出来，别让用户对着空气等。
        //
        // continueLoop: false 是必须的：这句是**失败说明**，不是"操作成功的结果"。
        // 若它触发续跑，就会绕过失败路径自己的重试预算（AGENT_FAILURE_MAX_RETRY = 1），
        // 变成"失败 → 续跑 → 再失败 → 再续跑"一直撞到续跑上限（8 次）才停 ——
        // 两套预算互相打架，用户看到的是 AI 对着一个不存在的路径反复尝试。
        insertAgentResult('操作失败：' + shortReason, { continueLoop: false });
    }
    // 解释里带了新的 [操作:…] → 真的执行它（走同一条标签管线，停止/授权照常生效）
    if (wantsRetry && window.ElainaTags) {
        window.ElainaTags.drive(raw);
    }
}

// 把 Agent 操作结果作为一条消息插入当前对话（作为上下文，AI 下轮可参考）
//
// **默认不自动续跑**，只有 `continueLoop: true` 才续跑。
//
// 为什么默认关：这个函数是 18 处调用的公共收口，其中大多数是
// 「无权限 / 未启用 / 用户取消 / 未识别」这类**被拒绝**的结果。
// 那些如果也触发续跑，就变成"被拒绝 → 续跑 → 又试一次 → 又被拒绝"的无效循环，
// 用户看到 AI 对着一个做不到的事反复尝试。
// 只有"真的做完了某件事"才值得让 AI 接着决定下一步。
function insertAgentResult(text, options = {}) {
    const conv = getCurrentConversation();
    if (!conv) { showCustomAlert(text, 'AI 操作结果'); return; }
    const msg = { id: generateId(), role: 'ai', text: '【AI 操作结果】\n' + text, timestamp: new Date().toLocaleTimeString() };
    conv.messages.push(msg);
    saveConversations();
    if (state.currentConversationId === conv.id) renderMessage(msg);
    if (options.continueLoop === true) scheduleAgentContinue();
}


// ===== Agent 自动续跑：操作做完自己接着走，不用用户说"继续" =====
//
// 症状：AI 读取/写入/点击之后就不动了，必须用户手动说一句"继续"才走下一步。
//
// 根因是一个**不对称**：
//   · 失败路径 explainAgentFailure() 会调 callAI()，所以 AI 能自己解释并重试；
//   · 成功路径只 insertAgentResult() 把结果塞进对话，**从不调 callAI()** ——
//     AI 看不到"我刚做完的事"，自然不会有下一步。
// 日志里能直接看到：执行完 [操作:保存文件 …] 后，下一次请求的末条消息是
// **user**（用户手动打的"继续"），而不是由操作结果触发的续跑。
//
// 三条硬约束：
//   1. **有预算**：否则"读文件 → 续跑 → 再读 → 再续跑"会烧光额度。
//      （失败路径早就因为同样的理由加了 AGENT_FAILURE_MAX_RETRY。）
//   2. **用户停止后不再续跑**：停止的意义就是让 AI 停下，续跑必须让位。
//   3. **合并触发**：一条回复里可能有多个操作标签，结果会连着插进来 ——
//      用防抖合成一次续跑，否则会并发打出好几个请求。
const AGENT_CONTINUE_MAX_STEPS = 8;
const AGENT_CONTINUE_PROMPT = '（系统内部通知：你刚才发起的操作已经执行完，结果已作为'
    + '「【AI 操作结果】」放进对话。请根据结果继续推进用户交代的任务。）\n'
    + '规则：\n'
    + '1. 还需要继续操作，就照常输出 [操作:…] 标签（标签不会显示给用户），系统会接着执行；\n'
    + '2. 任务已经完成，就直接用你的角色身份自然告诉用户结果，**不要再输出任何操作标签**；\n'
    + '3. 如果结果里显示某一步失败了或不被支持，不要重复同一步，换个方式或如实说明；\n'
    + '4. 不要提及"系统通知""标签"这类词，就像你自己在做这件事一样。';
let agentContinueUsed = 0;
let agentContinueTimer = null;

/** 每来一条新的用户消息就重置预算（一次用户请求 = 一个预算） */
function resetAgentContinueBudget() {
    agentContinueUsed = 0;
    if (agentContinueTimer) { clearTimeout(agentContinueTimer); agentContinueTimer = null; }
}

function scheduleAgentContinue() {
    if (agentContinueTimer) clearTimeout(agentContinueTimer);
    agentContinueTimer = setTimeout(() => {
        agentContinueTimer = null;
        void continueAgentLoop();
    }, 400);
}

async function continueAgentLoop() {
    const rt = window.agentRuntime;
    if (!rt) return;
    // 用户按了停止 → 绝不再自动往下走（否则"停止"会被续跑顶掉）
    if (typeof rt.isHalted === 'function' && rt.isHalted()) return;
    if (agentContinueUsed >= AGENT_CONTINUE_MAX_STEPS) {
        console.warn('[Agent] 自动续跑达到上限，停下等待用户');
        // continueLoop: false —— 这句是系统说明，不是操作结果。
        // 若它也触发续跑，就会"到上限 → 插提示 → 又调度 → 再到上限"无限循环。
        insertAgentResult('（已连续自动执行 ' + AGENT_CONTINUE_MAX_STEPS + ' 步，先停在这里。'
            + '如果还需要继续，跟我说一声就行。）', { continueLoop: false });
        rt.endRun();
        return;
    }
    const conv = getCurrentConversation();
    if (!conv) return;
    agentContinueUsed += 1;
    // 只在"还没在跑"时 beginRun：它会清空 approvedThisRun，
    // 无条件调用会让「同一次运行内允许过就不再问」这条策略在每次续跑时失效
    // （用户点了允许，下一步又问一遍）。runAgentPhoneOperation 也是这么写的。
    if (!rt.isRunning()) rt.beginRun();
    rt.setStep(rt.getStep() + 1, '继续处理');
    console.log('[Agent] 自动续跑第 ' + agentContinueUsed + '/' + AGENT_CONTINUE_MAX_STEPS + ' 步');
    let raw;
    try {
        raw = await callAI(AGENT_CONTINUE_PROMPT);
    } catch (e) {
        // 思考型模型在"系统内部通知"这种元提示上偶尔只回思考内容（EMPTY_MODEL_OUTPUT），
        // 与 explainAgentFailure 同样处理：原样重试一次，再失败就安静收尾。
        if (e instanceof ClientApiError && e.code === 'EMPTY_MODEL_OUTPUT') {
            try { raw = await callAI(AGENT_CONTINUE_PROMPT); } catch { raw = ''; }
        } else {
            raw = '';
        }
    }
    // 续跑途中用户按了停止 → 不渲染这半截回复
    if (typeof rt.isHalted === 'function' && rt.isHalted()) return;
    const text = window.ElainaTags ? window.ElainaTags.strip(raw || '') : (raw || '');
    if (text) {
        const aiMessage = { id: generateId(), role: 'ai', text, timestamp: new Date().toLocaleTimeString() };
        conv.messages.push(aiMessage);
        conv.updatedAt = new Date().toISOString();
        saveConversations();
        // 这三步必须和 handleUserInput 的 commitAiMessageOnce 保持一致，
        // 否则会出现"回复已经存进对话、界面上却看不见，得再发一句才冒出来"：
        //   · removeThinkingMessage() —— 否则"伊蕾娜正在想…"气泡一直挂着，
        //     而新回复被压在它下面（用户以为 AI 没回）；
        //   · 渲染前判当前会话与 notes/diary 模式 —— 在别的页面时不该往聊天区插节点；
        //   · 渲染后更新状态与滚动。
        removeThinkingMessage();
        if (state.currentConversationId === conv.id && !state.notesMode && !state.diaryMode
            && !document.getElementById(`msg-${safeAttrId(aiMessage.id)}`)) {
            renderMessage(aiMessage);
        }
        state.voiceState = 'idle';
        updateUI();
    }
    // 回复里带了新的 [操作:…] → 真的执行它（走同一条标签管线，
    // 停止/授权照常生效；执行完又会 insertAgentResult → 继续下一步）。
    //
    // 判据要**同步看有没有操作标签**，不能靠"等一下再看 agentContinueTimer"：
    // drive() 里的操作是异步的（要先弹授权、再发请求），此刻定时器还没被设上，
    // 那样判断会误判成"AI 已收尾"而提前 endRun。
    const hasMoreOps = /\[操作[:：]/.test(String(raw || ''));
    if (hasMoreOps && window.ElainaTags) {
        window.ElainaTags.drive(raw || '');
        return;   // 后续由新一轮 insertAgentResult 接力
    }
    // 没有操作标签 → AI 认为任务完成，结束本次运行（收起状态条）
    rt.endRun();
}


// ===== 自然语言触发表情 =====
// 用户明确要求"做出XX表情"时直接驱动 Live2D 表情（不依赖 AI 输出标签）
const NL_EXPRESSION_MAP = {
    '星星眼': '星星眼', '星星眼表情': '星星眼',
    '开心': 'happy', '高兴': 'happy', '微笑': 'smile', '笑': 'happy', '笑容': 'smile',
    '难过': 'sad', '伤心': 'sad', '悲伤': 'sad', '哭': 'cry', '委屈': 'cry', '哭哭': 'cry',
    '生气': 'angry', '愤怒': 'angry', '凶': 'angry', '气鼓鼓': 'angry',
    '害羞': 'shy', '脸红': 'blush', '娇羞': 'shy',
    '惊讶': 'surprised', '震惊': 'surprised', '吃惊': 'surprised',
    '思考': 'think', '疑惑': 'think', '晕': 'dizzy', '头晕': 'dizzy',
    '平静': 'calm', '淡定': 'calm', '正常': 'default'
};
function maybeAutoExpression(text) {
    const s = String(text || '');
    // 直接说特征表情名（星星眼等）或带"表情/脸"字样都算
    const featureHit = Object.keys(NL_EXPRESSION_MAP).find(k => s.includes(k));
    if (!/(表情|脸)/.test(s) && !featureHit) return false;
    // "做出/做个/表演/展示/来一个/露出 + 表情名 + (的)表情/脸"
    const m = s.match(/(?:做出|做|表演|展示|摆出|来一个|来个|露出|弄个?|换)\s*(?:一个|个|一下)?\s*([\u4e00-\u9fff]{2,4}?)(?:的)?(?:表情|脸)/);
    let name = m ? m[1] : '';
    if (!name) name = featureHit || '';
    if (!name) return false;
    // 去掉尾部可能带上的"的"
    name = name.replace(/的$/, '');
    const target = NL_EXPRESSION_MAP[name] || name;
    if (window.Live2DCall && typeof window.Live2DCall.setExpression === 'function') {
        console.log('[Live2D] 自然语言触发表情:', name, '→', target);
        void window.Live2DCall.setExpression(target);
        return true;
    }
    return false;
}


// ===== 自然语言触发文件写入（已移除）=====
// 这里原来有 parseFileWriteIntent() / maybeAutoFileWrite() / pendingAutoWrite：
// 用户在消息里说"在D盘写入文件 xxx"时，**由前端正则直接执行写文件**，不经过 AI。
//
// 已整体删除，原因见 handleUserInput 里的说明（绕过 AI、正则误伤、与授权脱节）。
// 注意 pendingAutoWrite 也一并删掉了 —— 它唯一的写入者就是 maybeAutoFileWrite，
// 留着会让 commitAiMessageOnce 里那段"待写入 AI 留言"成为永远进不去的死分支，
// 而它还会调 doAgentFile('write')，属于"看起来能用、实际永不可达"的陷阱代码。
// 现在"把你想说的话写进文件"由 AI 输出 [操作:保存文件 …] 完成。


// ==================== AI 定时任务（未来任务） ====================
// LLM 回复可用 [任务:每天 09:00 提醒我喝水] 等创建定时任务；到点 AI 自动以角色身份发消息。
// 支持格式：每天/明天/每周X + HH:MM；每N小时/分钟；N分钟后；仅 HH:MM（今天该时间）。
const TASK_STORE_KEY = 'elaina_open_tasks';

function loadScheduledTasks() {
    try {
        const arr = JSON.parse(localStorage.getItem(TASK_STORE_KEY) || '[]');
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function saveScheduledTasks(tasks) {
    try { localStorage.setItem(TASK_STORE_KEY, JSON.stringify(tasks)); } catch { /* ignore */ }
}

// 解析单个 [任务:...] 标签 → { content, intervalMs, nextAt }
function parseTaskTag(text) {
    if (!text) return null;
    // 剥掉 [任务: ] 外壳（兼容传入完整标签或纯内容）
    const m = String(text).match(/\[任务[:：]\s*([^\]]+)\]/);
    const raw = (m ? m[1] : String(text)).trim();
    if (!raw) return null;
    const now = new Date();
    let content = raw;
    let intervalMs = 0;
    let nextAt = null;
    let timeMatch = raw.match(/(\d{1,2}):(\d{2})/);
    let freqMatch;

    if ((freqMatch = raw.match(/每\s*(\d+)\s*(小时|分钟|天)/))) {
        const n = parseInt(freqMatch[1], 10);
        const unit = freqMatch[2];
        intervalMs = unit === '小时' ? n * 3600000 : (unit === '天' ? n * 86400000 : n * 60000);
        nextAt = now.getTime() + intervalMs;
        content = raw.replace(freqMatch[0], '');
    } else if ((freqMatch = raw.match(/每周([一二三四五六日天])/))) {
        const weekMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
        const hh = timeMatch ? parseInt(timeMatch[1], 10) : 9;
        const mm = timeMatch ? parseInt(timeMatch[2], 10) : 0;
        const d = new Date(now);
        const daysAhead = (weekMap[freqMatch[1]] - d.getDay() + 7) % 7;
        d.setDate(d.getDate() + daysAhead);
        d.setHours(hh, mm, 0, 0);
        if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 7);
        nextAt = d.getTime();
        intervalMs = 7 * 86400000;
        content = raw.replace(freqMatch[0], '').replace(/(\d{1,2}):(\d{2})/, '');
    } else if (raw.includes('每天')) {
        const hh = timeMatch ? parseInt(timeMatch[1], 10) : 9;
        const mm = timeMatch ? parseInt(timeMatch[2], 10) : 0;
        const d = new Date(now);
        d.setHours(hh, mm, 0, 0);
        if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
        nextAt = d.getTime();
        intervalMs = 86400000;
        content = raw.replace(/每天/, '').replace(/(\d{1,2}):(\d{2})/, '');
    } else if (raw.includes('明天')) {
        const hh = timeMatch ? parseInt(timeMatch[1], 10) : 9;
        const mm = timeMatch ? parseInt(timeMatch[2], 10) : 0;
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        d.setHours(hh, mm, 0, 0);
        nextAt = d.getTime();
        content = raw.replace(/明天/, '').replace(/(\d{1,2}):(\d{2})/, '');
    } else if ((freqMatch = raw.match(/(\d+)\s*分钟\s*后/))) {
        nextAt = now.getTime() + parseInt(freqMatch[1], 10) * 60000;
        content = raw.replace(freqMatch[0], '');
    } else if (timeMatch) {
        const hh = parseInt(timeMatch[1], 10);
        const mm = parseInt(timeMatch[2], 10);
        const d = new Date(now);
        d.setHours(hh, mm, 0, 0);
        if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
        nextAt = d.getTime();
        content = raw.replace(/(\d{1,2}):(\d{2})/, '');
    } else {
        nextAt = now.getTime() + 3600000; // 无时间信息默认 1 小时后
    }
    content = content.replace(/[，,。.\s]+$/g, '').trim();
    if (!content) content = '定时提醒';
    return { content, intervalMs, nextAt };
}

function createScheduledTask(desc) {
    const parsed = parseTaskTag(desc);
    if (!parsed || !parsed.nextAt) return null;
    const task = {
        id: generateId(),
        content: parsed.content,
        intervalMs: parsed.intervalMs,
        nextAt: parsed.nextAt,
        createdAt: Date.now()
    };
    const tasks = loadScheduledTasks();
    tasks.push(task);
    saveScheduledTasks(tasks);
    return task;
}

function cancelScheduledTask(id) {
    saveScheduledTasks(loadScheduledTasks().filter(t => t.id !== id));
}

function listScheduledTasks() {
    return loadScheduledTasks().sort((a, b) => a.nextAt - b.nextAt);
}

// 从 AI 回复提取 [任务:...] 标签并注册，返回创建数量
function extractAndCreateTasks(text) {
    if (!text) return 0;
    const matches = String(text).match(/\[任务[:：][^\]]*\]/g);
    if (!matches) return 0;
    let count = 0;
    let nextTime = null;
    for (const m of matches) {
        const task = createScheduledTask(m);
        if (task) {
            count++;
            if (!nextTime || task.nextAt < nextTime) nextTime = task.nextAt;
            console.log('[任务] 已创建:', task.content, new Date(task.nextAt).toLocaleString());
        }
    }
    if (count) {
        const tip = nextTime ? `下次：${new Date(nextTime).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
        showCustomAlert(`✅ 已为你创建 ${count} 个定时任务（${tip}），到点我会主动提醒你。`, '定时任务');
    }
    return count;
}

// 到期触发：AI 以角色身份生成提醒消息，插入当前对话
async function fireScheduledTask(task) {
    const conv = getCurrentConversation();
    if (!conv) {
        console.warn('[任务] 无当前对话，跳过触发:', task.content);
        return;
    }
    try {
        const raw = await callAI(`（定时提醒任务）请以你的角色身份，用一两句话自然提醒我这件事，不要提及"定时任务"或"提醒"：${task.content}`);
        const text = window.ElainaTags ? window.ElainaTags.strip(raw) : raw;
        const aiMessage = { id: generateId(), role: 'ai', text, timestamp: new Date().toLocaleTimeString() };
        conv.messages.push(aiMessage);
        saveConversations();
        if (window.ElainaTags) window.ElainaTags.drive(raw);
        if (state.currentConversationId === conv.id) {
            renderMessage(aiMessage);
        }
        // 浏览器通知（可选）
        try {
            if (window.Notification && Notification.permission === 'granted') {
                new Notification('ElainaChat · ' + (state.characterCard.name || '伊蕾娜'), { body: task.content });
            }
        } catch { /* ignore */ }
        console.log('[任务] 已触发:', task.content);
    } catch (error) {
        console.error('[任务] 触发失败:', error?.message || error);
    }
}

// 调度检查：每 30s 扫一次到期任务
function checkScheduledTasks() {
    const now = Date.now();
    const tasks = loadScheduledTasks();
    const due = tasks.filter(t => t.nextAt && t.nextAt <= now);
    if (!due.length) return;
    let changed = false;
    for (const t of due) {
        void fireScheduledTask(t);
        if (t.intervalMs > 0) {
            t.nextAt = now + t.intervalMs;
            changed = true;
        } else {
            tasks.splice(tasks.indexOf(t), 1);
            changed = true;
        }
    }
    if (changed) saveScheduledTasks(tasks);
}

// 设置页任务列表渲染
function renderScheduledTaskList() {
    const listEl = document.getElementById('scheduledTaskList');
    if (!listEl) return;
    const tasks = listScheduledTasks();
    if (!tasks.length) {
        listEl.innerHTML = '<p class="text-[11px] text-indigo-300">（暂无任务）</p>';
        return;
    }
    listEl.innerHTML = tasks.map(t => `
        <div class="flex items-center justify-between gap-2 bg-white/60 border border-indigo-100 rounded-lg px-3 py-2">
            <div class="min-w-0">
                <div class="text-xs text-indigo-800 truncate">${escapeHtml(t.content)}</div>
                <div class="text-[11px] text-indigo-400">下次：${new Date(t.nextAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${t.intervalMs > 0 ? '（周期）' : '（一次）'}</div>
            </div>
            <button type="button" class="btn-secondary text-xs text-red-500" onclick="window.__cancelScheduledTask('${safeAttrId(t.id)}')">取消</button>
        </div>
    `).join('');
}
window.__cancelScheduledTask = function (id) {
    cancelScheduledTask(id);
    renderScheduledTaskList();
};

async function runManualMemorySummary() {
    if (state.memorySummaryRunning) {
        showCustomAlert('记忆整理正在进行中，请稍候。', '记忆整理');
        return;
    }

    setManualMemoryUi(true);
    let result;
    try {
        result = await requestMemorySummary();
    } catch (error) {
        console.error('[记忆] 手动整理失败:', error);
        result = { ok: false, reason: 'failed', error };
    } finally {
        setManualMemoryUi(false);
        closeComposerToolsMenu();
    }

    if (result.ok) {
        if (state.diaryMode) renderDiaryPage();
        const preview = formatMemoryForPrompt(1);
        showCustomAlert('当前对话已整理完毕，经历已汇入伊蕾娜的通用记忆本，所有对话都会记得。\n\n' + (preview || '（记忆内容已保存）').slice(0, 400), '记忆整理完成');
    } else if (result.reason === 'empty') {
        showCustomAlert('当前会话还没有可整理的内容，先和伊蕾娜聊几句吧。', '记忆整理');
    } else if (result.reason === 'parse-fail') {
        showCustomAlert('模型返回的整理结果格式异常，请稍后再试。', '记忆整理');
    } else if (result.reason === 'busy') {
        showCustomAlert('记忆整理正在进行中，请稍候。', '记忆整理');
    } else if (result.error) {
        showClientApiError(result.error);
    } else {
        showCustomAlert('记忆整理失败，请检查 API 配置。', '记忆整理');
    }
}

