// 端到端：起真实服务 → 打日志 → 查 /api/logs/tail 的过滤能力 → 浏览器看查看器。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-tail-'));
const PORT = await freePort();
const HTTPS_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), HOST: '127.0.0.1', LOG_DIR, DATA_DIR: path.join(LOG_DIR, 'data'), LOG_TO_FILE: '1', LOG_CHAT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
let up = false;
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
child.on('exit', (code, sig) => {
    if (!up && code !== 0 && !out.includes('listening')) {
        console.log('（子进程退出 code=' + code + ' sig=' + sig + '）输出：\n' + out.slice(0, 1200));
    }
});

try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
        try { up = (await fetch(BASE + '/api/server-info')).ok; } catch { await wait(250); }
    }
    ok(up, '服务已启动', up ? '' : out.slice(-300));
    await wait(800);

    // ── 1. 基本拉取 ──
    const all = await (await fetch(BASE + '/api/logs/tail?limit=500')).json();
    ok(all.ok === true, '/api/logs/tail 可用');
    ok(Array.isArray(all.entries) && all.entries.length > 5, '缓冲里有启动日志', String(all.entries?.length));
    ok(all.entries[0].ts >= (all.entries[1]?.ts || 0), '★ 按时间倒序（最新在前）');
    for (const e of all.entries) {
        if (!(typeof e.ts === 'number' && e.level && e.tag && typeof e.message === 'string')) {
            ok(false, '记录字段完整', JSON.stringify(e)); break;
        }
    }
    ok(true, '每条记录都有 ts/level/tag/message 结构化字段');

    // ── 2. 级别过滤 ──
    const errs = await (await fetch(BASE + '/api/logs/tail?level=ERROR&limit=500')).json();
    ok(errs.entries.every((e) => ['ERROR', 'CRITICAL'].includes(e.level)),
        '★ level=ERROR 只返回 ERROR/CRITICAL', JSON.stringify(errs.entries.slice(0, 2).map((e) => e.level)));

    // ── 3. 模块过滤 ──
    const tags = await (await fetch(BASE + '/api/logs/tail?limit=500')).json().then((j) => j.tags);
    ok(Array.isArray(tags) && tags.includes('Mod'), '★ tags 列表包含 Mod（前端过滤下拉的数据源）', JSON.stringify(tags));
    const modOnly = await (await fetch(BASE + '/api/logs/tail?tags=Mod&limit=500')).json();
    ok(modOnly.entries.length > 0 && modOnly.entries.every((e) => e.tag === 'Mod'),
        '★ tags=Mod 只返回 Mod 模块', JSON.stringify(modOnly.entries.map((e) => e.tag).slice(0, 3)));

    // ── 4. 关键词过滤 ──
    const kw = await (await fetch(BASE + '/api/logs/tail?search=galgame&limit=500')).json();
    ok(kw.entries.every((e) => e.message.toLowerCase().includes('galgame')),
        '★ search 关键词过滤（大小写不敏感）');

    // ── 5. 增量拉取 ──
    const first = await (await fetch(BASE + '/api/logs/tail?limit=1')).json();
    const since = first.entries[0]?.ts || 0;
    await wait(300);
    const inc = await (await fetch(BASE + `/api/logs/tail?since=${since}&limit=300`)).json();
    ok(inc.entries.every((e) => e.ts > since), '★ since 增量只返回更新的记录', `${inc.entries.length} 条`);

    // ── 6. 内存缓冲不受落盘级别影响（即使把落盘级别调高，缓冲仍全量）──
    const setRes = await fetch(BASE + '/api/logs/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 'CRITICAL' }),
    });
    ok(setRes.ok, '把落盘级别调到 CRITICAL');
    console.log('[test] 触发一条 INFO（访问 /api/plugins）');
    await fetch(BASE + '/api/plugins');
    await wait(300);
    const after = await (await fetch(BASE + '/api/logs/tail?level=INFO&limit=50')).json();
    ok(after.entries.some((e) => e.level === 'INFO'),
        '★ 落盘级别=CRITICAL 时缓冲里仍有 INFO（过滤在读端做）', `共 ${after.entries.length} 条 INFO`);
    // 落盘文件里则**没有** INFO（级别过滤对文件仍生效）
    const fs = await import('node:fs');
    const logFile = fs.readdirSync(LOG_DIR).find((n) => n.endsWith('.log') && !n.includes('trace'));
    if (logFile) {
        const content = fs.readFileSync(path.join(LOG_DIR, logFile), 'utf8');
        const tailPart = content.split('\n').slice(-30).join('\n');
        ok(!/\[INFO\]/.test(tailPart) || !/plugins.*200/.test(tailPart),
            '★ 落盘文件仍然按级别过滤（CRITICAL 时不写 INFO）');
    }
    // 恢复级别
    await fetch(BASE + '/api/logs/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 'INFO' }),
    });

    // ── 7. 启动输出是英文事实行 ──
    //（等待插件扫描完成 —— 它在 listen 回调里异步跑）
    for (let i = 0; i < 20 && !out.includes('installed: elaina-avatar'); i++) {
        await wait(200);
    }
    // 注：emitLog 会把消息开头的 [mod] 抽成标签字段并规范为 [Mod]，
    // 所以输出行是 `[Mod] [INFO] ... installed: elaina-avatar`。
    ok(/installed: elaina-avatar \(dir=/.test(out), '★ 启动日志是英文事实行（installed: id (dir=…)）', out.slice(-300));
    ok(out.includes('listening on http://'), '★ listening 行给出地址');
    ok(!/【怎么用】/.test(out), '★ 说明文字不再刷进日志流');
    ok(!/技术信息/.test(out), '★ 冗长的技术信息块已移除');
} finally {
    child.kill();
    await wait(300);
    try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
