/* ========================================================================
 * 设置与运维：状态机 / 设置 / 悬浮窗 / 副屏监视 / 日志 / 数据 / 密码
 *
 * 本文件由 web/index.html 的主脚本按分区拆分而来（保持原始加载顺序）。
 * 拆分前提：主脚本是全局作用域，拆分后各文件共享同一全局词法环境，
 * 因此顶层 function / const / let 互相可见，调用点无需修改。
 *
 * 包含分区：
 *   · 状态机 UI
 *   · 设置
 *   · 操作悬浮窗（APK 独有）
 *   · 副屏监视窗
 *   · 日志设置（服务端）
 *   · 我的数据（导出 / 导入 / 位置）
 *   · 访问密码（局域网鉴权）
 *   · 问候打字机
 * ======================================================================== */

// ==================== 状态机 UI ====================

function alignFloatingMicToComposer() {
    if (!elements.floatingMic || elements.floatingMic.classList.contains('hidden')) return;
    const conversationComposer = elements.inputBar && !elements.inputBar.classList.contains('hidden')
        ? elements.inputBar.querySelector('.conversation-composer')
        : null;
    const initialComposer = elements.initialState && !elements.initialState.classList.contains('hidden')
        ? elements.initialState.querySelector('.initial-composer-shell')
        : null;
    const target = conversationComposer || initialComposer;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    elements.floatingMic.style.left = `${Math.round(rect.left)}px`;
    elements.floatingMic.style.top = `${Math.round(rect.top)}px`;
    elements.floatingMic.style.width = `${Math.round(rect.width)}px`;
    elements.floatingMic.style.transform = 'none';
}

let lastVoiceStateDispatch = '';
function updateUI() {
    const { voiceState } = state;

    // 通知视频通话界面（Live2D）语音状态变化：🎤 说话按钮同步聆听状态
    if (voiceState !== lastVoiceStateDispatch) {
        lastVoiceStateDispatch = voiceState;
        window.dispatchEvent(new CustomEvent('voice-state', { detail: { state: voiceState } }));
    }

    const statusMap = {
        'idle': '点击麦克风开始说话',
        'listening': '正在聆听...',
        'paused': '⏸ 已暂停（可继续说话，或点麦克风结束）',
        'thinking': '伊蕾娜思考中...',
        'error': '发生错误'
    };
    elements.statusText.textContent = statusMap[voiceState] || '';

    const micClass = {
        'listening': 'mic-btn mic-listening relative w-32 h-32 rounded-full flex items-center justify-center',
        'paused': 'mic-btn mic-paused relative w-32 h-32 rounded-full flex items-center justify-center',
        'thinking': 'mic-btn mic-thinking relative w-32 h-32 rounded-full flex items-center justify-center',
        'error': 'mic-btn mic-error relative w-32 h-32 rounded-full flex items-center justify-center',
        'idle': 'mic-btn mic-idle relative w-32 h-32 rounded-full flex items-center justify-center'
    };
    elements.micBtn.className = micClass[voiceState] || micClass['idle'];

    const listening = voiceState === 'listening' || voiceState === 'paused';
    elements.pulseRing1.classList.toggle('hidden', !listening);
    elements.pulseRing2.classList.toggle('hidden', !listening);
    elements.floatingPulse1.classList.toggle('hidden', !listening);
    elements.floatingPulse2.classList.toggle('hidden', !listening);

    if (elements.floatingVoiceTitle) {
        elements.floatingVoiceTitle.textContent = voiceState === 'paused' ? '等待继续说话' : '正在聆听';
        elements.floatingVoiceHint.textContent = voiceState === 'paused'
            ? '继续说话，或点击绿色按钮发送'
            : '说完后点击麦克风发送';
    }

    const dockVisible = listening && !state.notesMode && !state.diaryMode;
    elements.floatingMic.classList.toggle('hidden', !dockVisible);
    if (dockVisible) requestAnimationFrame(alignFloatingMicToComposer);
}


// ==================== 设置 ====================

// 把 state.settings / state.characterCard 填充到设置表单（打开设置 / 恢复默认后调用）
function fillSettingsForm() {
    // 回落用"当前格式"的预设，不要用 DEFAULT_SETTINGS —— 后者写死 DeepSeek 的地址和模型，
    // 选 Anthropic 时清空输入框会回落到 DeepSeek 的 URL，看起来像"格式没生效"。
    const fillPreset = CHAT_API_FORMATS[state.settings.apiFormat] || CHAT_API_FORMATS['openai-compatible'];
    elements.settingApiFormat.value = state.settings.apiFormat || 'openai-compatible';
    elements.settingBaseUrl.value = state.settings.baseUrl || fillPreset.defaultBaseUrl;
    elements.settingChatModel.value = state.settings.model || fillPreset.defaultModel;
    elements.settingApiKey.value = state.settings.apiKey;
    elements.settingTtsProvider.value = state.settings.ttsProvider || 'edge';
    document.getElementById('settingMinimaxApiKey').value = state.settings.minimaxApiKey || '';
    document.getElementById('settingMinimaxVoice').value = state.settings.minimaxVoice || '';
    document.getElementById('settingMinimaxModel').value = state.settings.minimaxModel || 'speech-2.8-hd';
    document.getElementById('settingDoubaoApiKey').value = state.settings.doubaoApiKey || '';
    document.getElementById('settingDoubaoAppId').value = state.settings.doubaoAppId || '';
    document.getElementById('settingDoubaoToken').value = state.settings.doubaoToken || '';
    document.getElementById('settingDoubaoCluster').value = state.settings.doubaoCluster || 'volcano_tts';
    document.getElementById('settingDoubaoVoice').value = state.settings.doubaoVoice || 'zh_female_shuangkuaisisi_uranus_bigtts';
    document.getElementById('settingDoubaoResourceId').value = state.settings.doubaoResourceId || 'seed-tts-2.0';
    document.getElementById('settingDashscopeTtsModel').value = state.settings.dashscopeTtsModel || 'qwen3-tts-flash';
    document.getElementById('settingDashscopeTtsVoice').value = state.settings.dashscopeTtsVoice || 'Cherry';
    document.getElementById('settingVisionBaseUrl').value = state.settings.visionBaseUrl || '';
    document.getElementById('settingVisionApiKey').value = state.settings.visionApiKey || '';
    document.getElementById('settingVisionModel').value = state.settings.visionModel || '';
    elements.settingTtsSpeed.value = state.settings.ttsSpeed;
    elements.ttsSpeedLabel.textContent = state.settings.ttsSpeed.toFixed(1) + 'x';
    elements.settingTtsVolume.value = Number(state.settings.ttsVolume ?? 1);
    elements.ttsVolumeLabel.textContent = Math.round(Number(state.settings.ttsVolume ?? 1) * 100) + '%';
    updateSliderFill(elements.settingTtsSpeed);
    updateSliderFill(elements.settingTtsVolume);

    document.querySelectorAll('input[name="ttsLang"]').forEach(r => {
        r.checked = (r.value === (state.settings.ttsLang || 'japanese'));
    });
    document.querySelectorAll('input[name="replyDisplayMode"]').forEach(r => {
        r.checked = (r.value === (state.settings.replyDisplayMode || DEFAULT_SETTINGS.replyDisplayMode));
    });

    document.querySelectorAll('input[name="asrProvider"]').forEach(r => {
        r.checked = (r.value === (state.settings.asrProvider || 'browser'));
    });
    updateChatFormatUI();
    updateAsrProviderUI();
    updateTtsProviderUI();

    document.getElementById('settingDashscopeApiKey').value = state.settings.dashscopeApiKey || '';
    document.getElementById('settingDashscopeAsrBaseUrl').value = state.settings.dashscopeAsrBaseUrl || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
    document.getElementById('settingDashscopeAsrModel').value = state.settings.dashscopeAsrModel || 'qwen3-asr-flash';
    document.getElementById('settingMimoApiKey').value = state.settings.mimoApiKey || '';
    document.getElementById('settingMimoBaseUrl').value = state.settings.mimoBaseUrl || 'https://api.xiaomimimo.com';
    document.getElementById('settingMimoAsrModel').value = state.settings.mimoAsrModel || 'mimo-v2.5-asr';
    elements.settingAutoMemory.checked = Boolean(state.settings.autoMemory);
    elements.settingMemoryEvery.value = state.settings.memoryEvery || 6;
    document.querySelectorAll('input[name="agentPermission"]').forEach(r => {
        r.checked = (r.value === (state.settings.agentPermission || 'app'));
    });
    document.querySelectorAll('input[name="agentApproval"]').forEach(r => {
        r.checked = (r.value === (state.settings.agentApproval || 'once'));
    });
    const phoneToggle = document.getElementById('settingAgentPhoneEnabled');
    if (phoneToggle) phoneToggle.checked = state.settings.agentPhoneEnabled !== false;
    syncAgentSectionsByDevice();

    renderCardSelect();
    fillCharacterCardForm();
    settingsContent.scrollTop = 0;
    renderScheduledTaskList();
    void refreshLogSettings();
    void refreshDataSettings();
    void refreshOverlayStatus();
}


