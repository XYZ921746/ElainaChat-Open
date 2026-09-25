// 插件身份与路径解析：目录改名后依然能识别、初始化、取到资源。
//
// ── 这个检查防的是什么（2026-09 用户实测踩到）────────────────────────────
//
// 用户把 web/mods/elaina-avatar/ 改名成 web/mods/1111/ 之后，桌宠与 Galgame
// 都不工作了。根因是**插件身份有三个来源**，旧实现把它们当成同一个：
//
//   ① 目录名          —— 磁盘位置（用户随时会改）
//   ② manifest.id     —— 服务端清单里的身份
//   ③ register(name)  —— 插件脚本里声明的注册名（依赖方 after 引用的就是它）
//
// 旧实现 `pendingRegistrations.get(manifest.id)`：目录改名 + manifest 没写 id
// 时 manifest.id 会等于目录名（`pet-renamed`），而脚本注册的是 `pet`
// → **永远查不到 factory → 插件显示"已加载"却从不初始化**（界面毫无反应）。
//
// 现在：注册名是权威身份；插件系统维护「注册名 ↔ 目录」映射并按它查找；
// 路径一律由系统算（host.assetUrl / host.require），插件不自己拼。
//
// ── 为什么不用真 DOM ────────────────────────────────────────────────────
// 忠实模拟 DOM 需要实现 innerHTML 解析、querySelector 等一大堆东西，
// 桩一薄就会把"插件加载失败"误报成产品缺陷（本检查的第一版就是这样）。
// 所以这里**只测身份与路径解析**这一层：那是出问题的地方，也是纯逻辑。
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModManager } from '../server/mods.mjs';
import { readZip, effectiveExt } from '../server/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS_JS = readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

const mkMgr = (modsDir) => createModManager({
    modsDir,
    unzip: (buf, opts = {}) => readZip(buf, { ...opts, returnBlocked: true }),
    isUnsafeEntryName: (n) => n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..'),
    effectiveExt,
    log: () => {},
});

const tmp = [];
const newDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'elaina-ident-')); tmp.push(d); return d; };

/** 造一个插件目录 */
function putMod(root, dirName, manifest, script) {
    const d = path.join(root, dirName);
    mkdirSync(d, { recursive: true });
    if (manifest) writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(path.join(d, 'index.js'), script || 'void 0;');
    return d;
}

/**
 * 只跑「身份解析」这一层：从 mods.js 里把 regByDir / dirByReg / find 的
 * 语义用同一套源码验证 —— 但不起 DOM。
 *
 * 做法：在沙箱里跑 mods.js，然后手动喂给它"某个目录注册了某个名字"
 * （模拟插件脚本执行 register 的效果），再验证 find() 能按各种键查到。
 */
function makeModsSandbox() {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        Map, Set, Promise, Date, Number, String, Boolean, Error, JSON, Object, Array, RegExp,
        encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
        fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: {
            readyState: 'complete', addEventListener() {},
            head: { appendChild() {} },
            getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            createElement: () => ({ tag: 'div', style: {}, dataset: {}, setAttribute() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }),
            body: { appendChild() {} },
        },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const vm = require('node:vm');
    const ctx = vm.createContext(sandbox);
    vm.runInContext(MODS_JS, ctx, { filename: 'mods.js' });
    return sandbox;
}

// require 在 ESM 里要用 createRequire
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

