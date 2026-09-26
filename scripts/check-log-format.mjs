// 日志系统端到端检查。
//
// 为什么必须起真实服务：日志格式、脱敏、双 sink 轮转、对话追踪全是**运行时行为**，
// 静态读源码看不出"时间戳是不是本地时间""来源行号有没有指到包装函数自己"
// "流式回复有没有拼回来"这类问题 —— 而这几条恰好是最容易悄悄坏掉的。
//
// 日志写进临时目录（LOG_DIR 覆盖），不碰用户的 data/logs，也不会触发旧日志轮转删除。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { readFileSync, readdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elainachat-log-'));
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/** 让系统分配一个空闲端口 —— 写死端口号和别的进程撞上时，报错会非常难懂 */
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = createNetServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond) { pass++; return; }
    failures.push(label + (extra ? `\n      ${extra}` : ''));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 取最近写入的主日志内容。
 *
 * 必须按 mtime 而不是文件名排序：同一秒内起两个实例时，第二个的文件名是
 * `<时刻>-2.log`，而 `-`(0x2D) 排在 `.`(0x2E) 前面 —— 按名字排序会把**旧的**那个
 * 当成"最新"，于是断言全部落在错误的对象上，用例变成假阳性。
 */
function readNewestMainLog() {
    const mains = readdirSync(LOG_DIR)
        .filter((n) => n.endsWith('.log') && !n.includes('.trace.'))
        .map((n) => ({ n, m: statSync(path.join(LOG_DIR, n)).mtimeMs }))
        .sort((a, b) => a.m - b.m);
    if (!mains.length) return '';
    return readFileSync(path.join(LOG_DIR, mains[mains.length - 1].n), 'utf8');
}

// ---------- mock 上游 ----------
const UPSTREAM_PORT = await freePort();
// 「连不上」用一个刚被释放的空闲端口 —— 写死一个号可能恰好被别的程序占着，那样这条用例就变成假阳性
const DEAD_PORT = await freePort();
const upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const send = (code, obj, type = 'application/json; charset=utf-8') => {
            res.writeHead(code, { 'content-type': type });
            res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
        };
        if (req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: 'a' }] });
        if (req.url === '/v1/chat/normal') {
            return send(200, {
                id: 'cmpl-1', model: 'test-model',
                choices: [{ message: { role: 'assistant', content: '你好呀，我是伊蕾娜。\n今天想去哪儿？' } }],
            });
        }
        if (req.url === '/v1/chat/bad') {
            return send(400, { detail: { error: { message: '模型 test-model 不存在，请改用 DeepSeek-V4-Flash' } } });
        }
        if (req.url === '/v1/chat/sse') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":"，第二段。"}}]}\n\n');
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        if (req.url === '/v1/chat/sse-err') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: {"error":{"message":"当前分组上游负载已饱和，请稍后再试"}}\n\n');
            return res.end();
        }
        return send(404, { error: { message: 'no route' } });
    });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

/** 起一次 serve.mjs，等端口就绪。每个场景用不同端口 —— 刚 kill 掉的进程端口未必立刻释放 */
async function startServer(extraEnv, port) {
    const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_DIR, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    for (let i = 0; i < 75; i++) {
        try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.status) return { child, getOut: () => out }; }
        catch { await wait(200); }
    }
    child.kill();
    throw new Error('服务没能启动：\n' + out);
}

// ================= 场景一：完整跑一遍各类请求 =================
const PORT = await freePort();
const { child, getOut } = await startServer({}, PORT);