// ==================== 操作悬浮窗（APK 独有） ====================
// AI 操作的是别的应用。没有悬浮窗时，每一步确认都要用户切回本应用来点，
// 而"切回来"会让被操作的应用退到后台，那一步操作就可能失败 → AI 重试 → 看起来像卡住。
// 悬浮窗是唯一能打破这个循环的东西：它浮在目标应用之上，不离开当前界面就能确认或停止。
//
// 注意这是 Android 的**特殊权限**（「显示在其他应用上层」），只能由用户
// 在系统设置里手动打开 —— 应用无法弹运行时权限框索取。所以这里只能"跳过去 + 回来复检"。
async function refreshOverlayStatus() {
    const dot = document.getElementById('overlayStatusDot');
    const text = document.getElementById('overlayStatusText');
    const btn = document.getElementById('overlayEnableBtn');
    const wrap = document.getElementById('overlayStatusDot')?.closest('div')?.parentElement;
    if (!text) return;

    const plugin = deviceBridge();
    // 网页版没有原生层：整块隐藏（在那个环境里这个设置本来就不适用）
    if (!plugin || typeof plugin.overlayStatus !== 'function') {
        if (wrap) wrap.classList.add('hidden');
        return;
    }
    if (wrap) wrap.classList.remove('hidden');
    try {
        const res = await plugin.overlayStatus();
        const ok = Boolean(res && res.canDraw);
        if (dot) dot.className = 'w-2 h-2 rounded-full flex-none ' + (ok ? 'bg-emerald-400' : 'bg-amber-400');
        text.textContent = ok ? '已开启' : '未开启（AI 操作时会提示你开）';
        if (btn) btn.textContent = ok ? '去系统设置检查' : '开启悬浮窗';
    } catch (e) {
        text.textContent = '检测失败';
    }
}

/**
 * 跳到系统设置里的「显示在其他应用上层」，让用户开启悬浮窗权限。
 *
 * @param opts.quiet 静默模式：不弹"已打开系统设置"的说明框。
 *   AI 操作流程里要用它 —— 那时用户正要去看 AI 做了什么，
 *   再叠一个说明框会挡住视线（而且他刚从确认框点过来的，已经知道自己在干什么）。
 */
async function enableOverlay(opts) {
    const quiet = Boolean(opts && opts.quiet);
    const plugin = deviceBridge();
    if (!plugin || typeof plugin.requestOverlay !== 'function') {
        showCustomAlert('当前环境没有原生设备层（电脑版没有这个功能）。', '操作悬浮窗');
        return;
    }
    try {
        await plugin.requestOverlay();
        if (quiet) return;
        // 跳到系统设置后用户会切走再回来 —— 这时 fillSettingsForm 会重新跑一次，
        // 但用户也可能直接返回而没触发刷新，所以下面给一句明确的手动提示。
        showCustomAlert(
            '已打开系统设置。\n\n'
            + '请找到并打开「显示在其他应用上层」/「悬浮窗」权限，然后返回本应用。\n\n'
            + '回来后在设置里点「重新检测」确认状态变成「已开启」。',
            '操作悬浮窗');
    } catch (e) {
        showCustomAlert('打开系统设置失败：' + (e.message || e), '操作悬浮窗');
    }
}


// ==================== 副屏监视窗 ====================
//
// AI 用「模块」后端操作手机时，它在**独立虚拟副屏**上跑，物理主屏看不到。
// 这个窗口把副屏画面搬进应用，让用户知道 AI 正在点什么、界面变成了什么样。
//
// 不做成 iframe 套模块的 3070 网页面板：那等于把浏览器塞进应用，风格割裂、
// 还有滚动/缩放两套坐标系。这里只从模块取「画面 + 状态」，UI 完全是我们自己的。
const SCREEN_WATCH_INTERVAL = 1500;   // 自动刷新间隔（模块出帧约 18ms，1.5s 足够跟手）
let screenWatchTimer = null;
let screenWatchAuto = true;
let screenWatchBusy = false;
let screenWatchLogs = [];

function screenWatchEl(id) { return document.getElementById(id); }

// setStep 在 agentRuntime 的 IIFE 里够不到这个函数，挂到 window 供它回调
window.__screenWatchNote = (text) => screenWatchNote(text);

