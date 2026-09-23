// 回归检查：APK 里「内置模型识别不到」的**真正根因**。
//
// 前一版修错了地方，这里记清楚：
//   视频通话里的列表走 refreshModelList() → fetch(...).json()
//   设置面板里的列表走 refreshLive2DSettingList() → readJsonSafe(res) → **await res.text()**
//
// 而 nativeLive2dFetch 返回的假 Response 只有 json()，没有 text()。
// 于是设置里那条路：res.text is not a function → 被 catch 吞掉 → 列表静默为空，
// 显示「（未上传模型）」。**同一个接口两条调用路径，只有一条炸** —— 这就是为什么
// 一开始只改了 refreshModelList 却"没解决问题"。
//
// 这个检查做两件事：
//   1. 源码层：所有假 Response 都必须同时提供 json() 与 text()
//   2. 行为层：把真实的 nativeLive2dFetch 跑起来，用**设置面板那条真实路径**
//      （readJsonSafe 的语义：先 text() 再 JSON.parse）取模型，断言能拿到
//
// 用法：node scripts/check-native-response.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label, detail) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

function extractFn(src, name) {
    let start = src.indexOf('function ' + name + '(');
    if (start < 0) return null;
    const asyncPrefix = src.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (asyncPrefix) start -= asyncPrefix[0].length;
    let i = src.indexOf('{', src.indexOf('(', start));
    let d = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}') { d--; if (d === 0) return src.slice(start, i + 1); }
    }
    return null;
}

// ============================================================ 1. 源码层
console.log('=== 1. 假 Response 必须同时有 json() 与 text() ===');
{
    const fnStart = html.indexOf('async function nativeLive2dFetch(');
    const fnEnd = html.indexOf('return { ', fnStart) > 0 ? html.indexOf('return { ', fnStart) : html.length;
    const body = html.slice(fnStart, fnEnd);

    // 构造假 Response 的地方必须用 makeRes / json 包装
    const bare = [...body.matchAll(/\{[^{}]*json:\s*async\s*\(\)\s*=>[^{}]*\}/g)]
        .map((m) => m[0])
        .filter((s) => !/text:/.test(s));
    // makeRes 内部那一处是定义本身，不算违规（它两个都提供了）
    const offenders = bare.filter((s) => !/makeRes/.test(s));
    ok(offenders.length === 0,
        '没有"只有 json() 没有 text()"的假 Response',
        offenders.length + ' 处: ' + offenders.slice(0, 2).join(' | '));

    ok(/text:\s*async\s*\(\)/.test(body), 'nativeLive2dFetch 里提供了 text()');
    ok(/const makeRes\s*=/.test(body), '用统一的 makeRes 构造响应（避免下次又漏一个）');
}

// ============================================================ 2. 行为层：走设置面板的真实路径
console.log('\n=== 2. 行为层：设置面板那条路径（先 text() 再 parse）===');

// 真实打包清单
const MANIFEST = path.join(ROOT, 'android-app', 'www', 'live2d', 'models', 'manifest.json');
ok(existsSync(MANIFEST), '安卓工程里有 manifest.json');
const manifestObj = JSON.parse(readFileSync(MANIFEST, 'utf8'));

// 空数据目录（模拟播种失败）—— 正是用户遇到的状态
const fsMock = {
    files: new Map(),
    Directory: { Data: 'DATA' },
    async mkdir() {},
    async writeFile(o) { this.files.set(o.path, o.data); },
    async appendFile(o) { this.files.set(o.path, (this.files.get(o.path) || '') + o.data); },
    async readFile(o) { if (!this.files.has(o.path)) throw new Error('不存在'); return { data: this.files.get(o.path) }; },
    async readdir() { return { files: [] }; },
    async getUri() { return { uri: 'file:///data/x/live2d/models' }; },
};