async function relay(body) {
    try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/relay`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: r.status, text: await r.text() };
    } catch (e) { return { status: 0, text: String(e.message) }; }
}

const chatBody = (model) => ({
    model, stream: false, temperature: 0.8,
    messages: [
        { role: 'system', content: '你是伊蕾娜，一个爱撒娇的魔女。' },
        { role: 'user', content: '今天天气怎么样？' },
        { role: 'assistant', content: '嗯……阳光很好呢。' },
        { role: 'user', content: '那我们去哪儿玩？' },
    ],
});
const target = (p) => `http://127.0.0.1:${UPSTREAM_PORT}${p}`;
const post = (p, body) => ({
    url: target(p), method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

await relay(post('/v1/chat/normal', chatBody('test-model')));
await relay(post('/v1/chat/bad', chatBody('test-model')));
await relay(post('/v1/chat/sse', chatBody('test-model')));
await relay(post('/v1/chat/sse-err', chatBody('test-model')));
await relay({ url: target('/v1/models'), method: 'GET' });
await relay({ url: `http://127.0.0.1:${DEAD_PORT}/v1/chat/completions`, method: 'POST', body: JSON.stringify(chatBody('test-model')) });
await relay({ url: 'not-a-url', method: 'POST' });
await wait(700);
child.kill();
await wait(200);

const consoleOut = getOut();
const files = readdirSync(LOG_DIR).filter((n) => n.endsWith('.log'));
const mainName = files.find((n) => !n.includes('.trace.'));
const traceName = files.find((n) => n.includes('.trace.'));
ok(!!mainName, '主日志文件已生成');
ok(!!traceName, '追踪日志文件已生成');
if (!mainName || !traceName) {
    console.log('主日志:', files);
    console.log(consoleOut);
    process.exit(1);
}

const main = readFileSync(path.join(LOG_DIR, mainName), 'utf8');
const trace = readFileSync(path.join(LOG_DIR, traceName), 'utf8');
const mainLines = main.split('\n').filter((l) => l !== '');

// ---- 格式 ----
//
// ★ 2026-09 起，主日志里**允许出现不带前缀的续行**。
//
//   为什么改：诊断块（启动横幅 / 检查清单 / 问题报告）是多行的，
//   它们存在的意义就是"让人一眼看懂"。旧实现无条件把换行压成 `⏎`，
//   压完完全没法读 —— 而用户的要求恰恰是"不懂这软件也能从日志看懂"。
//   现在的约定：
//     · 每条记录的**首行**必须带完整前缀（时间/标签/级别/来源）→ grep 仍可用
//     · 续行不带前缀，但必须**有缩进**（视觉上属于上一条记录）
//   所以断言拆成两条：首行必须合规；不带前缀的行必须缩进。
const LINE_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[[A-Za-z0-9]+\] \[(DBUG|INFO|WARN|ERRO|CRIT)\]( \[v[^\]]+\])? \[[a-z0-9_.-]+:\d+\]: \s*\S/;
const headLines = mainLines.filter((l) => LINE_RE.test(l));
const contLines = mainLines.filter((l) => !LINE_RE.test(l));
ok(headLines.length > 0, '主日志有合规的记录首行');
// 续行必须缩进**或以分隔线开头**。
// 为什么允许分隔线：横幅用 `====` 框住，那是刻意的视觉分隔；
// 强行缩进反而不像分隔线了。除这两种之外，裸文本行都算格式错误
// （因为它无法从视觉上归属到某条记录）。
const badCont = contLines.filter((l) => !/^\s+\S/.test(l) && !/^=+$/.test(l));
ok(badCont.length === 0, '不带前缀的续行都有缩进或分隔线（能归属到上一条记录）',
    badCont.slice(0, 3).join('\n      '));
// 首行必须是**记录开头**：它前面不能紧跟另一个首行之外的裸文本行（粗判）
ok(mainLines.length > 0, '主日志有内容');
ok(!main.includes('⏎'), '主日志里没有压平标记 ⏎（多行结构被保留）');
// 至少有一个多行诊断块，否则说明多行能力退化了
ok(contLines.length > 0, '★ 存在多行诊断块（说明多行结构确实被保留，没被压成一行）');

// ---- 时间是本地时间（旧实现用 toISOString，差了 8 小时）----
const first = headLines[0].match(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
ok(!!first, '首行带完整时间戳');
if (first) {
    const t = new Date(+first[1], +first[2] - 1, +first[3], +first[4], +first[5], +first[6]).getTime();
    const skew = Math.abs(Date.now() - t);
    ok(skew < 120000, '日志时间戳是本地时间（不是 UTC）', `偏差 ${Math.round(skew / 1000)} 秒`);
    // 文件名里的时刻要和行内时刻同源，否则"哪次启动"和"什么时候"对不上
    const stamp = mainName.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    ok(!!stamp && stamp[1] === `${first[1]}-${first[2]}-${first[3]}` && stamp[2] === first[4],
        '文件名时刻与日志内时间戳一致', `${mainName} vs ${first[0]}`);
}

// ---- 级别 ----
const warnPlus = headLines.filter((l) => /\[(WARN|ERRO|CRIT)\]/.test(l));
ok(warnPlus.length > 0, '有 WARN/ERRO 级别记录');
ok(warnPlus.every((l) => l.includes(`[v${VERSION}]`)), 'WARN 及以上带版本号');
const infoLines = headLines.filter((l) => l.includes('[INFO]'));
ok(infoLines.length > 0 && infoLines.every((l) => !l.includes('[v')), 'INFO 不带版本号（不制造噪音）');

// ---- 来源行号：必须是真的调用点，不能全指到包装函数自己 ----
const locs = [...main.matchAll(/\[(serve):(\d+)\]/g)].map((m) => Number(m[2]));
ok(locs.length === headLines.length, '每条记录首行都带来源位置',
    `${locs.length} 个位置 vs ${headLines.length} 个首行`);
ok(new Set(locs).size > 3, '来源行号能区分不同调用点（不是全指向包装层）', `去重后只有 ${new Set(locs).size} 个位置`);

// ---- 脱敏 ----
//
// ★ 这段是本次重做日志时**真正抓到问题**的地方，保留并加强：
//   文案一改（密码从"访问密码: xxx"变成独占一行），脱敏就可能失效，
//   而失效的后果是**明文密码落盘**。所以这里不只测当前格式，
//   把几种历史格式都测一遍 —— 防止以后改文案时又漏。
{
    // 从 serve.mjs 直接取真实规则，避免测试与实现各写一份
    const src = readFileSync(new URL('../web/serve.mjs', import.meta.url), 'utf8');
    const rm = src.match(/const SECRET_RULES = \[([\s\S]*?)\n\];/);
    ok(!!rm, '能取到 serve.mjs 的脱敏规则');
    if (rm) {
        const rules = eval('[' + rm[1] + ']');
        const redact = (t) => { let o = String(t); for (const [re, to] of rules) o = o.replace(re, to); return o; };
        const S = 'EPzNwvKXNWdt';
        const forms = [
            ['英文事实行（当前格式）', 'LAN access password (initial, change it in Settings): ' + S],
            ['密码独占一行', '要输这个密码\n      ' + S + '\n      建议改掉'],
            ['带修饰语的标签', '局域网访问密码（初始随机）：' + S],
            ['最老格式', '访问密码: ' + S],
            ['key=value', '{"password":"' + S + '"}'],
            ['Bearer', 'Authorization: Bearer ' + S + 'abcdefgh'],
        ];
        for (const [label, text] of forms) {
            ok(!redact(text).includes(S), `★ 脱敏有效：${label}`);
        }
        // 反向：正常内容不能被误伤
        const normal = 'installed: elaina-avatar (dir=elaina-avatar)';
        ok(redact(normal) === normal, '★ 正常内容不被误伤（脱敏不过度）');
    }

    const pw = consoleOut.match(/access password[^:\n]*:\s*(\S+)/i)
        || consoleOut.match(/访问密码[^：:\n]{0,20}[:：]\s*(\S+)/)
        || consoleOut.match(/要输这个密码\s*\n\s*(\S+)/);
    ok(!!pw, '控制台打印了访问密码（用户要靠它登录）');
    ok(pw && !main.includes(pw[1]), '★ 日志文件里没有明文访问密码（脱敏对文案变化仍有效）');
    // 反向断言：日志里必须能看到"已脱敏"的痕迹，否则可能是整条都没记
    ok(main.includes('******') || main.includes('user-configured'),
        '日志里能看到脱敏后的占位符（或"已由用户设置"的事实行）');
}

// ---- 控制台不重复输出 ----
ok(consoleOut.split('\n').filter((l) => l.includes('ElainaChat Mod v')).length === 1,
    '控制台每条日志只输出一次（没有"原文 + 格式化"两份）');
// eslint-disable-next-line no-control-regex
ok(!/\x1b\[/.test(consoleOut), '非 TTY 控制台不带 ANSI 颜色码');

// ---- 对话摘要 ----
// 4 次对话请求 + 1 次"连不上"（它也是对话请求，同样要记下问了什么）
const askCount = mainLines.filter((l) => l.includes('[Chat]') && l.includes('提问：')).length;
ok(askCount === 5, '每次对话请求都留一条「提问」摘要（含连不上的那次）', `实际 ${askCount}`);
ok(main.includes('提问：那我们去哪儿玩？'), '提问摘要是最后一条用户消息');
// 只有正常对话和流式对话成功；上游 400 / SSE 内报错 / 连不上 都不该出现「回复」
ok(mainLines.filter((l) => l.includes('回复：')).length === 2, '只有真正成功的请求才留「回复」摘要');

// ---- 报错原因直接写在主日志那一行 ----
ok(main.includes('<< 上游报错：模型 test-model 不存在，请改用 DeepSeek-V4-Flash'),
    '上游 4xx 的原因被挖出来写进主日志');
ok(main.includes('<< 响应内报错：当前分组上游负载已饱和'), '200 + SSE 内报错也能识别');
ok(/\[ERRO\][^\n]*ECONNREFUSED/.test(main), '连不上时记录 ECONNREFUSED（能区分 DNS/TLS/拒绝）');
ok(/\[WARN\][^\n]*目标地址无效/.test(main), '非法地址被拒绝时留下 WARN');

// ---- 追踪日志：完整内容 ----
ok(trace.includes('你是伊蕾娜，一个爱撒娇的魔女。'), '追踪日志含完整 system 提示');
ok(trace.includes('今天天气怎么样？'), '追踪日志含完整历史消息');
ok(trace.includes('你好呀，我是伊蕾娜。\n今天想去哪儿？'), '追踪日志含完整回复原文（换行保留）');
ok(trace.includes('{"detail":{"error":{"message":"模型 test-model 不存在'), '追踪日志含完整上游报错响应体');
ok(trace.includes('第一段，第二段。'), '流式回复被拼回完整正文');
ok(!trace.includes('⏎'), '追踪日志多行原样保留（不压行）');
ok(trace.includes('===== 请求失败'), '连不上时也记下当时问的是什么');
ok(!trace.includes('"object":"list"'), '非对话接口（获取模型）的响应体不灌进追踪日志');

// ================= 场景二：LOG_TO_FILE=0 =================
const { child: child2, getOut: out2 } = await startServer({ LOG_TO_FILE: '0' }, await freePort());
await wait(300);
child2.kill();
await wait(200);
ok(readdirSync(LOG_DIR).filter((n) => n.endsWith('.log')).length === 2,
    'LOG_TO_FILE=0 时不产生新日志文件（自动化场景要能关掉落盘）');
// 不落盘时也要如实说明 —— 用户看到"没有日志文件"时得知道是配置关掉了，
// 而不是以为日志功能坏了。说明在启动头的 log file 行里（英文事实行）。
ok(/disabled \(LOG_TO_FILE=0\)/.test(out2()) || /不落盘/.test(out2()),
    'LOG_TO_FILE=0 时明确说明了"不落盘"');

// ================= 场景四：控制台级别门（2026-09 新增）=================
// 用户要求："大量无用日志耽误排查进度" —— 成功请求归 DEBUG，
// 控制台默认 INFO，所以日常窗口不刷请求行；切 DEBUG（或 LOG_CONSOLE）才全量。
{
    const port4 = await freePort();
    const { child: c4, getOut: out4 } = await startServer({ LOG_TO_FILE: '0' }, port4);
    await wait(400);
    await fetch(`http://127.0.0.1:${port4}/api/plugins`).catch(() => {});
    await fetch(`http://127.0.0.1:${port4}/api/server-info`).catch(() => {});
    await wait(400);
    // ① 默认（INFO）：成功请求不刷屏
    ok(!/\[HTTP\]/.test(out4()), '★ 默认控制台级别下，成功请求不刷屏（[HTTP] 行消失）');
    ok(/listening on http:\/\//.test(out4()), '启动事件仍然可见');
    c4.kill();
    await wait(300);

    // ② LOG_CONSOLE=DEBUG：全量回归（旧行为）
    const port5 = await freePort();
    const { child: c5, getOut: out5 } = await startServer({ LOG_TO_FILE: '0', LOG_CONSOLE: 'DEBUG' }, port5);
    await wait(400);
    await fetch(`http://127.0.0.1:${port5}/api/plugins`).catch(() => {});
    await wait(400);
    ok(/\[HTTP\]/.test(out5()), '★ LOG_CONSOLE=DEBUG 时请求行可见（排查模式）');
    c5.kill();
    await wait(300);

    // ③ 失败请求在任何控制台级别都可见（WARN > INFO）
    const port6 = await freePort();
    const { child: c6, getOut: out6 } = await startServer({ LOG_TO_FILE: '0' }, port6);
    await wait(400);
    await fetch(`http://127.0.0.1:${port6}/api/definitely-not-exist`).catch(() => {});
    await wait(400);
    ok(/\[HTTP\].*404/.test(out6()), '★ 4xx 是 WARN，任何控制台级别下都可见');
    c6.kill();
    await wait(300);
}

// ================= 场景三：LOG_CHAT=0 =================
const { child: child3 } = await startServer({ LOG_CHAT: '0' }, await freePort());
await wait(300);
child3.kill();
await wait(200);
ok(readdirSync(LOG_DIR).filter((n) => n.includes('.trace.')).length === 1,
    'LOG_CHAT=0 时不生成追踪日志（只记录访问与错误摘要）');

// ================= 场景四：落盘级别过滤 =================
//
// 这是本轮改造的核心：**终端始终全量，级别只用来收窄文件**。
// 三条边界必须一起验，少验一条就会出现"终端也被静音"或"级别设了没用"。
{
    const port = await freePort();
    const { child: c, getOut: out } = await startServer({ LOG_LEVEL: 'WARN' }, port);
    // 触发一次 INFO（200）和一次 WARN（404）
    await fetch(`http://127.0.0.1:${port}/api/server-info`).catch(() => {});
    await fetch(`http://127.0.0.1:${port}/api/definitely-missing`).catch(() => {});
    await wait(400);
    c.kill();
    await wait(200);

    // 找到这次启动的主日志（按 mtime，同秒起两个实例时文件名排序不可靠）
    const text = readNewestMainLog();
    ok(!/\[INFO\][^\n]*server-info/.test(text),
        'LOG_LEVEL=WARN 时 INFO 记录不落盘（级别真的在过滤文件）');
    ok(/\[WARN\]/.test(text), 'LOG_LEVEL=WARN 时 WARN 仍然落盘');
    // 同一进程的控制台必须仍然有 INFO —— 否则"终端看全量"这个承诺是假的
    ok(/\[INFO\]/.test(out()), 'LOG_LEVEL=WARN 时控制台仍有 INFO（终端始终全量）');
}

// ================= 场景五：运行时改级别 + 对话追踪开关 =================
{
    const port = await freePort();
    const { child: c, getOut: out } = await startServer({ LOG_LEVEL: 'ERROR' }, port);
    // 1) 在 ERROR 级别下打一次 INFO 请求 —— 不该落盘
    await fetch(`http://127.0.0.1:${port}/api/server-info`).catch(() => {});
    await wait(200);

    const settingsUrl = `http://127.0.0.1:${port}/api/logs/settings`;
    const before = await (await fetch(settingsUrl)).json();
    ok(before.ok && before.level === 'ERROR', 'GET /api/logs/settings 返回当前级别');
    ok(Array.isArray(before.levels) && before.levels.length === 5,
        '接口给出五个级别（DEBUG/INFO/WARN/ERROR/CRITICAL）');

    // 2) 运行时改成 DEBUG
    const patched = await (await fetch(settingsUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 'DBUG' }),
    })).json();
    ok(patched.ok && patched.level === 'DEBUG', 'POST 接受 AstrBot 短名 DBUG 并归一成 DEBUG');

    // 3) 现在同样的 INFO 请求该落盘了 —— 证明改级别**无需重启**就生效
    await fetch(`http://127.0.0.1:${port}/api/server-info`).catch(() => {});
    // 4) 关掉对话追踪
    const off = await (await fetch(settingsUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trace: false }),
    })).json();
    ok(off.ok && off.trace === false, 'POST 能关闭对话追踪');

    // 5) 非法级别必须被拒绝，且不能悄悄改掉当前值
    const badRes = await fetch(settingsUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: '不存在的级别' }),
    });
    ok(badRes.status === 400, '非法级别返回 400（而不是静默接受）');
    const after = await (await fetch(settingsUrl)).json();
    ok(after.level === 'DEBUG', '非法级别被拒后当前级别保持不变');

    await wait(400);
    c.kill();
    await wait(200);

    const text = readNewestMainLog();
    const hits = (text.match(/server-info/g) || []).length;
    ok(hits === 1, '改级别后新产生的 INFO 才落盘（改之前那条没有）', `实际出现 ${hits} 次`);
    ok(/\[CRIT\]/.test(out()) === false, '本次没有 CRITICAL（不该凭空造出 CRITICAL）');
}

