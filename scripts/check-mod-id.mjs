// 插件 id 归一化 + 依赖可解析性 —— 钉住「资源包装了等于没装」这个真 bug。
//
// ── 这个 bug 长什么样（2026-09 实测踩到）────────────────────────────────
//
//   pack-assets 的产物名带版本号（`elaina-avatar-1.0.0.zip`），而旧逻辑
//   直接拿 zip 文件名当插件 id → 装进 `mods/elaina-avatar-1.0.0/`。后果两条并发：
//     ① 插件内部写死的资源 URL（`/mods/elaina-avatar/img/…`）404
//        → 桌宠 / Galgame 显示不出人物；
//     ② galgame/pet 声明 `after: ["elaina-avatar"]` 匹配不上实际 id
//        → 依赖解析失效，加载顺序失去保证（ElainaAvatar 可能还没定义）。
//
//   为什么以前的测试没抓到：check-mods.mjs 测的是"目录已存在"的场景，
//   而**打包 → 安装**这条链是两个模块各自的假设拼起来的 ——
//   pack-assets 认为"文件名带版本号没问题"，mods.mjs 认为"文件名就是 id"，
//   各自都对，合起来就错。这个检查专门覆盖那条接缝。
//
// 覆盖：① 带版本号的产物名装完 id 与目录都对；② after 依赖能匹配；
//       ③ 修复前已装坏的目录仍能被识别（用户不用重装）；④ 不误伤正常名字。
//
// 本检查自己用 createZip 造包，**不依赖 dist/**（那是构建产物、且被 gitignore），
// 否则 CI 里没跑过 pack-assets 就会失败。
import { existsSync, rmSync, mkdtempSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModManager } from '../server/mods.mjs';
import { readZip, createZip, effectiveExt } from '../server/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/** 造一个插件 zip：根目录直接放文件（与 pack-assets 的 mod 格式一致） */
function makeModZip(entries) {
    return createZip(entries.map(([name, data]) => ({ name, data: Buffer.from(data, 'utf8') })));
}

/** 造一个带真实 PNG 字节的立绘条目（验证资源路径时不能只放文本） */
function avatarZip(version = '1.0.0', declaredId = 'elaina-avatar') {
    const manifest = JSON.stringify({
        id: declaredId, name: '伊蕾娜立绘与情绪', version,
        entry: 'index.js', defaultEnabled: true, hidden: true,
    });
    return makeModZip([
        ['manifest.json', manifest],
        ['index.js', 'window.ElainaMods && window.ElainaMods.register("elaina-avatar",function(){return{}});'],
        ['img/p_calm.png', 'PNGDATA'],
    ]);
}

const tmp = [];
const newDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'elaina-modid-')); tmp.push(d); return d; };

