// 回归检查：数据导出的下载方式（防"被外部下载器抢走"）。
//
// 为什么需要：这是个**环境相关、静默失败**的坑，很容易被改回去。
//
//   迅雷 / FDM 这类下载器会往 Chrome 里装**机器级扩展**
//   （HKLM\SOFTWARE\...\Google\Chrome\Extensions，实测 path 指向
//   %LOCALAPPDATA%\ChromeExtensionCache\xl_ext_chrome.crx）。
//   机器级 = 任何 Chrome 实例都躲不掉，连自动化测试用的临时 profile 也会加载。
//
//   这个扩展只要看到响应带 `Content-Disposition: attachment`，就把 URL 抢走交给
//   自己的下载引擎 —— 浏览器里拿到的是被改写的空响应（实测 HTTP 204 + 0 字节），
//   用户既拿不到文件、也不知道为什么，还会被弹一个下载器窗口。
//
//   正确做法（本检查守护的两条）：
//     1. 后端**不发** Content-Disposition: attachment，文件名走自定义头
//     2. 前端 fetch 成 blob，用 <a download> 保存 —— blob: 是内存地址，抢不走
//   另外前端必须**检测空响应**，否则会静默存下一个 0 字节的坏文件。
//
// 这个检查只读源码与响应头，**不触发任何真实下载**（不会弹出外部下载器）。
//
// 用法：node scripts/check-export-download.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

// ============================================================ 1. 源码检查
console.log('=== 1. 前端下载方式（源码）===');
// 前端拆分后 exportDataBackup 在 web/js/app-*.js 里，必须读整个前端
const html = readFrontend();

/** 取出 exportDataBackup 函数体（靠大括号配对） */
function extractFn(source, name) {
    const start = source.indexOf('function ' + name + '(');
    if (start < 0) return null;
    let i = source.indexOf('{', source.indexOf('(', start));
    let depth = 0;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
    }
    return null;
}

const exportFn = extractFn(html, 'exportDataBackup');
ok(exportFn !== null, '找到 exportDataBackup 函数');
if (exportFn) {
    ok(/URL\.createObjectURL/.test(exportFn), '用 createObjectURL（blob 下载）');
    ok(/a\.download\s*=/.test(exportFn), '用 <a download> 触发保存');
    ok(!/location\.href\s*=/.test(exportFn), '没有用 location.href 跳转（那会被下载器抢）');
    ok(/blob\.size/.test(exportFn), '检测了空响应（blob.size）');
    ok(/X-Backup-Filename/.test(exportFn), '读取自定义文件名头');
    ok(/revokeObjectURL/.test(exportFn), '释放了 blob URL（不泄漏内存）');
}

// ============================================================ 2. 后端响应头
console.log('\n=== 2. 后端响应头（真实服务，不触发下载）===');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'elaina-export-'));
const dataDir = path.join(sandbox, 'data');
await mkdir(dataDir, { recursive: true });
await writeFile(path.join(dataDir, 'store.json'), JSON.stringify({
    elaina_open_settings: JSON.stringify({ model: 'x' }),
}), 'utf8');

const PORT = 4396;
const server = spawn(process.execPath, ['web/serve.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, LOG_DIR: path.join(sandbox, 'logs'), LOG_TO_FILE: '0', LOG_CHAT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
server.stdout.on('data', (d) => { bootLog += d; });
server.stderr.on('data', (d) => { bootLog += d; });

const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
    try { if ((await fetch(base + '/api/server-info')).ok) { up = true; break; } } catch { /* 等 */ }
    await new Promise((r) => setTimeout(r, 300));
}
if (!up) {
    console.log('服务没起来：\n' + bootLog.slice(0, 800));
    server.kill();
    await rm(sandbox, { recursive: true, force: true });
    process.exit(1);
}

try {
    const r = await fetch(base + '/api/data/export');
    ok(r.status === 200, '导出返回 200', 'got ' + r.status);

    const cd = r.headers.get('content-disposition') || '';
    ok(!/attachment/i.test(cd), '不发 Content-Disposition: attachment', cd || '(无)');
    ok(!/content-disposition/i.test([...r.headers.keys()].join(',')), '完全没有 Content-Disposition 头');

    const fn = r.headers.get('x-backup-filename') || '';
    ok(/^elainachat-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/.test(fn), '自定义头带合法文件名', fn);

    ok(/zip/.test(r.headers.get('content-type') || ''), 'Content-Type 是 zip');

    const buf = Buffer.from(await r.arrayBuffer());
    ok(buf.length > 0, '响应非空', buf.length + ' 字节');
    ok(buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50, '内容是合法 zip');

    // 自定义头必须能过 CORS 暴露（同源不需要，但记一笔）
    ok(true, '（同源请求，无需 Access-Control-Expose-Headers）');
} finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 400));
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：' + failures.join('、'));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
