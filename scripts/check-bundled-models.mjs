// 回归检查：APK 里「打包内置模型识别不到」。
//
// 背景（用户反馈）：装好 APK，Live2D 模型列表是空的，显示「（未上传模型）」。
//
// 排查结论：模型**确实在 APK 里**（assets/public/live2d/models/，70 个文件，
// 含 manifest.json），坏的是**取模型的链路**。原来的实现只有一条路：
//
//   1. 启动时把 assets 里的模型「播种」到应用数据目录（依赖 Capacitor Filesystem 插件）
//   2. 列模型时只扫**数据目录**
//
// 于是第 1 步一失败（插件不可用 / 权限被拒 / 存储写满 / ROM 限制），
// 数据目录就是空的，列表跟着空 —— 而 assets 里那份完好无损。
// 单点故障把一个「锦上添花」的功能变成了「内置模型完全不可用」。
//
// 修法：列模型时把**打包清单**合并进来（bundledManifestModels），
// 它直接读 /live2d/models/manifest.json —— WebView 的静态资源，不碰任何原生插件。
// 资源 URL 也要分清来源：bundled 的走 assets，其余的走数据目录。
//
// 这个检查盯住：
//   1. 兜底函数存在，且真的读 manifest.json
//   2. 列表接口在数据目录为空时仍能返回内置模型
//   3. 合并（不是"空了才兜底"）—— 否则用户上传过模型后内置的会消失
//   4. 资源 URL 按来源分流（否则 bundled 模型会去数据目录找文件而 404）
//
// 用法：node scripts/check-bundled-models.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label, detail) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

const html = readFrontend();
const video = readFileSync(path.join(ROOT, 'web', 'live2d-video.js'), 'utf8');

