/**
 * 对拍检查：模型列表的「服务端实现」与「Capacitor 原生实现」必须给出同样的结果。
 *
 * 为什么需要：APK 里没有 Node 服务端，模型列表由 index.html 里的 nativeLive2dFetch() 用
 * Capacitor Filesystem 自己实现；Web 版走 serve.mjs 的 listModels()。这是**同一套语义的两份代码**
 * （都要递归扫描、都优先取根目录的 model3.json / vtube.json、都要把 exps/motions 表达成
 * 相对模型根目录的路径），非常容易各改各的、悄悄跑偏 —— 而原生那份只有在真机上才能验证。
 *
 * 做法：用字符串切片把两边的真实函数体抠出来，喂**同一个真实模型目录**（web/live2d/models/），
 * 原生那份的 Capacitor Filesystem 用 Node fs 做一个等价桩，最后深比对两边输出。
 * 不复制任何业务逻辑，测的就是真代码。
 */
import { readFileSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_ROOT = path.join(projectRoot, 'web', 'live2d', 'models');
/** 与 serve.mjs 里 MODELS_DIR 指向同一个目录；Capacitor 桩里用相对路径 'live2d/models/...' 访问它 */

/**
 * 按函数名抠出完整函数声明（靠大括号配对找结尾；这些函数里没有出现在字符串字面量内的花括号）。
 * 注意：必须把前面的 `async` 一起带上 —— `indexOf('function x(')` 会从 `async function x(` 的
 * 中间开始切，抠出来的就成了同步函数，里面所有 `await` 立刻变成语法错误。
 */
function extractFn(source, name, label) {
    let start = source.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(`在 ${label} 里找不到函数: ${name}（重命名了？请同步更新本检查）`);
    const asyncMatch = source.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (asyncMatch) start -= asyncMatch[0].length;
    // **先跳过参数表**：`opts = {}` 这类默认值里就有大括号，直接找第一个 `{` 会抠出半截函数
    // （症状是 new Function 报一个和本函数毫无关系的 SyntaxError）。
    let i = source.indexOf('(', start);
    let paren = 0;
    for (; i < source.length; i++) {
        if (source[i] === '(') paren++;
        else if (source[i] === ')') { paren--; if (paren === 0) { i++; break; } }
    }
    let depth = 0;
    i = source.indexOf('{', i);
    for (; i < source.length; i++) {
        const c = source[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return source.slice(start, i);
}

// ==================== 服务端实现 ====================
const serveSrc = readFileSync(path.join(projectRoot, 'web', 'serve.mjs'), 'utf8');
const server = new Function('readdir', 'stat', 'path', 'MODELS_DIR', `
    ${extractFn(serveSrc, 'collectModelFiles', 'serve.mjs')}
    ${extractFn(serveSrc, 'listModels', 'serve.mjs')}
    return { listModels };
`)(readdir, stat, path, MODELS_ROOT);

// ==================== Capacitor 原生实现 ====================
const htmlSrc = readFileSync(path.join(projectRoot, 'web', 'index.html'), 'utf8');
/**
 * Capacitor Filesystem 的等价桩：readdir 返回 { files: [{ name, type, size }] }，语义与插件一致。
 * 关键：Capacitor 的 path 是**相对应用数据目录**的（`live2d/models`、`live2d/models/deepseek`），
 * 这里把数据目录映射到仓库里的 web/live2d/models，所以必须先剥掉 `live2d/models` 前缀，
 * 否则会拼成 .../live2d/models/live2d/models —— readdir 抛错、被上层的 try/catch 吞掉，
 * 表现为"原生实现返回空列表"，很容易误判成代码 bug。
 */
const fsStub = {
    Directory: { Data: 'DATA' },
    async readdir({ path: p }) {
        const rel = String(p).replace(/^live2d\/models\/?/, '');
        const abs = rel ? path.join(MODELS_ROOT, rel) : MODELS_ROOT;
        const entries = await readdir(abs, { withFileTypes: true });
        return {
            files: entries.map((e) => ({
                name: e.name,
                type: e.isDirectory() ? 'directory' : 'file',
                size: e.isDirectory() ? 0 : statSync(path.join(abs, e.name)).size,
            })),
        };
    },
};
const native = new Function('nativeFsStub', `
    ${extractFn(htmlSrc, 'nativeCollectModelFiles', 'index.html')}
    ${extractFn(htmlSrc, 'nativeWriteFile', 'index.html')}
    ${extractFn(htmlSrc, 'bytesToBase64', 'index.html')}
    ${extractFn(htmlSrc, 'unzipBrowser', 'index.html')}
    ${extractFn(htmlSrc, 'nativeLive2dFetch', 'index.html')}
    function nativeFs() { return nativeFsStub; }
    return { nativeLive2dFetch };
`)(fsStub);

// ==================== 跑两边，深比对 ====================
const resStub = { body: '', writeHead() {}, end(s) { this.body = s; } };
await server.listModels(resStub);
const serverModels = JSON.parse(resStub.body).models;

const nativeResponse = await native.nativeLive2dFetch('/api/live2d/models', { method: 'GET' });
const nativeModels = (await nativeResponse.json()).models;

const norm = (list) => list
    .map((m) => ({ name: m.name, modelJson: m.modelJson, vtube: m.vtube ?? null, exps: m.exps, motions: m.motions }))
    .sort((a, b) => a.name.localeCompare(b.name));

const a = norm(serverModels);
const b = norm(nativeModels);
const same = JSON.stringify(a) === JSON.stringify(b);

let pass = 0;
let fail = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
    if (!ok) console.log(`        got  = ${JSON.stringify(actual)}\n        want = ${JSON.stringify(expected)}`);
};

console.log('服务端 listModels()      :', JSON.stringify(a.map((m) => [m.name, m.exps.length, m.motions.length])));
console.log('原生 nativeLive2dFetch() :', JSON.stringify(b.map((m) => [m.name, m.exps.length, m.motions.length])));
console.log();

check('两边模型数一致', b.length, a.length);
check('两边结果逐字段深比对一致', same, true);

// 独立断言几个关键事实，防止"两边一起错成一样"
const deepseek = a.find((m) => m.name === 'deepseek');
const elaina = a.find((m) => m.name === '伊蕾娜·默认');
check('deepseek 的 modelJson 取的是根目录下的', deepseek?.modelJson, 'c_0120.model3.json');
check('deepseek 的 vtube 取的是根目录下的', deepseek?.vtube, 'c_0120.vtube.json');
check('deepseek 表情数 > 40（根目录下的 exp3 被扫到）', (deepseek?.exps.length ?? 0) > 40, true);
check('deepseek 动作包含 motions/ 子目录项',
    Boolean(deepseek?.motions.some((f) => f.startsWith('motions/'))), true);
check('exps 是相对路径而非裸文件名（根目录项不带斜杠）',
    Boolean(deepseek?.exps.every((f) => !f.includes('/'))), true);
check('伊蕾娜·默认 无表情无动作（模型本身没带，不是 bug）',
    `${elaina?.exps.length}/${elaina?.motions.length}`, '0/0');

// exps/motions 里列出的每个文件都必须真实存在（拼 URL 时不能 404）
const missing = [];
for (const m of a) {
    for (const rel of [...m.exps, ...m.motions]) {
        const abs = path.join(MODELS_ROOT, m.name, rel);
        try { statSync(abs); } catch { missing.push(`${m.name}/${rel}`); }
    }
}
check('清单里的每个表情/动作文件都真实存在', missing.length, 0);
if (missing.length) console.log('        缺失:', missing);

console.log(`\n模型列表双实现对拍：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
