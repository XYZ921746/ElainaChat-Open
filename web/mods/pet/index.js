/* ============================================================================
 * 桌宠（mod）
 *
 * 悬浮桌宠：立绘 + 聊天气泡 + 输入条，回复情绪自动切换表情。
 * 与 Galgame **共用立绘与情绪识别**（window.ElainaAvatar）—— 这是本次合并
 * 的重点：上游把这两个界面做成了两套独立实现（galgame.js 与 pet.js 各自
 * 写一份 avatarSrc/setEmotion/emotionFrom），资源上还打了三套立绘共 30.8MB，
 * 而逐字节校验显示其中两套是重复/死资源。
 *
 * ── 相对上游 v1.3.1 的改动 ──────────────────────────────────────────────
 *
 * ① **不再依赖独立页面**：上游 pet.js 靠 pet.html 里预置的 #bubbleScroller /
 *    #petInput / #petAvatar 等元素工作，是一个**独立窗口**（安卓悬浮窗 / PC
 *    WebView 各开一个页面）。这里改成与 Galgame 一致的**应用内浮层**，
 *    自己建 DOM —— 这样它才是一个真正的"可插拔 mod"：
 *    丢进 mods/ 就能用，删掉就干净，不需要宿主页面配合。
 *
 * ② **立绘与情绪走公共依赖**：与 Galgame 同源，词表只有一份。
 *
 * ③ **开关交给 mod 系统**：不再自己轮询 localStorage。
 *
 * ④ 发送走 host.sendUserMessage，与主界面完全同一条链路。
 *
 * ⑤ 上游还有"主动回复"（定时读前台界面内容然后搭话）。那依赖
 *    ElainaAccessibilityService 读屏 + ElainaPetService 前台服务，
 *    属于**安卓原生能力**，不在这个 Web 层 mod 的范围内 —— 见文件末尾说明。
 * ========================================================================== */
