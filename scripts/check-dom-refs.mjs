// 校验 web/index.html 里的 DOM 引用是否都能落地。
//
// 为什么需要它：单文件应用没有构建期检查，`document.getElementById('x')` 写错一个字母
// 只会得到 null，然后在某个不常走的代码路径上炸成 "Cannot read properties of null"。
// 改 id、重命名元素时尤其容易漏。这个脚本把这类错误在打开浏览器之前就报出来。
//
// 用法：node scripts/check-dom-refs.mjs [文件路径，默认 web/index.html]

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'web/index.html');
const html = readFileSync(file, 'utf8');

// 1) 收集 HTML 里真实存在的 id
const htmlIds = new Set();
for (const m of html.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)) htmlIds.add(m[1]);
// 运行时动态创建的 id（前端自己 appendChild 出来的）也要算进来
for (const m of html.matchAll(/\.id\s*=\s*["']([A-Za-z][\w-]*)["']/g)) htmlIds.add(m[1]);
for (const m of html.matchAll(/setAttribute\(\s*["']id["']\s*,\s*["']([^"']+)["']/g)) htmlIds.add(m[1]);

const problems = [];

// 2) 所有 getElementById('x') / querySelector('#x') 的目标必须存在
const getByIdRe = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
const seenById = new Map();
for (const m of html.matchAll(getByIdRe)) {
    const id = m[1];
    if (htmlIds.has(id)) continue;
    const line = html.slice(0, m.index).split('\n').length;
    if (!seenById.has(id)) seenById.set(id, line);
}
for (const [id, line] of seenById) {
    problems.push(`第 ${line} 行：getElementById('${id}') —— HTML 里没有这个 id`);
}

// 3) elements.xxx 必须都在 elements 映射表里定义
const mapMatch = html.match(/const elements\s*=\s*\{([\s\S]*?)\n\s{8}\};/);
if (!mapMatch) {
    problems.push('没找到 elements 映射表（正则可能已过时，需要更新本脚本）');
} else {
    const definedKeys = new Set();
    for (const m of mapMatch[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) definedKeys.add(m[1]);

    // 只检查 elements.xxx 的读取；elements.xxx = ... 是赋值，不算
    const usedKeys = new Map();
    for (const m of html.matchAll(/elements\.([A-Za-z_$][\w$]*)/g)) {
        const key = m[1];
        if (definedKeys.has(key)) continue;
        const line = html.slice(0, m.index).split('\n').length;
        if (!usedKeys.has(key)) usedKeys.set(key, line);
    }
    for (const [key, line] of usedKeys) {
        problems.push(`第 ${line} 行：elements.${key} —— 映射表里没有这个键`);
    }
    console.log(`elements 映射表：定义了 ${definedKeys.size} 个元素。`);
}

console.log(`HTML 中的 id 共 ${htmlIds.size} 个。`);
if (problems.length) {
    console.log(`\n发现 ${problems.length} 处引用问题：`);
    for (const p of problems) console.log('  · ' + p);
    process.exit(1);
}
console.log('\n所有 DOM 引用都能落地，0 处问题。');
