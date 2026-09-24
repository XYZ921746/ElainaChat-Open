// 安全加固回归：写入黑名单的扩展名判定 + 中转的内网地址判定 + 页面防嵌套头。
//
// 为什么必须有这个脚本：
//
//   1. agentWrite 的 BLOCKED_EXT 曾经直接用 `path.extname(target)` 判定。Windows 上有
//      三种写法让 extname 看到的**不是**最终落盘名，黑名单被整体绕过（实测可复现）：
//        x.html::$DATA  → NTFS 交换数据流，落盘就是 x.html，静态服务照样当 HTML 执行
//        x.html.        → 尾随点被 Windows 丢掉，落盘 x.html
//        x.html␠       → 尾随空格同理
//      这是**存储型 XSS**：AI（或任何能调 /api/agent/write 的人）可以把脚本写进 web/，
//      再诱导用户打开同源页面。nosniff / X-Frame-Options 都拦不住 —— 它是同源的。
//
//   2. /api/relay 的内网判定曾经按字符串前缀比较，漏掉 IPv4-mapped IPv6：
//      `::ffff:127.0.0.1` 连的就是 127.0.0.1，但既不 startsWith('127.') 也不是 '::1'，
//      isPrivateIPv4 又因 split('.') 长度不对而返回 false → SSRF 防护失效。
//
// 两者都是"看代码觉得没问题、只有真跑才暴露"的类型，所以这里既做函数级矩阵，
// 也起真实服务做端到端验证。
//
// 用法：node scripts/check-security-hardening.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(ROOT, 'web', 'serve.mjs');
const src = readFileSync(SERVE, 'utf8');
const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elainachat-sec-'));
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elainachat-sec-data-'));

/**
 * 取一个**私有网段**的本机网卡地址，用它发请求才会走"非本机"分支。
 *
 * 必须限定 RFC1918：像 Radmin VPN 这类虚拟网卡用的是 26.x 这种公网段，
 * 从那种地址发起的请求，relay 判它"不是内网"而放行是**正确**的
 * （而且局域网设备本来就能直连该地址，中转过去不多给任何权限）。
 */
