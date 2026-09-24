// Edge TTS（微软免费朗读服务）—— 服务端实现。
//
// 为什么放在**服务端**而不是浏览器里：
//   微软这个端点会校验浏览器指纹（User-Agent 等），缺了就 403。
//   而浏览器的 `new WebSocket(url)` **不允许自定义任何请求头** —— 这条路在网页里必死。
//   Node 没有这个限制（`ws` 包支持 headers，或者像这里一样手写握手）。
//
// 为什么手写而不用 `ws` 包：
//   本项目零依赖（根 package.json 里没有 dependencies）。
//   WebSocket 客户端握手 + 帧编解码只有一百多行，自己写反而更好控制超时与取消。
//
// 协议参考：rany2/edge-tts 的公开协议（drm.py / communicate.py）与
// 本仓库旧版 TypeScript 项目里那份已跑通的实现。
//
// 用法：
//   const mp3 = await synthesizeEdge({ text: '你好', voice: 'zh-CN-XiaoxiaoNeural' });
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';

const WSS_HOST = 'speech.platform.bing.com';
const WSS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
/** 微软校验这几个头；User-Agent 缺了直接 403 */
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + `(KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION} Safari/537.36 Edg/${CHROMIUM_FULL_VERSION}`;

/**
 * 生成 Sec-MS-GEC 令牌。
 *
 * ticks 约 1.34e17，超出 Number 的安全整数（2^53 ≈ 9e15），所以用 BigInt ——
 * 用浮点算出来的 token 是错的，服务端必然拒绝。
 */
function secMsGec() {
    let seconds = BigInt(Math.floor(Date.now() / 1000) + 11644473600);
    seconds -= seconds % 300n;                 // 向下取整到 5 分钟
    const ticks = seconds * 10000000n;         // 秒 → 100ns
    return createHash('sha256').update(ticks.toString() + TRUSTED_CLIENT_TOKEN, 'ascii')
        .digest('hex').toUpperCase();
}

