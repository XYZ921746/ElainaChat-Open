/* ========================================================================
 * 初始化与绑定：启动流程 / 分栏 / Live2D 设置
 *
 * 本文件由 web/index.html 的主脚本按分区拆分而来（保持原始加载顺序）。
 * 拆分前提：主脚本是全局作用域，拆分后各文件共享同一全局词法环境，
 * 因此顶层 function / const / let 互相可见，调用点无需修改。
 *
 * 包含分区：
 *   · 初始化
 *   · 设置分栏 Tab 切换
 *   · Live2D 设置：模型列表 / 上传 / 测试
 *   · Live2D 背景设置（通话界面，带操作反馈）
 *   · 鼠标跟随幅度
 * ======================================================================== */

// ==================== 初始化====================

async function init() {
    syncViewportHeight();
    loadSettings();
    await loadApiSecrets();
    loadCharacterCard();
    loadConversations();
    loadFavorites();
    loadLikedQuotes();
    loadMemoryCore();
    elements.textInput.value = '';
    document.getElementById('initialTextInput').value = '';
    elements.sidebarSearchInput.value = '';
    elements.notesSearch.value = '';
    syncComposerThinkingToggles(Boolean(state.settings.thinkingMode));
    updateComposerSendVisibility();

    initSpeechRecognition();

    loadDailyQuote();

    startGreetingTyping();

    elements.micBtn.addEventListener('click', handleMicClick);
    elements.floatingMicBtn.addEventListener('click', handleMicClick);
    elements.floatingEndBtn.addEventListener('click', endListening);
    elements.floatingCancelBtn.addEventListener('click', cancelListening);

    elements.railSettingsBtn.addEventListener('click', openSettings);
    elements.closeSettings.addEventListener('click', closeSettingsPanel);
    elements.cancelSettings.addEventListener('click', closeSettingsPanel);
    elements.settingsOverlay.addEventListener('click', (e) => {
        if (e.target === elements.settingsOverlay) closeSettingsPanel();
    });
    elements.saveSettings.addEventListener('click', saveSettings);
    document.getElementById('resetSettingsBtn')?.addEventListener('click', restoreDefaultSettings);
    // 插件：重新扫描（把刚丢进 web/mods/ 的 zip 装上）+ 全局开关
    document.getElementById('modsRefreshBtn')?.addEventListener('click', () => {
        const hint = document.getElementById('modsHint');
        if (hint) { hint.textContent = '扫描中…'; hint.className = 'text-[11px] text-indigo-400'; }
        void refreshModsList();
    });
    // 外观主题：深色开关（模板卡片的事件由 theme.js 自己绑）
    document.getElementById('themeDarkToggle')?.addEventListener('change', (e) => {
        if (window.ElainaTheme) window.ElainaTheme.setDark(e.target.checked);
    });
    // 设置面板打开时同步一次状态（用户可能在别处改过主题）
    if (window.ElainaTheme) {
        const darkToggle = document.getElementById('themeDarkToggle');
        if (darkToggle) darkToggle.checked = window.ElainaTheme.isDark();
    }
    document.getElementById('authChangeBtn')?.addEventListener('click', changeAccessPassword);
    document.getElementById('authLogoutBtn')?.addEventListener('click', logoutAccess);
    // 日志设置：改完立即生效（服务端运行时热更新），不需要点「保存设置」
    elements.settingLogLevel?.addEventListener('change', () => { renderLogLevelHint(); void applyLogSettings(); });
    elements.settingLogTrace?.addEventListener('change', () => { void applyLogSettings(); });
    // 我的数据：导出直接下载备份，导入选文件后合并进 data/
    document.getElementById('dataExportBtn')?.addEventListener('click', exportDataBackup);
    // 操作悬浮窗：跳系统设置授权 / 重新检测
    document.getElementById('overlayEnableBtn')?.addEventListener('click', enableOverlay);
    document.getElementById('overlayCheckBtn')?.addEventListener('click', () => { void refreshOverlayStatus(); });
    // 副屏监视窗：入口在**运行状态条**上（AI 跑任务时才出现），
    // 不放在设置里 —— 那是"用的时候才需要"的东西，放设置里得先翻两层。
    document.getElementById('agentWatchBtn')?.addEventListener('click', () => { openScreenWatch(); });
    // 副屏监视窗
    document.getElementById('closeScreenWatch')?.addEventListener('click', closeScreenWatch);
    document.getElementById('screenWatchPanel')?.addEventListener('click', (e) => {
        // 点遮罩关闭（点面板内部不关）
        if (e.target && e.target.id === 'screenWatchPanel') closeScreenWatch();
    });
    document.getElementById('screenWatchRefreshBtn')?.addEventListener('click', () => { void screenWatchRefresh(); });
    document.getElementById('screenWatchAutoBtn')?.addEventListener('click', (e) => {
        screenWatchAuto = !screenWatchAuto;
        e.currentTarget.textContent = '自动刷新：' + (screenWatchAuto ? '开' : '关');
        if (screenWatchAuto) screenWatchStartAuto(); else screenWatchStopAuto();
    });
    document.getElementById('screenWatchPowerBtn')?.addEventListener('click', async (e) => {
        const plugin = deviceBridge();
        if (!plugin || typeof plugin.moduleDisplay !== 'function') return;
        const btn = e.currentTarget;
        const wasRunning = /关闭/.test(btn.textContent || '');
        btn.disabled = true;
        try {
            const res = await plugin.moduleDisplay({ op: wasRunning ? 'stop' : 'start' });
            screenWatchNote(wasRunning ? '已请求关闭副屏' : '已请求启动副屏');
            if (res && res.text) console.log('[ScreenWatch] ' + res.text);
        } catch (err) {
            screenWatchNote('副屏开关失败：' + (err.message || err));
        } finally {
            btn.disabled = false;
            // 副屏启停需要几秒，稍等再刷新
            setTimeout(() => { void screenWatchRefresh(); }, 2500);
        }
    });
    document.getElementById('dataImportBtn')?.addEventListener('click', () => {
        // APK 优先让用户从**已经导出到文档目录的备份**里挑（纯 Filesystem，不依赖 WebView 的文件选择器）；
        // 挑不到（没有备份 / 插件不可用）再退回系统文件选择器。
        if (IS_NATIVE_APP && nativeFs()) { void importFromDocumentsOrPicker(); return; }
        document.getElementById('dataImportFile')?.click();
    });
    document.getElementById('dataImportFile')?.addEventListener('change', (ev) => {
        const input = ev.target;
        const file = input.files && input.files[0];
        // 先清空 value：同一个文件连选两次也要能触发 change
        input.value = '';
        void importDataBackup(file);
    });
    // 获取模型列表。**三种格式都支持** —— Anthropic 也有 Models API（`GET /v1/models`），
    // 返回 `{ data: [{ id, display_name, … }] }`，和 OpenAI 的 `{ data: [{ id }] }` 同构，
    // 所以解析逻辑可以共用，差别只在**地址**和**认证头**。
    // 以前这里写着"Anthropic 不可用"，其实不是它没这个接口，是地址拼错了（见 modelsEndpointFor）。

    /**
     * 模型列表接口的地址。
     *
     * 版本段是唯一的坑：OpenAI 系的 Base URL 惯例上**就带** `/v1`
     * （默认值就是 `https://api.openai.com/v1`），所以和发对话一样直接拼 `/models`；
     * Anthropic 的惯例是**不带**（默认 `https://api.anthropic.com`），而它的 Models API 在
     * `/v1/models` —— 直接拼 `/models` 会 404。
     *
     * 这条规则必须和 `web/js/chat-providers.js` 里 `callAnthropicChat` 拼 `/messages` 的规则保持一致，
     * 否则会出现"对话能通、获取模型 404"这种最费解的现象。
     */
    function modelsEndpointFor(baseUrl, apiFormat) {
        let base = String(baseUrl || '').trim().replace(/\/+$/, '');
        if (!base) throw new Error('请先填写 API Base URL');
        // 用户可能把完整的功能地址整条粘进来（chat/completions、responses、messages），先剥掉再拼
        base = base.replace(/\/(?:chat\/completions|responses|messages)$/i, '');
        if (/\/models$/i.test(base)) return base;
        if (apiFormat === 'anthropic' && !/\/v\d+$/i.test(base)) return base + '/v1/models';
        return base + '/models';
    }

    /** 从模型列表响应里取模型名（OpenAI 与 Anthropic 的 `data[].id` 同构） */
    function parseModelList(payload) {
        const raw = Array.isArray(payload?.data) ? payload.data : [];
        return raw
            .map(item => (typeof item === 'string' ? item : item?.id))
            .filter(Boolean)
            .map(String)
            .sort((a, b) => a.localeCompare(b));
    }

    async function fetchModelList(baseUrl, apiKey, apiFormat) {
        const endpoint = modelsEndpointFor(baseUrl, apiFormat);
        const key = String(apiKey || '').trim();
        // Anthropic 的认证头是 x-api-key，不是 Authorization: Bearer —— 用错了会 401，
        // 而它只回 authentication_error，看不出是头用错了。
        // 但第三方中转（new-api 系）的 /v1/models 常常只认 Bearer，所以失败后**退一步再试**。
        // `limit=1000` 是 Anthropic 的上限（默认只回 20 条，不指定会静默截断）。
        const attempts = apiFormat === 'anthropic'
            ? [
                { url: endpoint + '?limit=1000', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
                { url: endpoint, headers: { Authorization: 'Bearer ' + key } }
            ]
            : [{ url: endpoint, headers: { Authorization: 'Bearer ' + key } }];
        let failure = null;
        for (const attempt of attempts) {
            let result;
            try {
                // 关键：走设备层，不要裸 fetch。
                // APK 的 WebView 里裸 fetch 会撞 CORS，而服务商并不都发 CORS 头 ——
                // 这正是「获取模型」在手机上一直失败的原因。
                result = await getJsonFromDevice(attempt.url, attempt.headers, 20000);
            } catch (error) {
                // 连不上 / 被中断：换一条路也一样，别白打第二次
                if (!failure) failure = error;
                break;
            }
            const models = result.ok ? parseModelList(result.payload) : [];
            if (models.length) return models;
            if (!failure) {
                const fromPayload = result.payload?.error?.message || result.payload?.message || '';
                // 200 却拿回 HTML —— 这是"地址少了版本段"最典型的症状：请求打到了
                // 站点首页/网关页，而不是 API。原来的文案说"可能该服务不支持 /models"，
                // 会把人引到完全错误的方向。
                // 实测：`https://newapi.gay/models` → text/html 首页；
                //       `https://newapi.gay/v1/models` 才是真接口。
                const looksHtml = /^\s*<(!doctype|html|head|body)/i.test(String(result.rawText || ''));
                const baseNoModels = endpoint.replace(/\/models$/, '');
                if (!result.ok) {
                    failure = new Error(fromPayload || ('HTTP ' + result.status));
                } else if (looksHtml) {
                    failure = new Error('接口返回的是网页（HTML），不是 API 响应'
                        + '\n· 实际请求：' + attempt.url
                        + '\n· 多半是 Base URL 少了版本段，试试：' + baseNoModels + '/v1'
                        + '\n  （OpenAI 兼容的 Base URL 惯例上就带 /v1，例如 https://api.deepseek.com/v1）');
                } else if (result.payload === null) {
                    failure = new Error('接口返回的不是有效 JSON'
                        + '\n· 实际请求：' + attempt.url
                        + '\n· 原文开头：' + String(result.rawText || '(空)').slice(0, 120));
                } else {
                    failure = new Error('接口返回的 JSON 里没有模型列表（data 为空）'
                        + '\n· 实际请求：' + attempt.url
                        + '\n· 如果这个服务确实有模型，可能是它的 /models 路径不同，或该账号下没有可用模型。');
                }
            }
            // 只有"这条路明显走不通"才换下一条。5xx / 超时换一条也一样失败。
            if (![401, 403, 404].includes(Number(result.status))) break;
        }
        throw failure || new Error('获取模型列表失败');
    }
    async function populateModelSelect({ btn, input, select, baseUrl, apiKey, apiFormat, defaultModels }) {
        const old = btn.textContent;
        btn.textContent = '⏳ 获取中…';
        try {
            const models = await fetchModelList(baseUrl, apiKey, apiFormat);
            if (!models.length) throw new Error('接口未返回模型列表（data 为空），可能该服务不支持 /models');
            select.innerHTML = '';
            for (const m of models) {
                const o = document.createElement('option');
                o.value = m; o.textContent = m;
                select.appendChild(o);
            }
            select.classList.remove('hidden');
            select.onchange = () => { input.value = select.value; };
            // 必须把模型名**填进输入框** —— 真正发给服务商的是 input 的值
            // （见 readProviderSettingsForm），只填下拉框等于这个功能没生效。
            //
            // 真实故障：Anthropic 下切格式时会自动填预设名 `claude-sonnet-4-20250514`，
            // 而它通常不在服务端真实返回的列表里。原来的代码只在"输入框的值恰好
            // 在列表里"时才回写下拉框选中项，从不写 input —— 于是列表拉出来了，
            // 发出去的还是那个不存在的预设名，一对话就 404。
            //
            // 四种情况分开处理（**顺序很重要**）：
            //   ① 输入框的值在列表里          → 原样保留。这一条必须放最前：
            //      预设名恰好有效时也该保留，否则会把用户当前用的模型
            //      悄悄换成列表里字母序第一个（如 claude-haiku），属于越权改动。
            //   ② 输入框为空                  → 填列表第一项（否则"拉到了但没选"，等于没用）
            //   ③ 输入框里是**预设默认值**     → 覆盖成列表第一项。那是切格式时应用自动填的，
            //                                   已证明不在真实列表里，留着必然 404。
            //   ④ 其它手填的值不在列表里       → **不覆盖**（可能是中转站的私有别名，
            //                                   用户是故意填的），但下拉框选中第一项，
            //                                   用户点一下即可换过去。
            const current = String(input.value || '').trim();
            const isStalePreset = Array.isArray(defaultModels) && defaultModels.includes(current);
            if (current && models.includes(current)) {
                select.value = current;
            } else if (!current || isStalePreset) {
                input.value = models[0];
                select.value = models[0];
            } else {
                select.value = models[0];
            }
        } catch (err) {
            // 上面各分支已经给出**具体**原因（HTML 首页 / 非 JSON / data 为空 / HTTP 码）。
            // 这里只兜底浏览器层失败 —— 那种情况错误信息里只有一句 "Failed to fetch"，
            // 不说清的话用户会以为是地址或 Key 写错了。
            const detail = String(err?.message || err);
            const isNetwork = /Failed to fetch|NetworkError|Load failed/i.test(detail);
            showCustomAlert(
                '获取模型列表失败：' + detail
                + (isNetwork
                    ? '\n\n这是**浏览器层面**的失败，不是地址或 Key 错。最常见的原因是服务商没发 CORS 响应头；'
                      + '\n用 启动.bat 打开页面会自动走本机中转绕开它，直接双击 index.html 则不走中转。'
                    : '')
                + '\n\n拉不到列表不影响使用 —— 把模型名直接手填进上面的输入框即可。',
                '获取模型'
            );
        } finally {
            btn.textContent = old;
        }
    }
    document.getElementById('fetchChatModelsBtn')?.addEventListener('click', () => {
        void populateModelSelect({
            btn: document.getElementById('fetchChatModelsBtn'),
            input: document.getElementById('settingChatModel'),
            select: document.getElementById('chatModelsSelect'),
            baseUrl: elements.settingBaseUrl.value,
            apiKey: elements.settingApiKey.value,
            apiFormat: elements.settingApiFormat.value,
            // 各格式的预设模型名：用来识别"输入框里是切格式时自动填的、并非用户手填"
            defaultModels: Object.values(CHAT_API_FORMATS).map(f => f.defaultModel)
        });
    });
    document.getElementById('fetchVisionModelsBtn')?.addEventListener('click', () => {
        void populateModelSelect({
            btn: document.getElementById('fetchVisionModelsBtn'),
            input: document.getElementById('settingVisionModel'),
            select: document.getElementById('visionModelsSelect'),
            baseUrl: document.getElementById('settingVisionBaseUrl')?.value,
            apiKey: document.getElementById('settingVisionApiKey')?.value
        });
    });
    elements.settingApiFormat.addEventListener('change', () => {
        const apiFormat = elements.settingApiFormat.value || 'openai-compatible';
        const preset = CHAT_API_FORMATS[apiFormat] || CHAT_API_FORMATS['openai-compatible'];
        const currentBaseUrl = elements.settingBaseUrl.value.trim();
        const usesDefault = !currentBaseUrl || Object.values(CHAT_API_FORMATS).some(format => format.defaultBaseUrl === currentBaseUrl);
        if (usesDefault) {
            elements.settingBaseUrl.value = preset.defaultBaseUrl;
        }
        // 切换格式时必须同步换掉模型名。
        // 否则切到 Anthropic 后框里还留着 deepseek-chat，会被原样发过去 → 404，
        // 而界面上完全看不出是这个原因（用户以为改格式就够了）—— 这就是"换了格式就连不上"。
        // 只替换"空"或"恰好等于某个预设默认值"的情况；用户自己填过的名字不动。
        const currentModel = String(elements.settingChatModel.value || '').trim();
        const isPresetDefault = Object.values(CHAT_API_FORMATS).some(format => format.defaultModel === currentModel);
        if (!currentModel || isPresetDefault) elements.settingChatModel.value = preset.defaultModel;
        updateChatFormatUI();
    });
    elements.settingTtsProvider.addEventListener('change', updateTtsProviderUI);
    elements.testChatConnectionBtn.addEventListener('click', testChatConnection);
    elements.testTtsConnectionBtn.addEventListener('click', testTtsConnection);
    elements.clearApiKeysBtn.addEventListener('click', clearApiKeys);
    elements.announcementConfirmBtn.addEventListener('click', closeAnnouncement);
    elements.announcementOverlay.addEventListener('click', (event) => {
        if (event.target === elements.announcementOverlay) closeAnnouncement();
    });

    document.querySelectorAll('input[name="asrProvider"]').forEach(r => {
        r.addEventListener('change', updateAsrProviderUI);
    });
    // 阿里云 ASR 连接测试：发 0.5s 静音验证 Key 与模型开通状态（Key 复用 TTS 的 DashScope Key）
    document.getElementById('settingAsrTest')?.addEventListener('click', async () => {
        const key = document.getElementById('settingDashscopeApiKey')?.value.trim();
        const asrUrl = document.getElementById('settingDashscopeAsrBaseUrl')?.value.trim() || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
        const asrModel = document.getElementById('settingDashscopeAsrModel')?.value.trim() || 'qwen3-asr-flash';
        const statusEl = document.getElementById('settingAsrTestStatus');
        if (!statusEl) return;
        if (!key) {
            statusEl.textContent = '请先填写 API Key（语音输出 → 阿里千问）';
            statusEl.className = 'text-[11px] text-red-400';
            return;
        }
        statusEl.textContent = '测试中…';
        statusEl.className = 'text-[11px] text-indigo-300';
        try {
            const samples = new Float32Array(ASR_TARGET_SAMPLE_RATE * 0.5); // 0.5s 静音
            const result = await postJsonFromDevice(asrUrl, {
                model: asrModel,
                input: { messages: [{ role: 'user', content: [{ audio: `data:audio/wav;base64,${float32ToWavBase64(samples, ASR_TARGET_SAMPLE_RATE)}` }] }] },
                parameters: { asr_options: { language: 'zh', enable_itn: true } }
            }, { Authorization: `Bearer ${key}`, 'X-DashScope-DataInspection': 'enable' }, 20000);
            if (result.ok) {
                statusEl.textContent = '✅ 连接成功（HTTP ' + (result.status || 200) + '）：Key 有效、' + asrModel + ' 已开通';
                statusEl.className = 'text-[11px] text-green-500';
            } else {
                const msg = String(
                    result.payload?.base_resp?.status_msg ||
                    result.payload?.message ||
                    result.payload?.error?.message ||
                    result.payload?.error ||
                    ('HTTP ' + result.status)
                );
                statusEl.textContent = '❌ ' + msg + '（HTTP ' + (result.status || '?') + '）';
                statusEl.className = 'text-[11px] text-red-400';
            }
        } catch (err) {
            statusEl.textContent = '❌ ' + (err.message || err);
            statusEl.className = 'text-[11px] text-red-400';
        }
    });
    // 小米 MiMo ASR 连接测试（OpenAI 兼容 /v1/chat/completions + input_audio）
    document.getElementById('settingMimoAsrTest')?.addEventListener('click', async () => {
        const key = document.getElementById('settingMimoApiKey')?.value.trim();
        const baseUrl = (document.getElementById('settingMimoBaseUrl')?.value.trim() || 'https://api.xiaomimimo.com').replace(/\/+$/, '');
        const model = document.getElementById('settingMimoAsrModel')?.value.trim() || 'mimo-v2.5-asr';
        const statusEl = document.getElementById('settingMimoAsrTestStatus');
        if (!statusEl) return;
        if (!key) {
            statusEl.textContent = '请先填写 MiMo API Key';
            statusEl.className = 'text-[11px] text-red-400';
            return;
        }
        statusEl.textContent = '测试中…';
        statusEl.className = 'text-[11px] text-indigo-300';
        try {
            const samples = new Float32Array(ASR_TARGET_SAMPLE_RATE * 0.5); // 0.5s 静音
            const result = await postJsonFromDevice(baseUrl + '/v1/chat/completions', {
                model,
                messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${float32ToWavBase64(samples, ASR_TARGET_SAMPLE_RATE)}`, format: 'wav' } }] }],
                asr_options: { language: 'zh' },
                stream: false
            }, { 'api-key': key, 'Content-Type': 'application/json' }, 20000);
            if (result.ok) {
                statusEl.textContent = '✅ 连接成功（HTTP ' + (result.status || 200) + '）：MiMo ASR 可用';
                statusEl.className = 'text-[11px] text-green-500';
            } else {
                const msg = String(
                    result.payload?.message ||
                    result.payload?.error?.message ||
                    result.payload?.error ||
                    ('HTTP ' + result.status)
                );
                statusEl.textContent = '❌ ' + msg + '（HTTP ' + (result.status || '?') + '）';
                statusEl.className = 'text-[11px] text-red-400';
            }
        } catch (err) {
            statusEl.textContent = '❌ ' + (err.message || err);
            statusEl.className = 'text-[11px] text-red-400';
        }
    });
    elements.settingTtsSpeed.addEventListener('input', () => {
        elements.ttsSpeedLabel.textContent = parseFloat(elements.settingTtsSpeed.value).toFixed(1) + 'x';
        updateSliderFill(elements.settingTtsSpeed);
    });
    elements.settingTtsVolume.addEventListener('input', () => {
        elements.ttsVolumeLabel.textContent = Math.round(parseFloat(elements.settingTtsVolume.value) * 100) + '%';
        updateSliderFill(elements.settingTtsVolume);
    });
    document.getElementById('previewPromptBtn').addEventListener('click', previewPrompt);
    document.getElementById('resetCharacterBtn').addEventListener('click', resetCharacterCard);
// 多人设：切换 / 新建 / 复制 / 改名 / 删除
document.getElementById('ccPresetSelect')?.addEventListener('change', (e) => switchCard(e.target.value));
document.getElementById('ccPresetNew')?.addEventListener('click', () => { void addCard(false); });
document.getElementById('ccPresetDup')?.addEventListener('click', () => { void addCard(true); });
document.getElementById('ccPresetRename')?.addEventListener('click', () => { void renameCard(); });
document.getElementById('ccPresetDelete')?.addEventListener('click', () => { void deleteCard(); });

    elements.newConversationBtn.addEventListener('click', () => {
        createConversation(state.activeCategoryId);
        closeSidebarDrawer();
    });
    elements.newCategoryBtn.addEventListener('click', () => {
        promptCreateCategory();
    });

    elements.initialTextInput.addEventListener('input', updateComposerSendVisibility);
    elements.textInput.addEventListener('input', updateComposerSendVisibility);
    [elements.initialTextInput, elements.textInput].forEach(input => {
        input.addEventListener('focus', () => keepFocusedComposerVisible(input));
    });
    elements.initialComposerMoreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleComposerToolsMenu(elements.initialComposerMoreBtn, elements.initialComposerMoreMenu, elements.initialComposerThinkingToggle);
    });
    elements.composerMoreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleComposerToolsMenu(elements.composerMoreBtn, elements.composerMoreMenu, elements.composerThinkingToggle);
    });
    elements.initialComposerImageBtn.addEventListener('click', openComposerImagePicker);
    elements.composerImageBtn.addEventListener('click', openComposerImagePicker);
    elements.composerImageInput.addEventListener('change', async () => {
        const file = elements.composerImageInput.files?.[0];
        if (!file) return;
        composerImageProcessing = true;
        elements.initialComposerImageBtn.disabled = true;
        elements.composerImageBtn.disabled = true;
        updateComposerSendVisibility();
        try {
            pendingComposerImage = await compressComposerImage(file);
            renderPendingComposerImage();
        } catch (error) {
            removePendingComposerImage();
            showCustomAlert(error?.message || '图片处理失败，请更换一张图片。', '无法添加图片');
        } finally {
            composerImageProcessing = false;
            elements.initialComposerImageBtn.disabled = false;
            elements.composerImageBtn.disabled = false;
            updateComposerSendVisibility();
        }
    });
    const updateThinkingMode = (checked) => {
        state.settings.thinkingMode = checked;
        syncComposerThinkingToggles(checked);
        persistSettings();
    };
    elements.initialComposerThinkingToggle.addEventListener('change', () => updateThinkingMode(elements.initialComposerThinkingToggle.checked));
    elements.composerThinkingToggle.addEventListener('change', () => updateThinkingMode(elements.composerThinkingToggle.checked));
    elements.initialComposerMemoryBtn.addEventListener('click', runManualMemorySummary);
    elements.composerMemoryBtn.addEventListener('click', runManualMemorySummary);
    elements.composerPromptBtn.addEventListener('click', openConversationPromptEditor);
    elements.initialComposerPromptBtn.addEventListener('click', openConversationPromptEditor);
    elements.conversationPromptCancelBtn.addEventListener('click', closeConversationPromptEditor);
    elements.conversationPromptSaveBtn.addEventListener('click', saveConversationPrompt);
    elements.conversationWorldInput.addEventListener('input', updateConversationPromptCount);
    elements.conversationCharacterInput.addEventListener('input', updateConversationPromptCount);
    elements.conversationPromptOverlay.addEventListener('click', (event) => {
        if (event.target === elements.conversationPromptOverlay) closeConversationPromptEditor();
    });
    document.addEventListener('click', (event) => {
        const anyMenuOpen = !elements.initialComposerMoreMenu.classList.contains('hidden') || !elements.composerMoreMenu.classList.contains('hidden');
        if (anyMenuOpen && !event.target.closest('.composer-tools')) {
            closeComposerToolsMenu();
        }
    });

    elements.sidebarSearchInput.addEventListener('input', renderFolderList);
    elements.sidebarSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && elements.sidebarSearchInput.value) {
            elements.sidebarSearchInput.value = '';
            renderFolderList();
        }
    });
    elements.sidebarSearchClear.addEventListener('click', () => {
        elements.sidebarSearchInput.value = '';
        elements.sidebarSearchClear.classList.add('hidden');
        renderFolderList();
        elements.sidebarSearchInput.focus();
    });
    elements.sidebarSearchInput.addEventListener('input', () => {
        elements.sidebarSearchClear.classList.toggle('hidden', !elements.sidebarSearchInput.value);
    });

    elements.railChatBtn.addEventListener('click', () => {
        if (state.notesMode) exitNotesMode();
        else if (state.diaryMode) exitDiaryMode();
        else syncRailActive();
    });
    elements.notesBtn.addEventListener('click', () => {
        if (state.notesMode) {
            exitNotesMode();
        } else {
            enterNotesMode();
        }
    });
    elements.railDiaryBtn.addEventListener('click', () => {
        if (state.diaryMode) exitDiaryMode();
        else enterDiaryMode();
    });
    elements.exitDiaryBtn.addEventListener('click', exitDiaryMode);
    elements.exitNotesBtn.addEventListener('click', () => {
        if (state.notesMode) exitNotesMode();
    });
    elements.notesSearch.addEventListener('input', (e) => renderNotesPage(e.target.value));

    document.querySelectorAll('.notes-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            state.notesTab = btn.dataset.tab;
            document.querySelectorAll('.notes-tab').forEach(b => {
                const active = b === btn;
                b.classList.toggle('tab-active', active);
                b.classList.toggle('text-indigo-500', !active);
                b.classList.toggle('bg-white/40', !active);
                b.classList.toggle('border', !active);
                b.classList.toggle('border-white/55', !active);
            });
            renderNotesPage(elements.notesSearch.value);
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeComposerToolsMenu();
        if (e.key === 'Escape' && state.selectedFavoriteId) {
            collapseFavorite();
        }
    });

    elements.detailClose.addEventListener('click', collapseFavorite);
    elements.notesOverlay.addEventListener('click', (e) => {
        if (e.target === elements.notesOverlay) collapseFavorite();
    });
    elements.detailRemoveBtn.addEventListener('click', () => {
        if (state.selectedFavoriteId) {
            removeFavoriteWithConfirm(state.selectedFavoriteId);
        }
    });
    elements.detailJumpBtn.addEventListener('click', () => {
        const fav = state.favorites.find(f => f.id === state.selectedFavoriteId);
        if (fav) jumpToOriginal(fav);
    });

    elements.manageCategoriesBtn.addEventListener('click', () => {
        openCategoriesModal();
    });
    elements.memoryBtn.addEventListener('click', runManualMemorySummary);
    elements.categoriesModalClose.addEventListener('click', closeCategoriesModal);
    elements.categoriesModalOverlay.addEventListener('click', (e) => {
        if (e.target === elements.categoriesModalOverlay) closeCategoriesModal();
    });
    elements.categoriesModalNew.addEventListener('click', async () => {
        await promptCreateCategory();
        renderCategoriesModalList();
    });
    elements.catSelectAllBtn.addEventListener('click', () => {
        const visible = [...elements.categoriesModalList.querySelectorAll('.cat-checkbox')];
        const allChecked = visible.every(cb => cb.checked);
        visible.forEach(cb => cb.checked = !allChecked);
        if (allChecked) {
            visible.forEach(cb => catSelected.delete(cb.dataset.convId));
        } else {
            visible.forEach(cb => catSelected.add(cb.dataset.convId));
        }
        renderCategoriesModalList();
        renderCatBatchBar();
    });
    elements.catInvertBtn.addEventListener('click', () => {
        const visible = [...elements.categoriesModalList.querySelectorAll('.cat-checkbox')];
        visible.forEach(cb => {
            if (cb.checked) catSelected.delete(cb.dataset.convId);
            else catSelected.add(cb.dataset.convId);
        });
        renderCategoriesModalList();
        renderCatBatchBar();
    });
    elements.catMoveSelect.addEventListener('change', catMoveSelected);
    elements.catDeleteSelectedBtn.addEventListener('click', catDeleteSelected);
    elements.conversationMoveClose.addEventListener('click', closeConversationMoveDialog);
    elements.conversationMoveCancel.addEventListener('click', closeConversationMoveDialog);
    elements.conversationMoveOverlay.addEventListener('click', (e) => {
        if (e.target === elements.conversationMoveOverlay) closeConversationMoveDialog();
    });

    document.getElementById('quoteLikeBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleQuoteLike();
    });
    document.getElementById('quoteFavBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleQuoteFavorite();
    });

    elements.showSidebar.addEventListener('click', showSidebarFunc);
    elements.mobileSidebarClose.addEventListener('click', closeSidebarDrawer);
    elements.sidebarOverlay.addEventListener('click', closeSidebarDrawer);
    elements.folderList.addEventListener('scroll', closeConversationContextMenu, { passive: true });
    window.addEventListener('resize', () => {
        syncViewportHeight();
        closeConversationContextMenu();
        requestAnimationFrame(alignFloatingMicToComposer);
    });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', syncViewportHeight);
        window.visualViewport.addEventListener('scroll', syncViewportHeight);
    }
    document.addEventListener('pointerdown', (e) => {
        if (!conversationContextMenu || conversationContextMenu.contains(e.target)) return;
        closeConversationContextMenu();
    });
    document.addEventListener('click', (e) => {
        if (window.innerWidth > 860 || !document.body.classList.contains('sidebar-open')) return;
        if (elements.sidebar.contains(e.target) || elements.showSidebar.contains(e.target)) return;
        closeSidebarDrawer();
    });
    elements.sidebar.addEventListener('click', (e) => {
        if (window.innerWidth > 860) return;
        if (e.target.closest('[data-conv-id], [data-rail-action]')) {
            closeSidebarDrawer();
        }
    });

    updateNotesBadge();
    const mobileFirstScreen = window.matchMedia('(max-width: 860px)').matches;
    if (mobileFirstScreen) {
        // 移动端每次进入先落在新对话欢迎页，不直接恢复上次聊天内容。
        state.currentConversationId = null;
    }
    renderFolderList();

    if (mobileFirstScreen) {
        showInitialState();
        loadAnnouncement().then(openAnnouncement);
        return;
    }
    const hasConversation = Boolean(state.currentConversationId);
    if (hasConversation) {
        const conv = state.conversations.find(c => c.id === state.currentConversationId);
        if (conv && conv.messages.length > 0) {
            loadConversation(conv.id);
        }
    }
    loadAnnouncement().then(openAnnouncement);
    // 启动 AI 定时任务调度（每 30s 检查到期任务）
    setInterval(checkScheduledTasks, 30000);
}

function showSidebarFunc() {
    if (window.innerWidth <= 860) {
        elements.initialState.classList.add('sidebar-underlay-hidden');
        elements.floatingMic.classList.add('sidebar-underlay-hidden');
    }
    document.body.classList.add('sidebar-open');
    elements.sidebarOverlay.classList.remove('hidden');
}

function syncViewportHeight() {
    const viewport = window.visualViewport;
    const viewportHeight = viewport?.height || window.innerHeight;
    const viewportTop = window.innerWidth <= 860 ? Math.max(0, viewport?.offsetTop || 0) : 0;
    if (viewportHeight) document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
    document.documentElement.style.setProperty('--viewport-offset-top', `${Math.round(viewportTop)}px`);
}

function keepFocusedComposerVisible(input) {
    if (!input || window.innerWidth > 860) return;
    const align = () => {
        if (document.activeElement !== input) return;
        syncViewportHeight();
        input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (input === elements.textInput && elements.conversationHistory) {
            elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
        }
    };
    requestAnimationFrame(align);
    setTimeout(align, 180);
    setTimeout(align, 360);
}

function closeSidebarDrawer() {
    if (window.innerWidth > 860) return;
    closeConversationContextMenu();
    document.body.classList.remove('sidebar-open');
    elements.sidebarOverlay.classList.add('hidden');
    elements.initialState.classList.remove('sidebar-underlay-hidden');
    elements.floatingMic.classList.remove('sidebar-underlay-hidden');
}



// ===== 设置分栏 Tab 切换 =====
function switchSettingsTab(name) {
    document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.settingsTab === name));
    document.querySelectorAll('.settings-tab-panel').forEach(p => p.classList.toggle('active-panel', p.id === name));
}
document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchSettingsTab(btn.dataset.settingsTab));
});


// ===== Live2D 设置：模型列表 / 上传 / 测试 =====
let live2dModelList = [];   // 最近一次拉到的模型列表，重命名时要用
// 服务端返回的可能不是 JSON（例如服务还是旧版本时，/api/live2d/rename 落到静态处理器返回纯文本 "Not found"）。
// 直接 res.json() 会抛 "Unexpected token 'N'..."，用户完全看不懂，所以这里统一兜一层。
async function readJsonSafe(res) {
    const text = await res.text();
    try { return JSON.parse(text); } catch { /* 非 JSON */ }
    return {
        ok: false,
        message: res.status === 404
            ? '服务端没有这个接口（HTTP 404）。多半是 serve.mjs 改了但服务没重启 —— 到 cmd 窗口按 Ctrl+C，再重新双击「启动.bat」。'
            : '服务端返回了非预期的内容（HTTP ' + res.status + '）：' + text.slice(0, 80),
    };
}
async function refreshLive2DSettingList() {
    const sel = document.getElementById('settingLive2DModel');
    if (!sel) return;
    try {
        const res = await fetch('/api/live2d/models');
        const json = await readJsonSafe(res);
        live2dModelList = json.models || [];
        const prev = sel.value;
        sel.innerHTML = '';
        if (!live2dModelList.length) sel.innerHTML = '<option value="">（未上传模型）</option>';
        live2dModelList.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.name;       // 目录名即显示名
            opt.textContent = m.name;
            sel.appendChild(opt);
        });
        if (prev && live2dModelList.some(m => m.name === prev)) sel.value = prev;
    } catch (e) { console.warn('[Live2D] 列表失败', e); }
}

// 重命名模型：真改文件夹（目录名即显示名）。改完要把客户端按模型名存的东西一起迁走。
document.getElementById('settingLive2DRename')?.addEventListener('click', async () => {
    const sel = document.getElementById('settingLive2DModel');
    const oldName = sel?.value;
    if (!oldName) { showCustomAlert('请先在上面的下拉里选一个模型。', '重命名模型'); return; }
    const next = await showCustomModal({
        title: '重命名模型',
        message: '会把这个模型的文件夹一起改名。视频通话里的模型下拉、以及它的缩放/水印设置都会跟着迁移。',
        input: true,
        defaultValue: oldName,
        placeholder: '例如：伊蕾娜 · 默认装',
        confirmText: '保存',
    });
    if (next === null) return;   // 取消
    const desired = String(next).trim();
    if (!desired || desired === oldName) return;
    try {
        const res = await fetch('/api/live2d/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: oldName, displayName: desired }),
        });
        const json = await readJsonSafe(res);
        if (!json.ok) { showCustomAlert(json.message || '重命名失败', '重命名失败'); return; }
        const newName = json.newName || desired;
        if (newName !== desired) showCustomAlert('「' + desired + '」已被占用，已改为「' + newName + '」。', '重命名完成');
        // 迁移每模型设置 + 刷新通话界面下拉，并把选中项指到新名字
        if (window.Live2DCall?.applyRenamedModel) await window.Live2DCall.applyRenamedModel(oldName, newName);
        await refreshLive2DSettingList();
        if (sel) sel.value = newName;
    } catch (e) {
        showCustomAlert('重命名失败：' + (e.message || e), '重命名失败');
    }
});
document.getElementById('settingLive2DUpload')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    const status = document.getElementById('settingLive2DUploadStatus');
    if (!file || !status) return;
    status.textContent = '上传中…';
    try {
        const res = await fetch('/api/live2d/upload', { method: 'POST', body: file });
        const json = await readJsonSafe(res);
        if (json.ok) {
            // 服务端会跳过 .html/.js/.svg 等可执行类型（防止上传后被同源执行），
            // 这里必须告诉用户跳过了什么，否则模型"上传成功"却少了文件会很难排查
            const skipped = Array.isArray(json.blocked) ? json.blocked : [];
            status.textContent = '✅ 已上传: ' + json.modelName +
                (skipped.length ? `　已跳过 ${skipped.length} 个不允许的文件：${skipped.join('、')}` : '');
        } else {
            status.textContent = '❌ ' + (json.message || '失败');
        }
        if (json.ok) await refreshLive2DSettingList();
    } catch (err) { status.textContent = '❌ ' + (err.message || err); }
    e.target.value = '';
});

// ===== Live2D 背景设置（通话界面，带操作反馈） =====
let bgToastTimer = null;
function bgToast(msg) {
    let el = document.getElementById('live2d-bg-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'live2d-bg-toast';
        el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:100001;background:rgba(15,23,42,.92);color:#fff;padding:8px 16px;border-radius:999px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.35);transition:opacity .25s;pointer-events:none;white-space:nowrap';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(bgToastTimer);
    bgToastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
}
function syncBgSelected() {
    const cur = window.Live2DCall?.getBackground ? window.Live2DCall.getBackground() : '';
    document.querySelectorAll('.l2d-bg-opt').forEach(b => b.classList.toggle('selected', b.dataset.bg === cur));
}
document.querySelectorAll('.l2d-bg-opt').forEach(btn => {
    btn.addEventListener('click', () => {
        const v = btn.dataset.bg;
        if (window.Live2DCall?.setBackground) window.Live2DCall.setBackground(v);
        syncBgSelected();
        bgToast('✅ 背景已应用');
    });
});
document.getElementById('settingLive2DBgColor')?.addEventListener('input', (e) => {
    if (window.Live2DCall?.setBackground) window.Live2DCall.setBackground(e.target.value);
    syncBgSelected();
});
document.getElementById('settingLive2DBgColor')?.addEventListener('change', (e) => {
    bgToast('✅ 已应用自定义颜色');
});
document.getElementById('settingLive2DBgImage')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        if (window.Live2DCall?.setBackground) window.Live2DCall.setBackground('url(' + reader.result + ')');
        syncBgSelected();
        bgToast('✅ 背景图片已应用');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
});
document.getElementById('settingLive2DBgClear')?.addEventListener('click', () => {
    if (window.Live2DCall?.setBackground) window.Live2DCall.setBackground('');
    syncBgSelected();
    bgToast('已恢复默认背景');
});
        document.getElementById('settingLive2DTest')?.addEventListener('click', () => {
    if (window.Live2DCall) window.Live2DCall.open();
});
// 打开设置时刷新模型列表 + 同步背景选中状态
const origOpenSettingsForLive2D = window.openSettings;
window.openSettings = function (...args) {
    if (origOpenSettingsForLive2D) origOpenSettingsForLive2D.apply(this, args);
    setTimeout(refreshLive2DSettingList, 100);
    setTimeout(syncBgSelected, 100);
    setTimeout(syncMouseFollowControls, 100);
};
document.getElementById('settingLive2DDelete')?.addEventListener('click', async () => {
    const sel = document.getElementById('settingLive2DModel');
    const name = sel?.value;
    if (!name) return;
    if (!window.confirm('确定删除模型「' + name + '」？')) return;
    if (window.Live2DCall?.deleteModel) {
        const ok = await window.Live2DCall.deleteModel(name);
        if (ok) await refreshLive2DSettingList();
    } else {
        const res = await fetch('/api/live2d/models/' + encodeURIComponent(name), { method: 'DELETE' });
        const json = await readJsonSafe(res);
        if (json.ok) await refreshLive2DSettingList();
        else showCustomAlert('删除失败：' + (json.message || ''), '删除失败');
    }
});
// 鼠标跟随开关：状态由 live2d 模块存在 localStorage，勾选即时生效
function syncMouseFollowBox() {
    const box = document.getElementById('settingMouseFollow');
    if (box) box.checked = window.Live2DCall?.isMouseFollow ? window.Live2DCall.isMouseFollow() : true;
}


// ===== 鼠标跟随幅度 =====
// 滑块 0-10 是标准范围，10 = 原始幅度（×1.0）；右侧数字框可以填更大的数字解锁更高倍率。
// 需要它的原因：同一个 ParamAngleX=20，不同模型的实际视觉幅度能差约 7 倍，
// 敏感度低的模型要调高、敏感度高的要调低，否则"同样的设置"在不同模型上完全不是一个效果。
const MOUSE_SCALE_FALLBACK_MAX = 100;
const MOUSE_SCALE_BASE = 10;   // 滑块满格 / 数字框里的 10 = ×1.0
function mouseScaleMax() {
    const m = Number(window.Live2DCall?.getMouseFollowScaleMax?.());
    return Number.isFinite(m) && m > 0 ? m : MOUSE_SCALE_FALLBACK_MAX;
}
function mouseScaleCurrent() {
    const v = Number(window.Live2DCall?.getMouseFollowScale?.());
    return Number.isFinite(v) && v >= 0 ? v : MOUSE_SCALE_BASE;
}
// keepNumValue：用户在数字框里打字时不要把正在输入的内容覆盖掉（否则「1」还没打完就被改成别的）
function renderMouseFollowScale(keepNumValue) {
    const level = mouseScaleCurrent();
    const slider = document.getElementById('settingMouseFollowScale');
    const num = document.getElementById('settingMouseFollowScaleNum');
    const label = document.getElementById('mouseFollowScaleLabel');
    const hint = document.getElementById('mouseFollowScaleHint');
    const wrap = document.getElementById('settingMouseFollowScaleWrap');
    const on = document.getElementById('settingMouseFollow')?.checked !== false;
    if (slider) {
        const max = Number(slider.max) || MOUSE_SCALE_BASE;
        slider.value = String(Math.min(level, max));
        updateSliderFill(slider);
        slider.disabled = !on;
    }
    if (num) {
        if (!keepNumValue) num.value = String(level);
        num.max = String(mouseScaleMax());
        num.disabled = !on;
    }
    if (label) label.textContent = '×' + (level / MOUSE_SCALE_BASE).toFixed(1);
    if (hint) {
        if (level === 0) hint.textContent = '已归零，模型不跟随';
        else if (level > MOUSE_SCALE_BASE) {
            // 头部幅度被模型自身参数量程锁死，超过上限后只有身体跟随还会继续变大。
            // 这里把上限直接告诉用户，免得他以为"数字填了没用"是 bug。
            const info = window.Live2DCall?.getFollowAmpInfo?.();
            if (info && info.loaded && info.headSaturateAt) {
                hint.textContent = `头部上限 ×${info.headSaturateAt}，更高倍率由身体跟随补足`;
            } else if (info && info.loaded) {
                hint.textContent = '已解锁更高幅度';
            } else {
                hint.textContent = '已解锁更高幅度（开始通话后生效）';
            }
        } else hint.textContent = '标准范围';
    }
    if (wrap) wrap.style.opacity = on ? '1' : '0.45';
}
function syncMouseFollowControls() {
    syncMouseFollowBox();
    renderMouseFollowScale();
}
document.getElementById('settingMouseFollow')?.addEventListener('change', (e) => {
    if (window.Live2DCall?.setMouseFollow) window.Live2DCall.setMouseFollow(e.target.checked);
    renderMouseFollowScale();
});
// 滑块：拖完立刻生效，数字框跟着同步
document.getElementById('settingMouseFollowScale')?.addEventListener('input', (e) => {
    if (window.Live2DCall?.setMouseFollowScale) window.Live2DCall.setMouseFollowScale(e.target.value);
    renderMouseFollowScale();
});
// 数字框：可以填超出滑块范围的值（解锁更高倍率），超出上限时按上限处理
const mouseScaleNum = document.getElementById('settingMouseFollowScaleNum');
mouseScaleNum?.addEventListener('input', (e) => {
    if (e.target.value === '') return;   // 清空时先不动，等用户输完
    if (window.Live2DCall?.setMouseFollowScale) window.Live2DCall.setMouseFollowScale(e.target.value);
    renderMouseFollowScale(true);
});
// 失焦 / 回车：把实际生效的值（已按上限截断）写回输入框
mouseScaleNum?.addEventListener('blur', () => renderMouseFollowScale());
mouseScaleNum?.addEventListener('keydown', (e) => { if (e.key === 'Enter') renderMouseFollowScale(); });
syncMouseFollowControls();

refreshLive2DSettingList();
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