/** 记录一条"AI 最近动作"，显示在监视窗里 */
function screenWatchNote(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    screenWatchLogs.push(stamp + '  ' + t);
    if (screenWatchLogs.length > 40) screenWatchLogs = screenWatchLogs.slice(-40);
    const box = screenWatchEl('screenWatchLog');
    if (box) {
        box.innerHTML = screenWatchLogs.slice(-12).map((line) =>
            '<div>' + line.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>').join('');
        box.scrollTop = box.scrollHeight;
    }
}

/** 拉一帧副屏画面 + 状态 */
async function screenWatchRefresh() {
    if (screenWatchBusy) return;
    const plugin = deviceBridge();
    const img = screenWatchEl('screenWatchImg');
    const empty = screenWatchEl('screenWatchEmpty');
    const meta = screenWatchEl('screenWatchMeta');
    const dot = screenWatchEl('screenWatchDot');
    const powerBtn = screenWatchEl('screenWatchPowerBtn');
    if (!plugin || typeof plugin.liveFrame !== 'function') {
        if (meta) meta.textContent = '电脑版没有副屏';
        return;
    }
    screenWatchBusy = true;
    try {
        const res = await plugin.liveFrame();
        if (!res || !res.ok) {
            // 明确区分"没有画面"和"模块不可用" —— 前者要引导启动副屏，后者要引导刷模块
            if (res && res.reason === 'no-frame') {
                if (meta) meta.textContent = '副屏无画面';
                if (dot) dot.style.background = '#fbbf24';
                if (empty) empty.classList.remove('hidden');
                if (img) img.classList.add('hidden');
                const hint = screenWatchEl('screenWatchEmptyHint');
                if (hint) hint.textContent = '副屏是空的（只有壁纸）。让 AI 先执行一次「手机打开 某应用」。';
            } else {
                if (meta) meta.textContent = '模块不可用';
                if (dot) dot.style.background = '#f87171';
                if (empty) empty.classList.remove('hidden');
                if (img) img.classList.add('hidden');
                const hint = screenWatchEl('screenWatchEmptyHint');
                if (hint) hint.textContent = String(res && res.text || '没刷 KernelSU 模块，或 vd_server 没在跑。');
            }
            if (powerBtn) powerBtn.textContent = '启动副屏';
            return;
        }
        if (img && res.imageBase64) {
            img.src = 'data:' + (res.mime || 'image/jpeg') + ';base64,' + res.imageBase64;
            img.classList.remove('hidden');
            if (empty) empty.classList.add('hidden');
            // 模块的截图优先返回**缓存的帧**（换速度），刚启动应用时可能还是旧的黑帧。
            // 判断依据：JPEG 极小时基本就是纯色（黑屏副屏约 9KB，有内容时几十~几百KB）。
            // 这里不弹提示打断，只把状态文字改掉，1.5s 后的自动刷新通常会追上新画面。
            const tiny = (res.bytes || 0) < 20000;
            if (tiny && meta && String(res.status || '') === 'running') {
                meta.textContent = '运行中 · Display ' + res.displayId + ' · 画面更新中…';
            }
        }
        const running = String(res.status || '') === 'running';
        if (dot) dot.style.background = running ? '#34d399' : '#fbbf24';
        if (meta) {
            meta.textContent = running
                ? ('运行中 · Display ' + res.displayId + ' · ' + res.width + '×' + res.height)
                : '已休眠';
        }
        if (powerBtn) powerBtn.textContent = running ? '关闭副屏' : '启动副屏';
    } catch (e) {
        if (meta) meta.textContent = '读取失败';
    } finally {
        screenWatchBusy = false;
    }
}

function screenWatchStartAuto() {
    screenWatchStopAuto();
    if (!screenWatchAuto) return;
    screenWatchTimer = setInterval(() => { void screenWatchRefresh(); }, SCREEN_WATCH_INTERVAL);
}
function screenWatchStopAuto() {
    if (screenWatchTimer) { clearInterval(screenWatchTimer); screenWatchTimer = null; }
}

function openScreenWatch() {
    const panel = screenWatchEl('screenWatchPanel');
    if (!panel) return;
    // 监视窗与设置面板同为 100002 层（见 CSS 里的分层说明）。两者若同时开着，
    // 谁在上面就由 DOM 顺序决定 —— 那正是注释里说要避免的事。
    // 所以打开监视窗前先把设置关掉（注释声称如此，实现以前漏了这一步）。
    if (typeof closeSettingsPanel === 'function') closeSettingsPanel();
    panel.classList.remove('hidden');
    panel.classList.add('flex');
    void screenWatchRefresh();
    screenWatchStartAuto();
}
function closeScreenWatch() {
    const panel = screenWatchEl('screenWatchPanel');
    if (panel) { panel.classList.add('hidden'); panel.classList.remove('flex'); }
    screenWatchStopAuto();
}


// ==================== 日志设置（服务端） ====================
// 与其它设置不同：日志级别存在**服务端**（data/logs/log-settings.json），因为它管的是
// 服务进程往文件里写什么，跟浏览器无关。所以它不进 state.settings，也不等「保存设置」，
// 改完立刻 POST 生效 —— 否则用户会以为改完没生效（要重启服务才生效的话更是如此）。
const LOG_LEVEL_HINT = {
    DEBUG: '最详细，含前端调试信息',
    INFO: '默认，日常排查够用',
    WARN: '只看警告与报错',
    ERROR: '只看报错',
    CRITICAL: '只看致命错误（如端口占用）',
};

function renderLogLevelHint() {
    const sel = elements.settingLogLevel;
    const hint = document.getElementById('settingLogLevelHint');
    if (!sel || !hint) return;
    hint.textContent = LOG_LEVEL_HINT[sel.value] || '';
}

async function refreshLogSettings() {
    const box = document.getElementById('logStatusBox');
    const sel = elements.settingLogLevel;
    const traceBox = elements.settingLogTrace;
    const section = document.getElementById('logSettingsSection');
    if (!box) return;
    try {
        const res = await fetch('/api/logs/settings');
        if (!res.ok) { box.textContent = '无法读取日志设置（HTTP ' + res.status + '）'; return; }
        const json = await res.json();
        if (!json.ok) { box.textContent = '无法读取日志设置'; return; }
        if (sel) sel.value = json.level || 'INFO';
        if (traceBox) traceBox.checked = Boolean(json.trace);
        renderLogLevelHint();
        if (!json.fileEnabled) {
            box.textContent = '当前以 LOG_TO_FILE=0 启动，日志不落盘，级别设置不生效（只打终端）。';
            return;
        }
        const files = [];
        if (json.mainFile) files.push('主日志 ' + json.mainFile);
        if (json.trace && json.traceFile) files.push('追踪日志 ' + json.traceFile);
        box.innerHTML = '当前落盘级别 <code class="text-indigo-500">' + escapeHtml(json.level || 'INFO')
            + '</code>，每次启动一组文件、保留最近 ' + escapeHtml(String(json.keep || 10)) + ' 次，'
            + '单文件上限 ' + escapeHtml(String(json.maxMb || 8)) + 'MB。<br>'
            + '位置：<code class="text-indigo-500">' + escapeHtml(json.logDir || 'data/logs') + '</code>'
            + (files.length ? '<br>' + files.map(f => escapeHtml(f)).join('<br>') : '');
    } catch (e) {
        // 安卓 App（Capacitor 本地文件）没有本地服务：日志落盘这件事在 APK 上根本不存在。
        // 整块隐藏，而不是留一个能点、点了却弹"修改失败"的下拉框 —— 那比没有更糟。
        // （与「电脑操作权限」按设备形态隐藏是同一种处理。）
        if (section) section.classList.add('hidden');
    }
}

async function applyLogSettings() {
    const sel = elements.settingLogLevel;
    const traceBox = elements.settingLogTrace;
    if (!sel) return;
    // 整块已被隐藏（无本地服务）时不再发请求：否则会弹出"修改失败"，
    // 而用户在 APK 上本来就没有这个功能，弹窗只会让人以为坏了。
    const section = document.getElementById('logSettingsSection');
    if (section && section.classList.contains('hidden')) return;
    try {
        const res = await fetch('/api/logs/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                level: sel.value,
                trace: traceBox ? traceBox.checked : undefined
            })
        });
        const json = await res.json();
        if (!json.ok) { showCustomAlert(json.message || '日志设置修改失败', '日志'); return; }
        await refreshLogSettings();
    } catch (e) {
        showCustomAlert('日志设置修改失败：' + (e.message || e), '日志');
    }
}