/** JS 风格的 UTC 时间串（服务端按这个格式解析 X-Timestamp） */
function dateString() {
    const d = new Date();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p = (n) => String(n).padStart(2, '0');
    return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} `
        + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * 合成语音，返回 MP3 Buffer。
 *
 * @param text    要读的文本
 * @param voice   音色（如 zh-CN-XiaoxiaoNeural）
 * @param ratePct 语速百分比（0 = 原速，正数更快）
 * @param timeoutMs 总超时
 */
export function synthesizeEdge({ text, voice = 'zh-CN-XiaoxiaoNeural', ratePct = 0, timeoutMs = 25000 } = {}) {
    return new Promise((resolve, reject) => {
        if (!text || !String(text).trim()) {
            reject(new Error('文本为空'));
            return;
        }
        const rate = `${ratePct >= 0 ? '+' : ''}${Math.round(ratePct)}%`;
        const key = randomBytes(16).toString('base64');
        const url = `${WSS_PATH}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
            + `&Sec-MS-GEC=${secMsGec()}`
            + `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
            + `&ConnectionId=${randomUUID().replace(/-/g, '')}`;

        const socket = tlsConnect(443, WSS_HOST, { servername: WSS_HOST });
        socket.setTimeout(timeoutMs);

        let buf = Buffer.alloc(0);
        let handshakeDone = false;
        let settled = false;
        const audio = [];

        const finish = (err, data) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch { /* 已断开 */ }
            if (err) reject(err);
            else resolve(data);
        };

        socket.on('secureConnect', () => {
            socket.write([
                `GET ${url} HTTP/1.1`,
                `Host: ${WSS_HOST}`,
                'Connection: Upgrade',
                'Upgrade: websocket',
                `Sec-WebSocket-Key: ${key}`,
                'Sec-WebSocket-Version: 13',
                `Origin: ${ORIGIN}`,
                `User-Agent: ${USER_AGENT}`,
                'Pragma: no-cache',
                'Cache-Control: no-cache',
                'Accept-Encoding: gzip, deflate, br',
                'Accept-Language: en-US,en;q=0.9',
                `Cookie: muid=${randomBytes(16).toString('hex').toUpperCase()};`,
                '', '',
            ].join('\r\n'));
        });

        /** 发一个客户端帧（RFC 6455 要求客户端必须掩码） */
        function sendFrame(opcode, payload) {
            const mask = randomBytes(4);
            let header;
            if (payload.length < 126) {
                header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
            } else if (payload.length < 65536) {
                header = Buffer.alloc(4);
                header[0] = 0x80 | opcode;
                header[1] = 0x80 | 126;
                header.writeUInt16BE(payload.length, 2);
            } else {
                header = Buffer.alloc(10);
                header[0] = 0x80 | opcode;
                header[1] = 0x80 | 127;
                header.writeBigUInt64BE(BigInt(payload.length), 2);
            }
            const masked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
            socket.write(Buffer.concat([header, mask, masked]));
        }

        function pump() {
            for (;;) {
                if (!handshakeDone) {
                    const idx = buf.indexOf('\r\n\r\n');
                    if (idx < 0) return;
                    const head = buf.subarray(0, idx).toString('latin1');
                    const status = parseInt(head.split(' ')[1], 10);
                    buf = buf.subarray(idx + 4);
                    if (status !== 101) {
                        // 把响应体一起带出来（400/403 时服务端会说明原因）
                        const detail = buf.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                        finish(new Error(`Edge TTS 握手失败 HTTP ${status}`
                            + (detail ? `：${detail.slice(0, 160)}` : '')));
                        return;
                    }
                    handshakeDone = true;
                    // ① speech.config
                    sendFrame(0x1, Buffer.from(
                        `X-Timestamp:${dateString()}\r\n`
                        + 'Content-Type:application/json; charset=utf-8\r\n'
                        + 'Path:speech.config\r\n\r\n'
                        + '{"context":{"synthesis":{"audio":{"metadataoptions":'
                        + '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},'
                        + '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n', 'utf8'));
                    // ② ssml
                    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>`
                        + `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>`
                        + `${xmlEscape(text)}</prosody></voice></speak>`;
                    sendFrame(0x1, Buffer.from(
                        `X-RequestId:${randomUUID().replace(/-/g, '')}\r\n`
                        + 'Content-Type:application/ssml+xml\r\n'
                        + `X-Timestamp:${dateString()}Z\r\n`
                        + 'Path:ssml\r\n\r\n' + ssml, 'utf8'));
                    continue;
                }

                if (buf.length < 2) return;
                const opcode = buf[0] & 0x0f;
                let len = buf[1] & 0x7f;
                let off = 2;
                if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
                else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
                if (buf.length < off + len) return;
                const payload = buf.subarray(off, off + len);
                buf = buf.subarray(off + len);

                if (opcode === 0x8) { finish(null, Buffer.concat(audio)); return; }
                if (opcode === 0x1) {
                    if (payload.toString('utf8').includes('Path:turn.end')) {
                        finish(null, Buffer.concat(audio));
                        return;
                    }
                    continue;
                }
                if (opcode === 0x2) {
                    // 音频帧：[2 字节大端头长度][头部][MP3]
                    // 控制帧（turn.start / response / audio.metadata）没有长度前缀，
                    // 读到无效长度时忽略即可。
                    if (payload.length < 2) continue;
                    const headerLen = payload.readUInt16BE(0);
                    if (2 + headerLen >= payload.length) continue;
                    const header = payload.subarray(2, 2 + headerLen).toString('utf8');
                    if (!header.includes('Path:audio')) continue;
                    audio.push(Buffer.from(payload.subarray(2 + headerLen)));
                    continue;
                }
                // ping / pong 忽略
            }
        }

        socket.on('data', (d) => { buf = Buffer.concat([buf, d]); pump(); });
        socket.on('error', (e) => finish(e));
        socket.on('timeout', () => finish(new Error('Edge TTS 请求超时')));
        socket.on('close', () => { if (!settled) finish(null, Buffer.concat(audio)); });
    });
}

/** 连通性自检：能否完成握手（不合成）。设置页的"测试"按钮用。 */
export function probeEdge({ timeoutMs = 10000 } = {}) {
    return synthesizeEdge({ text: '测试', voice: 'zh-CN-XiaoxiaoNeural', timeoutMs })
        .then((mp3) => ({ ok: true, bytes: mp3.length }))
        .catch((e) => ({ ok: false, message: String(e && e.message || e) }));
}

/** 可选的音色列表（界面下拉用；不联网，取自常用项） */
export const EDGE_VOICES = Object.freeze([
    { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 中文女声（自然）' },
    { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 中文女声（活泼）' },
    { id: 'zh-CN-YunxiNeural', label: '云希 · 中文男声（年轻）' },
    { id: 'zh-CN-YunyangNeural', label: '云扬 · 中文男声（新闻）' },
    { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 中文女声（东北）' },
    { id: 'ja-JP-NanamiNeural', label: '七海 · 日语女声' },
    { id: 'ja-JP-KeitaNeural', label: '圭太 · 日语男声' },
    { id: 'en-US-EmmaMultilingualNeural', label: 'Emma · 多语女声' },
    { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew · 多语男声' },
]);