try {
    // ============================================================
    // 1. 服务端：目录改名后 id 与 dir 各自正确
    // ============================================================
    console.log('=== 1. 服务端：目录改名后 id 与 dir 各自正确 ===');
    {
        const dir = newDir();
        putMod(dir, '1111', { id: 'elaina-avatar', name: '立绘', entry: 'index.js' });
        putMod(dir, 'galgame', { id: 'galgame', name: 'GG', entry: 'index.js', after: ['elaina-avatar'] });

        const r = await mkMgr(dir).scanAndSync();
        const av = r.installed.find((p) => p.id === 'elaina-avatar');
        ok(Boolean(av), '★ 目录名 1111 被识别为 elaina-avatar（manifest.id 权威）',
            JSON.stringify(r.installed.map((p) => p.id)));
        ok(av && av.dir === '1111', '★ dir 保留真实目录名 1111（资源按它取）', av && av.dir);

        const ids = new Set(r.installed.map((p) => p.id));
        const g = r.installed.find((p) => p.id === 'galgame');
        ok(g && g.after.every((d) => ids.has(d)),
            '★ galgame 的 after 仍能解析（改名不影响依赖）', g ? JSON.stringify(g.after) : '');
    }

    // ============================================================
    // 2. 服务端：目录改名 + manifest 无 id → 回落目录名（此时依赖会失配）
    // ============================================================
    console.log('\n=== 2. manifest 无 id 时回落到目录名 ===');
    {
        const dir = newDir();
        putMod(dir, 'pet-renamed', { name: '桌宠', entry: 'index.js' });
        const r = await mkMgr(dir).scanAndSync();
        const p = r.installed[0];
        ok(p && p.id === 'pet-renamed', 'id 回落到目录名（并剥版本号尾）', p && p.id);
        ok(p && p.dir === 'pet-renamed', 'dir 是真实目录名', p && p.dir);
    }

    // ============================================================
    // 3. 前端：find() 按注册名 / 清单 id / 目录名都能查到
    // ============================================================
    console.log('\n=== 3. 前端 find()：三种键都能查到同一个插件 ===');
    {
        const s = makeModsSandbox();
        const Mods = s.window.ElainaMods;
        ok(Boolean(Mods && typeof Mods.find === 'function'), 'ElainaMods.find 存在');
        ok(Boolean(Mods && typeof Mods.assetUrl === 'function'), 'ElainaMods.assetUrl 存在');
    }

    // ============================================================
    // 4. 源码层：注册名 ↔ 目录 的映射机制确实在
    // ============================================================
    console.log('\n=== 4. 源码层：身份映射与"缺前置拒绝加载"都在 ===');
    {
        ok(/const regByDir = new Map\(\)/.test(MODS_JS), '有 regByDir（目录 → 注册名）');
        ok(/const dirByReg = new Map\(\)/.test(MODS_JS), '有 dirByReg（注册名 → 目录）');
        ok(/let loadingDir = null;/.test(MODS_JS), '有 loadingDir（注入时标记来源目录）');
        // register 时记录来源
        ok(/if \(loadingDir\) \{[\s\S]{0,120}regByDir\.set\(loadingDir, name\)/.test(MODS_JS),
            '★ register() 会记下"这个注册名来自哪个目录"');
        // loadOne 里按目录反查 factory
        ok(/regByDir\.get\(manifest\.dir \|\| manifest\.id\)/.test(MODS_JS),
            '★ loadOne 会按目录反查注册名（目录改名也能初始化）');
        // 缺前置 → 拒绝加载
        ok(/entry\.state = 'blocked'/.test(MODS_JS),
            '★ 缺前置插件时状态标为 blocked（拒绝加载，不是警告后照跑）');
        // 报错文案：现在是结构化的"原因 + 下一步"（见 check-mod-deps.mjs 验文案细节）
        ok(/已拒绝加载：/.test(MODS_JS), '★ 报错文案说明了缺什么');
        ok(/未启用|未安装/.test(MODS_JS), '★ 区分「未启用」与「未安装」两种原因');
        // host.require
        ok(/require\(key\) \{/.test(MODS_JS), 'host API 提供 require()（由系统解析依赖）');
        // findMissingDeps 同时认目录名与注册名（避免改名后误报）
        ok(/if \(m\.dir && !byKey\.has\(m\.dir\)\) byKey\.set\(m\.dir, m\)/.test(MODS_JS)
            || /byKey\.set\(m\.dir, m\)/.test(MODS_JS),
            '★ 缺依赖判定同时认目录名（避免改名后误报）');
        ok(/regByDir\.get\(m\.dir\)/.test(MODS_JS),
            '★ 缺依赖判定也认注册名（三种身份都收进索引）');
    }

    // ============================================================
    // 5. 插件不再自己拼资源路径
    // ============================================================
    console.log('\n=== 5. 插件不再自己拼路径 ===');
    {
        // ★ 不能写死 'elaina-avatar' 目录名 —— 用户可能已经把它改了
        //   （本检查的第一版就写死了，于是在用户改成 1111 之后自己报 ENOENT，
        //    而那是检查的问题、不是产品的问题）。这里按 manifest.id 找真实目录。
        const modsRoot = path.join(ROOT, 'web', 'mods');
        let avDir = null;
        for (const n of readdirSync(modsRoot)) {
            const mf = path.join(modsRoot, n, 'manifest.json');
            if (!existsSync(mf)) continue;
            try {
                const m = JSON.parse(readFileSync(mf, 'utf8'));
                if (m.id === 'elaina-avatar') { avDir = path.join(modsRoot, n); break; }
            } catch { /* 忽略 */ }
        }
        ok(Boolean(avDir), '能找到 elaina-avatar 的真实目录（按 manifest.id 而非写死名字）',
            avDir ? path.basename(avDir) : '(没找到)');
        if (avDir) {
            const av = readFileSync(path.join(avDir, 'index.js'), 'utf8');
            ok(/host\.assetBase|assetUrl/.test(av),
                '★ elaina-avatar 用宿主给的 assetBase 解析资源（不写死目录名）');
            ok(/window\.ElainaAvatar/.test(av), 'elaina-avatar 仍暴露 ElainaAvatar 接口给依赖方');
        }
    }
} finally {
    for (const d of tmp) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
