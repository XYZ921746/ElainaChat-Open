// 软件内日志查看器（AstrBot 风格分级系统的前端一半）。
//
// ── 目标（用户原话）─────────────────────────────────────────────────────
//
//   "控制台输出全部日志，然后软件内日志系统可以对日志进行分类，
//    分离掉不想看的信息" —— 之前没做好，这里补完。
//
// 数据源：GET /api/logs/tail（服务端内存缓冲，**全量**、不受落盘级别约束）。
// 过滤在服务端做（级别 / 模块 / 关键词），前端只负责展示与轮询。
//
// ── 为什么轮询而不是 WebSocket ──────────────────────────────────────────
// 服务端是零依赖的静态服务，没有 ws 升级层；日志查看是低频操作（打开设置才看），
// 2 秒轮询的代价可以忽略。引入 WS 栈只为这个功能不值得。
//
// 日志正文本身是英文（检索友好），这里的**界面文案**用中文（给人看）。
(function () {
    'use strict';

    // 级别徽标的配色（与 AstrBot 的级别色一致：debug 灰、info 绿、warn 黄、error/crit 红）
    const LEVEL_STYLE = {
        DEBUG: 'text-slate-400',
        DBUG: 'text-slate-400',
        INFO: 'text-emerald-400',
        WARN: 'text-amber-400',
        ERROR: 'text-red-400',
        ERRO: 'text-red-400',
        CRITICAL: 'text-red-300 font-bold',
        CRIT: 'text-red-300 font-bold',
    };
    // 模块名固定配色：一眼区分"谁在说话"
    const TAG_HUES = [210, 280, 30, 150, 330, 60, 180, 255];
    const tagColor = (tag) => {
        let h = 0;
        for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
        return `hsl(${TAG_HUES[h % TAG_HUES.length]} 70% 70%)`;
    };

    let timer = null;
    let lastTs = 0;          // 增量拉取：只取比这更新的
    let knownTags = new Set();

    const el = (id) => document.getElementById(id);

    function esc(s) {
        return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function fmtTime(ts) {
        const d = new Date(ts);
        const p = (n, w = 2) => String(n).padStart(w, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    }

    /** 一条记录 → 一行 HTML。级别/模块上色，正文保持原样。 */
    function renderEntry(e) {
        const lv = LEVEL_STYLE[e.level] || 'text-slate-300';
        const tg = tagColor(e.tag);
        return `<div class="hover:bg-white/5 rounded px-1">`
            + `<span class="text-slate-500">${fmtTime(e.ts)}</span> `
            + `<span class="${lv}">[${esc(e.level)}]</span> `
            + `<span style="color:${tg}">[${esc(e.tag)}]</span> `
            + `<span class="text-slate-300">${esc(e.message)}</span></div>`;
    }

    async function refresh(full) {
        const box = el('logViewerBox');
        if (!box) return;
        try {
            const level = el('logViewerLevel')?.value || '';
            const tag = el('logViewerTag')?.value || '';
            const search = el('logViewerSearch')?.value?.trim() || '';
            // 首次 / 换过滤条件：全量拉（最多 500 条）；否则增量
            const params = new URLSearchParams();
            if (level) params.set('level', level);
            if (tag) params.set('tags', tag);
            if (search) params.set('search', search);
            if (!full && lastTs) { params.set('since', String(lastTs)); params.set('limit', '300'); }
            const res = await fetch('/api/logs/tail?' + params.toString(), { cache: 'no-store' });
            if (!res.ok) return;
            const json = await res.json();
            if (!json.ok) return;

            // 模块下拉框：把缓冲里出现过的模块补进去（只增不减）
            const tagSel = el('logViewerTag');
            if (tagSel && Array.isArray(json.tags)) {
                for (const t of json.tags) {
                    if (!knownTags.has(t)) {
                        knownTags.add(t);
                        const opt = document.createElement('option');
                        opt.value = t; opt.textContent = '模块: ' + t;
                        tagSel.appendChild(opt);
                    }
                }
            }

            const entries = json.entries || [];
            if (!entries.length && !full) return;   // 增量没有新东西，不动 DOM

            if (full) {
                // 全量：新→旧直接铺
                box.innerHTML = entries.map(renderEntry).join('') || '<div class="text-slate-500">（没有匹配的日志）</div>';
                box.scrollTop = 0;
            } else {
                // 增量：插到顶部
                if (entries.length) box.insertAdjacentHTML('afterbegin', entries.map(renderEntry).join(''));
            }
            // 记录本次拉到的最新时间戳（entries[0] 是最新的）
            if (entries.length) lastTs = entries[0].ts;

            const meta = el('logViewerMeta');
            if (meta) {
                const shown = full
                    ? entries.length
                    : ('+' + entries.length);
                meta.textContent = `内存缓冲 ${json.total} 条`
                    + (json.dropped ? `（已滚动丢弃 ${json.dropped} 条旧记录）` : '')
                    + ` · 当前显示 ${shown} 条`
                    + ' · 日志正文为英文（便于检索），完整历史在 data/logs/ 下的日志文件里';
            }
        } catch (e) { /* 服务端不在（APK 场景）时整个 section 已被隐藏 */ }
    }

    function start() {
        if (timer) return;
        timer = setInterval(() => {
            const section = el('logViewerSection');
            // 不可见或面板收起时不再轮询（省电；也避免后台积累无意义请求）
            if (!section || section.classList.contains('hidden') || !el('logViewerAuto')?.checked) return;
            refresh(false);
        }, 2000);
    }

    function bind() {
        const section = el('logViewerSection');
        if (!section) return false;
        el('logViewerRefresh')?.addEventListener('click', () => refresh(true));
        for (const id of ['logViewerLevel', 'logViewerTag']) {
            el(id)?.addEventListener('change', () => refresh(true));
        }
        // 关键词：输入停顿 400ms 再拉，避免每敲一个字符都打一次接口
        let debounce = null;
        el('logViewerSearch')?.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => refresh(true), 400);
        });
        el('logViewerAuto')?.addEventListener('change', (ev) => {
            if (ev.target.checked) refresh(true);
        });
        return true;
    }

    // 暴露给 app-06-settings：面板被打开时调用（做首次全量加载）
    window.LogViewer = {
        show() {
            const section = el('logViewerSection');
            if (!section) return;
            section.classList.remove('hidden');
            if (!bind()) return;
            refresh(true);
            start();
        },
    };
})();
