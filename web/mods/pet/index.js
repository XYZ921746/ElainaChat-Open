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
                  + 'border-radius:14px 14px 0 0;background:rgba(255,255,255,.55);backdrop-filter:blur(10px);'
                  + 'font-size:11px;color:#6366f1;user-select:none">⠿ 按住拖动</div>'
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
        }

        function close() {
            if (root) root.style.display = 'none';
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
            if (emoTimer) { clearTimeout(emoTimer); emoTimer = null; }
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
        };
    });
})();
