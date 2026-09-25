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

    /**
     * 插件在磁盘上的**实际目录名**（已做 URL 编码，可直接拼进 URL）。
     *
     * ★ 为什么不能直接用 manifest.id 拼 URL（2026-09 修的真 bug）：
     *   插件 id 是**身份**（依赖匹配、资源引用都以它为准），而目录名是
     *   "它落在磁盘的哪个文件夹"。两者正常时相同，但**可能不同** ——
     *   历史版本把打包产物名（`elaina-avatar-1.0.0.zip`）当目录名安装过，
     *   于是目录叫 `elaina-avatar-1.0.0` 而 id 是 `elaina-avatar`。
     *   此时按 id 拼 URL 会让脚本与图片**全部 404**（表现为
     *   "插件开关打开了，但桌宠/Galgame 没有立绘、依赖也报缺失"）。
     *
     * ★ 为什么必须 encodeURIComponent（2026-09 第二次踩）：
     *   用户完全可以把插件目录改成中文（"桌宠"）或带空格（"my pet"）。
     *   不编码的话，同一个目录在不同地方会拼出不同字符串：
     *     · `el.src = '/mods/桌宠/index.js'` —— 浏览器读属性时得到**已编码**的
     *       `/mods/%E6%A1%8C%E5%AE%A0/index.js`
     *     · 而 `loadedScripts` 里存的是**未编码**的原串
     *   两者对不上 → `neverLoaded` 永远为真 → **每次启用都重复注入脚本**，
     *   插件的初始化会跑两次（界面出现两份、事件监听挂两遍）。
     *   `assetUrl()` 同理：编码后 `new Image().src` 与 fetch 才都能取到。
     *
     * 服务端在清单里为每个插件同时给出 id 与 dir，这里优先用 dir；
     * 旧版服务端没有 dir 字段时回落到 id（那时两者本来就一致）。
     */
    function modDir(manifest) {
        const d = manifest && typeof manifest.dir === 'string' ? manifest.dir.trim() : '';
        const raw = d || (manifest && manifest.id) || '';
        // 逐段编码：不能整串 encodeURIComponent（会把路径分隔符也编掉）。
        // 这里 dir 是单层目录名，但仍按 '/' 分段处理，兼容带子路径的写法。
        return String(raw).split('/').map(encodeURIComponent).join('/');
    }

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

    /**
     * 忘掉某个插件的启用状态（删插件时调用）。
     *
     * 为什么删了还要清这个键：留着它没意义（插件都没了），更要紧的是
     * **重装同一个插件时会读到旧状态** —— 若上次是"已启用"，重装后会直接
     * 自动启用，而插件的约定是"默认关闭、用户手动开"。那会让新装的插件
     * 在用户不知情时改动界面。
     */
    function forgetMod(id) {
        try {
            localStorage.removeItem(MOD_ENABLED_KEY_PREFIX + id);
            const entry = registry.get(id);
            registry.delete(id);
            // 清掉"已注入脚本"的记录时要同时认 id 与**实际目录名** ——
            // 两者可能不同（见 modDir 说明），只按 id 匹配会漏删，
            // 于是重装同一个插件时脚本不会被重新注入（表现为"装了没反应"）。
            const needles = ['/' + id + '/'];
            if (entry && entry.manifest && entry.manifest.dir) needles.push('/' + entry.manifest.dir + '/');
            loadedScripts.forEach((v, k) => {
                if (needles.some((n) => k.includes(n))) loadedScripts.delete(k);
            });
        } catch (e) { /* 忽略 */ }
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
     *
     * @param {object} manifest 清单条目
     * @param {string} [regName] 插件脚本里 register() 用的名字（缺省 = manifest.id）
     */
    function createHostApi(manifest, regName) {
        // 日志前缀用**注册名**（插件自己认得的名字），便于对上它的源码
        const name = regName || manifest.id;
        const log = (level, ...args) => {
            const tag = '[Mod:' + name + ']';
            const fn = console[level] || console.log;
            try { fn(tag, ...args); } catch (e) { /* 忽略 */ }
        };
        return {
            id: name,
            manifestId: manifest.id,
            version: manifest.version || '0.0.0',

            // ---- 资源定位（修「资源包装了等于没装」的另一半）----
            /**
             * 取本插件资源的 URL 基址（结尾带 /）。
             *
             * 为什么必须用它而不是插件自己拼 '/mods/<名字>/…'：
             *   插件**声明的 id** 与它**实际被安装成**的目录名可能不一致
             *   （历史版本曾把带版本号的 zip 名当目录名，装出
             *    elaina-avatar-1.0.0/ 这种目录，写死的 URL 全部 404）。
             *   这里用的 manifest.dir 是**磁盘上的真实目录名**，
             *   由它给的基址才是资源真正能取到的位置。
             *
             * 典型用法：host.assetUrl('img/p_calm.png')
             *   → '/mods/elaina-avatar/img/p_calm.png'
             */
            assetUrl(rel) {
                const r = String(rel || '').replace(/^\/+/, '');
                return MOD_ROOT + modDir(manifest) + '/' + r;
            },
            /** 本插件资源目录的 URL（结尾带 /），供需要自行拼路径的场合 */
            assetBase() { return MOD_ROOT + modDir(manifest) + '/'; },

            // ---- 查找其他插件（★ 由插件系统统一解析，插件不自己拼路径）----
            /**
             * 按**注册名 / 清单 id / 目录名**中的任意一个查找插件。
             *
             * 为什么要有这个：插件之间互相依赖（galgame 要用 elaina-avatar 的
             * 立绘接口）时，插件自己拼 `/mods/elaina-avatar/…` 是脆的 ——
             * 用户改了目录名、或清单 id 与注册名不一致，路径就错了。
             * 交给系统查表才是稳的：系统维护着"注册名 ↔ 目录"的映射。
             *
             * 用法：
             *   const av = host.require('elaina-avatar');
             *   if (!av.ok) { host.error(av.reason); return; }
             *   const url = av.url('img/p_calm.png');   // 资源路径由系统算
             */
            require(key) {
                try {
                    const found = window.ElainaMods.find(key);
                    if (!found) {
                        return {
                            ok: false,
                            reason: '找不到插件「' + key + '」。请先在「设置 → 插件」里安装并启用它。',
                        };
                    }
                    if (found.state !== 'ready') {
                        return {
                            ok: false,
                            found,
                            reason: '插件「' + key + '」当前状态是 ' + found.state
                                + '，还不能使用' + (found.entry && found.entry.error ? '：' + found.entry.error : '。'),
                        };
                    }
                    const dir = found.dir;
                    const enc = dir.split('/').map(encodeURIComponent).join('/');
                    return {
                        ok: true,
                        id: found.id,
                        dir,
                        regName: found.regName,
                        api: found.entry ? found.entry.api : null,
                        /** 取该插件的资源 URL（路径由系统按真实目录算） */
                        url: (rel) => MOD_ROOT + enc + '/' + String(rel || '').replace(/^\/+/, ''),
                        base: () => MOD_ROOT + enc + '/',
                    };
                } catch (e) {
                    return { ok: false, reason: '查找插件「' + key + '」时出错：' + (e && e.message || e) };
                }
            },

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
             *
             * ★ 必须自己构造消息**对象**并推进会话，不能只把字符串丢给
             *   handleUserInput —— 它签名是 `(message, conversation)`，
             *   内部读 `message.text` / `message.id`。早先这里传的是字符串，
             *   于是 `message.text` 是 undefined → **发出去的是空消息**
             *   （实测踩过：出站请求里 `role=user` 的内容长度是 0，
             *   桌宠的"主动搭话"因此说了个空话，AI 完全看不到电脑状态）。
             *
             *   主输入框那条路（processVoiceInput / handleInitialTextSubmit）
             *   也是这么构造的：id + role + text + timestamp，再 push 进
             *   conversation.messages。这里照做，才叫"同一条链路"。
             */
            sendUserMessage(text) {
                try {
                    const msg = String(text || '').trim();
                    if (!msg) return false;
                    const c = this.getConversation();
                    if (!c || typeof handleUserInput !== 'function') return false;
                    if (typeof generateId !== 'function') return false;

                    const message = {
                        id: generateId(),
                        role: 'user',
                        text: msg,
                        timestamp: new Date().toLocaleTimeString(),
                    };
                    if (!Array.isArray(c.messages)) c.messages = [];
                    c.messages.push(message);

                    // 首条消息时给会话起个名（与主输入框一致），
                    // 否则插件发出的第一条消息不会让会话标题变正常
                    if (c.messages.length === 1) {
                        try {
                            if (typeof autoNameConversation === 'function') {
                                c.title = autoNameConversation(c.messages);
                            }
                            if (typeof renderFolderList === 'function') renderFolderList();
                            if (typeof updateCurrentConversationTitle === 'function') updateCurrentConversationTitle();
                        } catch (e) { /* 命名失败不影响发送 */ }
                    }
                    // 让界面把新消息画出来（主输入框那条路也会 loadConversation）
                    try {
                        if (typeof loadConversation === 'function') loadConversation(c.id);
                    } catch (e) { /* 忽略 */ }

                    handleUserInput(message, c);
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
     * 让整个白屏（那会让用户连"去设置里关掉它"都做不到）。
     *
     * @param {object} manifest 清单条目
     * @param {Array<{id:string,reason:string,fixable:boolean}>} [missingDeps]
     *        不可用的前置插件（非空时**拒绝加载**）
     */
    async function loadOne(manifest, missingDeps = []) {
        const entry = { manifest, state: 'pending', error: null, api: null };
        registry.set(manifest.id, entry);

        // ★ 前置插件不可用 → **拒绝加载**，并给出可读原因。
        //
        // 旧行为只是 console.error 一句警告、然后照样加载。那很糟：
        // 插件会在"依赖不在"的前提下跑起来 —— 例如 galgame 拿不到
        // window.ElainaAvatar，于是它自己回落成"没有立绘"，用户看到的是
        // "界面能打开但没有人物"，而设置里那个"缺依赖"角标很容易被忽略。
        // 更麻烦的是**加载顺序失去保证**：依赖可能排在它后面才加载。
        //
        // 实测踩到的真实日志（旧实现只看"装没装"，漏了"启用没启用"）：
        //     [Mod] 加载完成：elaina-avatar=disabled galgame=ready pet=ready
        // 前置被禁用了，两个依赖方却照样 ready —— 拿不到立绘而系统认为正常。
        // 现在"未启用"也算不可用，并按原因给出**可执行的下一步**。
        if (missingDeps.length) {
            entry.state = 'blocked';
            entry.missingDeps = missingDeps;
            // 每条原因一句话，人（和 AI）都能读懂该做什么
            const detail = missingDeps.map((d) => {
                const what = '前置插件「' + d.id + '」' + d.reason;
                if (d.reason === '未启用') {
                    return what + ' —— 到「设置 → 插件」里把它的开关打开';
                }
                if (d.reason === '未安装') {
                    return what + ' —— 需要先安装它（见 Releases 的扩展包）';
                }
                if (d.reason === '插件系统总开关已关闭') {
                    return what + ' —— 到「设置 → 插件」打开「启用插件系统」并刷新页面';
                }
                return what + ' —— 请先修好那个插件';
            }).join('；');
            entry.error = '已拒绝加载：' + detail
                + '。（缺了前置就启动，功能只会是残缺的，所以这里直接拒绝而不是带病运行。）';
            console.error('[Mod:' + manifest.id + '] ' + entry.error);
            return entry;
        }

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
            //    路径由 modDir() 统一给出（已 URL 编码），插件自己不拼路径
            for (const css of (Array.isArray(manifest.styles) ? manifest.styles : [])) {
                const href = css.startsWith('/') ? css : MOD_ROOT + modDir(manifest) + '/' + css;
                const el = document.createElement('link');
                el.rel = 'stylesheet';
                el.href = href;
                el.setAttribute('data-mod', manifest.id);
                document.head.appendChild(el);
            }

            // ② 入口脚本
            //
            // ★ 注入前记下"当前在加载哪个目录"：插件脚本执行时会调
            //   register(name, …)，系统据此知道**这个注册名来自哪个目录**。
            //   这是"路径由插件系统查"的关键一环 —— 见 regByDir 的说明。
            const entrySrc = manifest.entry || 'index.js';
            const src = entrySrc.startsWith('/') ? entrySrc : MOD_ROOT + modDir(manifest) + '/' + entrySrc;
            loadingDir = manifest.dir || manifest.id;
            try {
                await injectScript(src);
            } finally {
                loadingDir = null;
            }

            // ③ 初始化：找这个插件注册的 factory。
            //
            // ★ 先按 manifest.id 找（常规情况），找不到就按**本目录注册了什么**找。
            //   为什么需要第二步：用户改了目录名、而 manifest 又没写 id 时，
            //   manifest.id 会等于目录名（如 pet-renamed），而脚本里注册的
            //   仍是 'pet' —— 只按 manifest.id 查会**永远查不到**，
            //   插件表现为"已加载但从不初始化"（界面毫无反应）。
            //   按目录反查就能把这条链接上，目录怎么改都不影响。
            let factory = pendingRegistrations.get(manifest.id);
            let regName = manifest.id;
            if (typeof factory !== 'function') {
                const byDir = regByDir.get(manifest.dir || manifest.id);
                if (byDir && typeof pendingRegistrations.get(byDir) === 'function') {
                    factory = pendingRegistrations.get(byDir);
                    regName = byDir;
                    console.warn('[Mod:' + manifest.id + '] 清单 id 与注册名不一致（'
                        + manifest.id + ' ≠ ' + byDir + '），已按注册名加载'
                        + '（建议在 manifest.json 里显式写 "id": "' + byDir + '"）');
                }
            }

            if (typeof factory === 'function') {
                entry.regName = regName;
                entry.api = await factory(createHostApi(manifest, regName));
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

    /**
     * 注册名 ↔ 目录 的双向映射（★ 插件系统自己维护，插件不参与算路径）。
     *
     * ── 为什么需要它（2026-09 踩到的真 bug）──────────────────────────────
     *
     * 插件的**身份**其实有两个来源：
     *   · 服务端清单给的 `manifest.id`（来自 manifest.json，或回落到目录名）
     *   · 插件脚本里 `register('pet', …)` 声明的**注册名**
     *
     * 正常情况两者相同。但用户**改了插件目录名**之后就可能不同：
     * 目录叫 `pet-renamed`、manifest 又没写 id → 清单 id 是 `pet-renamed`，
     * 而脚本注册的是 `pet`。旧实现直接 `pendingRegistrations.get(manifest.id)`
     * → **查不到 factory → 插件永远不初始化**（清单里显示"已加载"，
     * 界面却毫无反应，是最难排查的那种）。
     *
     * 修法就是"让插件系统来做查找"：脚本是按目录注入的，所以系统**知道**
     * 某个 register() 调用来自哪个目录。于是记录 dir → 注册名，
     * loadOne 先按 manifest.id 找，找不到就按"我这个目录注册了什么"找。
     * 这样**目录怎么改都不影响插件被正确初始化**。
     */
    const regByDir = new Map();     // dir（磁盘目录名）→ 注册名
    const dirByReg = new Map();     // 注册名 → dir

    /** 当前正在注入的插件目录（register() 据此知道自己来自哪个目录） */
    let loadingDir = null;

    /**
     * 找出每个插件**不可用的前置插件**，并说明原因。
     *
     * ── 为什么要单独做这件事 ─────────────────────────────────────────────
     *
     * `sortByDependency` 里对找不到的依赖是 `if (d) visit(...)` —— **静默跳过**。
     * 这在单仓库时代问题不大（一起发布），但 mod 拆到独立仓库分发后，
     * "只装 galgame 不装 elaina-avatar"会变成常态。那时的表现是
     * "Galgame 打开了但没有立绘"，控制台一声不响 —— 最难排查的那类问题。
     *
     * ── ★ 关键修正：装了但**没启用**，等于不可用（2026-09 实测踩到）──────
     *
     * 旧实现只判断"清单里有没有这个 id"，于是出现了这个真实日志：
     *
     *     [Mod] 加载完成：elaina-avatar=disabled galgame=ready pet=ready
     *
     * 前置被**禁用**了，依赖它的两个插件却照样 ready —— 它们拿不到立绘，
     * 而系统认为一切正常。所以判定必须同时看**启用状态**：
     *   · 前置不在清单里           → 原因：未安装
     *   · 前置在清单里但被禁用      → 原因：未启用（用户可以在设置里打开）
     *   · 前置自己被拦（缺它自己的前置）→ 原因：前置本身不可用（级联）
     * 三种情况给三种不同的提示，用户才知道该做什么。
     *
     * ★ 身份判定要同时认**清单 id**、**目录名**、**注册名**：
     *   用户改了插件目录名、而 manifest 没写 id 时，清单 id 会等于目录名
     *   （如 `pet-renamed`），而依赖方 after 里写的仍是注册名 `pet`。
     *   只按清单 id 比会**误报"缺依赖"**，把好好的插件拦下来。
     *
     * @returns {Map<string, Array<{id:string, reason:string, fixable:boolean}>>}
     */
    function findMissingDeps(manifests) {
        // 建三张索引：清单 id / 目录名 / 注册名 → 清单条目
        const byKey = new Map();
        for (const m of manifests) {
            if (m.id) byKey.set(m.id, m);
            if (m.dir && !byKey.has(m.dir)) byKey.set(m.dir, m);
            const rn = m.dir ? regByDir.get(m.dir) : null;
            if (rn && !byKey.has(rn)) byKey.set(rn, m);
        }

        // 第一轮：只算"未安装 / 未启用"（不涉及级联）
        const missing = new Map();
        for (const m of manifests) {
            const deps = Array.isArray(m.after) ? m.after : [];
            const lack = [];
            for (const d of deps) {
                const target = byKey.get(d);
                if (!target) {
                    lack.push({ id: d, reason: '未安装', fixable: false });
                    continue;
                }
                // 前置存在但被禁用（或全局插件系统关着）→ 同样不可用
                if (!modsGloballyEnabled()) {
                    lack.push({ id: d, reason: '插件系统总开关已关闭', fixable: true });
                } else if (!isModEnabled(target.id, target)) {
                    lack.push({ id: d, reason: '未启用', fixable: true });
                }
            }
            if (lack.length) missing.set(m.id, lack);
        }

        // 第二轮：级联 —— 前置自己也被拦时，标成"前置本身不可用"。
        //   一遍不够（A 依赖 B、B 依赖 C），这里迭代到稳定，最多 N 轮。
        //   不这样做的后果：A 会显示"前置 B 已就绪"，而 B 其实也没起来。
        for (let round = 0; round < manifests.length; round++) {
            let changed = false;
            for (const m of manifests) {
                const lack = missing.get(m.id);
                if (!lack) continue;
                for (const item of lack) {
                    if (item.reason !== '未安装' && item.reason !== '未启用') continue;
                    const depBlocked = missing.has(item.id);
                    if (depBlocked) {
                        item.reason = '前置本身不可用（它自己也缺前置）';
                        item.fixable = false;
                        changed = true;
                    }
                }
            }
            if (!changed) break;
        }
        return missing;
    }

    /** 加载全部插件 */
    async function loadAll() {
        // ★ 先打一条总览日志（console.log，会被前端日志转发带到启动窗口）。
        //
        // 为什么必须有：插件的加载是"看不见的过程"，而"没有 mod 日志"这个现象
        // 既可能是**成功**（旧实现里成功日志走 console.log、不被转发），
        // 也可能是 **mods.js 压根没跑 / 清单读不到** —— 两者在启动窗口里
        // 长得一模一样，无法据此排查（实测就卡在这里）。
        // 现在无论成败，先留一条"我开始加载了、清单里有几个"的痕迹。
        const manifests = await discover();
        console.log('[Mod] 开始加载：清单里发现 ' + manifests.length + ' 个插件'
            + (manifests.length ? '（' + manifests.map((m) => m.id).join('、') + '）' : ''));
        if (!manifests.length) {
            // 清单为空 = 没装任何插件，或 index.json 取不到。后者要能看出来。
            console.warn('[Mod] 插件清单为空 —— 没安装任何插件，或 /mods/index.json 读取失败');
            return [];
        }

        // ★ 先查不可用的前置插件 —— 这类插件会被**拒绝加载**（不是警告后照跑）。
        //   判定同时看"装没装"与"启用没启用"，并认清单 id / 目录名 / 注册名三种键。
        const missing = findMissingDeps(manifests);
        for (const [id, lack] of missing) {
            console.error('[Mod] 插件「' + id + '」无法加载 —— 它依赖的前置插件不可用：\n'
                + lack.map((d) => '        · 「' + d.id + '」' + d.reason).join('\n'));
        }

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
            const lack = missing.get(m.id) || [];
            const entry = await loadOne(m, lack);
            // 不可用的前置也记到条目上，供设置界面显示（loadOne 已在 error 里写了原因）
            if (lack.length) entry.missingDeps = lack;
            results.push(entry);
        }

        logLoadSummary(results);
        return results;
    }

    /** 插件状态的**中文说明** —— 日志与设置界面共用一份，避免两处说法不一致 */
    const STATE_LABEL = {
        ready: '已加载',
        disabled: '已关闭（未启用）',
        blocked: '已拒绝加载（前置插件不可用）',
        error: '加载失败',
        pending: '加载中',
    };

    /**
     * 打印加载结果汇总。
     *
     * ★ 为什么要把这段单独写好（2026-09 重做）：
     *   上一版打的是 `elaina-avatar=disabled galgame=ready pet=ready` ——
     *   那是**机器视角的键值对**：换个不知道本项目的 AI（或用户本人）
     *   看到这行，既不知道 `disabled` 是好是坏，也看不出
     *   "前置没启用、依赖它的却起来了"这个关键矛盾。
     *
     *   日志是给**排查问题的人（或 AI）**看的，不是给程序看的。所以改成：
     *     · 先一句话总结（几个可用、几个有问题）
     *     · 每个有问题的插件：名字 + 中文状态 + 具体原因 + **下一步该做什么**
     *     · 正常的插件只列名字，不刷屏
     *   这样即使把日志原样丢给一个完全不了解本项目的 AI，它也能读懂并给出建议。
     */
    function logLoadSummary(results) {
        const total = results.length;
        const ready = results.filter((e) => e.state === 'ready');
        const disabled = results.filter((e) => e.state === 'disabled');
        const broken = results.filter((e) => e.state !== 'ready' && e.state !== 'disabled');

        // ---- ① 一句话总结：先给结论 ----
        console.log('[Mod] 插件加载完成：共 ' + total + ' 个'
            + '，可用 ' + ready.length + ' 个'
            + (disabled.length ? '，未启用 ' + disabled.length + ' 个' : '')
            + (broken.length ? '，有问题 ' + broken.length + ' 个' : '')
            + '。');

        // ---- ② 可用的：只列名字 ----
        if (ready.length) {
            console.log('[Mod]   ✔ 可用：' + ready.map((e) => e.manifest.name || e.manifest.id).join('、'));
        }

        // ---- ③ 未启用的：说明这是正常的，并给开启方法 ----
        if (disabled.length) {
            console.log('[Mod]   ○ 未启用（这是正常的，插件默认关闭）：'
                + disabled.map((e) => e.manifest.name || e.manifest.id).join('、')
                + '\n        如需使用，到「设置 → 插件」打开对应开关。');
        }

        // ---- ④ 有问题的：这是重点，逐条给原因 + 下一步 ----
        if (broken.length) {
            for (const e of broken) {
                const label = STATE_LABEL[e.state] || e.state;
                const name = (e.manifest.name || e.manifest.id)
                    + (e.manifest.id !== (e.manifest.name || e.manifest.id) ? '（' + e.manifest.id + '）' : '');
                console.error('[Mod]   ✘ ' + name + '：' + label);
                if (e.error) console.error('[Mod]     ' + e.error);
            }
            console.error('[Mod] 以上插件不会生效。按上面每条给出的方法处理后，刷新页面重试。');
        }

        // ---- ⑤ 全部正常时明确说一句 ----
        //   为什么不省略：日志里"什么都没有"与"一切正常"在视觉上无法区分 ——
        //   用户会以为日志坏了（这个坑实际发生过）。
        if (!broken.length && !disabled.length) {
            console.log('[Mod]   全部正常。');
        }
    }

    /** 运行时启用/停用（停用只隐藏，不卸载脚本 —— 卸载需要整页刷新） */
    /**
     * 运行时启用 / 停用。
     *
     * ⚠️ 这里有个很容易漏的点：**mod 默认是关闭的，所以它的脚本从未被注入过**
     * （loadAll 只加载"已启用"的 mod）。如果启用时只改状态和 localStorage，
     * 用户会看到开关变成"已启用"、界面却没有任何反应 —— 而且刷新后才正常，
     * 看起来像"开关坏了"。
     *
     * 所以启用时必须判断：脚本还没加载（api 为空且不在 pendingRegistrations 里）
     * 就先走一遍加载流程。停用则只调 mod 自己的 setEnabled(false) 让它收起来
     * —— 已注入的脚本没法"卸载"，但停用后它不显示、不注册提示词，效果等价。
     */
    async function setEnabled(id, on) {
        const entry = registry.get(id);
        if (!entry) return false;
        setModEnabled(id, on);

        if (on) {
            // 还没加载过 → 现场加载（这样开关是"立即生效"，不需要刷新页面）
            //
            // 判据用"入口脚本是否已注入"而不是 api 是否为空：
            //   · 有些 mod 没有 register()，加载完 api 就是 null —— 用 api 判会误判成"没加载过"
            //   · 重复启用时不该重复注入脚本（<script> 会被再插一遍，mod 的初始化会跑两次）
            const entrySrc = entry.manifest.entry || 'index.js';
            // 与 loadOne 保持一致：走 modDir()，否则"已注入过没有"的判断会看错路径，
            // 导致重复注入脚本（mod 的初始化跑两次）
            const src = entrySrc.startsWith('/') ? entrySrc : MOD_ROOT + modDir(entry.manifest) + '/' + entrySrc;
            const neverLoaded = !loadedScripts.has(src);
            if (neverLoaded) {
                try {
                    await loadOne(entry.manifest);
                } catch (e) {
                    // loadOne 内部已经做了失败隔离，这里兜住它自己抛出的意外
                    const fresh = registry.get(id);
                    if (fresh) { fresh.state = 'error'; fresh.error = String((e && e.message) || e); }
                }
            } else if (typeof entry.api?.setEnabled === 'function') {
                try { entry.api.setEnabled(on); } catch (e) { /* mod 自己的开关失败不该影响宿主 */ }
            }
            // 注意：loadOne 会往 registry 里塞一个**新** entry 对象，
            // 所以这里必须重新取一次，不能继续用上面那个旧引用（否则读到过期的 state）
            const fresh = registry.get(id);
            if (fresh && fresh.state !== 'error') fresh.state = 'ready';
        } else {
            try {
                if (typeof entry.api?.setEnabled === 'function') entry.api.setEnabled(false);
            } catch (e) { /* 忽略 */ }
            entry.state = 'disabled';
        }

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
        /**
         * 插件脚本用它注册初始化函数：ElainaMods.register('galgame', (host) => ({...}))
         *
         * ★ 注册名就是插件的**权威身份**（依赖匹配、资源查找都以它为准）。
         *   这里同时记下"它来自哪个目录"（loadingDir）—— 这样即使目录名、
         *   manifest.id、注册名三者不一致，插件系统也能靠这张表把它们对上。
         *   见 regByDir 的说明。
         */
        register(id, factory) {
            const name = String(id);
            pendingRegistrations.set(name, factory);
            if (loadingDir) {
                regByDir.set(loadingDir, name);
                dirByReg.set(name, loadingDir);
            }
        },
        /**
         * 按注册名/清单 id/目录名中的**任意一个**查插件。
         *
         * 这是"路径与身份由插件系统统一管理"的入口：插件之间互相查找
         * （例如 galgame 找 elaina-avatar）不该靠拼字符串，而该问系统。
         * 三个键都试一遍，用户改了目录名也照样查得到。
         *
         * @returns {{id, dir, regName, state, entry}|null}
         */
        find(key) {
            const k = String(key || '');
            if (!k) return null;
            // ① 直接命中清单 id
            let entry = registry.get(k);
            // ② 命中注册名 → 反查它的目录 → 再取条目
            if (!entry) {
                const dir = dirByReg.get(k);
                if (dir) entry = [...registry.values()].find((e) => (e.manifest.dir || e.manifest.id) === dir);
            }
            // ③ 命中目录名
            if (!entry) entry = [...registry.values()].find((e) => (e.manifest.dir || e.manifest.id) === k);
            if (!entry) return null;
            return {
                id: entry.manifest.id,
                dir: entry.manifest.dir || entry.manifest.id,
                regName: entry.regName || entry.manifest.id,
                state: entry.state,
                entry,
            };
        },
        /** 取某个插件资源的 URL（按注册名/清单 id/目录名均可查，自动编码） */
        assetUrl(key, rel) {
            const found = window.ElainaMods.find(key);
            const dir = found ? found.dir : String(key || '');
            const r = String(rel || '').replace(/^\/+/, '');
            const enc = dir.split('/').map(encodeURIComponent).join('/');
            return MOD_ROOT + enc + '/' + r;
        },
        loadAll,
        /** 列出已发现的插件及其状态（供设置界面渲染） */
        list() {
            return [...registry.values()].map((e) => ({
                id: e.manifest.id,
                // dir / regName 都暴露出去：设置界面与宿主都要用真实目录，
                // 而不是拿 id 去猜（三者可能不一致，见 modDir 说明）
                dir: e.manifest.dir || e.manifest.id,
                regName: e.regName || e.manifest.id,
                name: e.manifest.name || e.manifest.id,
                version: e.manifest.version || '',
                description: e.manifest.description || '',
                state: e.state,
                error: e.error,
                enabled: isModEnabled(e.manifest.id, e.manifest),
                // hidden：公共依赖类插件（不提供界面，被其他插件共用）。
                // 设置界面用它加一句用途说明 —— 但**仍然给开关**：
                // 以前 hidden 的插件不给开关，一旦被禁用就无法从界面恢复，
                // 依赖它的插件会连带失效而用户找不到地方修（实测踩过）。
                hidden: e.manifest.hidden === true,
                // 不可用的前置插件（未安装 / 未启用 / 级联不可用）——
                // 这类插件会被**拒绝加载**，设置界面据此显示原因与下一步
                missingDeps: e.missingDeps || [],
            }));
        },
        setEnabled,
        /** 删插件时调用：清掉启用状态与已加载记录（避免重装后被自动启用） */
        forget: forgetMod,
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
