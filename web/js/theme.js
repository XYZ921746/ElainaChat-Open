/* ============================================================================
 * 主题系统
 *
 * ── 为什么不用"上游那份 theme-liquid.css" ────────────────────────────────
 *
 * 实测对比过：上游 theme-liquid.css（95KB）依赖它自己的 app.css（121KB）骨架 ——
 * 类名重合率只有 60.8%，上游独有 49 个类（sw-menu / sw-seg / sw-* 设置组件）
 * 和 32 个 lg-* 变量，在我们这套 HTML 里**根本不存在**。直接套用只会得到
 * 一堆无效规则 + 部分元素变色、部分不变，比不做还难看。
 *
 * ── 实际做法：变量 + 覆盖层 ──────────────────────────────────────────────
 *
 * 我们的界面有 408 处硬编码 Tailwind 颜色类（indigo 占 229）和 294 处 CSS 变量引用。
 * 两个事实决定了实现方式：
 *
 *   ① **光改变量不够** —— 大量颜色是类名写死的（text-indigo-800 等）。
 *   ② **Tailwind 是运行时 JIT** —— 它扫 DOM 生成样式并在运行时注入 <style>，
 *      注入位置在 <head> 末尾、晚于我们的样式表。所以覆盖规则必须
 *      用 `!important` 才能稳定压住它（靠选择器权重不够，因为它后注入）。
 *
 * 于是主题 = ① 覆盖一批 CSS 变量（管那些用了变量的地方）
 *            + ② 一批 `!important` 覆盖规则（管那些写死类名的地方）
 *
 * ── 主题清单 ─────────────────────────────────────────────────────────────
 *
 *   elaina   —— 现有粉紫样式（默认，保持原样不动）
 *   ios      —— 液态玻璃 · iOS 蓝（上游主视觉）
 *   claude   —— 液态玻璃 · 陶土橙
 *   sage     —— 液态玻璃 · 鼠尾草
 *   sakura   —— 液态玻璃 · 樱花桃
 *
 * 深色模式是**正交**的第二个维度：data-theme="dark" 叠在任意模板上。
 *
 * ── 与"不改现有功能"的关系 ───────────────────────────────────────────────
 *
 * 默认主题是 elaina（也就是现在的样子），所有覆盖规则都在
 * `html[data-theme-template="..."]` 之下 —— 不设这个属性时**一条都不生效**。
 * 所以不选主题的用户看到的东西与改动前逐像素一致。
 * ========================================================================== */

