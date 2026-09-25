/* ============================================================================
 * AI 标签协议：剥离 + 分发（宿主自有，不依赖 Live2D）
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────────
 *
 * 这套东西原先**整个长在 web/live2d-video.js 里**：`stripTags()` 与
 * `drive()` → `handleAgentOperation()`。调用点在宿主各处：
 *
 *   app-05-voice.js   正常回复：drive(response) + stripTags(response)
 *   app-03-agent.js   续跑 / 失败解释 / 定时任务：drive(raw) + stripTags(raw)
 *
 * 问题在于 `handleAgentOperation` 是**全部 [操作:…] 标签的唯一分发器** ——
 * 包括文件操作、电脑命令、手机操作、整理记忆。而宿主调用它时带着
 * `if (window.Live2DCall)` 判断。
 *
 * 于是只要 Live2D 不在（被当成可选 mod 卸掉、或那个文件加载失败），
 * 后果不是"少了个视频通话"，而是：
 *   ① **整个 Agent 系统失效** —— 文件/命令/手机标签全部不会被转发执行；
 *   ② **标签漏进可见文本** —— stripTags 也没了，用户直接看到 `[表情:开心]`。
 *
 * 这就是"把 Live2D 拆出去"的真正阻塞点：**它不是界面耦合，是能力寄生**。
 *
 * ── 现在的分工（解耦后）──────────────────────────────────────────────────
 *
 *   本文件（宿主，永远加载）     标签剥离 + 操作标签分发（文件/命令/手机/记忆/通话）
 *   live2d-video.js（可选）      只负责"表现"：表情/动作/情绪/位置/大小/背景
 *                                以及 Live2D 独有的 水印 / 静音 两个操作
 *
 * ★ 关键：`[操作:…]` 的分发**不再**经过 Live2D。Live2D 只能通过
 *   `registerOperationHandler` 往分发链里**追加**自己的两个操作，
 *   而不是拥有整条链。
 *
 * ── 两个入口 ─────────────────────────────────────────────────────────────
 *
 *   ElainaTags.strip(text)   剥掉所有标签，得到给用户看的正文
 *   ElainaTags.drive(text)   解析并执行：先分发操作，再把表现交给 presenters
 *
 * 两者都不依赖 Live2D —— Live2D 不在时它们照常工作（只是没有表现可驱动）。
 * ========================================================================== */
