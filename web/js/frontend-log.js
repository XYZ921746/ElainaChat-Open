// 前端日志转发
// 从 web/index.html 拆分而来（原内联 <script> 块）。
// 保持原样：用 IIFE 包裹，不向全局泄漏任何名字。

    /* ===== 前端日志转发 =====
       浏览器里的报错平时只在控制台可见。手机上一旦出问题（语音起不来、模型加载失败），
       根本没法去看控制台。这里把 error / warn / 未捕获异常转发到服务端，
       直接显示在启动窗口里，和请求日志对照着看。 */
    (function () {
        if (window.__logRelayInstalled) return;
        window.__logRelayInstalled = true;

        var queue = [];
        var timer = null;

        function toText(args) {
            var parts = [];
            for (var i = 0; i < args.length; i++) {
                var a = args[i];
                try {
                    // Error 取 stack 而不只是 message：前端报错的原因常常在调用链上
                    // （"哪个函数调的、参数是什么"），只发一句 message 过去基本查不出东西。
                    if (a instanceof Error) parts.push(a.stack || a.message);
                    else if (typeof a === 'object' && a !== null) parts.push(JSON.stringify(a));
                    else parts.push(String(a));
                } catch (e) { parts.push('[无法序列化]'); }
            }
            // 旧值是 300，恰好把最关键的上游报错砍在半截（`requestedModel":"Qwen3.8-` 就断了）。
            // 服务端主日志留 2000 字、完整原文进追踪日志，这里跟着放宽。
            return parts.join(' ').slice(0, 2000);
        }

        function push(level, text) {
            if (!text) return;
            queue.push({ level: level, text: text, page: location.pathname + location.hash.slice(0, 20) });
            if (queue.length > 40) queue.splice(0, queue.length - 40);
            if (!timer) timer = setTimeout(flush, 1200);
        }

        function flush() {
            timer = null;
            if (!queue.length) return;
            var items = queue.splice(0, 20);
            try {
                var blob = new Blob([JSON.stringify({ items: items })], { type: 'application/json' });
                navigator.sendBeacon('/api/client-log', blob);
            } catch (e) { /* 上报失败就算了，绝不影响应用本身 */ }
        }

        var origError = console.error;
        console.error = function () { origError.apply(console, arguments); push('error', toText(arguments)); };
        var origWarn = console.warn;
        console.warn = function () { origWarn.apply(console, arguments); push('warn', toText(arguments)); };
        // console.debug 也转发（记为 DBUG）：前端自己现在没调用它，但 pixi / Live2D 这些
        // 第三方库会调 —— 出问题时那些输出正是最需要看到的。服务端只在落盘级别为 DEBUG 时
        // 才把它写进文件，所以平时不会造成噪音。
        var origDebug = console.debug;
        if (typeof origDebug === 'function') {
            console.debug = function () { origDebug.apply(console, arguments); push('debug', toText(arguments)); };
        }

        // ★ console.log 也转发，但**只转 mod 相关的那几条**（2026-09 补）。
        //
        // 为什么必须补：插件的加载是"看不见的过程" ——
        //   · 成功时插件走 host.log()，而它落到 console.log → 启动窗口里一条都没有；
        //   · 失败时才有 [Mod:…] 的 error → 于是"没有 mod 日志"既可能是成功、
        //     也可能是 mods.js 压根没跑，**两者在启动窗口里长得一模一样**。
        //   实测就踩了这个坑：用户报"日志里没有 mod 开头的日志"，无法据此判断
        //   到底是没加载还是加载成功。
        //
        // 为什么不转发**所有** console.log：宿主自己有大量正常日志
        // （每轮对话、每次请求），全转发会把启动窗口刷满、把真正的错误埋掉 ——
        // 这正是当初只挂 error/warn/debug 的原因。这里只认 mod 前缀，
        // 代价小、收益明确：插件装没装、启没启、加载成没成，一眼可查。
        var origLog = console.log;
        console.log = function () {
            origLog.apply(console, arguments);
            try {
                var first = arguments.length ? String(arguments[0]) : '';
                // host.log 打的是 '[Mod:<name>] …'；宿主自己的 Mod 生命周期日志也用这个前缀
                if (first.indexOf('[Mod:') === 0 || first.indexOf('[Mod]') === 0) {
                    push('info', toText(arguments));
                }
            } catch (e) { /* 绝不影响应用本身 */ }
        };

        window.addEventListener('error', function (e) {
            push('error', '未捕获异常: ' + (e.message || '') + '  @'
                + String(e.filename || '').split('/').pop() + ':' + (e.lineno || 0));
        });
        window.addEventListener('unhandledrejection', function (e) {
            var r = e.reason;
            push('error', '未处理的 Promise 拒绝: ' + ((r && r.message) || String(r)));
        });
    })();
