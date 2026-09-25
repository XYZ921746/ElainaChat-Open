// 端到端：真实服务 + 真实 zip 安装，验证用户报的两个症状都修好了。
//
// 用临时 MODS_DIR 不可行（serve.mjs 写死 web/mods），所以这里：
//   ① 先在临时目录里用真实的 createModManager 走"装带版本号的 zip"这条链
//   ② 再起真实服务，对真实的 web/mods 断言清单与资源可达
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModManager } from '../server/mods.mjs';
import { readZip, createZip, effectiveExt } from '../server/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

const tmp = [];
const newDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'e2e-')); tmp.push(d); return d; };

const mkMgr = (modsDir) => createModManager({
    modsDir,
    unzip: (buf, opts = {}) => readZip(buf, { ...opts, returnBlocked: true }),
    isUnsafeEntryName: (n) => n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..'),
    effectiveExt,
    log: () => {},
});

try {
    // ============================================================
    // 第一部分：安装链 —— 模拟用户从 Releases 下载带版本号的 zip 丢进 mods/
    // ============================================================
    console.log('=== 1. 用户下载 elaina-avatar-1.0.0.zip 丢进 mods/ ===');
    const modsDir = newDir();
    const zip = createZip([
        { name: 'manifest.json', data: Buffer.from(JSON.stringify({
            id: 'elaina-avatar', name: '伊蕾娜立绘与情绪', version: '1.0.0',
            entry: 'index.js', defaultEnabled: true, hidden: true,
        }), 'utf8') },
        { name: 'index.js', data: Buffer.from(
            'window.ElainaMods&&window.ElainaMods.register("elaina-avatar",function(host){'
            + 'if(host&&host.assetBase)window.__base=host.assetBase();return{};});', 'utf8') },
        { name: 'img/p_calm.png', data: Buffer.from('PNGDATA') },
    ]);
    writeFileSync(path.join(modsDir, 'elaina-avatar-1.0.0.zip'), zip);

    const mgr = mkMgr(modsDir);
    const r1 = await mgr.scanAndSync();

    const dirs = readdirSync(modsDir).filter((n) => !n.endsWith('.zip') && n !== 'index.json');
    ok(dirs.includes('elaina-avatar'), '★ 装成 elaina-avatar/（不是 elaina-avatar-1.0.0/）', JSON.stringify(dirs));
    ok(!dirs.includes('elaina-avatar-1.0.0'), '★ 没有留下带版本号的目录');
    const av = r1.installed.find((p) => p.id === 'elaina-avatar');
    ok(Boolean(av), '清单里 id 是 elaina-avatar');
    ok(av && av.dir === 'elaina-avatar', 'dir 与实际目录一致', av && av.dir);

    // 资源 URL（插件内部约定路径）能对上
    ok(existsSync(path.join(modsDir, 'elaina-avatar', 'img', 'p_calm.png')),
        '★ 立绘落在 /mods/elaina-avatar/img/p_calm.png 对应位置（不再 404）');

    console.log('\n=== 2. 再装 galgame（依赖 elaina-avatar） ===');
    const gdir = path.join(modsDir, 'galgame');
    (await import('node:fs')).mkdirSync(gdir, { recursive: true });
    writeFileSync(path.join(gdir, 'manifest.json'), JSON.stringify({
        id: 'galgame', name: 'Galgame 界面', version: '1.0.0', entry: 'index.js',
        styles: ['style.css'], defaultEnabled: false, after: ['elaina-avatar'],
    }));
    writeFileSync(path.join(gdir, 'index.js'), 'void 0;');
    writeFileSync(path.join(gdir, 'style.css'), '/* x */');

    const r2 = await mgr.scanAndSync();
    const ids = new Set(r2.installed.map((p) => p.id));
    const g = r2.installed.find((p) => p.id === 'galgame');
    ok(ids.has('elaina-avatar'), '★ 依赖目标 elaina-avatar 在清单里');
    ok(g && g.after.every((d) => ids.has(d)),
        '★ galgame 的 after 能解析（依赖不再失效）', g ? JSON.stringify(g.after) : '');

    // ============================================================
    // 第二部分：真实服务 —— 对真实 web/mods 断言清单与资源可达
    // ============================================================
    console.log('\n=== 3. 真实服务的清单与资源 ===');
    const DATA_DIR = newDir();
    const LOG_DIR = newDir();
    const PORT = await freePort();
    const HTTPS_PORT = await freePort();
    const BASE = `http://127.0.0.1:${PORT}`;

    const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT),
            HOST: '127.0.0.1', DATA_DIR, LOG_DIR, LOG_TO_FILE: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    try {
        let up = false;
        for (let i = 0; i < 80 && !up; i++) {
            try { up = (await fetch(BASE + '/api/server-info')).ok; } catch { await wait(250); }
        }
        ok(up, '服务已启动', up ? '' : out.slice(-300));

        if (up) {
            const api = await (await fetch(BASE + '/api/plugins')).json();
            ok(api.ok === true, '/api/plugins 可用');
            const plugins = api.plugins || [];
            for (const p of plugins) {
                console.log(`      id=${String(p.id).padEnd(16)} dir=${String(p.dir).padEnd(16)} after=${JSON.stringify(p.after)}`);
            }

            const avP = plugins.find((p) => p.id === 'elaina-avatar');
            ok(avP && typeof avP.dir === 'string' && avP.dir.length > 0,
                '★ 清单带 dir 字段（前端按它加载脚本）', avP && avP.dir);

            const ids = new Set(plugins.map((p) => p.id));
            for (const dep of ['galgame', 'pet']) {
                const m = plugins.find((p) => p.id === dep);
                if (!m) { ok(false, `${dep} 在清单里`); continue; }
                ok(m.after.every((d) => ids.has(d)), `★ ${dep} 的 after 可解析`, JSON.stringify(m.after));
            }

            // 按 dir 拼 URL 能取到脚本（这是前端 loadOne 的真实路径）
            for (const p of plugins) {
                const url = `/mods/${p.dir}/${p.entry || 'index.js'}`;
                const r = await fetch(BASE + url);
                ok(r.status === 200, `★ ${url} → 200`, 'status=' + r.status);
            }

            // 立绘图片可达
            const img = await fetch(BASE + '/mods/elaina-avatar/img/p_calm.png');
            ok(img.status === 200, '★ 立绘 /mods/elaina-avatar/img/p_calm.png → 200', 'status=' + img.status);
            ok((img.headers.get('content-type') || '').startsWith('image/'),
                '返回图片类型', img.headers.get('content-type'));
        }
    } finally {
        child.kill();
        await wait(300);
    }
} finally {
    for (const d of tmp) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