// ============================================================ 1. 兜底函数
console.log('=== 1. 兜底函数（直接读打包清单，不依赖原生插件）===');
ok(/async function bundledManifestModels\s*\(/.test(html), '有 bundledManifestModels()');
{
    const start = html.indexOf('async function bundledManifestModels(');
    const end = html.indexOf('async function nativeLive2dFetch(');
    const body = start > 0 && end > start ? html.slice(start, end) : '';
    ok(body.includes("'/live2d/models/manifest.json'"),
        '读的是 /live2d/models/manifest.json（静态资源，不是 /api/）');
    ok(!/nativeFs\s*\(/.test(body) && !/Filesystem/.test(body),
        '整个函数不碰 Filesystem（不依赖原生插件，这正是兜底的意义）');
    ok(/model3\.json/.test(body), '会挑出 model3.json');
    ok(/exp3\.json/.test(body) && /motion3\.json/.test(body), '会收集表情与动作');
    ok(/bundled\s*:\s*true/.test(body), '给结果打 bundled 标记（供资源 URL 分流用）');
}

// ============================================================ 2. 列表接口真的合并
console.log('\n=== 2. 列表接口合并内置模型 ===');
{
    const start = html.indexOf("if (url === '/api/live2d/models' && method === 'GET')");
    const end = html.indexOf("if (url === '/api/live2d/upload'");
    const body = start > 0 && end > start ? html.slice(start, end) : '';
    ok(body.includes('bundledManifestModels'), '列表接口调用了兜底函数');

    // 关键：必须是「合并」而不是「空了才兜底」。
    // 若写成 if (!models.length) { models = bundled }，用户一旦上传过模型（目录非空），
    // 内置的那两个就会从列表里消失。
    ok(/const have = new Set\(models\.map/.test(body),
        '按名字去重后合并（不是"空了才整体替换"）');
    ok(/for \(const b of bundled\)/.test(body), '逐个补入内置模型');
    ok(/have\.has\(b\.name\)/.test(body), '同名的跳过（用户改过的以数据目录为准）');

    // 反向确认：不能出现"空才替换"那种写法
    ok(!/if\s*\(\s*!\s*models\.length\s*\)\s*\{\s*(const|let|var)?\s*\w*\s*=?\s*await\s+bundledManifestModels/.test(body),
        '没有写成"仅在为空时替换"（那会让上传后内置模型消失）');
}

// ============================================================ 3. 资源 URL 按来源分流
console.log('\n=== 3. 资源 URL 分流（bundled 走 assets，其余走数据目录）===');
{
    const start = video.indexOf('function modelBaseUrl(');
    const end = video.indexOf('function modelAssetUrl(');
    const body = start > 0 && end > start ? video.slice(start, end) : '';
    ok(body.includes('bundled'), 'modelBaseUrl 识别 bundled 标记');
    ok(/\/live2d\/models\//.test(body), 'bundled 时走 /live2d/models/（assets）');
    ok(body.includes('__nativeModelBase'), '非 bundled 时仍走数据目录（原有行为不变）');
}

// ============================================================ 4. 端到端：数据目录为空时列表不为空
console.log('\n=== 4. 端到端（用真实代码 + 假 Filesystem 跑一遍）===');

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

// 真实的打包清单（从安卓工程读，那是要打进 APK 的那份）
//
// ★ 清单**可能不存在** —— `npm run sync:web:lite` 是"纯净版 APK"模式：
//   模型不打包进 APK，改走扩展包（Releases 分发，用户在设置里上传）。
//   那种情况下清单本来就不该有，所以这里不能直接 fail。
//
//   但要区分两种"没有清单"：
//     · 刻意的纯净版（正常）→ 跳过模型相关断言，仍跑代码逻辑测试
//     · 忘了同步 / 同步坏了（异常）→ 应该 fail
//   判据：lite 模式下 www/live2d/models 整个目录都不存在；
//   而"忘了同步"时目录在、只是文件不齐。
const MANIFEST = path.join(ROOT, '..', 'android-app', 'www', 'live2d', 'models', 'manifest.json');
const MODELS_DIR = path.join(ROOT, '..', 'android-app', 'www', 'live2d', 'models');
const liteMode = !existsSync(MODELS_DIR);   // 目录都没有 = 刻意纯净版

if (liteMode) {
    console.log('  [纯净版模式] 安卓工程未打包 Live2D 模型（--lite），跳过模型打包相关断言');
    console.log('                 模型走扩展包分发，用户在「设置 → Live2D → 上传模型」安装');
    ok(true, '纯净版：模型不内嵌（这是 --lite 的预期行为）');
    // 顺带确认：纯净版下确实一个模型文件都没有（不是"目录在但空了"）
    ok(!existsSync(MANIFEST), '纯净版：不含打包清单');
} else {
    ok(existsSync(MANIFEST), '安卓工程里有打包清单 manifest.json');
}
const manifestText = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : '{"models":[]}';
const manifestObj = JSON.parse(manifestText);
if (!liteMode) {
    ok(Array.isArray(manifestObj.models) && manifestObj.models.length > 0,
        '清单里有模型', String((manifestObj.models || []).length));
}

// 假文件系统：数据目录**完全为空**（模拟播种失败）
function makeEmptyFs() {
    const files = new Map();
    return {
        files,
        Directory: { Data: 'DATA', Documents: 'DOCUMENTS' },
        async mkdir() {},
        async writeFile(o) { files.set(o.path, o.data); },
        async appendFile(o) { files.set(o.path, (files.get(o.path) || '') + o.data); },
        async readFile(o) { if (!files.has(o.path)) throw new Error('不存在'); return { data: files.get(o.path) }; },
        async readdir() { return { files: [] }; },   // 空目录 —— 这就是 bug 现场
        async getUri() { return { uri: 'file:///data/data/x/files/live2d/models' }; },
    };
}

const fsMock = makeEmptyFs();
const sandbox = {
    console,
    window: {},
    Capacitor: {
        convertFileSrc: (u) => 'https://localhost/_capacitor_file_' + String(u).replace('file://', ''),
        Plugins: { Filesystem: fsMock },
    },
    IS_NATIVE_APP: true,
    nativeFs: () => fsMock,
    nativeModelRootReady: true,   // 目录"建好了"，只是里面没东西
    TextEncoder, TextDecoder, Uint8Array, Buffer, JSON, Number, String, Math, Object, Array, Error, Promise, Map, Set,
    setTimeout, clearTimeout,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    fetch: async (url) => {
        const u = String(url).replace(/^https?:\/\/[^/]+/, '');
        if (u === '/live2d/models/manifest.json') {
            return { ok: true, status: 200, async json() { return manifestObj; } };
        }
        return { ok: false, status: 404 };
    },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const pieces = [
    extractFn(html, 'bundledManifestModels'),
    extractFn(html, 'nativeCollectModelFiles'),
    extractFn(html, 'nativeLive2dFetch'),
].filter(Boolean);
vm.runInContext(pieces.join('\n\n'), sandbox);

const result = await vm.runInContext(
    `nativeLive2dFetch('/api/live2d/models', { method: 'GET' }).then(r => r.json())`,
    sandbox);
const models = (result && result.models) || [];
console.log('  数据目录为空时，列表返回 ' + models.length + ' 个: ' + JSON.stringify(models.map((m) => m.name)));
if (liteMode) {
    // 纯净版：清单为空，所以"合并内置模型"这条路径没有输入 —— 断言会退化成
    // 0 === 0（恒真，没有检验力）。所以这里明确说明跳过，而不是假装测过了。
    console.log('  [纯净版模式] 无内置模型可合并，跳过"合并内置模型"相关断言');
    console.log('                 这段逻辑本身仍被第 2 节（源码层）覆盖着');
    ok(models.length === 0, '纯净版：数据目录为空 + 无内置模型 → 列表为空（符合预期）');
} else {
    ok(models.length === manifestObj.models.length,
        '数据目录为空时仍列出全部内置模型（这就是修复本身）',
        '期望 ' + manifestObj.models.length + '，实际 ' + models.length);
    ok(models.every((m) => m.bundled === true), '这些模型都带 bundled 标记（资源会从 assets 取）');
    ok(models.every((m) => m.modelJson), '每个都有 modelJson');
    {
        const withExp = models.filter((m) => m.exps.length > 0).length;
        ok(withExp > 0, '至少有模型带了表情（' + withExp + ' 个）');
    }
}

// ============================================================ 5. 播种成功时不会重复
console.log('\n=== 5. 播种成功时不重复（同名去重）===');
if (liteMode || !manifestObj.models.length) {
    // 纯净版没有内置模型，这段"同名去重"也就没有输入 —— 明确跳过
    console.log('  [纯净版模式] 无内置模型，跳过"播种去重"断言');
    ok(true, '纯净版：无需播种内置模型');
} else {
    const fsMock2 = makeEmptyFs();
    // 模拟"播种成功"：数据目录里有同名模型（含它自己的 model3.json）。
    // readdir 必须**按路径**返回不同内容 —— 否则递归收集时会把顶层目录项
    // 当成模型内的文件，拿不到 modelJson，那条记录就被跳过了。
    const firstName = manifestObj.models[0].name;
    fsMock2.files.set('live2d/models/' + firstName + '/x.model3.json', 'AAAA');
    fsMock2.readdir = async (o) => {
        if (!o.path || o.path === 'live2d/models') {
            return { files: [{ name: firstName, type: 'directory', size: 0 }] };
        }
        if (o.path === 'live2d/models/' + firstName) {
            return { files: [{ name: 'x.model3.json', type: 'file', size: 4 }] };
        }
        return { files: [] };
    };
    const sb2 = { ...sandbox };
    sb2.nativeFs = () => fsMock2;
    sb2.window = sb2;
    sb2.globalThis = sb2;
    vm.createContext(sb2);
    vm.runInContext(pieces.join('\n\n'), sb2);
    const r2 = await vm.runInContext(
        `nativeLive2dFetch('/api/live2d/models', { method: 'GET' }).then(r => r.json())`, sb2);
    const names = (r2.models || []).map((m) => m.name);
    const dup = names.filter((n) => n === firstName).length;
    ok(dup === 1, '同名模型不重复出现', '出现 ' + dup + ' 次');
    ok(names.length === manifestObj.models.length, '总数仍等于清单数（合并而非叠加）', JSON.stringify(names));
    const fromData = (r2.models || []).find((m) => m.name === firstName);
    ok(fromData && !fromData.bundled, '同名时以数据目录里的为准（不带 bundled 标记）');
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：' + failures.join('、'));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