// ==================== 我的数据（导出 / 导入 / 位置） ====================
// 后端把数据分类落在 data/ 下（人设卡一卡一文件、聊天记录、记忆各自独立）。
// 这里只负责"让用户能看见、能备份、能恢复" —— 换机器和升级前的那道保险。
//
// 两种运行环境，两条路径：
//   Web：数据在服务端 data/ 下 → 走 /api/data/*
//   APK：没有本地服务 → 走 web/js/chat-backup.js，直接读写 localStorage
//
// **APK 侧以前是整块隐藏的**，但那恰恰是最需要备份的地方 ——
// 数据存在应用私有目录，卸载即丢，用户连手动拷出来都做不到。
// 现在两边都提供导入导出，而且备份格式同构，可以互相导入。
async function refreshDataSettings() {
    const box = document.getElementById('dataStatusBox');
    const section = document.getElementById('dataSettingsSection');
    if (!box) return;

    // ---- APK：本地统计，不发请求 ----
    if (IS_NATIVE_APP && window.ChatBackup) {
        try {
            let cards = 0;
            let convs = 0;
            let mem = 0;
            try { cards = JSON.parse(localStorage.getItem('elaina_open_character_cards') || '[]').length; } catch { /* 忽略 */ }
            try { convs = JSON.parse(localStorage.getItem('elaina_open_conversations') || '[]').length; } catch { /* 忽略 */ }
            try { mem = (JSON.parse(localStorage.getItem('elaina_open_memory_core') || '{}').diary || []).length; } catch { /* 忽略 */ }
            box.innerHTML = '数据位置：<code class="text-indigo-500">应用私有目录</code>'
                + '<span class="text-indigo-300">（安卓应用数据，卸载会一并删除）</span><br>'
                + '人设卡 <b>' + escapeHtml(String(cards)) + '</b> 张'
                + ' · 对话 <b>' + escapeHtml(String(convs)) + '</b> 个'
                + ' · 记忆 <b>' + escapeHtml(String(mem)) + '</b> 条';
        } catch (e) {
            box.textContent = '无法读取本地数据统计';
        }
        return;
    }

    // ---- Web：走后端 ----
    try {
        const res = await fetch('/api/data/info');
        if (!res.ok) { if (section) section.classList.add('hidden'); return; }
        const json = await res.json();
        if (!json.ok) { if (section) section.classList.add('hidden'); return; }
        const c = json.counts || {};
        box.innerHTML = '数据位置：<code class="text-indigo-500">' + escapeHtml(json.dir || 'data')
            + '</code><br>'
            + '人设卡 <b>' + escapeHtml(String(c.characters || 0)) + '</b> 张'
            + ' · 对话 <b>' + escapeHtml(String(c.conversations || 0)) + '</b> 个'
            + ' · 记忆 <b>' + escapeHtml(String(c.memoryEntries || 0)) + '</b> 条';
    } catch (e) {
        if (section) section.classList.add('hidden');
    }
}

function setDataHint(text, isError) {
    const hint = document.getElementById('dataActionHint');
    if (!hint) return;
    hint.textContent = text || '';
    hint.className = isError ? 'text-[11px] text-red-500' : 'text-[11px] text-indigo-300';
}

async function exportDataBackup() {
    setDataHint('导出中…');

    // ---- APK：本地生成 zip 并**写进应用文档目录**（没有后端可用）----
    //
    // 为什么不用 <a download> + blob URL：**安卓 WebView 不处理 blob: 下载**。
    // 桌面浏览器会把 blob 交给下载器，WebView 里点下去通常毫无反应
    //（这也是 Capacitor 社区反复提到的一点）。所以 APK 侧走 Capacitor Filesystem，
    // 把备份真正写到磁盘上，再把路径告诉用户。
    if (IS_NATIVE_APP && window.ChatBackup) {
        try {
            const fs = nativeFs();
            if (!fs) { setDataHint('导出失败：文件系统插件不可用', true); return; }
            const blob = await window.ChatBackup.buildBackupBlob();
            if (!blob.size) { setDataHint('导出失败：本地数据为空', true); return; }
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const t = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            const fileName = 'elainachat-backup-' + t + '.zip';
            // Documents 目录：用户能用系统文件管理器找到（比 Data 私有目录友好）
            const dir = (fs.Directory && fs.Directory.Documents) ? fs.Directory.Documents : 'DOCUMENTS';
            await nativeWriteFile(fileName, dir, bytes);
            // 同时取一个 WebView 能访问的 URL，方便用户直接点开/分享
            let where = '文档目录';
            try {
                const uri = await fs.getUri({ path: fileName, directory: dir });
                if (uri && uri.uri) where = uri.uri;
            } catch { /* 拿不到就只报目录名 */ }
            setDataHint('已导出：' + fileName + '（' + Math.round(bytes.length / 1024) + ' KB）');
            showCustomAlert(
                '备份已保存到手机的**文档目录**：\n\n' + fileName
                + '\n\n大小 ' + Math.round(bytes.length / 1024) + ' KB。'
                + '\n\n用系统「文件管理」进 文档 / Documents 就能看到它。'
                + '传到电脑后，在网页版的「我的数据 → 导入备份」里可以直接还原。',
                '导出完成');
        } catch (e) {
            setDataHint('导出失败：' + (e.message || e), true);
        }
        return;
    }

    // ---- Web：走后端 ----
    try {
        const res = await fetch('/api/data/export');
        if (!res.ok) { setDataHint('导出失败（HTTP ' + res.status + '）', true); return; }
        const blob = await res.blob();
        // 空响应要明确报错，而不是静默存下一个 0 字节文件。
        // 什么时候会空：装了迅雷/FDM 之类下载器的浏览器，其扩展会拦走带
        // attachment 的响应（后端已刻意不发那个头，但旧版服务或别的中间层
        // 仍可能造成空响应）。这种情况用户拿到的文件是坏的，必须说出来。
        if (!blob.size) {
            setDataHint('导出失败：服务端返回了空内容。若装了迅雷/FDM，请先关掉它的浏览器扩展再试。', true);
            return;
        }
        // 文件名走自定义头（后端不再发 Content-Disposition，避免被下载器识别成下载）
        let name = res.headers.get('X-Backup-Filename') || '';
        if (!name) {
            const cd = res.headers.get('Content-Disposition') || '';
            const m = cd.match(/filename="?([^";]+)"?/);
            if (m && m[1]) name = m[1];
        }
        if (!name) {
            const t = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            name = 'elainachat-backup-' + t + '.zip';
        }
        // blob: 是内存地址，外部下载器接管不了，也不会弹它的窗口
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setDataHint('已导出：' + name + '（' + Math.round(blob.size / 1024) + ' KB）');
    } catch (e) {
        setDataHint('导出失败：' + (e.message || e), true);
    }
}

/**
 * APK 侧导入入口：先看文档目录里有没有导出过的备份，有就让用户选；
 * 一个都没有（或插件不可用）时退回系统文件选择器。
 *
 * 为什么要有这条路径：安卓 WebView 的 <input type="file"> 行为在各厂商 ROM 上
 * 差异很大（有的能选、有的只能选图片）。而"自己导出的备份就在文档目录里"是
 * **最常见的使用场景**（导完想恢复），走 Filesystem 读取最可靠。
 */