try {
    // ============ 1. 带版本号的 zip 名 → id 与目录都应归一化 ============
    console.log('=== 1. 装 elaina-avatar-1.0.0.zip（带版本号的产物名） ===');
    {
        const dir = newDir();
        writeFileSync(path.join(dir, 'elaina-avatar-1.0.0.zip'), avatarZip('1.0.0'));
        const r = await mkMgr(dir).scanAndSync();

        const ids = r.installed.map((p) => p.id);
        ok(ids.includes('elaina-avatar'), '★ 清单里的 id 归一化为 elaina-avatar', JSON.stringify(ids));

        const dirs = readdirSync(dir).filter((n) => !n.endsWith('.zip') && n !== 'index.json');
        ok(dirs.includes('elaina-avatar'), '★ 磁盘目录也装成 elaina-avatar（不是带版本号的）', JSON.stringify(dirs));

        const p = r.installed.find((x) => x.id === 'elaina-avatar');
        ok(p && p.dir === 'elaina-avatar', '清单里 dir 字段与实际目录一致', p && p.dir);

        // 资源能落在"约定 URL"对应的位置
        ok(existsSync(path.join(dir, 'elaina-avatar', 'img', 'p_calm.png')),
            '★ 立绘落在 /mods/elaina-avatar/img/p_calm.png 能取到的位置');
        ok(!existsSync(path.join(dir, 'elaina-avatar-1.0.0')),
            '★ 没有留下带版本号的目录（旧 bug 的形态）');
    }

    // ============ 2. after 依赖可解析 ============
    console.log('\n=== 2. galgame/pet 的 after 依赖能否匹配 ===');
    {
        const dir = newDir();
        writeFileSync(path.join(dir, 'elaina-avatar-1.0.0.zip'), avatarZip('1.0.0'));
        const mgr = mkMgr(dir);
        await mgr.scanAndSync();

        // galgame 以目录形式放进（它依赖 elaina-avatar）
        const gdir = path.join(dir, 'galgame');
        mkdirSync(gdir, { recursive: true });
        writeFileSync(path.join(gdir, 'manifest.json'), JSON.stringify({
            id: 'galgame', name: 'Galgame 界面', entry: 'index.js', after: ['elaina-avatar'],
        }));
        writeFileSync(path.join(gdir, 'index.js'), 'void 0;');

        const r2 = await mgr.scanAndSync();
        const ids = new Set(r2.installed.map((p) => p.id));
        ok(ids.has('elaina-avatar'), '★ elaina-avatar 在清单里（依赖能被解析到）', JSON.stringify([...ids]));
        ok(ids.has('galgame'), 'galgame 也在清单里');
        // 直接断言依赖声明与清单 id 对得上 —— 这正是旧实现失败的地方
        const g = r2.installed.find((p) => p.id === 'galgame');
        ok(g && g.after.every((d) => ids.has(d)),
            '★ galgame 声明的 after 全部能在清单里找到（依赖解析有效）',
            g ? JSON.stringify(g.after) : '');
    }

    // ============ 3. 兼容修复前已装坏的目录 ============
    console.log('\n=== 3. 兼容修复前已装坏的目录（elaina-avatar-1.0.0/） ===');
    {
        const dir = newDir();
        const old = path.join(dir, 'elaina-avatar-1.0.0');
        mkdirSync(path.join(old, 'img'), { recursive: true });
        writeFileSync(path.join(old, 'manifest.json'), JSON.stringify({
            id: 'elaina-avatar', name: '伊蕾娜立绘', entry: 'index.js',
        }));
        writeFileSync(path.join(old, 'index.js'), 'void 0;');
        writeFileSync(path.join(old, 'img', 'p_calm.png'), 'PNGDATA');

        const r = await mkMgr(dir).scanAndSync();
        const p = r.installed.find((x) => x.id === 'elaina-avatar');
        ok(Boolean(p), '★ 旧目录被识别为 elaina-avatar（id 归一化，用户不用重装）',
            JSON.stringify(r.installed.map((x) => x.id)));
        ok(p && p.dir === 'elaina-avatar-1.0.0',
            '★ 同时保留真实目录名（脚本/资源按它加载，不会 404）', p && p.dir);
        ok(existsSync(old), '★ 旧目录没有被删（用户数据/设置在它下面）');
    }

    // ============ 4. 不误伤正常名字 ============
    console.log('\n=== 4. 归一化不该误伤正常名字 ===');
    {
        const dir = newDir();
        // 这些名字里带数字，但**不是**版本号，必须原样保留
        for (const name of ['my-mod-2', 'mod2', 'plugin-v2', 'a-1']) {
            const d = path.join(dir, name);
            mkdirSync(d, { recursive: true });
            writeFileSync(path.join(d, 'index.js'), 'void 0;');
        }
        const r = await mkMgr(dir).scanAndSync();
        const ids = r.installed.map((x) => x.id);
        for (const name of ['my-mod-2', 'mod2', 'plugin-v2', 'a-1']) {
            ok(ids.includes(name), `★ ${name} 不被误剥（单段数字不是版本号）`, JSON.stringify(ids));
        }
    }

    // ============ 5. manifest.id 是权威来源 ============
    console.log('\n=== 5. manifest.id 优先于目录名 ===');
    {
        const dir = newDir();
        // 目录名是乱写的，manifest 里声明了真 id
        const d = path.join(dir, 'wrong-dir-name');
        mkdirSync(d, { recursive: true });
        writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({
            id: 'real-id', name: '真名', entry: 'index.js',
        }));
        writeFileSync(path.join(d, 'index.js'), 'void 0;');
        const r = await mkMgr(dir).scanAndSync();
        const p = r.installed[0];
        ok(p && p.id === 'real-id', '★ 清单 id 取 manifest.id（不是目录名）', p && p.id);
        ok(p && p.dir === 'wrong-dir-name', 'dir 字段仍是真实目录名（供加载脚本用）', p && p.dir);
    }

    // ============ 6. manifest.id 非法时必须回落，不能信任外部输入 ============
    console.log('\n=== 6. manifest.id 非法时回落到目录名（外部输入不可信） ===');
    {
        const dir = newDir();
        for (const [dirName, badId] of [['safe-dir', '../../etc/passwd'], ['safe-dir2', 'has space'], ['safe-dir3', '']]) {
            const d = path.join(dir, dirName);
            mkdirSync(d, { recursive: true });
            writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id: badId, name: 'x', entry: 'index.js' }));
            writeFileSync(path.join(d, 'index.js'), 'void 0;');
        }
        const r = await mkMgr(dir).scanAndSync();
        const ids = r.installed.map((x) => x.id).sort();
        ok(ids.includes('safe-dir') && ids.includes('safe-dir2') && ids.includes('safe-dir3'),
            '★ 非法 manifest.id 被拒，回落到目录名', JSON.stringify(ids));
        ok(!ids.some((x) => x.includes('..') || x.includes('/')),
            '★ 没有路径成分泄漏进 id', JSON.stringify(ids));
    }
} finally {
    for (const d of tmp) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