(function () {
    'use strict';

    if (window.ElainaTags) return;   // 幂等：重复引入不覆盖

    /** 全部标签名的权威清单。剥离用一份，避免各处正则走样。 */
    const TAG_NAMES = ['表情', '动作', '情绪', '位置', '大小', '背景', '操作', '任务'];

    /**
     * 剥掉标签，返回给用户看的正文。
     *
     * 为什么集中一处：剥离散落会导致"某个标签在 A 处被剥、在 B 处漏出来"。
     * 之前 live2d-video.js 里那份是唯一实现，宿主各处都去调它 ——
     * 现在搬到这里，宿主调自己人，不再依赖 Live2D 是否存在。
     */
    function strip(text) {
        let out = String(text == null ? '' : text);
        for (const name of TAG_NAMES) {
            out = out.replace(new RegExp('\\[' + name + '[:：][^\\]]*\\]', 'g'), '');
        }
        return out.trim();
    }

    /**
     * Live2D 等"表现层"注册进来的操作处理器。
     *
     * 每个处理器 = { test: (v) => boolean, run: (v) => void }。
     * 加这一层是为了让 Live2D 的 水印/静音 能挂上，
     * 同时**宿主自己的操作不经过它** —— 否则又变成寄生。
     */
    const extraHandlers = [];

    /**
     * 注册一个额外的操作处理器（供表现层扩展）。
     *
     * @param {(v:string)=>boolean} test 判据：这个操作名归我管吗
     * @param {(v:string)=>void} run 执行
     * @returns {() => void} 取消注册
     */
    function registerOperationHandler(test, run) {
        const entry = { test, run };
        extraHandlers.push(entry);
        return () => {
            const i = extraHandlers.indexOf(entry);
            if (i >= 0) extraHandlers.splice(i, 1);
        };
    }

    /** 安全调用 agentActions 上的某个方法（宿主未就绪时不要炸） */
    function callAction(name, ...args) {
        try {
            const fn = window.agentActions && window.agentActions[name];
            if (typeof fn === 'function') { fn(...args); return true; }
            console.warn('[Tags] 主应用还没有 ' + name + '，本次操作被忽略');
        } catch (e) {
            console.warn('[Tags] 执行 ' + name + ' 失败:', e);
        }
        return false;
    }

    /**
     * 分发**一个**操作标签的内容。
     *
     * ★ 分支顺序是有讲究的，改动前先读这段：
     *   · `^电脑命令` 必须排在文件操作**之前** —— 命令正文里可能含
     *     「查看文件」这类词（`[操作:电脑命令 git status]`），
     *     文件分支的判据很宽泛，排在前面会把命令正文吃掉。
     *   · 手机分支用 `^(手机|设备)` 锚定，与命令分支不冲突。
     */
    function handleOperation(v) {
        const name = String(v == null ? '' : v).trim();
        if (!name) return;

        // ---- 先给表现层（Live2D）机会：水印 / 静音 只有它知道怎么执行 ----
        for (const h of extraHandlers) {
            try {
                if (h.test(name)) { h.run(name); return; }
            } catch (e) {
                console.warn('[Tags] 扩展操作处理器出错:', e);
            }
        }

        // ---- 宿主自己的操作（不依赖任何表现层）----
        if (/打开|开始|进入/.test(name) && /视频通话|通话|live2d/i.test(name)) return void callAction('openVideoCall');
        if (/关闭|结束|挂断/.test(name) && /视频通话|通话|live2d/i.test(name)) return void callAction('closeVideoCall');
        if (/整理记忆|记忆整理/.test(name)) return void callAction('organizeMemory');
        if (/^(手机|设备)/.test(name)) return void callAction('agentPhoneOperation', name);
        if (/^(电脑命令|执行命令|运行命令|电脑执行)/.test(name)) return void callAction('agentCommandOperation', name);
        if (/列出文件|列出目录|查看文件夹|查看文件|读取文件|保存文件|写入文件|创建文件|新建文件/.test(name)) {
            return void callAction('agentFileOperation', name);
        }
        console.warn('[Tags] 未知操作:', name);
    }

    /** 取一条回复里出现的全部 [操作:…] 标签（可能多个） */
    function extractOperations(text) {
        const t = String(text == null ? '' : text);
        const raw = t.match(/\[操作[:：]\s*[^\]]+\]/g) || [];
        return raw
            .map((r) => r.replace(/^\[操作[:：]\s*/, '').replace(/\]$/, '').trim())
            .filter(Boolean);
    }

    /** 只分发操作标签（不做表现驱动） */
    function dispatchOperations(text) {
        for (const op of extractOperations(text)) handleOperation(op);
    }

    /**
     * 统一入口：解析一条 AI 回复里的全部标签。
     *
     *   ① 操作标签 → 分发（宿主自己的 + 表现层注册的）
     *   ② 表现标签（表情/动作/情绪/位置/大小/背景）→ 交给表现层
     *
     * 表现层是可选的：Live2D 不在时第 ② 步什么也不做，
     * 但第 ① 步照常执行 —— 这正是解耦的目的。
     */
    function drive(text) {
        const t = String(text == null ? '' : text);
        if (!t) return;
        dispatchOperations(t);
        try {
            const presenter = window.Live2DCall;
            if (presenter && typeof presenter.drivePresentation === 'function') {
                presenter.drivePresentation(t);
            }
        } catch (e) {
            console.warn('[Tags] 表现层驱动失败:', e);
        }
    }

    window.ElainaTags = {
        strip,
        drive,
        dispatchOperations,
        extractOperations,
        registerOperationHandler,
        TAG_NAMES,
    };
})();
