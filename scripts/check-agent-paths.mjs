/**
 * 回归检查：Agent 文件操作的「真实位置」解析与目录归类。
 *
 * 为什么需要：这一块连着两个真踩过的坑 ——
 *
 * 1. **桌面不一定在 C:\Users\<用户名>\Desktop**。用户可以把桌面「移动」到任意位置
 *    （资源管理器 → 桌面属性 → 位置 → 移动），OneDrive 也会把它重定向到 OneDrive 下。
 *    实测踩过：用户的桌面在 `D:\桌面`，AI 按惯例猜 `C:\Users\Administrator\Desktop`，
 *    拿到一句「目录不存在」之后直接卡死，文件也没建成。
 *    修法是服务端从注册表读出真实位置（`/api/agent/roots` + `%DESKTOP%` 别名）。
 *
 * 2. **Windows 的 junction 既不是目录也不是文件**。`C:\Users\All Users`、
 *    `<用户>\My Documents` 这类兼容性链接在 readdir 的 Dirent 里 `isDirectory()` 为 false、
 *    `isSymbolicLink()` 为 true，旧实现把它们全标成「文件」，用户一看就觉得"和我电脑对不上"。
 *
 * 做法：真的起一次 serve.mjs（LOG_TO_FILE=0，不污染 data/logs/），打真实 HTTP 接口断言。
 * 这比抠函数体更接近实际 —— 注册表读取、路径展开、权限判定全都在真实链路上跑一遍。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
    if (!ok) console.log(`        got  = ${JSON.stringify(actual)}\n        want = ${JSON.stringify(expected)}`);
};
const note = (label, text) => console.log(`  --   ${label}: ${text}`);

/** 取一个空闲端口（先 listen(0) 再关掉，避免和用户正在跑的 4173 撞车） */
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

const port = await freePort();
const child = spawn(process.execPath, ['web/serve.mjs'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_TO_FILE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
child.stdout.on('data', (d) => { bootLog += d.toString(); });
child.stderr.on('data', (d) => { bootLog += d.toString(); });

const base = `http://127.0.0.1:${port}`;
const api = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json().catch(() => null) };
};
const ls = (p, permission) => api('/api/agent/ls?permission=' + permission + '&path=' + encodeURIComponent(p));