const sandbox = {
    console,
    window: {},
    Capacitor: { convertFileSrc: (u) => 'https://localhost/_capacitor_file_' + u, Plugins: { Filesystem: fsMock } },
    IS_NATIVE_APP: true,
    nativeFs: () => fsMock,
    nativeModelRootReady: true,
    TextEncoder, TextDecoder, Uint8Array, Buffer, JSON, Number, String, Math, Object, Array, Error, Promise, Map, Set,
    setTimeout, clearTimeout,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    fetch: async (url) => {
        const u = String(url).replace(/^https?:\/\/[^/]+/, '');
        if (u === '/live2d/models/manifest.json') {
            return { ok: true, status: 200, async json() { return manifestObj; }, async text() { return JSON.stringify(manifestObj); } };
        }
        return { ok: false, status: 404, async json() { return {}; }, async text() { return ''; } };
    },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext([
    extractFn(html, 'bundledManifestModels'),
    extractFn(html, 'nativeCollectModelFiles'),
    extractFn(html, 'nativeLive2dFetch'),
].filter(Boolean).join('\n\n'), sandbox);

// 复刻设置面板的真实取法：readJsonSafe 的语义 = 先 text()，JSON.parse
const settingPath = await vm.runInContext(`
    nativeLive2dFetch('/api/live2d/models', { method: 'GET' }).then(async (res) => {
        // 这就是 readJsonSafe 的第一步 —— 旧代码在这里抛 TypeError
        const text = await res.text();
        return { hasText: typeof text === 'string', parsed: JSON.parse(text) };
    })
`, sandbox);

ok(settingPath.hasText, 'res.text() 可用（旧代码在这里抛 TypeError）');
const models = (settingPath.parsed && settingPath.parsed.models) || [];
console.log('  设置面板这条路径拿到 ' + models.length + ' 个模型: ' + JSON.stringify(models.map((m) => m.name)));
ok(models.length === manifestObj.models.length,
    '设置面板能列出全部内置模型（这就是用户报的那个问题）',
    '期望 ' + manifestObj.models.length + '，实际 ' + models.length);

// ============================================================ 3. 视频通话那条路径也不能坏
console.log('\n=== 3. 视频通话那条路径（只用 json()）仍然正常 ===');
{
    const r = await vm.runInContext(`nativeLive2dFetch('/api/live2d/models', { method: 'GET' }).then(r => r.json())`, sandbox);
    const list = (r && r.models) || [];
    ok(list.length === manifestObj.models.length, 'json() 路径同样返回全部模型', String(list.length));
}

// ============================================================ 4. 错误响应也带 text()
console.log('\n=== 4. 错误响应同样要带 text() ===');
{
    const r = await vm.runInContext(`
        nativeLive2dFetch('/api/live2d/nonexistent', { method: 'GET' }).then(async (res) => {
            let textOk = false;
            try { textOk = typeof (await res.text()) === 'string'; } catch (e) { textOk = false; }
            return { status: res.status, ok: res.ok, textOk };
        })
    `, sandbox);
    ok(r.status === 404, '未知接口返回 404');
    ok(r.ok === false, 'ok 为 false');
    ok(r.textOk, '404 响应也有 text()（readJsonSafe 对非 2xx 也要能读）');
}

// ============================================================ 5. 所有出口都覆盖到
console.log('\n=== 5. 出口覆盖（model3 缺失 / 上传异常等）===');
{
    // 直接扫源码：每个 return 出去的响应都必须来自 makeRes 或 json()
    const fnStart = html.indexOf('async function nativeLive2dFetch(');
    const body = html.slice(fnStart, html.indexOf('// 字节 → base64', fnStart));
    const returns = [...body.matchAll(/return\s+(\{[\s\S]{0,120}?\};)/g)].map((m) => m[1]);
    const bad = returns.filter((r) => /json:\s*async/.test(r) && !/makeRes/.test(r));
    ok(bad.length === 0, '所有 return 的响应都走 makeRes/json', bad.slice(0, 2).join(' | '));
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：' + failures.join('、'));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
