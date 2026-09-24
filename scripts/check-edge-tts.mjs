// 回归检查：Edge TTS 的两条路（服务端 / 原生插件）+ GEC 算法。
//
// 背景：微软端点校验浏览器指纹（User-Agent 等），缺了返回 403；
// 而浏览器 JS 的 `new WebSocket()` **不允许自定义请求头** —— 网页里直连必失败。
// 所以做成两条路：
//   · 电脑版 → 本机后端 /api/tts/edge（Node 能自定义头）
//   · 安卓版 → 原生插件 EdgeTtsPlugin（原生能自定义头）
//
// 这个检查盯住：
//   1. server/edge-tts.mjs 存在且关键实现齐全（GEC 用 BigInt、带齐浏览器头、手写握手）
//   2. serve.mjs 暴露了 /api/tts/edge 与 probe
//   3. 前端按平台分流（原生插件优先，否则走后端）
//   4. GEC 算法与参考实现逐字节一致
//   5. 端到端：真起服务、真合成、验证返回的是合法 MP3
//
// 用法：node scripts/check-edge-tts.mjs
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, l, d) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; failures.push(l); console.log('  FAIL  ' + l + (d ? '  -> ' + d : '')); } };

const EDGE = path.join(ROOT, 'server', 'edge-tts.mjs');
const SERVE = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');
const HTML = readFrontend();

// ============================================================ 1. 服务端实现
console.log('=== 1. 服务端实现（server/edge-tts.mjs）===');
ok(existsSync(EDGE), 'edge-tts.mjs 存在');
const edge = existsSync(EDGE) ? readFileSync(EDGE, 'utf8') : '';
ok(/export function synthesizeEdge/.test(edge), '导出 synthesizeEdge');
ok(/export function probeEdge/.test(edge), '导出 probeEdge');
ok(/export const EDGE_VOICES/.test(edge), '导出音色列表');
ok(edge.includes('speech.platform.bing.com'), '用微软朗读端点');
ok(edge.includes('Sec-MS-GEC'), '带 Sec-MS-GEC token');
ok(edge.includes('BigInt'), '★ GEC 时间计算用 BigInt（Number 会丢精度 → token 错 → 403）');
ok(edge.includes('tlsConnect') || edge.includes('tls.connect'), '用 TLS socket 手写握手');
ok(!/from 'ws'/.test(edge) && !/require\('ws'\)/.test(edge), '不依赖 ws 包（本项目零依赖）');
// 浏览器头：缺 User-Agent 会 403（实测）
ok(/User-Agent/.test(edge), '★ 带 User-Agent（缺了服务端返回 403）');
ok(/Origin/.test(edge), '带 Origin');
ok(/Cookie.*muid/.test(edge), '带 muid Cookie');
// 握手三要素必须真发出去（HttpURLConnection 会丢，所以手写）
ok(/Connection: Upgrade/.test(edge), '发 Connection: Upgrade');
ok(/Upgrade: websocket/.test(edge), '发 Upgrade: websocket');
ok(/Sec-WebSocket-Key/.test(edge), '发 Sec-WebSocket-Key');
// 帧协议
ok(/Path:speech\.config/.test(edge), '先发 speech.config');
ok(/Path:ssml/.test(edge), '再发 ssml');
ok(/Path:audio/.test(edge), '解析音频帧');
ok(/turn\.end/.test(edge), '识别合成结束');