async function importFromDocumentsOrPicker() {
    const fs = nativeFs();
    let names = [];
    try {
        const dir = (fs.Directory && fs.Directory.Documents) ? fs.Directory.Documents : 'DOCUMENTS';
        const res = await fs.readdir({ path: '', directory: dir });
        names = (res && res.files ? res.files : [])
            .filter((f) => /^elainachat-backup-.*\.(zip|json)$/i.test(f.name))
            .map((f) => f.name)
            .sort()
            .reverse();   // 最新的排前面
    } catch { /* 目录读不到就当没有 */ }

    if (!names.length) {
        // 没有备份 → 交给系统文件选择器（用户可能从微信/下载目录里选了传进来的）
        document.getElementById('dataImportFile')?.click();
        return;
    }

    const picked = await showCustomModal({
        title: '从手机里选择备份',
        message: '文档目录里找到 ' + names.length + ' 个备份（最新的在最前）：\n\n'
            + names.slice(0, 8).map((n, i) => (i + 1) + '. ' + n).join('\n')
            + (names.length > 8 ? '\n…还有 ' + (names.length - 8) + ' 个' : '')
            + '\n\n输入序号导入；留空则改用系统文件选择器。',
        input: true,
        defaultValue: '1',
        placeholder: '序号，如 1',
    });
    if (picked === null || picked === undefined || String(picked).trim() === '') {
        document.getElementById('dataImportFile')?.click();
        return;
    }
    const idx = Number(String(picked).trim()) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= names.length) {
        setDataHint('序号无效', true);
        return;
    }
    const fileName = names[idx];
    try {
        const dir = (fs.Directory && fs.Directory.Documents) ? fs.Directory.Documents : 'DOCUMENTS';
        const read = await fs.readFile({ path: fileName, directory: dir });
        // Capacitor 返回 base64（v7 起固定返回 data 字段）
        const b64 = String(read && read.data ? read.data : '');
        if (!b64) { setDataHint('读不到文件内容', true); return; }
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], fileName, { type: 'application/zip' });
        await importDataBackup(file);
    } catch (e) {
        setDataHint('读取备份失败：' + (e.message || e), true);
    }
}

async function importDataBackup(file) {
    if (!file) return;
    // 合并模式：只覆盖备份里有的数据，本机其它数据不动 —— 比"替换"安全得多，
    // 所以默认用它，且不做二次确认之外的额外询问。
    const okToGo = await showCustomConfirm(
        '导入备份会覆盖同名的数据（聊天记录 / 人设卡 / 记忆 / 设置），本机其它数据保留。\n\n'
        + '继续导入吗？', '导入备份');
    if (!okToGo) { setDataHint('已取消'); return; }
    setDataHint('导入中…');

    // ---- APK：本地写回 localStorage（没有后端可用）----
    if (IS_NATIVE_APP && window.ChatBackup) {
        try {
            const r = await window.ChatBackup.applyBackup(file);
            setDataHint('已导入 ' + r.keys + ' 项数据（' + (r.source === 'zip' ? 'zip' : '旧版 JSON') + '）');
            await refreshDataSettings();
            showCustomAlert('已导入 ' + r.keys + ' 项数据。\n\n刷新页面后即可看到导入的聊天记录与人设卡。', '导入完成');
        } catch (e) {
            setDataHint('导入失败：' + (e.message || e), true);
        }
        return;
    }

    // ---- Web：交给后端 ----
    try {
        // 直接把文件原样发上去：备份是 zip（二进制），不能走 JSON 包装。
        // 后端两种都认（zip 与 v1 的单 JSON 旧备份），所以这里不用判断类型。
        const res = await fetch('/api/data/import?mode=merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file
        });
        const json = await res.json().catch(() => ({ ok: false, message: '服务端返回了非 JSON 内容（HTTP ' + res.status + '）' }));
        if (!json.ok) { setDataHint(json.message || '导入失败', true); return; }
        setDataHint(json.message || '导入完成');
        await refreshDataSettings();
        showCustomAlert((json.message || '导入完成') + '。\n\n刷新页面后即可看到导入的聊天记录与人设卡。', '导入完成');
    } catch (e) {
        setDataHint('导入失败：' + (e.message || e), true);
    }
}


// ==================== 访问密码（局域网鉴权） ====================
// 本机（127.0.0.1）自动是管理员：免密、且可修改访问密码（也是忘记密码的找回入口）。
async function refreshAuthStatus() {
    const box = document.getElementById('authStatusBox');
    if (!box) return;
    try {
        const res = await fetch('/api/auth/status');
        if (!res.ok) { box.textContent = '无法获取鉴权状态（HTTP ' + res.status + '）'; return; }
        const json = await res.json();
        if (!json.ok) { box.textContent = '无法获取鉴权状态'; return; }
        if (json.isAdmin) {
            box.innerHTML = json.isDefaultPassword
                ? '当前是本机管理员（免密）。访问密码仍是初始随机密码：<code class="text-indigo-500">' + escapeHtml(json.passwordHint || '') + '</code>，建议改成自己的。'
                : '当前是本机管理员（免密）。访问密码已由你自行设置，控制台不再显示。';
        } else {
            box.textContent = '当前设备已登录（非本机）。如需修改访问密码，请在这台电脑上打开本应用操作。';
        }
    } catch (e) {
        // 安卓 App（Capacitor 本地文件）没有本地服务，此功能不适用
        box.textContent = '当前环境没有本地服务（如安卓 App），访问密码功能不适用。';
    }
}

async function changeAccessPassword() {
    const a = document.getElementById('authNewPwd');
    const b = document.getElementById('authNewPwd2');
    const next = (a && a.value ? a.value : '').trim();
    const again = (b && b.value ? b.value : '').trim();
    if (next.length < 6) { showCustomAlert('新密码至少 6 位。', '访问密码'); return; }
    if (next !== again) { showCustomAlert('两次输入的密码不一致，请重新输入。', '访问密码'); return; }
    try {
        const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ next })
        });
        const json = await res.json();
        if (!json.ok) { showCustomAlert(json.message || '修改失败', '访问密码'); return; }
        if (a) a.value = '';
        if (b) b.value = '';
        await refreshAuthStatus();
        showCustomAlert('访问密码已更新。\n\n· 手机/平板等局域网设备需要重新输入新密码\n· 本机仍然免密\n· 服务端控制台不再显示密码，请记牢', '访问密码');
    } catch (e) {
        showCustomAlert('修改失败：' + (e.message || e), '访问密码');
    }
}

async function logoutAccess() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) { /* 忽略：无论成功与否都跳登录页 */ }
    location.href = '/login';
}

// 「电脑操作权限」与「手机操作」两组设置按设备形态只显示一组：
// 电脑上给「允许操作电脑」，手机上给「手机操作」—— 混在一起用户看不懂。
// 用 IS_MOBILE_DEVICE（设备本身）而不是窗口宽度，电脑上把窗口拖窄不该变成"手机"。
function syncAgentSectionsByDevice() {
    const pcSection = document.getElementById('agentPermissionSection');
    const phoneSection = document.getElementById('agentPhoneSection');
    if (pcSection) pcSection.classList.toggle('hidden', IS_MOBILE_DEVICE);
    if (phoneSection) phoneSection.classList.toggle('hidden', !IS_MOBILE_DEVICE);
}

