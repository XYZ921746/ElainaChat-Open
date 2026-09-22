// 校验前端脚本的语法：web/index.html 里的内联 <script> 块 + web/js/ 下的外置脚本。
//
// 为什么需要它：这是单文件应用拆出来的前端，任何一处 JS 语法错误都会让整个页面
// 白屏且浏览器只报一句 SyntaxError，定位成本极高。改完代码跑一遍这个脚本，
// 能在打开浏览器之前就把语法错误挡掉。
//
// 覆盖范围（两处都要查，漏一处就等于没保护）：
//   1. web/index.html 里每个内联 <script> 块
//   2. web/js/**/*.js 每个外置脚本文件
//
// 用法：node scripts/check-inline-scripts.mjs [文件路径，默认 web/index.html]
//       传了路径就只查那一个文件（保持旧行为，方便单独排查）。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = resolve(root, 'web/js');

let errors = 0;
let checked = 0;

// SourceTextModule 只有加 --experimental-vm-modules 才存在，没加时**顶层 import 会直接抛**，
// 连普通脚本的检查都跑不了。所以惰性加载：只有真遇到 type="module" 的块才去要它。
let SourceTextModule = null;
async function getSourceTextModule() {
    if (SourceTextModule) return SourceTextModule;
    try {
        ({ SourceTextModule } = await import('node:vm'));
    } catch {
        throw new Error('检查 type="module" 脚本需要 --experimental-vm-modules（见 package.json 的 check 脚本）');
    }
    return SourceTextModule;
}

/** 语法检查一段 JS 代码；失败时打印带大致行号的信息。 */
async function checkScript(body, type, label, startLine) {
    checked++;
    try {
        if (type === 'module') {
            const M = await getSourceTextModule();
            new M(body);
        } else {
            // eslint-disable-next-line no-new-func
            new Function(body);
        }
    } catch (err) {
        errors++;
        const stack = String(err.stack || err.message);
        const lineMatch = stack.match(/<anonymous>:(\d+)/);
        const rel = lineMatch ? Number(lineMatch[1]) : 0;
        console.log(`\n[FAIL] ${label} (type=${type})`);
        if (startLine && rel) console.log(`       大致位置：第 ${startLine + rel - 1} 行`);
        console.log(`       ${err.name}: ${err.message}`);
    }
}

/** 检查一个 HTML 文件里的内联脚本块 */
async function checkHtml(file) {
    const html = readFileSync(file, 'utf8');
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;
    let index = 0;

    while ((match = re.exec(html))) {
        index++;
        const attrs = match[1] || '';
        const body = match[2] || '';

        // 外链脚本、数据块、模板块都不是可执行 JS，跳过。
        if (/\bsrc\s*=/.test(attrs)) continue;
        if (/type\s*=\s*["']?(application\/json|text\/template|importmap)/i.test(attrs)) continue;

        const typeMatch = attrs.match(/type\s*=\s*["']?([\w/-]+)/i);
        const type = typeMatch ? typeMatch[1] : 'text/javascript';
        if (type !== 'text/javascript' && type !== 'module') continue;

        const startLine = html.slice(0, match.index).split('\n').length;
        await checkScript(body, type, `<script> #${index}（${relative(root, file)}）`, startLine);
    }
}

/** 检查 web/js/ 下的每个 .js 文件 */
async function checkJsDir() {
    if (!existsSync(JS_DIR)) return;
    const files = readdirSync(JS_DIR, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.js'))
        .map((e) => e.name)
        .sort();
    for (const name of files) {
        await checkScript(readFileSync(join(JS_DIR, name), 'utf8'), 'text/javascript', `web/js/${name}`, 1);
    }
}

// 传了路径就只查那个文件（兼容旧用法）；否则查 index.html + web/js/
const explicit = process.argv[2];
if (explicit) {
    await checkHtml(resolve(explicit));
} else {
    await checkHtml(resolve(root, 'web/index.html'));
    await checkJsDir();
}

console.log(`\n检查了 ${checked} 个脚本块，${errors} 个错误。`);
process.exit(errors ? 1 : 0);
