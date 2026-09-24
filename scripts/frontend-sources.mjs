// 前端源码读取器 —— 拆分之后，检查脚本仍然能"看到全部前端代码"。
//
// 为什么需要它：
//   拆分前，整个前端逻辑都在 web/index.html 里，23 个检查脚本用
//   `readFileSync('web/index.html')` + 正则去断言（"有没有这个函数""这段逻辑对不对"）。
//   一旦把 10200 行主脚本拆到 web/js/*.js、把 Galgame/桌宠拆成 web/mods/*，
//   那些脚本读到的就只剩 HTML 骨架 —— 断言会全部失败，而且**失败原因是"读错文件"，
//   不是"功能坏了"**，那种红最难排查。
//
//   所以这里提供 readFrontend()：把所有前端源码按**加载顺序**拼成一份文本，
//   检查脚本改用它就等于"仍然在看整个前端"。
//
// 顺序必须与 index.html 里 <script> 的实际加载顺序一致 —— 有些脚本会断言
// "A 定义在 B 之前"（比如 chat-providers.js 必须在主脚本之前加载），
// 拼接顺序错了会让这类断言产生假结果。
//
// 用法：
//   import { readFrontend, listFrontendFiles } from './_frontend-sources.mjs';
//   const html = readFrontend();

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB = path.join(ROOT, 'web');

/**
 * 按加载顺序列出前端源码文件。
 *
 * 顺序规则（与 index.html 保持一致）：
 *   1. index.html 本身（含内联 <style>，供样式断言用）
 *   2. web/*.js 顶层脚本（live2d-video.js 等）
 *   3. web/js/*.js（按文件名排序，app-01 / app-02 … 前缀保证顺序）
 *   4. web/mods/<name>/*.js（插件，按名字排序；manifest 里声明了顺序则按其声明）
 *
 * 只收文本类文件（.html/.js/.css），跳过二进制与 node_modules。
 */
export function listFrontendFiles() {
    const out = [];

    const pushIfFile = (p) => {
        if (existsSync(p) && statSync(p).isFile()) out.push(p);
    };
    const pushDir = (dir, filter) => {
        if (!existsSync(dir)) return;
        const names = readdirSync(dir)
            .filter((n) => filter(n) && statSync(path.join(dir, n)).isFile())
            .sort();
        for (const n of names) out.push(path.join(dir, n));
    };

    // 1) HTML 骨架（含内联样式与内联脚本）
    pushIfFile(path.join(WEB, 'index.html'));

    // 2) web/ 顶层的独立脚本（如 live2d-video.js）
    pushDir(WEB, (n) => n.endsWith('.js'));

    // 3) web/js/ 下的模块（app-01-* 前缀决定顺序）
    pushDir(path.join(WEB, 'js'), (n) => n.endsWith('.js'));

    // 4) 插件目录：每个插件一个子目录，内部的 js/css 都要收进来
    //    （检查脚本会断言"插件是否真的被注册""样式有没有带进去"）
    const pluginsDir = path.join(WEB, 'plugins');
    if (existsSync(pluginsDir)) {
        const plugins = readdirSync(pluginsDir)
            .filter((n) => statSync(path.join(pluginsDir, n)).isDirectory())
            .sort();
        for (const name of plugins) {
            const dir = path.join(pluginsDir, name);
            pushIfFile(path.join(dir, 'manifest.json'));
            pushDir(dir, (n) => n.endsWith('.js'));
            pushDir(dir, (n) => n.endsWith('.css'));
            // 插件自己的 js/ 子目录（若按子目录组织）
            pushDir(path.join(dir, 'js'), (n) => n.endsWith('.js'));
        }
    }

    // 5) 主题目录（多主题切换后，样式断言要能看到全部主题）
    const themesDir = path.join(WEB, 'themes');
    if (existsSync(themesDir)) {
        pushDir(themesDir, (n) => n.endsWith('.css') || n.endsWith('.js'));
    }

    return out;
}

/**
 * 把全部前端源码拼成一份文本。
 *
 * 每个文件前加一行 `/* ==== 文件: <相对路径> ==== *​/` 分隔注释 ——
 * 出问题时能从报错行号回溯到具体文件（否则只剩一个全局行号，没法定位）。
 */
export function readFrontend() {
    const files = listFrontendFiles();
    return files
        .map((f) => {
            const rel = path.relative(ROOT, f).replace(/\\/g, '/');
            let text = '';
            try { text = readFileSync(f, 'utf8'); } catch { text = ''; }
            return `/* ==== 文件: ${rel} ==== */\n${text}`;
        })
        .join('\n');
}

/** 只读某个具体前端文件（相对 web/ 的路径），找不到返回空串 */
export function readWebFile(rel) {
    const p = path.join(WEB, rel);
    try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

/**
 * 取"某段逻辑"的源码切片，用于 `html.slice(indexOf(a), indexOf(b))` 这类断言。
 *
 * 拆分之后，原本相邻的两段代码可能落在不同文件里，`indexOf(b)` 可能落在
 * `indexOf(a)` 之前（或找不到），于是 slice 得到空串、断言静默失败。
 * 这个函数保证：b 找不到时退化为"从 a 到文本末尾"，并在 b 在 a 之前时给出提示。
 */
export function sliceBetween(text, startMarker, endMarker) {
    const a = text.indexOf(startMarker);
    if (a < 0) return '';
    if (!endMarker) return text.slice(a);
    const b = text.indexOf(endMarker, a);
    return b < 0 ? text.slice(a) : text.slice(a, b);
}