function openSettings() {
    fillSettingsForm();
    void refreshAuthStatus();
    // 每次打开设置都刷新插件列表：用户可能在服务运行期间往 web/mods/ 丢了新 zip，
    // 刷新一次就能看到（而不是要求他重启服务）
    void refreshModsList();
    // 外观主题：同步选择器状态（模板卡片 + 深色开关）
    if (window.ElainaTheme) {
        window.ElainaTheme.renderPicker();
        window.ElainaTheme.markPicker();
        const darkToggle = document.getElementById('themeDarkToggle');
        if (darkToggle) darkToggle.checked = window.ElainaTheme.isDark();
    }
    elements.settingsOverlay.classList.remove('hidden');
    elements.settingsOverlay.classList.add('flex');
    setRailActive('settings');
}

// ==================== 插件（mod）设置栏 ====================

/**
 * 渲染「设置 → 插件」列表。
 *
 * 数据来源两条路，缺一不可：
 *   ① 服务端 /api/plugins —— 会扫描 web/mods/ 并把新丢进去的 zip 解压安装，
 *      然后返回清单。这是"装了哪些 mod"的权威来源。
 *   ② 前端 window.ElainaMods.list() —— 加载器**实际加载**的结果（含每个 mod 的
 *      运行状态：ready / disabled / error）。
 *
 * 为什么要合并两者：服务端知道"磁盘上有什么"，前端知道"跑起来没有"。
 * 只看服务端会把加载失败的 mod 显示成正常；只看前端则看不到"刚丢进去还没加载"的 mod。
 * 另外 APK 端没有服务端，此时只能靠前端那份（构建时打包进去的 mod）。
 */