// ============================================================ 2. 后端路由
console.log('\n=== 2. 后端路由 ===');
ok(SERVE.includes("'/api/tts/edge'"), '有 POST /api/tts/edge');
ok(SERVE.includes("'/api/tts/edge/probe'"), '有 probe 接口');
ok(/synthesizeEdge/.test(SERVE) && /probeEdge/.test(SERVE), 'serve.mjs 引入了实现');
ok(/Content-Type': 'audio\/mpeg'|'Content-Type': 'audio\/mpeg'/.test(SERVE), '返回 audio/mpeg');
ok(/文本过长/.test(SERVE), '有长度上限校验');

// ============================================================ 3. 前端分流
console.log('\n=== 3. 前端按平台分流 ===');
ok(/async function speakTextEdge\(/.test(HTML), '有 speakTextEdge');
const fnStart = HTML.indexOf('async function speakTextEdge(');
const fnEnd = HTML.indexOf('async function speakTextMinimax(');
const fn = fnStart > 0 && fnEnd > fnStart ? HTML.slice(fnStart, fnEnd) : '';
ok(/Plugins\?\.EdgeTts/.test(fn), '识别原生插件');
ok(/\/api\/tts\/edge/.test(fn), '★ 电脑版走后端接口（不再说"只有安卓能用"）');
ok(/useNative/.test(fn), '按平台分流');
ok(!/只有安卓版 App 能用/.test(HTML), '界面已移除"只有安卓能用"的错误说法');

// ============================================================ 4. GEC 算法对拍
console.log('\n=== 4. GEC 算法与参考实现对拍 ===');
{
    // 从源码抠出 secMsGec 的算法逻辑，用固定时间戳算一遍，与 node:crypto 的期望值比
    const m = edge.match(/function secMsGec\(\)[\s\S]*?\n\}/);
    ok(Boolean(m), '能定位 secMsGec');
    if (m) {
        const sandbox = { BigInt, Date, Math, createHash };
        const fixedNow = 1767225600000;   // 2026-01-01 00:00:00 UTC
        // secMsGec 引用了模块级常量 TRUSTED_CLIENT_TOKEN，得一起喂进去
        const token = (edge.match(/TRUSTED_CLIENT_TOKEN = '([^']+)'/) || [])[1] || '';
        const fnGec = new Function('createHash', 'BigInt', 'Date', 'Math', 'TRUSTED_CLIENT_TOKEN',
            m[0] + '; return secMsGec;')(createHash, BigInt,
            { now: () => fixedNow }, Math, token);
        const got = fnGec();
        let seconds = BigInt(Math.floor(fixedNow / 1000) + 11644473600);
        seconds -= seconds % 300n;
        const ticks = seconds * 10000000n;
        const want = createHash('sha256').update(ticks.toString() + token, 'ascii').digest('hex').toUpperCase();
        ok(got === want, 'GEC 值与参考实现一致', `got ${String(got).slice(0, 12)}… want ${want.slice(0, 12)}…`);
        ok(/^[0-9A-F]{64}$/.test(got), 'GEC 是 64 位大写 hex');
    }
}

// ============================================================ 5. 端到端
console.log('\n=== 5. 端到端：真起服务、真合成 ===');
{
    const PORT = 4491;
    const DATA = process.env.TEMP + '\\elaina-edge-check';
    const { rmSync, mkdirSync } = await import('node:fs');
    rmSync(DATA, { recursive: true, force: true });
    mkdirSync(DATA, { recursive: true });

    const child = spawn(process.execPath, ['web/serve.mjs'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, LOG_TO_FILE: '0' },
        stdio: 'ignore',
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
        await sleep(4000);
        const resp = await fetch(`http://127.0.0.1:${PORT}/api/tts/edge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '你好，这是自动化测试。', voice: 'zh-CN-XiaoxiaoNeural' }),
        });
        ok(resp.ok, '合成请求返回 200', 'HTTP ' + resp.status);
        const buf = Buffer.from(await resp.arrayBuffer());
        ok(buf.length > 5000, '拿到音频数据', buf.length + ' 字节');
        const isMp3 = buf.length > 1 && buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0;
        const isId3 = buf.length > 2 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
        ok(isMp3 || isId3, '★ 是合法 MP3', isMp3 ? '帧同步字' : (isId3 ? 'ID3' : '前 4 字节 ' + [...buf.subarray(0, 4)].map((b) => b.toString(16)).join(' ')));
    } catch (e) {
        ok(false, '端到端合成', String(e && e.message || e));
    } finally {
        child.kill();
        rmSync(DATA, { recursive: true, force: true });
    }
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：' + failures.join('、'));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