(function () {
    'use strict';

    const MOD_ID = 'pet';

    window.ElainaMods.register(MOD_ID, function (host) {
        const BASE = '/mods/' + MOD_ID + '/';
        const PREFIX = 'elaina_pet_';
        function get(k, d) {
            try { const v = localStorage.getItem(PREFIX + k); return v === null ? d : v; } catch (e) { return d; }
        }
        function set(k, v) {
            try { localStorage.setItem(PREFIX + k, v); } catch (e) { /* 忽略 */ }
        }

        let root = null, avatarEl = null, bubbleEl = null, inputEl = null;
        let typeTimer = null, emoTimer = null, dragState = null;
        let enabled = false;

        // ==================== 立绘与情绪（公共依赖） ====================

        function avatarApi() {
            return (window.ElainaAvatar && typeof window.ElainaAvatar.src === 'function')
                ? window.ElainaAvatar : null;
        }
        function avatarSrc(key) {
            const api = avatarApi();
            return api ? api.src(key) : '';
        }
        function emotionFrom(text) {
            const api = avatarApi();
            if (api && typeof api.fromText === 'function') {
                try { return api.fromText(text); } catch (e) { /* 回落 */ }
            }
            return null;
        }
        /**
         * 切换表情。
         *
         * 与 Galgame 的区别：桌宠是"短暂反应"—— 显示几秒后自动回到 calm
         * （上游行为，保留）。Galgame 则保持当前表情直到剧情变化。
         */
        function setEmotion(key, holdMs) {
            if (!avatarEl) return;
            const api = avatarApi();
            const list = api ? api.EMOTIONS : ['calm'];
            const k = list.indexOf(key) >= 0 ? key : 'calm';
            const src = avatarSrc(k);
            if (src && avatarEl.getAttribute('src') !== src) {
                avatarEl.setAttribute('src', src);
                avatarEl.classList.remove('emo-swap');
                void avatarEl.offsetWidth;
                avatarEl.classList.add('emo-swap');
            }
            if (emoTimer) clearTimeout(emoTimer);
            if (k !== 'calm') {
                emoTimer = setTimeout(() => setEmotion('calm'), holdMs || 4200);
            }
        }

        // ==================== DOM ====================

        function build() {
            if (root) return;
            root = document.createElement('div');
            root.id = 'petLayer';
            // 位置：右下角悬浮。用户拖动后位置会被记住。
            const pos = get('pos', '');
            root.style.cssText = 'position:fixed;z-index:44;display:none;'
                + 'right:18px;bottom:18px;width:min(360px,88vw);'
                + 'filter:drop-shadow(0 18px 40px rgba(0,0,0,.35))';
            root.innerHTML =
                '<div id="petDrag" style="height:26px;cursor:move;display:flex;align-items:center;justify-content:center;'
                  + 'position:relative;'
                  + 'border-radius:14px 14px 0 0;background:rgba(255,255,255,.55);backdrop-filter:blur(10px);'
                  + 'font-size:11px;color:#6366f1;user-select:none">⠿ 按住拖动'
                  // 主动搭话开关：放在拖动条右侧。
                  //
                  // 为什么放这儿：这是桌宠自己的行为（定时读电脑状态 → 主动说话），
                  // 属于"宠物在做什么"，和桌宠放一起最自然。
                  // **默认关闭** —— 会主动发消息、还会读电脑状态的功能，
                  // 必须用户明确开启，不能默认打开。
                  + '<button id="petProactive" type="button" title="主动搭话：定时看看你在忙什么，主动说句话" '
                    + 'style="position:absolute;right:6px;top:3px;height:20px;padding:0 7px;border-radius:10px;'
                    + 'border:1px solid rgba(99,102,241,.35);background:rgba(255,255,255,.6);cursor:pointer;'
                    + 'font-size:10px;color:#6366f1;line-height:18px">主动搭话</button>'
                + '</div>'
                + '<div id="petCard" style="border-radius:0 0 18px 18px;overflow:hidden;'
                  + 'background:linear-gradient(180deg,rgba(255,255,255,.72),rgba(255,255,255,.55));'
                  + 'backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.7);border-top:0">'
                  + '<div id="petBubbles" style="max-height:190px;overflow-y:auto;padding:10px 12px 4px;display:flex;flex-direction:column;gap:8px"></div>'
                  + '<div style="position:relative;height:190px;display:flex;align-items:flex-end;justify-content:center;pointer-events:none">'
                    + '<img id="petAvatar" src="' + avatarSrc('calm') + '" alt="伊蕾娜" '
                    + 'style="max-height:100%;max-width:82%;object-fit:contain;object-position:bottom center;'
                    + 'animation:pet-breathe 6.5s ease-in-out infinite">'
                  + '</div>'
                  + '<div style="display:flex;gap:6px;padding:8px 10px 12px;align-items:center">'
                    + '<button id="petMic" type="button" title="语音输入" '
                      + 'style="flex:none;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.8);'
                      + 'background:rgba(255,255,255,.7);cursor:pointer;font-size:15px">🎤</button>'
                    + '<input id="petInput" type="text" placeholder="和伊蕾娜说点什么…" autocomplete="off" '
                      + 'style="flex:1;min-width:0;padding:8px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.9);'
                      + 'background:rgba(255,255,255,.8);font-size:13px;color:#1e1b4b;outline:none">'
                    + '<button id="petSend" type="button" '
                      + 'style="flex:none;width:34px;height:34px;border-radius:50%;border:0;cursor:pointer;'
                      + 'background:linear-gradient(135deg,#f472b6,#a78bfa);color:#fff;font-size:15px">➤</button>'
                    + '<button id="petClose" type="button" title="收起桌宠" '
                      + 'style="flex:none;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.8);'
                      + 'background:rgba(255,255,255,.7);cursor:pointer;font-size:14px">✕</button>'
                  + '</div>'
                + '</div>';

            document.body.appendChild(root);
            avatarEl = root.querySelector('#petAvatar');
            bubbleEl = root.querySelector('#petBubbles');
            inputEl = root.querySelector('#petInput');

            // 拖动（记住位置）
            const dragBar = root.querySelector('#petDrag');
            dragBar.addEventListener('pointerdown', (ev) => {
                const r = root.getBoundingClientRect();
                dragState = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
                dragBar.setPointerCapture(ev.pointerId);
            });
            dragBar.addEventListener('pointermove', (ev) => {
                if (!dragState) return;
                // 用 left/top 定位，并把 right/bottom 清掉（否则两者同时生效会互相拉扯）
                const x = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dragState.dx));
                const y = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - dragState.dy));
                root.style.left = x + 'px';
                root.style.top = y + 'px';
                root.style.right = 'auto';
                root.style.bottom = 'auto';
            });
            dragBar.addEventListener('pointerup', () => {
                if (!dragState) return;
                dragState = null;
                set('pos', root.style.left + ',' + root.style.top);
            });

            root.querySelector('#petClose').addEventListener('click', () => {
                setEnabled(false);
                // 同步关掉 mod 系统的开关（理由同 galgame：两个状态不一致会让
                // 设置里显示"已启用"、界面却不在，下次刷新又冒出来）
                try {
                    if (window.ElainaMods && typeof window.ElainaMods.setEnabled === 'function') {
                        window.ElainaMods.setEnabled(MOD_ID, false);
                    }
                } catch (e) { /* 忽略 */ }
                host.log('桌宠已收起');
            });
            root.querySelector('#petMic').addEventListener('click', startVoice);
            root.querySelector('#petSend').addEventListener('click', send);
            inputEl.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.stopPropagation(); send(); }
            });
            inputEl.addEventListener('click', (ev) => ev.stopPropagation());

            // 主动搭话开关（默认关闭）
            const proBtn = root.querySelector('#petProactive');
            const paintProactive = () => {
                if (!proBtn) return;
                const on = isProactive();
                proBtn.textContent = on ? '主动搭话 · 开' : '主动搭话';
                proBtn.style.background = on ? 'rgba(99,102,241,.9)' : 'rgba(255,255,255,.6)';
                proBtn.style.color = on ? '#fff' : '#6366f1';
            };
            proBtn.addEventListener('click', async (ev) => {
                // 阻止冒泡：它在拖动条里，不拦的话点按钮会触发拖拽
                ev.stopPropagation();
                const next = !isProactive();
                if (!next) {
                    setProactive(false);
                    paintProactive();
                    addBubble('那我就不打扰你了', 'ai');
                    return;
                }
                paintProactive();
                // ⚠️ 顺序很重要：先 setProactive（它写 localStorage），再 paint。
                //   反过来画的是**旧状态** —— 按钮显示"关"、存储却是"1"，
                //   状态不一致（实测踩过）。
                // setProactive 开启时会**立即执行一次**并把 Promise 返回回来，
                // 我们只等这一个结果来决定说什么 —— 不要自己再探一次，
                // 那会重复读活动（白花 4 秒）并弹重复气泡（实测踩过）。
                const r = await setProactive(true);
                paintProactive();
                if (!r || r.skipped === 'no-activity') {
                    // 读不到就如实说明，并且**关回去** —— 开着开关却什么都不发生
                    // 比明说"这里没有这个能力"更糟
                    addBubble('读不到电脑状态（需要电脑版 + 服务端运行；手机端没有这个能力）', 'ai');
                    setProactive(false);
                    paintProactive();
                    return;
                }
                if (r.skipped === 'no-conversation') {
                    addBubble('还没有对话呢，先开一个对话我才能跟你说话～', 'ai');
                    return;
                }
                if (r.sent) addBubble('好呀，我会偶尔看看你在忙什么～', 'ai');
                else addBubble('发送失败了，可能对话已经不在了', 'ai');
            });
            paintProactive();

            // 恢复上次位置
            const p = String(pos).split(',');
            if (p.length === 2 && p[0].endsWith('px') && p[1].endsWith('px')) {
                root.style.left = p[0];
                root.style.top = p[1];
                root.style.right = 'auto';
                root.style.bottom = 'auto';
            }
        }

        // ==================== 气泡 ====================

        function addBubble(text, who) {
            const div = document.createElement('div');
            const mine = who === 'me';
            div.style.cssText = 'max-width:88%;padding:7px 11px;border-radius:14px;font-size:13px;line-height:1.6;'
                + (mine
                    ? 'align-self:flex-end;background:linear-gradient(135deg,rgba(244,114,182,.9),rgba(167,139,250,.9));color:#fff'
                    : 'align-self:flex-start;background:rgba(255,255,255,.92);color:#1e1b4b;border:1px solid rgba(255,255,255,.9)');
            const speak = document.createElement('div');
            speak.style.cssText = 'font-size:10px;font-weight:700;opacity:.75;margin-bottom:2px';
            speak.textContent = mine ? '你' : '伊蕾娜';
            const msg = document.createElement('div');
            msg.style.cssText = 'white-space:pre-wrap;word-break:break-word';
            msg.textContent = text;
            div.appendChild(speak);
            div.appendChild(msg);
            bubbleEl.appendChild(div);
            bubbleEl.scrollTop = bubbleEl.scrollHeight;
            // 只留最近 12 条，避免长对话把气泡区撑爆
            while (bubbleEl.children.length > 12) bubbleEl.removeChild(bubbleEl.firstChild);
            return msg;
        }

        /** 打字机效果（桌宠气泡用纯文本 —— 气泡很小，Markdown 反而挤） */
        function typewrite(el, text) {
            if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
            let i = 0;
            el.textContent = '';
            const full = String(text || '');
            typeTimer = setInterval(() => {
                i += 2;
                el.textContent = full.slice(0, i);
                bubbleEl.scrollTop = bubbleEl.scrollHeight;
                if (i >= full.length) { clearInterval(typeTimer); typeTimer = null; }
            }, 26);
        }

        // ==================== 与主对话同步 ====================

        let lastMsgKey = '';

        function msgKey(m) { return m ? (m.id + ':' + (m.text || '').length) : ''; }

        /**
         * 把主对话的最新一条 AI 回复显示到桌宠气泡。
         *
         * 桌宠**不自己维护对话**：它读 host.getMessages()，与主界面共用同一份数据。
         * 这样"从桌宠发的话"和"从主界面发的话"在两边都看得到。
         */
        function syncFromState() {
            const msgs = host.getMessages().filter((m) => m && m.text && m.role !== 'system');
            if (!msgs.length) return;
            const last = msgs[msgs.length - 1];
            const key = msgKey(last);
            if (key === lastMsgKey) return;
            lastMsgKey = key;
            addBubble(last.text, last.role === 'user' ? 'me' : 'ai');
            if (last.role !== 'user') setEmotion(emotionFrom(last.text));
            else setEmotion('calm');
        }

        // ==================== 看电脑在干什么（主动搭话的基础） ====================
        //
        // 上游桌宠（C# / WPF）有 `UiTextReader.cs`：用 UIAutomation 读前台窗口
        // 的标题与控件文本，然后定期"主动搭话"（PetBrain 的定时器）。
        //
        // 我们是 Web，浏览器里拿不到 UIAutomation —— 但**服务端可以**
        // （它就跑在这台电脑上），所以走 `GET /api/agent/activity`。
        // 服务端那边用 PowerShell 调同一套 UIAutomation API，能力等价。
        //
        // 该接口**仅本机可访问**（服务端已限制）：这是"用户在看什么"的隐私数据。
        //
        // 桌宠在**浏览器里**，所以 APK 端没有这个能力（那边没有服务端）——
        // 拿不到就安静降级，不报错。

        /** 读一次"当前在干什么"。失败返回 null（静默降级） */
        async function fetchActivity(force) {
            try {
                const r = await fetch('/api/agent/activity' + (force ? '?force=1' : ''), { cache: 'no-store' });
                if (!r.ok) return null;
                const j = await r.json();
                return j && j.ok ? j : null;
            } catch (e) {
                // 网络失败 / APK 端没有这个接口 / 非 Windows —— 都属于"没有这个能力"，
                // 不该打扰用户（他可能只是没开服务端）
                return null;
            }
        }

        /** 主动搭话的冷却与去重状态 */
        let lastProactiveAt = 0;
        let lastActivityKey = '';

        /**
         * 主动搭话：读当前在干什么 → 拼一句提示交给主对话。
         *
         * 为什么要**去重 + 冷却**：
         *   · 去重：同一个窗口反复触发会让 AI 一直说"你还在看那个啊"，很烦
         *   · 冷却：用户可能刚说过话，不该马上又被搭话
         * 所以只有当"活动指纹"变了、且距上次超过冷却时间，才会真的发。
         *
         * ★ 本函数**不弹气泡**，只返回结果（{sent} / {skipped}）——
         *   由调用方决定要不要说话。理由：定时器触发时不该打扰用户
         *   （那是后台行为），而用户**手动开启**时该给反馈。若在这里弹，
         *   两条路径的文案会打架、甚至重复弹（实测踩过重复气泡）。
         */
        async function proactiveOnce(opts) {
            const o = opts || {};
            const now = Date.now();
            const cooldown = Number(get('proactiveCooldown', 5 * 60 * 1000)) || 5 * 60 * 1000;
            if (!o.force && now - lastProactiveAt < cooldown) return { skipped: 'cooldown' };

            const act = await fetchActivity(o.force);
            if (!act) return { skipped: 'no-activity' };

            // 活动指纹：只看前台窗口标题 + 进程名，不含窗口正文（那会频繁变化，
            // 导致每次都算"变了"而疯狂搭话）
            const fgTitle = (act.foreground && act.foreground.title) || '';
            const procNames = (act.processes || []).slice(0, 8).map((p) => p.name).join(',');
            const key = fgTitle + '|' + procNames;
            if (!o.force && key === lastActivityKey) return { skipped: 'same-activity' };

            // ⚠️ 必须先确认"有当前对话"：没有对话时 sendUserMessage 会返回 false
            //    （它要求 conv 存在）。用户开着桌宠但还没建对话是常见状态，
            //    调用方会据此给出明确提示。
            const conv = host.getConversation();
            if (!conv) {
                lastActivityKey = key;
                lastProactiveAt = now;
                return { skipped: 'no-conversation' };
            }

            lastActivityKey = key;
            lastProactiveAt = now;

            // 交给主对话：让 AI 以角色身份自然地评论/关心一句。
            // 走 sendUserMessage 而不是自己拼回复 —— 复用宿主整条链路
            // （记忆、停止、语音都自动生效），这也是 host API 的设计意图。
            const prompt = [
                '（系统提示：以下是这台电脑当前的状态，请以伊蕾娜的身份**自然地**对用户说一句话，',
                '就像她看到你在忙什么随口搭话。不要提及"系统提示""检测到"这类字眼，',
                '也不要逐条复述这些信息。一句话，口语化，20 字以内。）',
                '',
                act.summary,
            ].join('\n');
            const sent = host.sendUserMessage(prompt);
            if (sent) setEmotion(emotionFrom(fgTitle || 'calm'));
            return { sent, key };
        }

        let proactiveTimer = null;

        /**
         * 开关主动搭话（默认关闭 —— 会主动发消息的功能必须用户明确开启）。
         *
         * @param {boolean} on
         * @param {boolean} [immediate] 是否立刻执行一次（默认 true）。
         *   用户**点开关**时该立即执行 —— 否则要等 10 分钟才有反应，会以为坏了。
         *   但**恢复定时器**（打开桌宠/刷新页面时按上次设置恢复）不该立即执行，
         *   否则每次刷新都会平白发一条消息。
         * @returns {Promise|null} 执行了首次则返回其 Promise；否则 null
         */
        function setProactive(on, immediate) {
            set('proactive', on ? '1' : '0');
            if (proactiveTimer) { clearInterval(proactiveTimer); proactiveTimer = null; }
            if (!on) return null;
            const every = Number(get('proactiveEvery', 10 * 60 * 1000)) || 10 * 60 * 1000;
            const runNow = immediate !== false;
            // ★ 立即执行一次（仅用户主动开启时）。
            //
            //   否则用户开了开关后要等 10 分钟才有反应，会以为功能坏了
            //   （实测踩过：端到端测试等 6 秒，什么都没发生）。
            //   立即执行还有个好处：马上就能看到"它读到我在干什么了"，
            //   用户能立刻判断这个功能有没有用、要不要留着。
            //
            //   用 `force: true` 绕过冷却：这是用户**刚开启**时的"试一下"，
            //   冷却的本意是防止重复打扰，不该拦住这次明确的开启动作。
            //
            //   把 Promise 返回给调用方，让它根据结果给反馈 —— 这样"读活动"
            //   只发生一次。早先的写法是调用方自己再探一次，既多花 4 秒
            //   （服务端要跑 PowerShell），又会和 proactiveOnce 内部各说一句话，
            //   用户看到**两条重复气泡**（实测踩过）。
            const first = runNow ? proactiveOnce({ force: true }) : null;
            proactiveTimer = setInterval(() => { void proactiveOnce(); }, Math.max(60_000, every));
            return first;
        }

        function isProactive() { return get('proactive', '0') === '1'; }

        // ==================== 发送 / 语音 ====================

        function send() {
            const v = (inputEl && inputEl.value || '').trim();
            if (!v) return;
            inputEl.value = '';
            // 先把自己的话显示出来（不等宿主回灌，手感更跟手）
            addBubble(v, 'me');
            setEmotion('calm');
            if (!host.sendUserMessage(v)) {
                addBubble('发送失败：没有当前对话', 'ai');
            }
        }

        function startVoice() {
            try {
                const btn = document.getElementById('micBtn')
                    || document.querySelector('.conversation-mic-btn')
                    || document.querySelector('.initial-conversation-mic-btn')
                    || document.querySelector('[id*="mic" i]');
                if (btn) {
                    btn.click();
                    addBubble('语音识别中…结果会出现在主输入框', 'ai');
                    return;
                }
                addBubble('未找到语音入口，请在主界面使用麦克风', 'ai');
            } catch (e) { addBubble('语音启动失败', 'ai'); }
        }

        // ==================== 开关 ====================

        let pollTimer = null;

        function open() {
            build();
            root.style.display = 'block';
            // 首次打开时把最近几条对话铺上去（否则气泡区是空的）
            const msgs = host.getMessages().filter((m) => m && m.text && m.role !== 'system').slice(-4);
            bubbleEl.innerHTML = '';
            if (!msgs.length) {
                addBubble('你好呀，我是伊蕾娜～', 'ai');
            } else {
                for (const m of msgs) addBubble(m.text, m.role === 'user' ? 'me' : 'ai');
            }
            const last = msgs[msgs.length - 1];
            if (last) {
                lastMsgKey = msgKey(last);
                setEmotion(last.role !== 'user' ? emotionFrom(last.text) : 'calm');
            }
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = setInterval(() => {
                if (!root || root.style.display === 'none') return;
                try { syncFromState(); } catch (e) { /* 忽略 */ }
            }, 700);
            // 主动搭话：mod 打开时按用户设置恢复定时器。
            // 传 immediate=false —— 恢复定时器是后台行为，不该在打开桌宠 /
            // 刷新页面时立刻发一条消息（用户没点开关）。
            if (isProactive()) setProactive(true, false);
        }

        function close() {
            if (root) root.style.display = 'none';
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
            if (emoTimer) { clearTimeout(emoTimer); emoTimer = null; }
            // 关掉桌宠就停掉主动搭话 —— 看不见的宠物不该在后台发消息
            if (proactiveTimer) { clearInterval(proactiveTimer); proactiveTimer = null; }
        }

        function setEnabled(on) {
            enabled = !!on;
            set('enabled', on ? '1' : '0');
            if (on) open(); else close();
        }

        // ==================== 初始化 ====================

        // ⚠️ 不读自己那份 enabled 开关 —— 理由同 galgame：会形成双重开关，
        // 用户从设置启用 mod 后界面却不出现。语义应该是「mod 启用 = 界面出现」。
        enabled = true;
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => open());
        else open();
        host.log('已就绪（立绘走 elaina-avatar，与 Galgame 同源）');

        return {
            setEnabled,
            isOpen: () => Boolean(root && root.style.display !== 'none'),
            toggle: () => setEnabled(!enabled),
            /** 供其他 mod / 宿主主动推一条 AI 回复进来（上游的 window.PetOnReply 等价物） */
            onReply: (text) => {
                if (!root) return;
                addBubble(String(text || ''), 'ai');
                setEmotion(emotionFrom(text));
            },
            showTip: (text) => {
                if (!root) return;
                addBubble(String(text || ''), 'ai');
            },
            setEmotion,
            // ---- 看电脑在干什么（上游 UiTextReader / PetBrain 的等价物）----
            /** 读一次当前活动（前台窗口 + 进程）。失败返回 null */
            activity: () => fetchActivity(false),
            /** 立即主动搭话一次（忽略冷却；用于用户点"现在说一句"） */
            proactiveNow: () => proactiveOnce({ force: true }),
            /** 开关主动搭话（默认关闭） */
            setProactive,
            isProactive,
        };
    });
})();