try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
        try { up = (await fetch(base + '/api/server-info')).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    if (!up) throw new Error('serve.mjs 没能启动：\n' + bootLog);

    // ==================== 1. 真实外壳文件夹 ====================
    const rootsRes = await api('/api/agent/roots?permission=computer');
    const roots = rootsRes.body?.roots || [];
    check('GET /api/agent/roots 返回 ok', rootsRes.body?.ok, true);
    for (const key of ['desktop', 'documents', 'downloads']) {
        check(`roots 里有 ${key}`, roots.some((r) => r.key === key), true);
    }
    const desktop = roots.find((r) => r.key === 'desktop');
    check('desktop 的 path 是绝对路径', Boolean(desktop?.path && path.isAbsolute(desktop.path)), true);
    check('desktop 路径真实存在', desktop ? statSync(desktop.path, { throwIfNoEntry: false })?.isDirectory() === true : false, true);
    note('这台机器上的桌面', desktop?.path || '(没解析出来)');

    // 权限边界：不带 permission=computer 时不能把宿主机的真实路径吐给局域网访客
    const noPerm = await api('/api/agent/roots');
    check('不带 permission 时不返回任何真实路径',
        (noPerm.body?.roots || []).every((r) => r.path === undefined), true);

    // ==================== 2. 路径别名展开 ====================
    const byAlias = await ls('%DESKTOP%', 'computer');
    check('%DESKTOP% 解析到真实桌面', byAlias.body?.path, desktop?.path);
    const byTilde = await ls('~desktop', 'computer');
    check('~desktop 解析到同一个路径', byTilde.body?.path, desktop?.path);
    const byProfile = await ls('%USERPROFILE%', 'computer');
    check('%USERPROFILE% 解析到用户目录', byProfile.body?.path, os.homedir());

    // 别名出现在路径中段也要展开（不能只认"整条路径就是一个别名"）
    const midAlias = await api('/api/agent/read?permission=computer&path='
        + encodeURIComponent('%DESKTOP%' + path.sep + '_elaina_check_missing_.txt'));
    check('别名后接文件名时也展开（404 里能看到展开后的完整路径）',
        String(midAlias.body?.message || '').includes(desktop?.path || '\u0000'), true);

    // ==================== 3. 猜错路径时要给出真实位置 ====================
    const guessed = path.join(os.homedir(), 'Desktop');
    if (statSync(guessed, { throwIfNoEntry: false })?.isDirectory()) {
        note('跳过「猜错路径」断言', `${guessed} 在这台机器上真实存在，构不成"猜错"场景`);
    } else {
        const bad = await ls(guessed, 'computer');
        check('猜错的桌面路径返回 404', bad.status, 404);
        check('404 的文案里带着真实桌面路径', String(bad.body?.message || '').includes(desktop?.path || '\u0000'), true);
    }

    // ==================== 4. 目录归类：junction 不能当成文件 ====================
    const home = await ls(os.homedir(), 'computer');
    const entries = home.body?.entries || [];
    check('能列出用户目录', entries.length > 0, true);
    check('每个条目的 type 只能是 dir/file', entries.every((e) => e.type === 'dir' || e.type === 'file'), true);
    check('每个条目都带 link 布尔标记', entries.every((e) => typeof e.link === 'boolean'), true);

    // 核心断言：凡是被标成 file 的，stat 之后都不能是目录（旧实现正是在这里把 junction 判成文件）
    const misclassified = entries
        .filter((e) => e.type === 'file')
        .filter((e) => statSync(path.join(os.homedir(), e.name), { throwIfNoEntry: false })?.isDirectory() === true)
        .map((e) => e.name);
    check('被标成 file 的条目里没有实际是目录的', misclassified.length, 0);
    if (misclassified.length) console.log('        误判:', misclassified);
    note('识别到的链接（junction）', entries.filter((e) => e.link).map((e) => e.name).join('、') || '（本机没有）');

    // ==================== 5. 权限边界：别名不能绕过限制模式 ====================
    const appMode = await ls('%DESKTOP%', 'app');
    check('限制模式下 %DESKTOP% 被拒绝（别名不能绕过权限）', appMode.status, 403);
    const traversal = await ls(path.join(projectRoot, 'web', '..', 'data'), 'app');
    check('限制模式下 web/../data 穿越被拒绝', traversal.status, 403);
    const inApp = await ls(path.join(projectRoot, 'web'), 'app');
    check('限制模式下 web/ 本身可以列出', inApp.body?.ok, true);

    // ==================== 6. 提示词注入：AI 到底知不知道真实位置 ====================
    // 这一段是**关键闭环**：服务端解析得再对，只要没进到提示词里，AI 还是照旧猜路径。
    // 用字符串切片抠出 index.html 里的真实函数体跑一遍（不复制逻辑）。
    const htmlSrc = readFileSync(path.join(projectRoot, 'web', 'index.html'), 'utf8');
    const fnStart = htmlSrc.indexOf('function agentRootsText(');
    if (fnStart < 0) throw new Error('index.html 里找不到 agentRootsText()（重命名了？请同步更新本检查）');
    let depth = 0;
    let end = htmlSrc.indexOf('{', fnStart);
    for (; end < htmlSrc.length; end++) {
        if (htmlSrc[end] === '{') depth++;
        else if (htmlSrc[end] === '}') { depth--; if (depth === 0) { end++; break; } }
    }
    const makeRootsText = new Function('state', 'agentRootsCache',
        htmlSrc.slice(fnStart, end) + '; return agentRootsText;');

    const rootsText = (permission, cache) => makeRootsText({ settings: { agentPermission: permission } }, cache)();
    check('限制模式下不注入真实位置（本来就不该翻磁盘）', rootsText('app', roots), '');
    check('缓存为空时不注入（也不能抛异常）', rootsText('computer', null), '');
    const injected = rootsText('computer', roots);
    check('允许操作电脑时把真实桌面写进提示词', injected.includes(desktop?.path || '\u0000'), true);
    check('提示词里带别名用法说明', injected.includes('%DESKTOP%'), true);
    check('提示词里明确要求不要按惯例猜路径', injected.includes('不要'), true);
    check('没有 path 的条目不会被写进提示词（局域网访客拿到的就是这种）',
        rootsText('computer', roots.map((r) => ({ ...r, path: undefined }))), '');
} catch (err) {
    fail++;
    console.log(' FAIL  检查过程中抛异常: ' + (err && err.message));
} finally {
    child.kill();
}

console.log(`\nAgent 真实位置与目录归类检查：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
