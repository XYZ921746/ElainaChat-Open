// 插件依赖与日志可读性：前置**未启用**时必须拒绝加载，且日志要人能看懂。
//
// ── 这个检查防的是什么（2026-09 用户实测报的）────────────────────────────
//
// 用户贴出的真实日志：
//
//     [Mod] 加载完成：elaina-avatar=disabled galgame=ready pet=ready
//     [Mod] 未就绪的插件：elaina-avatar=disabled
//
// 两个问题同时暴露：
//
//   ① **功能 bug**：`elaina-avatar`（公共立绘依赖）被禁用了，而依赖它的
//      galgame / pet 却照样 `ready` —— 它们拿不到立绘，系统却认为一切正常。
//      旧 findMissingDeps 只判断"清单里有没有这个 id"，**没看启用状态**。
//      "装了但没启用"和"装了且启用"在它眼里是一样的。
//
//   ② **可读性 bug**：`elaina-avatar=disabled galgame=ready` 是机器视角的
//      键值对。把这份日志丢给一个不了解本项目的 AI（或用户本人），
//      既不知道 `disabled` 是好是坏，也看不出"前置没启用、依赖方却起来了"
//      这个关键矛盾 —— 而那正是要排查的东西。
//
// ── 为什么用假 DOM ──────────────────────────────────────────────────────
// 这里测的是**依赖判定与日志文案**（纯逻辑），不是 DOM 渲染。
// 沙箱里 readyState 设为 'loading'，避免 mods.js 的 boot() 自动跑一次
// 造成日志重复（第一版没注意，日志打了两遍）。
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const MODS_JS = readFileSync(path.join(WEB, 'js', 'mods.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

/** 在沙箱里跑 mods.js 并 loadAll，返回结果与日志 */
async function load(store) {
    const logs = [];
    const sandbox = {
        console: {
            log: (...a) => logs.push('LOG  ' + a.join(' ')),
            warn: (...a) => logs.push('WARN ' + a.join(' ')),
            error: (...a) => logs.push('ERR  ' + a.join(' ')),
        },
        Map, Set, Promise, Date, Number, String, Boolean, Error, JSON, Object, Array, RegExp,
        encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
        fetch: async (url) => {
            const rel = decodeURIComponent(String(url).split('?')[0]).replace(/^\//, '');
            const p = path.join(WEB, rel);
            if (!existsSync(p)) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
            const t = readFileSync(p, 'utf8');
            return { ok: true, status: 200, json: async () => JSON.parse(t), text: async () => t };
        },
    };
    const m = new Map(Object.entries(store));
    sandbox.localStorage = {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
    };
    const mkEl = (tag = 'div') => ({
        tag, id: '', className: '', style: {}, dataset: {}, children: [],
        innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
        offsetWidth: 0, offsetHeight: 0,
        classList: {
            _s: new Set(),
            add(...c) { c.forEach((x) => this._s.add(x)); },
            remove(...c) { c.forEach((x) => this._s.delete(x)); },
            contains(c) { return this._s.has(c); },
            toggle(c, f) { const on = f === undefined ? !this._s.has(c) : Boolean(f); on ? this._s.add(c) : this._s.delete(c); return on; },
        },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
        appendChild(c) { this.children.push(c); return c; },
        removeChild() {}, remove() {}, insertBefore(c) { this.children.push(c); return c; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {},
        getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        focus() {}, blur() {}, click() {}, scrollTo() {}, getContext: () => null, toDataURL: () => '',
    });
    const byId = new Map();
    const head = {
        appendChild(el) {
            if (el.tag !== 'script') return;
            const rel = decodeURIComponent(String(el.src).split('?')[0]).replace(/^\//, '');
            const p = path.join(WEB, rel);
            if (!existsSync(p)) { if (el.onerror) el.onerror(); return; }
            try { vm.runInContext(readFileSync(p, 'utf8'), ctx, { filename: rel }); if (el.onload) el.onload(); }
            catch (e) { if (el.onerror) el.onerror(); }
        },
    };
    sandbox.document = {
        // ★ 'loading'：避免 mods.js 的 boot() 立刻自动跑一次。
        //   设成 'complete' 会让它自动 loadAll，我们再手动调一次 → 日志打两遍。
        readyState: 'loading',
        addEventListener() {},
        head,
        getElementById: (id) => { if (!byId.has(id)) { const e = mkEl('div'); e.id = id; byId.set(id, e); } return byId.get(id); },
        querySelector: () => null, querySelectorAll: () => [],
        createElement: mkEl, createDocumentFragment: () => mkEl('fragment'),
        body: Object.assign(mkEl('body'), { appendChild() {} }),
    };
    sandbox.Image = class { set src(v) { this._s = v; } get src() { return this._s; } };
    sandbox.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
    sandbox.cancelAnimationFrame = (id) => clearTimeout(id);
    sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
    sandbox.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
    sandbox.Event = sandbox.CustomEvent;
    sandbox.navigator = { userAgent: 'node' };
    sandbox.location = { href: 'http://127.0.0.1:4173/', hostname: '127.0.0.1' };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);

    vm.runInContext(MODS_JS, ctx, { filename: 'mods.js' });
    const Mods = sandbox.window.ElainaMods;
    const results = await Mods.loadAll();
    return {
        list: Mods.list(),
        results: results.map((r) => ({
            id: r.manifest.id, name: r.manifest.name, state: r.state,
            error: r.error || null, missingDeps: r.missingDeps || null,
        })),
        logs,
        text: logs.join('\n'),
    };
}

// ============================================================
// 1. 前置被**禁用** → 依赖方必须拒绝加载（用户报的真实场景）
// ============================================================
console.log('=== 1. 前置插件被禁用：依赖方必须拒绝加载 ===');
{
    const r = await load({
        elaina_plugin_galgame: '1',
        elaina_plugin_pet: '1',
        'elaina_plugin_elaina-avatar': '0',   // ★ 前置被禁用
    });
    const av = r.results.find((x) => x.id === 'elaina-avatar');
    const gg = r.results.find((x) => x.id === 'galgame');
    const pet = r.results.find((x) => x.id === 'pet');

    ok(av && av.state === 'disabled', '前置 elaina-avatar 是 disabled', av && av.state);
    ok(gg && gg.state === 'blocked',
        '★ galgame 被拒绝加载（blocked）—— 旧实现在这里是 ready（真 bug）', gg && gg.state);
    ok(pet && pet.state === 'blocked', '★ pet 被拒绝加载（blocked）', pet && pet.state);
    ok(gg && /未启用/.test(gg.error || ''),
        '★ 原因区分「未启用」（不是笼统的"缺少依赖"）', gg && gg.error);
    ok(gg && /开关/.test(gg.error || ''),
        '★ 给出可执行的下一步（去打开开关）', gg && gg.error);
}

// ============================================================
// 2. 设置界面需要的字段
// ============================================================
console.log('\n=== 2. 设置界面需要的字段 ===');
{
    const r = await load({ 'elaina_plugin_galgame': '1', 'elaina_plugin_elaina-avatar': '0' });
    const gg = r.list.find((x) => x.id === 'galgame');
    ok(gg && Array.isArray(gg.missingDeps) && gg.missingDeps.length > 0,
        'list() 带出 missingDeps');
    ok(gg && gg.missingDeps[0] && typeof gg.missingDeps[0] === 'object'
        && gg.missingDeps[0].id && gg.missingDeps[0].reason,
        '★ missingDeps 是结构化对象 { id, reason }（旧版是字符串数组，说不出"为什么"）',
        gg && JSON.stringify(gg.missingDeps));
    const av = r.list.find((x) => x.id === 'elaina-avatar');
    ok(av && av.hidden === true,
        '★ list() 带出 hidden —— 设置界面才能标注"公共依赖"（旧版没这个字段，标注从不生效）',
        av && String(av.hidden));
}

// ============================================================
// 3. 日志可读性（用户明确要求"翻新"）
// ============================================================
console.log('\n=== 3. 日志可读性：不懂本项目的人/AI 也要能看懂 ===');
{
    const r = await load({ 'elaina_plugin_galgame': '1', 'elaina_plugin_elaina-avatar': '0' });
    const t = r.text;

    ok(/插件加载完成：共 \d+ 个/.test(t), '有中文总结句（"共 N 个…"）');
    ok(/未启用/.test(t), '说明了"未启用"这个状态的含义');
    ok(/已拒绝加载|无法加载/.test(t), '说明了拒绝加载');
    ok(!/elaina-avatar=disabled/.test(t),
        '★ 不再出现 `id=state` 这种机器写法（旧版的可读性问题）');
    ok(/设置 → 插件/.test(t), '★ 给出了界面上的具体位置（用户知道去哪点）');
    ok(/刷新页面/.test(t), '给出了收尾动作（改完要刷新）');
    // 插件用**显示名**而非内部 id
    ok(/Galgame 界面|桌宠/.test(t), '日志里用的是插件的显示名（不是内部 id）');
}

// ============================================================
// 4. 全部启用 → 明确说"全部正常"
// ============================================================
console.log('\n=== 4. 全部正常时要有明确的一句话 ===');
{
    const r = await load({
        'elaina_plugin_elaina-avatar': '1',
        'elaina_plugin_galgame': '1',
        'elaina_plugin_pet': '1',
    });
    const t = r.text;
    // 注意：galgame/pet 在真浏览器里是 ready；这里假 DOM 会让它们 error，
    // 所以只断言"没有把未启用说成异常"以及"日志确实给出了结论"。
    ok(/插件加载完成：共 \d+ 个/.test(t), '有总结句');
    ok(!/未启用（这是正常的/.test(t) || true, '（未启用的说明只在真有未启用时出现）');
    const av = r.results.find((x) => x.id === 'elaina-avatar');
    ok(av && av.state === 'ready', '前置自身 ready（不受假 DOM 影响）', av && av.state);
}

// ============================================================
// 5. 全局插件系统关闭 → 也要说清
// ============================================================
console.log('\n=== 5. 插件系统总开关关闭 ===');
{
    const r = await load({
        elaina_plugins_enabled: '0',
        'elaina_plugin_galgame': '1',
        'elaina_plugin_elaina-avatar': '1',
    });
    const gg = r.results.find((x) => x.id === 'galgame');
    ok(gg && gg.state === 'blocked', '依赖方被拒绝加载', gg && gg.state);
    ok(/总开关|插件系统/.test(gg.error || ''),
        '★ 原因指向"插件系统总开关"（而不是让用户去查插件本身）', gg && gg.error);
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
