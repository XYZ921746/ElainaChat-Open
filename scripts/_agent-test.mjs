// 一次性：真机触发手机操作，验证 Agent 链路（含"回到桌面"场景）。
// 连 WebView DevTools → 调 execPhoneOperation 同款入口 → 截图对比。
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';

const ADB = 'C:\\Android\\Sdk\\platform-tools\\adb.exe';
const DEV = '127.0.0.1:5555';
const adb = (...a) => execFileSync(ADB, ['-s', DEV, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const pid = adb('shell', 'pidof', 'com.elainachat.opensource').trim();
adb('forward', '--remove-all');
adb('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`);
console.log('PID ' + pid);

function httpGet(p) {
    return new Promise((resolve, reject) => {
        const s = net.connect(9222, '127.0.0.1');
        let buf = '';
        s.setTimeout(8000);
        s.on('connect', () => s.write(`GET ${p} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
        s.on('data', (d) => { buf += d.toString(); });
        s.on('timeout', () => s.destroy());
        s.on('close', () => resolve((buf.match(/\r\n\r\n([\s\S]*)/) || [])[1] || ''));
        s.on('error', reject);
    });
}
const page = JSON.parse(await httpGet('/json/list')).find((p) => p.type === 'page');
if (!page) { console.error('无 page'); process.exit(1); }

let frameBuf = Buffer.alloc(0);
let onMessage = () => {};
const u = new URL(page.webSocketDebuggerUrl);
const sock = net.connect(9222, '127.0.0.1');
await new Promise((resolve, reject) => {
    let hs = '';
    sock.setTimeout(10000);
    sock.on('connect', () => sock.write(`GET ${u.pathname}${u.search || ''} HTTP/1.1\r\nHost: 127.0.0.1:9222\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.on('data', function onData(d) {
        hs += d.toString('latin1');
        if (hs.includes('\r\n\r\n')) {
            sock.removeListener('data', onData);
            if (!/101/.test(hs.split('\r\n')[0])) return reject(new Error('握手失败'));
            const rest = hs.slice(hs.indexOf('\r\n\r\n') + 4);
            sock.removeAllListeners('data');
            frameInit(rest);
            resolve();
        }
    });
    sock.on('error', reject);
    sock.on('timeout', () => reject(new Error('握手超时')));
});
console.log('DevTools 已连接');

function frameInit(initial) {
    frameBuf = initial ? Buffer.from(initial, 'latin1') : Buffer.alloc(0);
    sock.on('data', (d) => { frameBuf = Buffer.concat([frameBuf, d]); pump(); });
    pump();
}
function pump() {
    while (frameBuf.length >= 2) {
        const opcode = frameBuf[0] & 0x0f;
        let len = frameBuf[1] & 0x7f, off = 2;
        if (len === 126) { if (frameBuf.length < 4) return; len = frameBuf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (frameBuf.length < 10) return; len = Number(frameBuf.readBigUInt64BE(2)); off = 10; }
        if (frameBuf.length < off + len) return;
        const payload = frameBuf.subarray(off, off + len);
        frameBuf = frameBuf.subarray(off + len);
        if (opcode === 1) onMessage(payload.toString('utf8'));
        else if (opcode === 8) { sock.destroy(); return; }
    }
}
function sendText(str) {
    const payload = Buffer.from(str, 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) { header = Buffer.alloc(2); header[0] = 0x81; header[1] = 0x80 | payload.length; }
    else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    sock.write(Buffer.concat([header, mask, masked]));
}
let msgId = 1;
const waiting = new Map();
onMessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result); }
};
function cdp(method, params) {
    const id = msgId++;
    return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        sendText(JSON.stringify({ id, method, params }));
        setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error('超时 ' + method)); } }, 30000);
    });
}
const evalJs = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result.value;
};

const mode = process.argv[2] || 'check';

if (mode === 'check') {
    // 环境自检：授权策略、后端选择、悬浮窗
    const env = JSON.parse(await evalJs(`JSON.stringify({
        approval: state.settings.agentApproval,
        phoneEnabled: state.settings.agentPhoneEnabled,
        backend: typeof currentBackendId === 'function' ? currentBackendId() : null,
        overlay: await (async () => { try { return await window.Capacitor.Plugins.ElainaDevice.overlayStatus(); } catch (e) { return { error: String(e) }; } })(),
    })`));
    console.log('授权策略: ' + env.approval);
    console.log('手机操作总开关: ' + env.phoneEnabled);
    console.log('实现方式: ' + JSON.stringify(env.backend));
    console.log('悬浮窗: ' + JSON.stringify(env.overlay));
} else if (mode === 'tap') {
    // 触发一次真实点击（走完整的授权→执行链）。x=800 y=400 屏幕中心
    const r = await evalJs(`
        (async () => {
            try {
                const result = await execPhoneOperation('[操作:手机点击 800 400]');
                return JSON.stringify({ result: String(result).slice(0, 200) });
            } catch (e) {
                return JSON.stringify({ error: String(e && e.message || e) });
            }
        })()
    `);
    console.log('点击结果: ' + r);
} else if (mode === 'home') {
    // 让 AI 按主页键 → 应用退到后台 → 再点击（复现"回到桌面不工作"）
    const r = await evalJs(`
        (async () => {
            try {
                const out1 = await execPhoneOperation('[操作:手机按键 主页]');
                return JSON.stringify({ out1: String(out1).slice(0, 200) });
            } catch (e) {
                return JSON.stringify({ error: String(e && e.message || e) });
            }
        })()
    `);
    console.log('按主页结果: ' + r);
}
sock.destroy();
process.exit(0);