// ================= 场景六：CRITICAL 真的有产生路径 =================
//
// 之前 LEVEL_SHORT / LEVEL_NO / LEVEL_COLOR 都定义了 CRITICAL，却没有任何代码能产生它 ——
// 是死配置。这条用例锁住"它真的能被触发"，防止又退回成摆设。
{
    const busyPort = await freePort();
    // 兼容入口的端口也自己分配：默认 4174 可能正被用户真实的实例占着，
    // 那样"第二个实例启动失败"就不是因为端口冲突，用例会假阳性。
    const httpsPort = await freePort();
    const first = await startServer(
        { LOG_LEVEL: 'DEBUG', HTTPS_PORT: String(httpsPort) }, busyPort);
    // 再起一个抢同一个端口 → 必然 EADDRINUSE
    const second = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(busyPort), HOST: '127.0.0.1',
            LOG_DIR, HTTPS_PORT: String(httpsPort),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out2 = '';
    second.stdout.on('data', (d) => { out2 += d; });
    second.stderr.on('data', (d) => { out2 += d; });
    await wait(1500);
    second.kill();
    first.child.kill();
    await wait(200);
    ok(/\[CRIT\]/.test(out2), '端口被占用时产生 CRITICAL 记录（级别不是死配置）', out2.slice(-300));
}

upstream.close();

// ---------- 结果 ----------
console.log(`\n日志系统检查：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
}
