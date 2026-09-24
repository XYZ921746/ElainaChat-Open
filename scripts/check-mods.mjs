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
    // 解压实现已合并到 server/zip.mjs（原先 serve.mjs 里另有一份几乎相同的 unzip）。
    // 所以 BLOCKED_EXT / effectiveExt / allowScripts 这些要看**实现那份**，
    // 不能再断言它们在 serve.mjs 里 —— 那是合并前的布局。
    const zip = readFileSync(path.join(ROOT, 'server', 'zip.mjs'), 'utf8');

    ok(/export function createModManager/.test(mods), 'server/mods.mjs 导出 createModManager');
    ok(/function scanAndSync/.test(mods), '有 scanAndSync（扫描目录 + 解压 + 生成清单）');
    ok(/function uninstall/.test(mods), '有 uninstall');
    ok(/MOD_ID_RE/.test(mods), '插件名有白名单校验（挡 .. 与绝对路径）');

    // ★ allowScripts：mod 的本质是 JS，但解压默认黑名单含 .js
    ok(/allowScripts:\s*true/.test(mods), '★ 解压 mod 时传 allowScripts:true（否则 .js 会被拦掉）');
    ok(/allowScripts/.test(zip), '★ server/zip.mjs 的 readZip 支持 allowScripts 选项');
    ok(/SCRIPT_EXTS/.test(zip), '脚本类扩展名被单独识别');
    // 合并后的单一实现：serve.mjs 不该再有自己那份 unzip
    ok(!/^function unzip\(/m.test(serve) || /readZip\(buf, \{ \.\.\.opts, returnBlocked: true \}\)/.test(serve),
        '★ 解压实现只有一份（serve.mjs 只保留薄包装，不再自带完整实现）');
    ok(/from '\.\.\/server\/zip\.mjs'/.test(serve), 'serve.mjs 从 zip.mjs 引入解压实现');

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

    // ---- 宿主消费 mod 提示词（Galgame 场景指令送达模型的必经路径）----
    const data = readFileSync(path.join(ROOT, 'web', 'js', 'app-02-data.js'), 'utf8');
    ok(/ElainaMods/.test(data) && /collectPromptHints/.test(data),
        '★ 宿主在构造提示词时消费 mod 注入的 system 片段');

    // ---- 设置 → 插件分栏 ----
    ok(/data-settings-tab="tab-mods"/.test(html), '设置里有「插件」Tab');
    ok(/id="tab-mods"/.test(html), '有 #tab-mods 面板');
    ok(/id="modsList"/.test(html), '有 mod 列表容器');
    ok(/id="modsGlobalToggle"/.test(html), '有全局开关');
    const settings = readFileSync(path.join(ROOT, 'web', 'js', 'app-06-settings.js'), 'utf8');
    ok(/async function refreshModsList/.test(settings), '有 refreshModsList');
    ok(/\/api\/plugins/.test(settings), '列表数据来自服务端 /api/plugins');
    ok(/ElainaMods\.list\(\)/.test(settings), '同时合并前端加载状态（服务端只知道磁盘上有什么）');
    ok(/加载失败/.test(settings), '★ 加载失败的 mod 有显眼标记（否则用户以为"开了没反应"）');
    ok(/公共依赖/.test(settings), '★ hidden 的 mod 显示为「公共依赖」而非开关');
}

// ============================================================ 1.5 两个 mod 本体
console.log('\n=== 1.5 Galgame 与桌宠（本体与共用层） ===');
{
    const galPath = path.join(ROOT, 'web', 'mods', 'galgame', 'index.js');
    const petPath = path.join(ROOT, 'web', 'mods', 'pet', 'index.js');
    ok(existsSync(galPath), 'galgame/index.js 存在');
    ok(existsSync(petPath), 'pet/index.js 存在');
    ok(existsSync(path.join(ROOT, 'web', 'mods', 'elaina-avatar', 'index.js')), 'elaina-avatar/index.js 存在');

    if (existsSync(galPath) && existsSync(petPath)) {
        const gal = readFileSync(galPath, 'utf8');
        const pet = readFileSync(petPath, 'utf8');

        ok(/ElainaMods\.register\(MOD_ID/.test(gal), 'galgame 用 register 注册（id 用 MOD_ID 常量）');
        ok(/ElainaMods\.register\(MOD_ID/.test(pet), 'pet 用 register 注册（id 用 MOD_ID 常量）');
        // 两个 mod 的 id 常量必须与目录名一致（对不上会导致加载器认不出）
        ok(/const MOD_ID = 'galgame'/.test(gal), 'galgame 的 MOD_ID 与目录名一致');
        ok(/const MOD_ID = 'pet'/.test(pet), 'pet 的 MOD_ID 与目录名一致');

        // ★ 共用立绘与情绪：这是"消除上游 20MB 重复"的落点
        ok(/ElainaAvatar/.test(gal) && !/img\/elaina\/p_/.test(gal),
            '★ galgame 用公共 ElainaAvatar，不自己拼立绘路径');
        ok(/ElainaAvatar/.test(pet) && !/img\/elaina\/p_/.test(pet),
            '★ pet 用公共 ElainaAvatar，不自己拼立绘路径');

        // ★ 不直接摸宿主全局
        ok(!/\bstate\.conversations\b/.test(gal), '★ galgame 不直接读 state（走 host API）');
        ok(!/\bstate\.conversations\b/.test(pet), '★ pet 不直接读 state（走 host API）');

        // ★ 提示词注入走注册表（不往 window 挂变量）
        ok(/setPromptHint/.test(gal), '★ galgame 用 host.setPromptHint');
        // 只在**代码**里查这个符号 —— 注释里提到它是为了说明"不再用"，
        // 直接对全文断言会误报（第一版就踩了这个）
        const galCodeOnly = gal.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
        ok(!/__galgameSceneHint/.test(galCodeOnly), '★ 代码里不再往 window 上挂提示词变量');

        // ★ 双重开关已消除
        ok(!/get\('enabled'/.test(gal), '★ galgame 不读自己的 enabled（避免双重开关）');
        ok(!/get\('enabled'/.test(pet), '★ pet 不读自己的 enabled');
        ok(/ElainaMods\.setEnabled\(MOD_ID, false\)/.test(gal), '★ galgame 退出时同步关 mod 开关');
        ok(/ElainaMods\.setEnabled\(MOD_ID, false\)/.test(pet), '★ pet 收起时同步关 mod 开关');

        // 资源
        ok(existsSync(path.join(ROOT, 'web', 'mods', 'galgame', 'style.css')), 'galgame 有样式');
        ok(existsSync(path.join(ROOT, 'web', 'mods', 'pet', 'style.css')), 'pet 有样式');

        // ★ 立绘只有一套（消除重复的实证）
        const imgDir = path.join(ROOT, 'web', 'mods', 'elaina-avatar', 'img');
        let pngs = [];
        try { pngs = readdirSync(imgDir).filter((f) => f.endsWith('.png')); } catch { /* 忽略 */ }
        ok(pngs.length === 9, '公共立绘恰好 9 张（一套），实得 ' + pngs.length);
    }
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