(function () {
    'use strict';

    const TPL_KEY = 'elaina_theme_template';
    const DARK_KEY = 'elaina_theme';

    /** 可选模板（顺序即设置里的显示顺序） */
    const TEMPLATES = [
        { id: 'elaina', name: '粉紫（默认）', dots: ['#ec4899', '#8b5cf6', '#fdf2f8'] },
        { id: 'ios', name: 'iOS 蓝', dots: ['#007aff', '#8ab4ff', '#eef1f5'] },
        { id: 'claude', name: '陶土橙', dots: ['#d97757', '#eab38f', '#f6f2ed'] },
        { id: 'sage', name: '鼠尾草', dots: ['#4f9d7d', '#9cc9b4', '#eef3ee'] },
        { id: 'sakura', name: '樱花桃', dots: ['#d97b93', '#f0b6c4', '#f8f1f3'] },
    ];

    // ========================================================================
    //  应用 / 读取
    // ========================================================================

    function currentTemplate() {
        try {
            const v = document.documentElement.getAttribute('data-theme-template')
                || localStorage.getItem(TPL_KEY) || 'elaina';
            return TEMPLATES.some((t) => t.id === v) ? v : 'elaina';
        } catch (e) { return 'elaina'; }
    }

    function setTemplate(id) {
        const tpl = TEMPLATES.some((t) => t.id === id) ? id : 'elaina';
        try {
            // elaina 是默认主题，**不设属性** —— 这样"没选过主题"与"选了粉紫"
            // 走的是同一条路径，不会因为属性存在与否产生细微差异
            if (tpl === 'elaina') document.documentElement.removeAttribute('data-theme-template');
            else document.documentElement.setAttribute('data-theme-template', tpl);
            localStorage.setItem(TPL_KEY, tpl);
        } catch (e) { /* 忽略 */ }
        markPicker();
        return tpl;
    }

    function isDark() {
        try { return document.documentElement.getAttribute('data-theme') === 'dark'; } catch (e) { return false; }
    }

    function setDark(on) {
        try {
            if (on) document.documentElement.setAttribute('data-theme', 'dark');
            else document.documentElement.removeAttribute('data-theme');
            localStorage.setItem(DARK_KEY, on ? 'dark' : 'light');
        } catch (e) { /* 忽略 */ }
        const btn = document.getElementById('themeDarkToggle');
        if (btn) btn.checked = !!on;
        return !!on;
    }

    /** 启动时尽早应用（避免闪一下默认色再切换） */
    function applyStored() {
        try {
            const dark = localStorage.getItem(DARK_KEY) === 'dark';
            if (dark) document.documentElement.setAttribute('data-theme', 'dark');
            const tpl = localStorage.getItem(TPL_KEY);
            if (tpl && tpl !== 'elaina' && TEMPLATES.some((t) => t.id === tpl)) {
                document.documentElement.setAttribute('data-theme-template', tpl);
            }
        } catch (e) { /* 忽略 */ }
    }

    // ========================================================================
    //  设置界面里的选择器
    // ========================================================================

    function markPicker() {
        const cur = currentTemplate();
        document.querySelectorAll('.theme-tpl-card').forEach((c) => {
            const on = c.getAttribute('data-tpl') === cur;
            c.classList.toggle('is-active', on);
            c.style.borderColor = on ? 'var(--color-primary)' : 'transparent';
        });
    }

    /**
     * 把主题选择器渲染进「设置 → 高级」里的容器。
     *
     * 为什么用 JS 渲染而不是写死在 HTML 里：模板清单是这一份数据，
     * 写死会出现"改了 TEMPLATES 但界面没变"。而且这样宿主 HTML 不用知道
     * 有几个主题。
     */
    function renderPicker() {
        const box = document.getElementById('themePickerBox');
        if (!box || box.dataset.filled === '1') return;
        box.dataset.filled = '1';
        box.innerHTML = TEMPLATES.map((t) => {
            const dots = t.dots.map((c) => '<span style="display:block;width:10px;height:10px;border-radius:50%;background:' + c + '"></span>').join('');
            return '<button type="button" class="theme-tpl-card" data-tpl="' + t.id + '" '
                + 'style="flex:0 0 auto;padding:8px 10px;border-radius:12px;border:2px solid transparent;'
                + 'background:rgba(255,255,255,.6);cursor:pointer;display:flex;flex-direction:column;gap:6px;align-items:center">'
                + '<span style="display:flex;gap:3px">' + dots + '</span>'
                + '<span style="font-size:11px;color:var(--text-body);white-space:nowrap">' + t.name + '</span>'
                + '</button>';
        }).join('');
        box.querySelectorAll('.theme-tpl-card').forEach((el) => {
            el.addEventListener('click', () => setTemplate(el.getAttribute('data-tpl')));
        });
        markPicker();
    }

    // ========================================================================
    //  对外接口
    // ========================================================================

    window.ElainaTheme = {
        TEMPLATES,
        templates: () => TEMPLATES.slice(),
        current: currentTemplate,
        set: setTemplate,
        isDark,
        setDark,
        applyStored,
        renderPicker,
        markPicker,
    };

    applyStored();
    // 设置面板可能是懒加载/后插入的，DOM 就绪后再填一次
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { renderPicker(); });
    } else {
        renderPicker();
    }
})();
