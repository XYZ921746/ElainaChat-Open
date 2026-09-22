// 端侧数据同步（跨设备）
// 从 web/index.html 拆分而来（原内联 <script> 块）。
// 保持原样：用 IIFE 包裹，不向全局泄漏任何名字。

    /* ===== 端侧数据同步（跨设备） =====
       localStorage 是"每台设备各存一份"：电脑上聊的记录、填的 API Key，手机上完全看不到。
       这里把需要共享的几项同步到服务端 data/store.json：
         · 启动时用同步 XHR 拉下来灌进 localStorage —— 必须是同步的，
           因为应用主脚本是同步读 localStorage 完成初始化的，异步拉取会来不及；
         · 之后每次写入这些键，防抖后推回服务端。
       实现方式是直接包 localStorage.setItem，所以业务代码一行都不用改。 */
    (function () {
        var SYNC_KEYS = [
            'elaina_open_settings',        // 设置（含 ASR/TTS provider、各类参数）
            'elainachat_open_api_secrets', // API Key
            'elaina_open_conversations',   // 聊天记录
            'elaina_open_categories',      // 分类
            'elaina_open_favorites',       // 收藏
            'elaina_open_liked_quotes',    // 喜欢的台词
            'elaina_open_character_card',  // 角色卡（当前生效的那套）
            'elaina_open_character_cards', // 多人设列表
            'elaina_open_current_card',    // 当前选中的人设 id
            'elaina_open_memory_core',     // 记忆
            'live2d.bg',                   // Live2D 背景
            'live2d.mouseFollow',          // 鼠标跟随开关
            'live2d.mouseFollowScale'      // 鼠标跟随幅度
        ];
        var SYNC_SET = {};
        for (var i = 0; i < SYNC_KEYS.length; i++) SYNC_SET[SYNC_KEYS[i]] = true;

        var pending = {};
        var timer = null;

        function flush() {
            timer = null;
            if (!Object.keys(pending).length) return;
            var body = JSON.stringify({ data: pending });
            pending = {};
            try {
                // 用 sendBeacon：刚改完设置就关页面/切后台时也能发出去
                if (navigator.sendBeacon) {
                    var blob = new Blob([body], { type: 'application/json' });
                    if (navigator.sendBeacon('/api/store', blob)) return;
                }
            } catch (e) { /* 退回 fetch */ }
            try {
                fetch('/api/store', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: body,
                    keepalive: true
                }).catch(function () { /* 服务端没开就只留本地 */ });
            } catch (e) { }
        }

        function queue(key, value) {
            pending[key] = value;
            if (!timer) timer = setTimeout(flush, 800);
        }

        // ① 先把服务端数据拉下来
        var serverData = null;
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', '/api/store', false);   // 同步
            xhr.send(null);
            if (xhr.status === 200) {
                var res = JSON.parse(xhr.responseText || '{}');
                serverData = (res && res.data) || {};
                for (var k in serverData) {
                    if (!SYNC_SET[k] || typeof serverData[k] !== 'string') continue;
                    try { localStorage.setItem(k, serverData[k]); } catch (e) { }
                }
            }
        } catch (e) { /* 未登录 / 离线 → 用本地数据继续，不影响使用 */ }

        // ② 服务端缺、本机有的项，补推上去。
        //    注意这里要**逐个键**判断，不能只看"服务端是不是空的" ——
        //    否则服务端只要有任何一条数据（比如另一台设备先同步了聊天记录），
        //    本机独有的项（比如刚填的 API Key）就永远传不上去。
        //    两边都有的键以服务端为准（多设备下它才是权威）。
        if (serverData) {
            for (var j = 0; j < SYNC_KEYS.length; j++) {
                var key = SYNC_KEYS[j];
                if (key in serverData) continue;
                try {
                    var lv = localStorage.getItem(key);
                    if (lv !== null) pending[key] = lv;
                } catch (e) { }
            }
            if (Object.keys(pending).length && !timer) timer = setTimeout(flush, 600);
        }

        // ③ 之后每次写入这些键都回推服务端
        try {
            var proto = Object.getPrototypeOf(window.localStorage);
            var origSet = proto.setItem;
            proto.setItem = function (key, value) {
                origSet.call(this, key, value);
                if (this === window.localStorage && SYNC_SET[key]) queue(key, String(value));
            };
        } catch (e) { /* 拿不到 Storage 原型就放弃同步，其它功能不受影响 */ }

        window.addEventListener('pagehide', function () {
            if (timer) { clearTimeout(timer); flush(); }
        });
    })();
