/* ============================================================================
 * 插件系统（动态 mod 加载器）
 *
 * 目标：Galgame、桌宠这类**可选功能**不该长在宿主主脚本里。它们要能：
 *   · 像 mod 一样放/删 —— 插件就是一个目录，删掉目录即卸载
 *   · 独立开关 —— 用户随时启用/停用，互不影响
 *   · 失败隔离 —— 一个插件崩了不能拖垮整个应用
 *   · 按需加载 —— 未启用的插件不注入脚本、不占内存
 *
 * ── 设计要点 ────────────────────────────────────────────────────────────────
 *
 * ① **清单驱动**：每个插件目录里有 manifest.json（id/name/version/entry/styles/
 *    defaultEnabled）。加载器只认清单，不硬编码任何插件名 —— 这样"新增一个 mod"
 *    等于"加一个目录"，不需要改宿主代码。
 *
 * ② **失败隔离**：插件的加载与初始化都包在 try/catch 里。任何一个插件抛错，
 *    只把它标记为 error 并继续加载其余插件 —— 绝不让一个坏 mod 白屏整个应用。
 *    这一点必须做，因为 mod 是"用户可自行增删"的东西，质量不可控。
 *
 * ③ **动态 script 注入**：用 <script src> 注入而不是 fetch+eval。原因：
 *    · 保持与现有 app-*.js 一致的加载语义（顶层 const/let 进全局词法环境）
 *    · 浏览器能正常显示来源文件，调试时堆栈可读
 *    · 不需要处理 CSP 与 eval 的额外风险
 *    代价是加载是异步的，所以提供 await loadAll() 让宿主能等。
 *
 * ④ **宿主 API 收窄**：插件不能直接摸宿主内部（那样插件一多就没法重构）。
 *    宿主通过 `host` 参数只暴露必要的接口（见 createHostApi）。
 *
 * ⑤ **顺序可控**：manifest 可声明 `after`（依赖的插件 id），加载器做拓扑排序；
 *    环形依赖会被检测并报错，而不是死循环。
 * ========================================================================== */