async function refreshModsList() {
    const box = document.getElementById('modsList');
    if (!box) return;
    const hint = document.getElementById('modsHint');

    let fromServer = [];
    try {
        const res = await fetch('/api/plugins', { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            fromServer = Array.isArray(data && data.plugins) ? data.plugins : [];
            // 安装失败的 zip 要让用户看见原因，否则"我放进去了但没反应"无从排查
            const bad = (data && data.installResults || []).filter((r) => !r.ok);
            if (hint && bad.length) {
                hint.textContent = '有 ' + bad.length + ' 个 zip 安装失败：' + bad.map((b) => b.zip + '（' + b.error + '）').join('；');
                hint.className = 'text-[11px] text-red-500';
            }
        }
    } catch (e) { /* APK 端没有这个接口，走前端那份 */ }

    const fromLoader = (window.ElainaMods && typeof window.ElainaMods.list === 'function')
        ? window.ElainaMods.list() : [];

    // 以服务端清单为准，用加载器状态补充
    const stateOf = new Map(fromLoader.map((m) => [m.id, m]));
    const merged = fromServer.map((m) => Object.assign({}, m, stateOf.get(m.id) || {}));
    // 服务端没有但加载器有的（APK 端 / 手工放目录）也要显示
    for (const m of fromLoader) {
        if (!merged.some((x) => x.id === m.id)) merged.push(m);
    }

    const globalToggle = document.getElementById('modsGlobalToggle');
    if (globalToggle && window.ElainaMods) {
        globalToggle.checked = window.ElainaMods.isGloballyEnabled();
        globalToggle.onchange = () => {
            window.ElainaMods.setGloballyEnabled(globalToggle.checked);
            if (hint) {
                hint.textContent = '已' + (globalToggle.checked ? '启用' : '关闭') + '插件系统，刷新页面后生效';
                hint.className = 'text-[11px] text-indigo-500';
            }
        };
    }

    if (!merged.length) {
        box.innerHTML = '<div class="text-[11px] text-indigo-400 py-3 text-center">'
            + '没有发现插件。把 mod 的 zip 放进 <code class="px-1 rounded bg-white/60">web/mods/</code> 后点「重新扫描」。</div>';
        return;
    }

    box.innerHTML = merged.map((m) => {
        const id = escapeHtml(m.id);
        const name = escapeHtml(m.name || m.id);
        const desc = escapeHtml(m.description || '');
        const ver = m.version ? '<span class="text-[10px] text-indigo-400 ml-1">v' + escapeHtml(m.version) + '</span>' : '';
        // 状态标记：加载失败必须显眼，否则用户只会觉得"开了没反应"
        let badge = '';
        if (m.state === 'error') {
            badge = '<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 ml-1" title="'
                + escapeHtml(m.error || '') + '">加载失败</span>';
        } else if (m.state === 'ready') {
            badge = '<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600 ml-1">已加载</span>';
        }
        // hidden 的 mod（如公共依赖）不显示开关 —— 它不提供界面，关掉只会让别的 mod 坏掉
        const toggle = m.hidden
            ? '<span class="text-[10px] text-indigo-300 flex-none">公共依赖</span>'
            : '<input type="checkbox" class="accent-pink-500 flex-none mod-toggle" data-mod-id="' + id + '"'
                + (m.enabled ? ' checked' : '') + '>';
        return '<label class="flex items-start gap-2 py-2 px-3 rounded-xl bg-white/50 cursor-pointer">'
            + toggle
            + '<span class="min-w-0">'
              + '<span class="text-xs font-semibold text-indigo-800">' + name + '</span>' + ver + badge
              + (desc ? '<span class="block text-[11px] text-indigo-400 leading-relaxed mt-0.5">' + desc + '</span>' : '')
            + '</span></label>';
    }).join('');

    // 开关事件：走 mod 系统的 setEnabled（会持久化 + 通知 mod 自己）
    box.querySelectorAll('.mod-toggle').forEach((el) => {
        el.addEventListener('change', async () => {
            const id = el.getAttribute('data-mod-id');
            // setEnabled 是 async 的：启用一个**尚未加载**的 mod 需要现场注入它的脚本
            // （mod 默认关闭时脚本从未加载过）。必须 await 之后再刷新列表，
            // 否则会读到旧的 state，把刚启用的 mod 显示成"未加载"。
            if (window.ElainaMods) await window.ElainaMods.setEnabled(id, el.checked);
            if (hint) {
                hint.textContent = '已' + (el.checked ? '启用' : '停用') + ' ' + id + '（立即生效）';
                hint.className = 'text-[11px] text-indigo-500';
            }
            void refreshModsList();
        });
    });
}

function closeSettingsPanel() {
    elements.settingsOverlay.classList.add('hidden');
    elements.settingsOverlay.classList.remove('flex');
    syncRailActive();
}

function updateAsrProviderUI() {
    const provider = document.querySelector('input[name="asrProvider"]:checked')?.value || 'browser';
    elements.dashscopeAsrFields.classList.toggle('hidden', provider !== 'aliyun');
    const mimoFields = document.getElementById('mimoAsrFields');
    if (mimoFields) mimoFields.classList.toggle('hidden', provider !== 'mimo');
    // 浏览器识别暂不可用提示
    const warn = document.getElementById('asrBrowserWarn');
    if (warn) warn.classList.toggle('hidden', provider !== 'browser');
    // 阿里云 Key 状态（复用 TTS 的 DashScope Key）
    const statusEl = document.getElementById('settingAsrKeyStatus');
    if (statusEl) {
        const has = Boolean(String(state.settings.dashscopeApiKey || '').trim());
        statusEl.textContent = has ? '✓ 已配置' : '未配置（请到上方语音输出填写）';
        statusEl.className = 'text-[11px] ' + (has ? 'text-green-500' : 'text-amber-400');
    }
}

function updateTtsProviderUI() {
    const provider = elements.settingTtsProvider?.value || 'edge';
    elements.edgeTtsFields?.classList.toggle('hidden', provider !== 'edge');
    elements.minimaxTtsFields?.classList.toggle('hidden', provider !== 'minimax');
    elements.doubaoTtsFields?.classList.toggle('hidden', provider !== 'doubao');
    elements.dashscopeTtsFields?.classList.toggle('hidden', provider !== 'dashscope');
}

// 只负责"刷新提示文案 + 占位符"，不再改写 Base URL 的值。
// 以前这里会因为「请求模式 = 直接连接」把输入框锁成只读并强行覆盖成预设地址，
// 用户想用自建中转时根本没地方改 —— 那个下拉已删除。
function updateChatFormatUI() {
    const apiFormat = elements.settingApiFormat.value || 'openai-compatible';
    const preset = CHAT_API_FORMATS[apiFormat] || CHAT_API_FORMATS['openai-compatible'];
    elements.settingBaseUrl.readOnly = false;
    elements.settingChatModel.placeholder = preset.defaultModel;
    const currentBase = String(elements.settingBaseUrl.value || '').trim();
    const looksLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(currentBase);
    elements.settingApiKey.placeholder = looksLocal
        ? '本地服务可留空；远程服务按需填写'
        : (/dashscope\.aliyuncs\.com/i.test(currentBase)
            ? 'sk-...（留空则复用语音里已填的 DashScope Key）'
            : 'sk-...（只保存在本机）');
    // 每个格式"什么时候该选它"直接写在旁边。
    // 选错格式报的错完全看不出是格式选错，这句话放在这里比放在文档里有用的多。
    const hintEl = document.getElementById('apiFormatHint');
    if (hintEl) hintEl.textContent = preset.hint || '';
    if (elements.chatFormatHint) {
        elements.chatFormatHint.textContent = `请求从当前设备直接发给 ${preset.label}，不经过作者服务器。Android Key 使用系统 Keystore 加密；Web Key 仅保存在当前标签页会话。`;
    }
}

function readProviderSettingsForm() {
    const apiFormat = elements.settingApiFormat.value || 'openai-compatible';
    const preset = CHAT_API_FORMATS[apiFormat] || CHAT_API_FORMATS['openai-compatible'];
    return {
        ...state.settings,
        apiProvider: DEFAULT_SETTINGS.apiProvider,
        apiFormat,
        baseUrl: elements.settingBaseUrl.value.trim() || preset.defaultBaseUrl,
        // 回落必须用"当前格式"的默认模型，不能用 DEFAULT_SETTINGS.model ——
        // 后者硬编码 deepseek-chat，选 Anthropic 时清空模型框就会把 deepseek-chat 发过去，
        // 而 placeholder 显示的却是 Claude 的模型名，界面上完全看不出来。
        model: elements.settingChatModel.value.trim() || preset.defaultModel,
        apiKey: elements.settingApiKey.value.trim(),
        minimaxApiKey: document.getElementById('settingMinimaxApiKey')?.value.trim() || '',
        minimaxVoice: document.getElementById('settingMinimaxVoice')?.value.trim() || '',
        minimaxModel: document.getElementById('settingMinimaxModel')?.value || 'speech-2.8-hd',
        ttsProvider: elements.settingTtsProvider?.value || 'minimax',
        doubaoApiKey: document.getElementById('settingDoubaoApiKey')?.value.trim() || '',
        doubaoAppId: document.getElementById('settingDoubaoAppId')?.value.trim() || '',
        doubaoToken: document.getElementById('settingDoubaoToken')?.value.trim() || '',
        doubaoCluster: document.getElementById('settingDoubaoCluster')?.value.trim() || 'volcano_tts',
        doubaoVoice: document.getElementById('settingDoubaoVoice')?.value.trim() || 'zh_female_shuangkuaisisi_uranus_bigtts',
        doubaoResourceId: document.getElementById('settingDoubaoResourceId')?.value || 'seed-tts-2.0',
        dashscopeTtsModel: document.getElementById('settingDashscopeTtsModel')?.value.trim() || 'qwen3-tts-flash',
        dashscopeTtsVoice: document.getElementById('settingDashscopeTtsVoice')?.value.trim() || 'Cherry',
        dashscopeApiKey: document.getElementById('settingDashscopeApiKey')?.value.trim() || '',
        dashscopeAsrBaseUrl: document.getElementById('settingDashscopeAsrBaseUrl')?.value.trim() || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        dashscopeAsrModel: document.getElementById('settingDashscopeAsrModel')?.value.trim() || 'qwen3-asr-flash',
        mimoApiKey: document.getElementById('settingMimoApiKey')?.value.trim() || '',
        mimoBaseUrl: document.getElementById('settingMimoBaseUrl')?.value.trim() || 'https://api.xiaomimimo.com',
        mimoAsrModel: document.getElementById('settingMimoAsrModel')?.value.trim() || 'mimo-v2.5-asr',
        visionBaseUrl: document.getElementById('settingVisionBaseUrl')?.value.trim() || '',
        visionApiKey: document.getElementById('settingVisionApiKey')?.value.trim() || '',
        visionModel: document.getElementById('settingVisionModel')?.value.trim() || ''
    };
}

async function withSettingsTestButton(button, runningText, callback) {
    if (!button || button.disabled) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = runningText;
    try { await callback(); }
    catch (error) { showClientApiError(error); }
    finally { button.disabled = false; button.textContent = originalText; }
}

async function testChatConnection() {
    await withSettingsTestButton(elements.testChatConnectionBtn, '测试中…', async () => {
        const draft = readProviderSettingsForm();
        const reply = await callChatAPI([
            { role: 'system', content: '这是连接测试。' },
            { role: 'user', content: '只回复 OK' }
        ], { maxTokens: 8, temperature: 0 }, draft);
        if (!reply.trim()) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '对话接口返回了空内容');
        showCustomAlert(`连接成功，模型返回：${reply.trim()}`, '对话连接正常');
    });
}