function lanAddress() {
    const isPrivate = (ip) => {
        const p = ip.split('.').map(Number);
        return p[0] === 10
            || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
            || (p[0] === 192 && p[1] === 168);
    };
    for (const list of Object.values(networkInterfaces())) {
        for (const ni of list || []) {
            if (ni.family === 'IPv4' && !ni.internal && isPrivate(ni.address)) return ni.address;
        }
    }
    return '';
}

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, label, extra) => {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

function freePort() {
    return new Promise((resolve, reject) => {
        const s = createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按花括号配对切出一个具名函数（serve.mjs 不是模块，只能这样取） */
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

// ============================================================ 1. 函数级：扩展名判定
console.log('=== 1. 写入黑名单：扩展名判定必须看"最终落盘名" ===');
{
    // 解压实现合并后，BLOCKED_EXT / effectiveExt 移到了 server/zip.mjs
    // （危险类型清单属于"解压"的安全约束，跟着实现走）；
    // isBlockedWritePath 仍留在 serve.mjs（它服务的是 agentWrite）。
    // 所以两个文件都要读。
    const zipSrc = readFileSync(path.join(ROOT, 'server', 'zip.mjs'), 'utf8');
    const need = ['effectiveExt', 'isBlockedWritePath', 'BLOCKED_EXT'];
    const missing = need.filter((n) => (n === 'BLOCKED_EXT'
        ? !/const BLOCKED_EXT = new Set\(\[/.test(zipSrc)
        : (n === 'effectiveExt' ? !extractFn(zipSrc, n) : !extractFn(src, n))));
    ok(missing.length === 0, '能找到 effectiveExt（zip.mjs）/ isBlockedWritePath（serve.mjs）/ BLOCKED_EXT（zip.mjs）',
        missing.length ? '缺少：' + missing.join(', ') : '');

    if (!missing.length) {
        // BLOCKED_EXT 常量单独切出来（到 `]);` 为止）
        const setStart = zipSrc.indexOf('const BLOCKED_EXT = new Set([');
        const setEnd = zipSrc.indexOf(']);', setStart) + 3;
        const ctx = vm.createContext({ path, console });
        vm.runInContext(
            zipSrc.slice(setStart, setEnd) + '\n'
            + extractFn(zipSrc, 'effectiveExt') + '\n'
            + extractFn(src, 'isBlockedWritePath') + '\n'
            + 'this.__blocked = isBlockedWritePath; this.__ext = effectiveExt;',
            ctx
        );

        // ① 必须拦住的（含全部绕过写法）
        const mustBlock = [
            'x.html', 'x.HTML', 'x.htm', 'x.xhtml', 'x.shtml', 'x.hta', 'x.mhtml',
            'x.js', 'x.mjs', 'x.cjs', 'x.jsx', 'x.ts',
            'x.svg', 'x.xml', 'x.xsl',
            'x.exe', 'x.dll', 'x.com', 'x.scr', 'x.msi', 'x.bat', 'x.cmd',
            'x.ps1', 'x.psm1', 'x.vbs', 'x.wsf', 'x.jar', 'x.sh',
            // ★ 这三种是本次修复的核心：extname 看不见，但落盘就是可执行类型
            'x.html.', 'x.html ', 'x.html. ',
            'x.html::$DATA', 'x.HTML::$DATA', 'x.js::$DATA', 'x.svg::$DATA',
            'x.html:ads.txt',
        ];
        for (const n of mustBlock) {
            ok(ctx.__blocked('D:/web/' + n) === true, '拦截 ' + JSON.stringify(n));
        }

        // ② 正常文本必须放行（别把功能修死）
        for (const n of ['note.txt', 'a.md', 'data.json', 'x.csv', 'readme', '中文名.txt', 'a.b.txt']) {
            ok(ctx.__blocked('D:/web/' + n) === false, '放行 ' + JSON.stringify(n));
        }

        // ③ 直接证明"修复前的判据会漏" —— 这条防止有人把实现改回 extname
        const naive = (n) => ['.html', '.js', '.svg'].includes(path.extname(n).toLowerCase());
        ok(naive('x.html::$DATA') === false,
            '★ 记录绕过原理：朴素 extname 判不出 x.html::$DATA（改回去就会漏）');
        ok(ctx.__blocked('D:/web/x.html::$DATA') === true, '★ 修复后的判据能判出 x.html::$DATA');
    }
}

// ============================================================ 2. 函数级：内网地址判定
console.log('\n=== 2. 中转内网判定：必须覆盖 IPv4-mapped IPv6 ===');
{
    const fns = ['isPrivateIPv4', 'mappedIPv4', 'isInternalAddress'];
    const missing = fns.filter((n) => !extractFn(src, n));
    ok(missing.length === 0, 'serve.mjs 里能找到 isPrivateIPv4 / mappedIPv4 / isInternalAddress',
        missing.length ? '缺少：' + missing.join(', ') : '');

    if (!missing.length) {
        const ctx = vm.createContext({ console });
        vm.runInContext(
            fns.map((n) => extractFn(src, n)).join('\n')
            + '\nthis.__internal = isInternalAddress;',
            ctx
        );

        const mustBlock = [
            '127.0.0.1', '127.1.2.3',
            '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
            '169.254.169.254', '0.0.0.0',
            '::1', '::',
            // ★ 本次修复的核心
            '::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:127.0.0.1]',
            '::ffff:192.168.1.1', '::ffff:10.0.0.1',
            'fe80::1', 'fd00::1', 'fc00::1',
        ];
        for (const ip of mustBlock) {
            ok(ctx.__internal(ip) === true, '判为内网 ' + JSON.stringify(ip));
        }

        const mustPass = [
            '8.8.8.8', '1.1.1.1',
            '172.32.0.1', '172.15.0.1',   // 172.16-31 之外是公网，别误伤
            '11.0.0.1',
            '2001:4860:4860::8888', '::ffff:8.8.8.8',
        ];
        for (const ip of mustPass) {
            ok(ctx.__internal(ip) === false, '判为公网 ' + JSON.stringify(ip));
        }

        // 记录绕过原理：朴素前缀比较漏掉 mapped 地址
        const naive = (a) => a === '::1' || a.startsWith('127.')
            || (String(a).split('.').length === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
        ok(naive('::ffff:127.0.0.1') === false, '★ 记录绕过原理：朴素前缀比较漏掉 ::ffff:127.0.0.1');
    }
}

// ============================================================ 3. 端到端：真实服务
console.log('\n=== 3. 端到端：起真实服务验证 ===');
const PORT = await freePort();
const PROBE = '__sec_probe';
let child = null;
try {
    child = spawn(process.execPath, [SERVE], {
        cwd: ROOT,
        // DATA_DIR 必须隔离：否则跑一次检查就会动用户真实的 data/（密码、会话、store）
        env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LOG_DIR, DATA_DIR },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    let ready = false;
    for (let i = 0; i < 75; i++) {
        try { const r = await fetch(`http://127.0.0.1:${PORT}/api/server-info`); if (r.status) { ready = true; break; } }
        catch { await wait(200); }
    }
    ok(ready, '服务已就绪', ready ? '' : out.slice(-500));

    if (ready) {
        const write = async (rel) => {
            const r = await fetch(`http://127.0.0.1:${PORT}/api/agent/write`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path: rel, content: '<script>document.title="PWNED"</script>', permission: 'app' }),
            });
            return r.status;
        };

        // ① 全部绕过写法都必须 400
        for (const name of [PROBE + '.html', PROBE + '.html.', PROBE + '.html ',
            PROBE + '.html. ', PROBE + '.html::$DATA', PROBE + '.HTML::$DATA',
            PROBE + '.js::$DATA', PROBE + '.svg::$DATA', PROBE + '.html:ads.txt']) {
            const st = await write('web/' + name);
            ok(st === 400, 'HTTP 400 拦截 web/' + name, '实得 ' + st);
        }

        // ② 磁盘上不许出现探针（这是真正要防的后果）
        const leaked = readdirSync(path.join(ROOT, 'web')).filter((f) => f.startsWith(PROBE));
        ok(leaked.length === 0, '★ web/ 内没有落盘任何探针文件', leaked.join(', '));

        // ③ 静态服务取不到探针
        const served = await fetch(`http://127.0.0.1:${PORT}/${PROBE}.html`);
        ok(served.status === 404, '★ 静态服务取不到 /' + PROBE + '.html', '实得 ' + served.status);

        // ④ 正常文本仍要能写（别把功能修死）
        const okStatus = await write('web/' + PROBE + '_ok.txt');
        ok(okStatus === 200, '正常文本文件仍可写入（功能没修坏）', '实得 ' + okStatus);
        const okPath = path.join(ROOT, 'web', PROBE + '_ok.txt');
        ok(existsSync(okPath), '文本文件确实落盘了');

        // ⑤ 登录页防嵌套头
        const login = await fetch(`http://127.0.0.1:${PORT}/login`);
        ok(login.headers.get('x-frame-options') === 'DENY', '/login 带 X-Frame-Options: DENY',
            String(login.headers.get('x-frame-options')));
        ok(login.headers.get('referrer-policy') === 'no-referrer', '/login 带 Referrer-Policy');
        ok(login.headers.get('x-content-type-options') === 'nosniff', '/login 带 X-Content-Type-Options');

        // ⑥ 应用页面本身不能被 iframe 嵌套
        const home = await fetch(`http://127.0.0.1:${PORT}/`);
        ok(home.status === 200, '首页仍可访问', '实得 ' + home.status);
        ok(home.headers.get('x-frame-options') === 'DENY', '首页带 X-Frame-Options: DENY');

        // ⑦ 本机访问本机服务（Ollama 场景）必须仍然放行
        const relayLocal = await fetch(`http://127.0.0.1:${PORT}/api/relay`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: `http://127.0.0.1:${PORT}/api/server-info`, method: 'GET', timeoutMs: 5000 }),
        });
        const relayBody = await relayLocal.json().catch(() => null);
        ok(!(relayBody && relayBody.relayError),
            '本机经中转访问本机服务仍放行（否则 Ollama 会挂）',
            relayBody && relayBody.message);
    }
} finally {
    if (child) { child.kill(); await wait(300); }
    // 清理探针，别把仓库弄脏
    for (const f of readdirSync(path.join(ROOT, 'web'))) {
        if (f.startsWith(PROBE)) {
            try { rmSync(path.join(ROOT, 'web', f), { force: true }); } catch { /* ignore */ }
        }
    }
    rmSync(LOG_DIR, { recursive: true, force: true });
    rmSync(DATA_DIR, { recursive: true, force: true });
}

// ============================================================ 4. 端到端：SSRF 的调用点
//
// 为什么单独起一个服务、并从**局域网地址**发请求：
// 上面第 2 节只验证了 isInternalAddress 这个函数本身对不对。但函数对、调用点没接上
// （或者调用点还留着旧的朴素比较），防护照样是失效的 —— 这条就是专门堵这个缺口：
// 从非回环地址发请求，才会走 handleRelay 里"非本机"那条分支。
console.log('\n=== 4. 端到端：从局域网地址发起，SSRF 拦截必须真的生效 ===');
{
    const LAN = lanAddress();
    if (!LAN) {
        // 没有非回环网卡时（极简容器）跳过，但明确说出来，不静默通过
        console.log('  SKIP  本机没有非回环 IPv4 网卡，无法构造"非本机来源"，本节跳过');
    } else {
        const port = await freePort();
        let kid = null;
        try {
            kid = spawn(process.execPath, [SERVE], {
                cwd: ROOT,
                env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', DATA_DIR, LOG_DIR },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            kid.stdout.on('data', (d) => { out += d; });
            kid.stderr.on('data', (d) => { out += d; });

            let up = false;
            for (let i = 0; i < 75; i++) {
                try { const r = await fetch(`http://${LAN}:${port}/api/server-info`); if (r.status) { up = true; break; } }
                catch { await wait(200); }
            }
            ok(up, '服务已就绪（经局域网地址 ' + LAN + ' 访问）', up ? '' : out.slice(-400));

            if (up) {
                // 非本机访问必须登录
                const pwd = (out.match(/访问密码[:：]\s*(\S+)/) || [])[1] || '';
                const login = await fetch(`http://${LAN}:${port}/api/auth/login`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ password: pwd }),
                });
                const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
                ok(login.status === 200 && Boolean(cookie), '以局域网身份登录成功（后续才能调中转）', 'HTTP ' + login.status);

                const relay = async (url) => {
                    const r = await fetch(`http://${LAN}:${port}/api/relay`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', cookie },
                        body: JSON.stringify({ url, method: 'GET', timeoutMs: 4000 }),
                    });
                    // 必须同时留原文：内网靶子返回的是 text/plain，只按 JSON 解析会得到 null，
                    // 于是"内容有没有泄漏"这条断言会变成永远通过的空断言。
                    const raw = await r.text();
                    let body = null;
                    try { body = JSON.parse(raw); } catch { /* 非 JSON，原文留在 raw 里 */ }
                    return { status: r.status, body, raw };
                };

                // ★ 关键：用一台**没有任何 Host 白名单**的内网服务当靶子。
                //   拿本应用自己的端口当靶子是不严谨的 —— 那个端口还有 Host 白名单兜底，
                //   即使 SSRF 判定失效也拦得住，于是测试会因为"另一道防线"而失败，
                //   掩盖了 SSRF 判定本身坏掉这件事。Ollama 这类服务才是真实威胁：
                //   它就住在 127.0.0.1，且没有任何别的防护。
                const SECRET = 'INTERNAL-SECRET-DO-NOT-LEAK';
                const internal = createHttpServer((req, res) => {
                    res.writeHead(200, { 'content-type': 'text/plain' });
                    res.end(SECRET);
                });
                const internalPort = await freePort();
                await new Promise((r) => internal.listen(internalPort, '127.0.0.1', r));

                try {
                    // ★ 这些必须被拦。前两条是本次修复的核心：它们**连的就是 127.0.0.1**，
                    //   但字面前缀比较看不见，只有"解析成 IP 再规范化判定"才拦得住。
                    const mustBlock = [
                        `http://127.0.0.1:${internalPort}/`,
                        `http://[::ffff:127.0.0.1]:${internalPort}/`,
                        `http://[::ffff:7f00:1]:${internalPort}/`,
                        `http://${LAN}:${internalPort}/`,
                        'http://169.254.169.254/latest/meta-data/',
                    ];
                    for (const u of mustBlock) {
                        const r = await relay(u);
                        ok(Boolean(r.body && r.body.relayError),
                            '★ 拦截非本机发起的 ' + u, 'HTTP ' + r.status + ' ' + (r.body && r.body.message || ''));
                    }

                    // ★ 最强的一条：内网服务的**响应内容**绝不能经中转漏出来。
                    //   这条不看状态码，直接看有没有泄密 —— 即使上面的拦截被绕过、换了种报错方式，
                    //   只要秘密没漏出去就还算安全，反之则是实打实的 SSRF。
                    let leaked = false;
                    for (const u of [`http://[::ffff:127.0.0.1]:${internalPort}/`, `http://127.0.0.1:${internalPort}/`]) {
                        const r = await relay(u);
                        if (String(r.raw || '').includes(SECRET)) leaked = true;
                    }
                    ok(!leaked, '★ 内网服务的内容没有经中转泄漏出来（SSRF 实质被挡住）');
                } finally {
                    internal.close();
                }
            }
        } finally {
            if (kid) { kid.kill(); await wait(300); }
        }
    }
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