(function () {
    'use strict';

    /** 插件根目录（相对站点根） */
    const MOD_ROOT = '/mods/';

    /** 插件状态：id -> { manifest, state, error, api } */
    const registry = new Map();

    /** 已注入的 <script>，避免重复注入 */
    const loadedScripts = new Set();

    /** 全局开关：用户可以在设置里彻底关掉插件系统 */
    const MODS_ENABLED_KEY = 'elaina_plugins_enabled';
    const MOD_ENABLED_KEY_PREFIX = 'elaina_plugin_';

    // ========================================================================
    //  用户偏好（哪些插件启用）
    // ========================================================================

    function modsGloballyEnabled() {
        try { return localStorage.getItem(MODS_ENABLED_KEY) !== '0'; } catch (e) { return true; }
    }
    function setModsGloballyEnabled(on) {
        try { localStorage.setItem(MODS_ENABLED_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }
    function isModEnabled(id, manifest) {
        try {
            const v = localStorage.getItem(MOD_ENABLED_KEY_PREFIX + id);
            if (v === null) return manifest && manifest.defaultEnabled !== false;
            return v === '1';
        } catch (e) {
            return !(manifest && manifest.defaultEnabled === false);
        }
    }
    function setModEnabled(id, on) {
        try { localStorage.setItem(MOD_ENABLED_KEY_PREFIX + id, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }

    // ========================================================================
    //  宿主 API：插件只能通过它访问宿主能力
    // ========================================================================

    /**
     * 构造交给插件的宿主接口。
     *
     * 为什么不直接把 window 给它：插件一旦随手引用宿主的内部变量
     * （`state` / `elements` / 各种内部函数），宿主以后就没法重构了 ——
     * 任何改名都会悄悄弄坏某个 mod。这里显式列出允许使用的入口，
     * 宿主改内部实现时只要保证这张表不变，插件就不会坏。
     */
    function createHostApi(manifest) {
        const log = (level, ...args) => {
            const tag = '[Mod:' + manifest.id + ']';
            const fn = console[level] || console.log;
            try { fn(tag, ...args); } catch (e) { /* 忽略 */ }
        };
        return {
            id: manifest.id,
            version: manifest.version || '0.0.0',

            // ---- 日志（带插件前缀，便于定位是哪个 mod 在说话）----
            log: (...a) => log('log', ...a),
            warn: (...a) => log('warn', ...a),
            error: (...a) => log('error', ...a),

            // ---- 对话数据（只读约定：改数据请走下面的 API）----
            /** 取当前会话；没有则 null */
            getConversation() {
                try {
                    if (typeof state === 'undefined' || !state) return null;
                    const list = state.conversations || [];
                    return list.find((c) => c.id === state.currentConversationId) || list[0] || null;
                } catch (e) { return null; }
            },
            /** 取会话里的消息数组（引用，插件只读遍历） */
            getMessages() {
                const c = this.getConversation();
                return (c && Array.isArray(c.messages)) ? c.messages : [];
            },
            /** 当前是否处于某个特殊页面模式（便签/日记），插件据此决定要不要显示 */
            getUiMode() {
                try {
                    return { notes: !!state.notesMode, diary: !!state.diaryMode };
                } catch (e) { return { notes: false, diary: false }; }
            },

            // ---- 发送消息（走宿主既有链路，不另起一套请求）----
            /**
             * 以用户身份发一条消息。复用宿主 handleUserInput，
             * 保证"从插件发出的消息"和"从主输入框发出的"完全同一条链路
             * （记忆、续跑、停止、语音都自动生效）。
             */
            sendUserMessage(text) {
                try {
                    const msg = String(text || '').trim();
                    if (!msg) return false;
                    const c = this.getConversation();
                    if (typeof handleUserInput !== 'function' || !c) return false;
                    handleUserInput(msg, c);
                    return true;
                } catch (e) { log('error', 'sendUserMessage 失败', e); return false; }
            },

            // ---- 文本渲染（Markdown / LaTeX，与主界面同一套）----
            renderText(text) {
                try {
                    if (typeof renderMessageText === 'function') return renderMessageText(text);
                } catch (e) { /* 回落到纯文本 */ }
                // 回落：至少把 HTML 转义掉，避免插件直接把用户内容当 HTML 插进去
                return String(text == null ? '' : text)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            },

            // ---- 样式注入（插件自己的 css，随插件启用/停用）----
            injectStyle(href) {
                const url = String(href || '');
                if (!url) return null;
                const id = 'mod-style-' + manifest.id + '-' + url.replace(/[^\w.-]/g, '_');
                let el = document.getElementById(id);
                if (el) return el;
                el = document.createElement('link');
                el.id = id;
                el.rel = 'stylesheet';
                el.href = url;
                el.setAttribute('data-mod', manifest.id);
                document.head.appendChild(el);
                return el;
            },

            // ---- 往 system 提示词里追加内容（插件影响模型行为的唯一入口）----
            /**
             * 注册一段"动态 system 提示词"。宿主在每次构造对话消息时调用它。
             * 为什么用注册而不是直接改：插件不该知道宿主怎么拼提示词，
             * 宿主也不该知道有哪些插件 —— 注册表是唯一的耦合点。
             */
            setPromptHint(text) {
                promptHints.set(manifest.id, String(text || ''));
            },
            clearPromptHint() { promptHints.delete(manifest.id); },

            // ---- 事件 ----
            on(event, handler) {
                if (!bus.has(event)) bus.set(event, new Set());
                bus.get(event).add(handler);
                return () => bus.get(event).delete(handler);
            },
            emit(event, detail) {
                const set = bus.get(event);
                if (!set) return;
                for (const h of set) {
                    try { h(detail); } catch (e) { log('error', '事件处理失败 ' + event, e); }
                }
            },

            // ---- 宿主能力探测：插件据此决定降级行为 ----
            has(name) {
                try { return typeof window[name] !== 'undefined'; } catch (e) { return false; }
            },
        };
    }

    /** 插件注册的 system 提示词片段：id -> text */
    const promptHints = new Map();

    /** 简易事件总线（宿主 ↔ 插件、插件 ↔ 插件） */
    const bus = new Map();

    /** 供宿主取全部插件的提示词片段（拼进 system） */
    function collectPromptHints() {
        const out = [];
        for (const [id, text] of promptHints) {
            if (text) out.push(text);
        }
        return out;
    }

    // ========================================================================
    //  清单发现与排序
    // ========================================================================

    /**
     * 发现所有插件。
     *
     * 为什么需要一份"清单索引"：浏览器里没法列目录。所以约定
     * `mods/index.json` 是插件清单数组（构建/手工维护），
     * 加载器读它。这样"加一个 mod"= 加目录 + 往 index.json 加一行。
     */
    async function discover() {
        try {
            const res = await fetch(MOD_ROOT + 'index.json', { cache: 'no-store' });
            if (!res.ok) return [];
            const data = await res.json();
            // 兼容两种写法：数组，或 { plugins: [...] }（后者便于写注释字段）
            const list = Array.isArray(data) ? data : (data && Array.isArray(data.plugins) ? data.plugins : []);
            return list.filter((m) => m && typeof m.id === 'string' && m.id);
        } catch (e) {
            // 没有插件目录是**正常情况**（用户全删了），不该报错打扰
            return [];
        }
    }

    /** 拓扑排序：尊重 manifest.after；检测环形依赖 */
    function sortByDependency(manifests) {
        const byId = new Map(manifests.map((m) => [m.id, m]));
        const out = [];
        const mark = new Map();   // id -> 1=访问中 2=已完成

        function visit(m, chain) {
            const st = mark.get(m.id);
            if (st === 2) return;
            if (st === 1) {
                throw new Error('插件依赖成环：' + chain.concat(m.id).join(' → '));
            }
            mark.set(m.id, 1);
            for (const dep of (Array.isArray(m.after) ? m.after : [])) {
                const d = byId.get(dep);
                if (d) visit(d, chain.concat(m.id));
            }
            mark.set(m.id, 2);
            out.push(m);
        }

        for (const m of manifests) visit(m, []);
        return out;
    }

    // ========================================================================
    //  加载
    // ========================================================================

    /** 注入一个 <script>，resolve 于 load / reject 于 error */
    function injectScript(src) {
        if (loadedScripts.has(src)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.setAttribute('data-mod-script', '1');
            el.onload = () => { loadedScripts.add(src); resolve(); };
            el.onerror = () => reject(new Error('脚本加载失败：' + src));
            document.head.appendChild(el);
        });
    }

    /**
     * 加载并初始化单个插件。
     *
     * 失败隔离的核心：**整个函数体都包在 try/catch 里**。
     * 插件是用户可自行增删的东西，质量不可控 —— 一个坏 mod 绝不能
     * 让整个应用白屏（那会让用户连"去设置里关掉它"都做不到）。
     */
    async function loadOne(manifest) {
        const entry = { manifest, state: 'pending', error: null, api: null };
        registry.set(manifest.id, entry);

        if (!modsGloballyEnabled()) {
            entry.state = 'disabled';
            return entry;
        }
        if (!isModEnabled(manifest.id, manifest)) {
            entry.state = 'disabled';
            return entry;
        }

        try {
            // ① 样式（可选）
            for (const css of (Array.isArray(manifest.styles) ? manifest.styles : [])) {
                const href = css.startsWith('/') ? css : MOD_ROOT + manifest.id + '/' + css;
                const el = document.createElement('link');
                el.rel = 'stylesheet';
                el.href = href;
                el.setAttribute('data-mod', manifest.id);
                document.head.appendChild(el);
            }

            // ② 入口脚本
            const entrySrc = manifest.entry || 'index.js';
            const src = entrySrc.startsWith('/') ? entrySrc : MOD_ROOT + manifest.id + '/' + entrySrc;
            await injectScript(src);

            // ③ 初始化：插件把 init 挂到 window.ElainaMods.register(id, fn)
            const factory = pendingRegistrations.get(manifest.id);
            if (typeof factory === 'function') {
                entry.api = await factory(createHostApi(manifest));
            } else if (manifest.autoInit !== false) {
                // 没有 register 的插件：脚本加载成功即算可用（有些 mod 自带启动逻辑）
                entry.api = null;
            }
            entry.state = 'ready';
        } catch (err) {
            entry.state = 'error';
            entry.error = String((err && err.message) || err);
            console.error('[Mod:' + manifest.id + '] 加载失败（已隔离，不影响其他插件）', err);
        }
        return entry;
    }

    /** 插件脚本通过它注册初始化函数（在脚本执行时调用） */
    const pendingRegistrations = new Map();

    /** 加载全部插件 */
    async function loadAll() {
        const manifests = await discover();
        if (!manifests.length) return [];

        let ordered;
        try {
            ordered = sortByDependency(manifests);
        } catch (err) {
            // 依赖成环：报错但不要全崩 —— 退化成"按声明顺序加载"
            console.error('[Mod] ' + err.message + '，退化为按声明顺序加载');
            ordered = manifests;
        }

        const results = [];
        // 顺序加载（不是并发）：插件之间可能有依赖，且顺序加载让失败定位更容易
        for (const m of ordered) {
            results.push(await loadOne(m));
        }
        return results;
    }

    /** 运行时启用/停用（停用只隐藏，不卸载脚本 —— 卸载需要整页刷新） */
    function setEnabled(id, on) {
        const entry = registry.get(id);
        if (!entry) return false;
        setModEnabled(id, on);
        try {
            if (typeof entry.api?.setEnabled === 'function') entry.api.setEnabled(on);
        } catch (e) { /* 插件自己的开关失败不该影响宿主 */ }
        entry.state = on ? 'ready' : 'disabled';
        emit('mod-changed', { id, enabled: on });
        return true;
    }

    function emit(event, detail) {
        const set = bus.get(event);
        if (!set) return;
        for (const h of set) {
            try { h(detail); } catch (e) { /* 忽略 */ }
        }
    }

    // ========================================================================
    //  对外接口
    // ========================================================================

    window.ElainaMods = {
        /** 插件脚本用它注册初始化函数：ElainaMods.register('galgame', (host) => ({...})) */
        register(id, factory) {
            pendingRegistrations.set(String(id), factory);
        },
        loadAll,
        /** 列出已发现的插件及其状态（供设置界面渲染） */
        list() {
            return [...registry.values()].map((e) => ({
                id: e.manifest.id,
                name: e.manifest.name || e.manifest.id,
                version: e.manifest.version || '',
                description: e.manifest.description || '',
                state: e.state,
                error: e.error,
                enabled: isModEnabled(e.manifest.id, e.manifest),
            }));
        },
        setEnabled,
        isEnabled: (id) => {
            const e = registry.get(id);
            return e ? isModEnabled(id, e.manifest) : false;
        },
        /** 全局开关：关掉后所有插件都不加载（需要刷新页面生效） */
        isGloballyEnabled: modsGloballyEnabled,
        setGloballyEnabled(on) { setModsGloballyEnabled(on); },
        /** 宿主用它取全部插件的 system 提示词片段 */
        collectPromptHints,
        /** 宿主用它广播事件给插件（如"AI 回复完成"） */
        emit,
        on(event, handler) {
            if (!bus.has(event)) bus.set(event, new Set());
            bus.get(event).add(handler);
            return () => bus.get(event).delete(handler);
        },
        _registry: registry,
    };

    // 页面就绪后自动加载（宿主也可以显式调 loadAll）
    function boot() {
        loadAll().catch((e) => console.error('[Plugin] 加载流程异常', e));
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