async function testTtsConnection() {
    await withSettingsTestButton(elements.testTtsConnectionBtn, '测试中…', async () => {
        const draft = readProviderSettingsForm();
        const provider = String(draft.ttsProvider || 'edge');
        if (provider === 'doubao') {
            const audio = await generateDoubaoTtsAudio('你好，这是豆包语音连接测试。', draft);
            if (!audio?.bytes?.byteLength) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '豆包返回了空音频');
            showCustomAlert('豆包已成功返回测试音频，凭据与音色可以使用。', '语音连接正常');
            return;
        }
        if (provider === 'dashscope') {
            const audio = await generateDashscopeTtsAudio('你好，这是阿里千问语音连接测试。', draft);
            if (!audio?.bytes?.byteLength) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '阿里千问音频文件为空');
            showCustomAlert('阿里千问已成功返回测试音频，Key、模型与音色可以使用。', '语音连接正常');
            return;
        }
        if (!draft.minimaxApiKey) throw new ClientApiError('APP_KEY_MISSING', '请先填写 MiniMax API Key');
        if (!draft.minimaxVoice) throw new ClientApiError('BAD_REQUEST', '请先填写自己的 MiniMax 音色 ID');
        const result = await postJsonFromDevice(MINIMAX_TTS_HTTP, {
            model: draft.minimaxModel,
            text: 'こんにちは、接続テストです。',
            stream: false,
            language_boost: 'Japanese',
            voice_setting: { voice_id: draft.minimaxVoice, speed: 1, vol: 1, pitch: 0 },
            audio_setting: { sample_rate: 24000, bitrate: 128000, format: 'mp3', channel: 1 }
        }, { Authorization: `Bearer ${draft.minimaxApiKey}` });
        if (!result.ok || Number(result.payload?.base_resp?.status_code || 0) !== 0) {
            await throwProviderResponseError(result, 'MiniMax 语音连接测试失败');
        }
        if (!String(result.payload?.data?.audio || '')) throw new ClientApiError('UPSTREAM_UNAVAILABLE', 'MiniMax 返回了空音频');
        showCustomAlert('MiniMax 已成功返回测试音频，Key、模型与音色 ID 可以使用。', '语音连接正常');
    });
}

async function clearApiKeys() {
    const confirmed = await showCustomConfirm('确认清除这台设备上保存的 DeepSeek、MiniMax、豆包、DashScope 与 MiMo API Key？');
    if (!confirmed) return;
    await clearStoredApiSecrets();
    elements.settingApiKey.value = '';
    document.getElementById('settingMinimaxApiKey').value = '';
    document.getElementById('settingDoubaoApiKey').value = '';
    document.getElementById('settingDoubaoToken').value = '';
    document.getElementById('settingDashscopeApiKey').value = '';
    document.getElementById('settingMimoApiKey').value = '';
    showCustomAlert('API Key 已从当前设备清除。', '已清除');
}

function updateSliderFill(slider) {
    if (!slider) return;
    const min = Number(slider.min || 0);
    const max = Number(slider.max || 100);
    const value = Number(slider.value || min);
    const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
    slider.style.setProperty('--slider-progress', `${Math.max(0, Math.min(100, percent))}%`);
}

async function saveSettings() {
    const asrProvider = document.querySelector('input[name="asrProvider"]:checked')?.value || 'browser';
    const ttsLang = document.querySelector('input[name="ttsLang"]:checked')?.value || 'chinese';
    const replyDisplayMode = document.querySelector('input[name="replyDisplayMode"]:checked')?.value || DEFAULT_SETTINGS.replyDisplayMode;
    const providerSettings = readProviderSettingsForm();
    if (!providerSettings.baseUrl) {
        showCustomAlert('自定义模式下必须填写 API Base URL。', '设置未保存');
        return;
    }
    state.settings = {
        ...providerSettings,
        ttsSpeed: parseFloat(elements.settingTtsSpeed.value) || 1.0,
        ttsVolume: Math.max(0, Math.min(2, parseFloat(elements.settingTtsVolume.value) || 0)),
        ttsLang,
        replyDisplayMode,
        asrProvider,
        autoMemory: elements.settingAutoMemory.checked,
        memoryEvery: Math.max(3, Math.min(50, parseInt(elements.settingMemoryEvery.value, 10) || 6)),
        agentPermission: document.querySelector('input[name="agentPermission"]:checked')?.value || 'app',
        agentApproval: document.querySelector('input[name="agentApproval"]:checked')?.value || 'once',
        agentPhoneEnabled: document.getElementById('settingAgentPhoneEnabled')?.checked !== false
    };
    try {
        await saveApiSecrets(state.settings);
    } catch (error) {
        // 密钥存储失败不阻断设置保存（其他设置仍生效；密钥兜底存 localStorage）
        console.warn('[BYOK] 密钥存储失败（设置仍已保存，密钥可能下次失效）', error);
    }
    persistSettings();

    // 存回「当前这套人设」，并落盘整个列表 —— 多套之间互不覆盖
    syncFormToCurrentCard();
    state.characterCard = cardContent(currentCard());
    persistCharacterCards();
    saveCharacterCard();
    renderCardSelect();

    closeSettingsPanel();
    showCustomAlert('设置已保存！', '保存成功');
}

// 恢复默认设置：对话/语音/视觉等回到默认值；API Key 保留（敏感信息，避免误操作丢失）；角色卡不变
async function restoreDefaultSettings() {
    const confirmed = await showCustomConfirm('确定恢复默认设置？\n\n对话 / 语音 / 视觉等配置将恢复为默认值。\n已保存的 API Key 会保留，角色卡不变。');
    if (!confirmed) return;
    const secrets = {};
    for (const k of API_SECRET_NAMES) {
        if (state.settings[k] !== undefined) secrets[k] = state.settings[k];
    }
    state.settings = Object.assign({}, DEFAULT_SETTINGS, secrets);
    try {
        await saveApiSecrets(state.settings);
    } catch (e) {
        console.warn('[Settings] 恢复默认时密钥存储写入失败（Android Keystore）', e);
    }
    persistSettings();
    fillSettingsForm();
    showCustomAlert('已恢复默认设置（API Key 已保留，角色卡不变）。', '已恢复默认');
}

function previewPrompt() {
    const card = {
        name: document.getElementById('ccName').value.trim() || '伊蕾娜',
        title: document.getElementById('ccTitle').value.trim() || '灰之魔女',
        worldSetting: document.getElementById('ccWorldSetting').value.trim(),
        characterPrompt: document.getElementById('ccCharacterPrompt').value.trim(),
        greeting: document.getElementById('ccGreeting').value.trim()
    };
    // 只展示用户可编辑的部分（核心协议 + 世界观 + 角色卡），
    // 系统注入的 Live2D 表现标签、Agent 操作指令等内部提示不在此展示，避免用户误改。
    const name = card.name;
    const title = card.title;
    const prompt = `${ROLEPLAY_CORE_PROTOCOL}

# 世界观设定
${card.worldSetting}

# 角色卡
角色名：${name}
称号：${title}
${card.characterPrompt}

（说明：系统还会附加 Live2D 表现与 AI 操作等内部指令，不在此展示。）`;
    showCustomAlert(prompt, '角色卡生成的 System Prompt');
}

function resetCharacterCard() {
    document.getElementById('ccName').value = DEFAULT_CHARACTER_CARD.name;
    document.getElementById('ccTitle').value = DEFAULT_CHARACTER_CARD.title;
    document.getElementById('ccWorldSetting').value = DEFAULT_CHARACTER_CARD.worldSetting;
    document.getElementById('ccCharacterPrompt').value = DEFAULT_CHARACTER_CARD.characterPrompt;
    document.getElementById('ccGreeting').value = DEFAULT_CHARACTER_CARD.greeting;
}


// ==================== 问候打字机 ====================

let greetingTyping = false;
function startGreetingTyping() {
    if (greetingTyping) return;
    greetingTyping = true;
    const el = document.getElementById('greetingText');
    const text = state.characterCard.greeting || DEFAULT_CHARACTER_CARD.greeting;
    el.classList.add('typing-cursor');
    let i = 0;
    const timer = setInterval(() => {
        i++;
        el.textContent = text.substring(0, i);
        if (i >= text.length) {
            clearInterval(timer);
            el.classList.remove('typing-cursor');
            greetingTyping = false;
        }
    }, 45);
}

