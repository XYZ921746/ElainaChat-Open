// 回归检查：mod（插件）系统 —— 服务端扫描 / 自动解压 / 清单生成 / 安全防护。
//
// 为什么必须常驻：mod 系统是**同源执行第三方 JS** 的入口，和我们修过的
// `.html::$DATA` 存储型 XSS 属同一类风险面。而且它有几个很容易回归的点：
//
//   · 路径穿越：zip 里写 `../../web/serve.mjs` 就能覆盖宿主代码
//   · 卸载不彻底：只删目录不删 zip，scanAndSync 会立刻把它装回来
//     （这个 bug 是端到端测试抓到的：断言"目录已删除"时发现它又回来了）
//   · allowScripts 开关：mod 的本质是 JS，但 unzip 的默认黑名单会拦掉 .js
//     （那是为 Live2D 模型设计的）。忘了传 allowScripts 会得到
//     "只装了 manifest.json、插件跑不起来"的怪现象
//
// 用法：node scripts/check-mods.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(ROOT, 'web', 'mods');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

const freePort = () => new Promise((res, rej) => {
    const s = createNetServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 手工构造 ZIP（store 方式，零依赖）—— 测试不该依赖外部打包工具 */
function makeZip(entries) {
    const crcTable = (() => {
        const t = new Int32Array(256);
        for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
        return t;
    })();
    const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
    const chunks = [], central = [];
    let offset = 0;
    for (const [name, content] of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const data = Buffer.from(content, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        chunks.push(local, nameBuf, data);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(offset, 42);
        central.push(cd, nameBuf);
        offset += local.length + nameBuf.length + data.length;
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ============================================================ 1. 源码检查
console.log('=== 1. 关键实现存在且语义正确 ===');
{
    const mods = readFileSync(path.join(ROOT, 'server', 'mods.mjs'), 'utf8');
    const serve = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');
    const loader = readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');

    ok(/export function createModManager/.test(mods), 'server/mods.mjs 导出 createModManager');
    ok(/function scanAndSync/.test(mods), '有 scanAndSync（扫描目录 + 解压 + 生成清单）');
    ok(/function uninstall/.test(mods), '有 uninstall');
    ok(/MOD_ID_RE/.test(mods), '插件名有白名单校验（挡 .. 与绝对路径）');

    // ★ allowScripts：mod 的本质是 JS，但 unzip 默认黑名单含 .js
    ok(/allowScripts:\s*true/.test(mods), '★ 解压 mod 时传 allowScripts:true（否则 .js 会被拦掉）');
    ok(/allowScripts/.test(serve), 'serve.mjs 的 unzip 支持 allowScripts 选项');
    ok(/SCRIPT_EXTS/.test(serve), '脚本类扩展名被单独识别');

    // ★ 卸载要连 zip 一起删
    ok(/id \+ ext/.test(mods) || /\.zip/.test(mods.split('function uninstall')[1] || ''),
        '★ 卸载时连安装包一起删（否则 scanAndSync 会把它装回来）');

    ok(/ElainaMods/.test(loader), '加载器挂在 window.ElainaMods');
    ok(/function discover/.test(loader), '有 discover（读 index.json 清单）');
    ok(/sortByDependency/.test(loader), '有依赖排序（manifest.after）');
    ok(/依赖成环/.test(loader), '检测环形依赖（不死循环）');
    ok(/失败隔离|已隔离/.test(loader), '加载失败会隔离（不拖垮整个应用）');
    ok(/register\(/.test(loader), '提供 register（mod 脚本注册初始化函数）');
    ok(/setPromptHint|promptHints/.test(loader), '提供 system 提示词注入入口（Galgame 场景切换要用）');

    // 宿主接线
    const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    ok(/<script src="\/js\/mods\.js"><\/script>/.test(html), 'index.html 引入了 mods.js');
    const iMods = html.indexOf('/js/mods.js');
    const iInit = html.indexOf('/js/app-07-init.js');
    ok(iMods > 0 && iInit > 0 && iMods < iInit, '★ mods.js 排在 app-07-init.js 之前（初始化要读清单）');
}

// ============================================================ 2. 端到端
console.log('\n=== 2. 端到端：扫描 / 解压 / 安全 / 卸载 ===');

mkdirSync(MODS, { recursive: true });

// 正常 mod
writeFileSync(path.join(MODS, 'demo-mod.zip'), makeZip([
    ['demo-mod/manifest.json', JSON.stringify({ name: '演示插件', version: '1.0.0', entry: 'index.js', styles: ['style.css'] })],
    ['demo-mod/index.js', 'window.ElainaMods && window.ElainaMods.register("demo-mod", function(h){ return {}; });'],
    ['demo-mod/style.css', '.demo{color:red}'],
]));
// 恶意 mod：路径穿越 + 本机可执行
writeFileSync(path.join(MODS, 'evil-mod.zip'), makeZip([
    ['evil-mod/manifest.json', JSON.stringify({ name: '恶意' })],
    ['evil-mod/index.js', 'console.log("x")'],
    ['evil-mod/../../web/serve.mjs', 'HACKED'],
    ['evil-mod/../../web/index.html', 'HACKED'],
    ['evil-mod/bad.exe', 'MZ'],
]));

const PORT = await freePort();
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-mod-data-'));
const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-mod-log-'));
const serveBefore = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');
const htmlBefore = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, LOG_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

try {
    let up = false;
    for (let i = 0; i < 75; i++) {
        try { const r = await fetch(`http://127.0.0.1:${PORT}/api/server-info`); if (r.status) { up = true; break; } }
        catch { await wait(200); }
    }
    ok(up, '服务已启动', up ? '' : out.slice(-400));

    if (up) {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/plugins`);
        const body = await res.json();
        ok(res.status === 200 && body.ok, 'GET /api/plugins 成功', 'HTTP ' + res.status);

        const ids = (body.plugins || []).map((p) => p.id);
        ok(ids.includes('demo-mod'), '★ zip 被自动解压成 mod');
        ok(ids.includes('elaina-avatar'), '已存在的目录 mod 被识别');

        const demo = (body.plugins || []).find((p) => p.id === 'demo-mod');
        ok(demo && demo.name === '演示插件', 'manifest.json 被正确读取', demo && demo.name);
        ok(demo && demo.entry === 'index.js', 'entry 字段生效');
        ok(demo && Array.isArray(demo.styles) && demo.styles.includes('style.css'), 'styles 字段生效');

        const evil = (body.installResults || []).find((r) => r.zip === 'evil-mod.zip');
        ok(Boolean(evil), '恶意 zip 有安装结果回报');

        // ★ 路径穿越必须无效
        ok(readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8') === serveBefore, '★ serve.mjs 未被路径穿越覆盖');
        ok(readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8') === htmlBefore, '★ index.html 未被路径穿越覆盖');
        ok(!existsSync(path.join(MODS, 'evil-mod', 'bad.exe')), '★ .exe 被拦下（不落盘）');
        ok(evil && evil.ok && evil.files === 2, '恶意 zip 只装进 2 个合法文件（穿越/可执行被拦）',
            evil ? 'files=' + evil.files : '');
        ok(existsSync(path.join(MODS, 'evil-mod', 'index.js')), '★ mod 的 index.js 允许落盘（mod 本质就是代码）');

        // 清单
        const idx = JSON.parse(readFileSync(path.join(MODS, 'index.json'), 'utf8'));
        ok(Array.isArray(idx.plugins), 'index.json 被重新生成');
        ok(idx.plugins.some((p) => p.id === 'demo-mod'), '清单里含新装的 mod');

        // 卸载
        const del = await fetch(`http://127.0.0.1:${PORT}/api/plugins/demo-mod`, { method: 'DELETE' });
        ok(del.status === 200, 'DELETE 卸载成功', 'HTTP ' + del.status);
        ok(!existsSync(path.join(MODS, 'demo-mod')), '★ mod 目录已被删除');
        ok(!existsSync(path.join(MODS, 'demo-mod.zip')), '★ 安装包也被删除（否则会被重新装回来）');

        // 静态资源
        ok((await fetch(`http://127.0.0.1:${PORT}/mods/elaina-avatar/img/p_calm.png`)).status === 200,
            'mod 立绘可经静态服务访问');
        ok((await fetch(`http://127.0.0.1:${PORT}/mods/index.json`)).status === 200, 'mod 清单可被前端读取');
        ok((await fetch(`http://127.0.0.1:${PORT}/js/mods.js`)).status === 200, 'mod 加载器脚本可被加载');
    }
} finally {
    child.kill();
    await wait(300);
    // 清理：测试不该在仓库里留痕
    for (const f of ['demo-mod.zip', 'evil-mod.zip']) rmSync(path.join(MODS, f), { force: true });
    for (const d of ['demo-mod', 'evil-mod']) rmSync(path.join(MODS, d), { recursive: true, force: true });
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(LOG_DIR, { recursive: true, force: true });
    try {
        const idx = JSON.parse(readFileSync(path.join(MODS, 'index.json'), 'utf8'));
        idx.plugins = (idx.plugins || []).filter((p) => !/^(demo|evil)-mod$/.test(p.id));
        writeFileSync(path.join(MODS, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
    } catch { /* 忽略 */ }
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
