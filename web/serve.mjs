import { createReadStream } from 'node:fs';
import { stat, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = path.dirname(fileURLToPath(import.meta.url));
// 默认监听 0.0.0.0：局域网内其他设备（手机/平板）可通过 http://<本机IP>:4173 访问。
// 可用 HOST 环境变量覆盖（如 HOST=127.0.0.1 仅本机）。
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4173);
const MODELS_DIR = path.join(root, 'live2d', 'models');
const MAX_UPLOAD = 200 * 1024 * 1024; // 200MB 上限

const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.json', 'application/json'],
    ['.moc3', 'application/octet-stream'],
    ['.svg', 'image/svg+xml'],
]);

/** GBK 解码（Windows zip 文件名常用） */
function gbkDecode(buf) {
    try {
        return new TextDecoder('gbk').decode(buf);
    } catch {
        return buf.toString('latin1');
    }
}

/**
 * 简易 zip 解压（deflate/store，无依赖）。
 * - 正确处理 UTF-8 标志位（bit 11）与 GBK 兜底
 * - 支持 data descriptor（bit 3）
 * 返回 [{name, data}]
 */
function unzip(buf) {
    if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error('不是有效的 zip 文件');
    const files = [];
    let off = 0;
    while (off + 30 <= buf.length) {
        const sig = buf.readUInt32LE(off);
        if (sig === 0x02014b50 || sig === 0x06054b50) break; // central dir / EOCD
        if (sig !== 0x04034b50) break; // 未知签名
        const flags = buf.readUInt16LE(off + 6);
        const method = buf.readUInt16LE(off + 8);
        const compSize = buf.readUInt32LE(off + 18);
        const nameLen = buf.readUInt16LE(off + 26);
        const extraLen = buf.readUInt16LE(off + 28);
        const nameRaw = buf.subarray(off + 30, off + 30 + nameLen);
        let name;
        if (flags & 0x800) name = nameRaw.toString('utf8');
        else {
            name = nameRaw.toString('utf8');
            if (name.includes('\uFFFD')) name = gbkDecode(nameRaw);
        }
        const dataStart = off + 30 + nameLen + extraLen;
        let data;
        if (flags & 0x8) {
            // data descriptor：找签名 0x08074b50
            let found = -1;
            for (let i = dataStart; i + 4 <= buf.length; i++) {
                if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x07 && buf[i + 3] === 0x08) { found = i; break; }
            }
            if (found >= 0) {
                data = buf.subarray(dataStart, found);
                off = found + 16;
            } else {
                data = buf.subarray(dataStart);
                off = buf.length;
            }
        } else {
            data = buf.subarray(dataStart, dataStart + compSize);
            off = dataStart + compSize;
        }
        if (!name.endsWith('/')) {
            let content;
            if (method === 0) content = Buffer.from(data);
            else if (method === 8) content = inflateRawSync(data);
            else throw new Error(`不支持的压缩方式: ${method}`);
            files.push({ name: name.replace(/\\/g, '/'), data: content });
        }
    }
    if (!files.length) throw new Error('zip 内没有文件');
    return files;
}

/** 处理上传的模型 zip：解压到 models/<name>/ 下 */
async function handleUpload(req, res) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_UPLOAD) { res.writeHead(413).end('太大'); return; }
        chunks.push(chunk);
    }
    try {
        const files = unzip(Buffer.concat(chunks));
        // 展示名 = 顶层文件夹名 或 model3.json 所在文件夹
        let displayName = '';
        const modelFile = files.find(f => f.name.toLowerCase().endsWith('.model3.json'));
        if (modelFile) {
            const dir = path.posix.dirname(modelFile.name);
            displayName = dir === '.' ? path.posix.basename(modelFile.name, '.model3.json') : dir.split('/').pop();
        }
        if (!displayName) displayName = (files[0].name.split('/')[0] || 'model');
        // 目录名用英文安全 id，避免中文/特殊字符路径问题
        const modelName = 'model_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const targetDir = path.join(MODELS_DIR, modelName);
        await mkdir(targetDir, { recursive: true });
        // 公共顶层目录（去掉它，把文件平铺到模型目录）
        const topDir = modelFile ? path.posix.dirname(modelFile.name).split('/')[0] : null;
        for (const f of files) {
            let rel = f.name;
            if (topDir && rel.startsWith(topDir + '/')) rel = rel.slice(topDir.length + 1);
            else if (topDir === '.' ) rel = rel.replace(/^\.\//, '');
            if (rel.split('/').some(p => p === '..')) continue;
            const outPath = path.join(targetDir, rel);
            if (!outPath.startsWith(targetDir)) continue;
            await mkdir(path.dirname(outPath), { recursive: true });
            await writeFile(outPath, f.data);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, modelName, displayName, files: files.length }));
    } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: err.message || String(err) }));
    }
}

/** 列出已上传模型（附 model3.json 路径、exp 表情/动作列表、vtube.json 路径，供 AI 表情决策与探测使用） */
async function listModels(res) {
    try {
        const entries = await stat(MODELS_DIR).catch(() => null);
        if (!entries) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, models: [] })); return; }
        const dirs = (await readdir(MODELS_DIR, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
        const models = [];
        for (const name of dirs) {
            let modelJson = null;
            let exps = [];
            let motions = [];
            let vtube = null;
            try {
                const files = await readdir(path.join(MODELS_DIR, name));
                modelJson = files.find(f => f.toLowerCase().endsWith('.model3.json')) || null;
                vtube = files.find(f => f.toLowerCase().endsWith('.vtube.json')) || null;
                const expDirName = files.find(f => f.toLowerCase() === 'exp');
                if (expDirName) {
                    try {
                        const expFiles = (await readdir(path.join(MODELS_DIR, name, expDirName))).sort();
                        exps = expFiles.filter(f => f.toLowerCase().endsWith('.exp3.json'));
                        motions = expFiles.filter(f => f.toLowerCase().endsWith('.motion3.json'));
                    } catch { /* ignore */ }
                }
            } catch { /* ignore */ }
            models.push({ name, modelJson, exps, motions, vtube });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, models }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: err.message }));
    }
}

/** 删除模型目录 */
async function deleteModel(name, res) {
    const safe = String(name || '').replace(/[\\/]/g, '');
    if (!safe) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '模型名无效' })); return; }
    const target = path.join(MODELS_DIR, safe);
    if (!target.startsWith(MODELS_DIR + path.sep)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '禁止' })); return; }
    try {
        await rm(target, { recursive: true, force: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted: safe }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: err.message }));
    }
}

// ===== AI Agent 文件操作 API =====
// 权限模式：app = 仅应用文件夹（web/ 目录）；computer = 允许操作电脑任意路径（用户自行承担风险）
const AGENT_APP_ROOT = path.resolve(root);
const AGENT_READ_LIMIT = 300 * 1024; // 读文件上限 300KB

/**
 * 判断请求是否来自本机。
 * 安全前提：服务默认监听 0.0.0.0（方便手机/平板访问），而 Agent 文件操作接口没有鉴权，
 * 权限模式又是由**请求方自己传参**决定的。如果不做来源校验，局域网内任何设备只要访问
 * http://<本机IP>:4173 就能带上 permission=computer 往本机任意路径写文件/读文件。
 * 因此："允许操作电脑"只对本机请求开放，局域网请求一律降级为应用文件夹模式。
 */
function isLocalRequest(request) {
    const addr = request.socket?.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const PERM_DENIED_MSG = '限制模式：仅可操作应用文件夹（web/）。如需操作电脑其他路径，请在本机用 http://127.0.0.1:4173 打开（出于安全，局域网访问一律限制在应用文件夹内）。';

function resolveAgentPath(rawPath, permission, isLocal) {
    const p = String(rawPath || '').trim();
    if (!p) return null;
    // 只有本机请求才允许"允许操作电脑"；其余一律按 app 模式处理
    const effective = (isLocal && permission === 'computer') ? 'computer' : 'app';
    const resolved = path.resolve(p);
    if (effective === 'app') {
        if (resolved !== AGENT_APP_ROOT && !resolved.startsWith(AGENT_APP_ROOT + path.sep)) return null;
    }
    return resolved;
}

async function agentLs(params, res, isLocal) {
    try {
        const permission = String(params.get('permission') || 'app');
        const target = resolveAgentPath(params.get('path') || AGENT_APP_ROOT, permission, isLocal);
        if (!target) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: (permission === 'computer' && isLocal) ? '路径无效' : PERM_DENIED_MSG })); return; }
        const info = await stat(target).catch(() => null);
        if (!info || !info.isDirectory()) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '目录不存在' })); return; }
        const entries = await readdir(target, { withFileTypes: true });
        const list = entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: target, entries: list }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: err.message }));
    }
}

async function agentRead(params, res, isLocal) {
    try {
        const permission = String(params.get('permission') || 'app');
        const target = resolveAgentPath(params.get('path'), permission, isLocal);
        if (!target) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: (permission === 'computer' && isLocal) ? '路径无效' : PERM_DENIED_MSG })); return; }
        const info = await stat(target).catch(() => null);
        if (!info || !info.isFile()) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '文件不存在' })); return; }
        if (info.size > AGENT_READ_LIMIT) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '文件过大（>300KB）' })); return; }
        const buf = await (await import('node:fs/promises')).readFile(target, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, path: target, content: String(buf).slice(0, AGENT_READ_LIMIT) }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: err.message }));
    }
}

async function agentWrite(request, res, isLocal) {
    try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '请求体无效' })); return; }
        const permission = String(body.permission || 'app');
        const target = resolveAgentPath(body.path, permission, isLocal);
        if (!target) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: (permission === 'computer' && isLocal) ? '路径无效' : PERM_DENIED_MSG })); return; }
        // 只在目录不存在时创建（Windows 对盘符根目录如 D:\ 执行 mkdir 会报 EPERM）
        const dir = path.dirname(target);
        try {
            await stat(dir);
        } catch {
            try { await mkdir(dir, { recursive: true }); } catch (e) { /* 忽略已存在等错误 */ }
        }
        await (await import('node:fs/promises')).writeFile(target, String(body.content ?? ''), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: target }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: err.message }));
    }
}

// ===== 访问鉴权（局域网访问控制） =====
// 背景：服务默认监听 0.0.0.0（手机/平板可访问），而 Agent 文件接口没有鉴权、权限模式又由请求方
// 自己传参决定。如果不设访问控制，同一局域网内任何设备都能打开应用、甚至读写本机文件。
//
// 规则：
//   · 本机（127.0.0.1）自动视为管理员：免密进入，且可修改访问密码 —— 这也是忘记密码时的找回入口。
//   · 局域网设备必须登录，登录后种 HttpOnly Cookie 会话（默认 7 天）。
//   · 首次启动生成随机密码并在控制台打印；用户改过密码后只存加盐哈希，控制台不再打印。
const AUTH_FILE = path.join(root, '.local-auth.json');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'elaina_session';
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 60 * 1000;
const sessions = new Map();   // token -> 过期时间戳
const loginFails = new Map(); // ip -> { count, until }

// 去掉容易看错的字符（0/O、1/l/I），方便手输
const PWD_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomPassword(len = 12) {
    const bytes = randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) out += PWD_CHARS[bytes[i] % PWD_CHARS.length];
    return out;
}

function hashPassword(password, salt) {
    return scryptSync(String(password), String(salt), 64).toString('hex');
}

function safeEqualHex(a, b) {
    const ba = Buffer.from(String(a), 'hex');
    const bb = Buffer.from(String(b), 'hex');
    if (!ba.length || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

let auth = null; // { isDefault:true, password } 或 { isDefault:false, salt, hash }

async function loadAuthFile() {
    try {
        const o = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
        if (o && typeof o === 'object') return o;
    } catch { /* 文件不存在或损坏 → 视为未初始化 */ }
    return null;
}

async function saveAuthFile(o) {
    await writeFile(AUTH_FILE, JSON.stringify(o, null, 2), 'utf8');
}

// 启动时准备密码：没有就生成；仍是初始随机密码就再打印一次（方便重启后查看）
async function ensureAuth() {
    auth = await loadAuthFile();
    if (auth && auth.isDefault === false && auth.salt && auth.hash) return { generated: false, isDefault: false };
    if (auth && auth.isDefault && auth.password) return { generated: false, isDefault: true, password: auth.password };
    const password = randomPassword();
    auth = { isDefault: true, password, createdAt: new Date().toISOString() };
    await saveAuthFile(auth);
    return { generated: true, isDefault: true, password };
}

function verifyPassword(password) {
    if (!auth) return false;
    if (auth.isDefault && auth.password) {
        const a = Buffer.from(String(password));
        const b = Buffer.from(String(auth.password));
        return a.length === b.length && timingSafeEqual(a, b);
    }
    if (auth.salt && auth.hash) return safeEqualHex(hashPassword(password, auth.salt), auth.hash);
    return false;
}

// 改成加盐哈希保存，之后控制台不再打印明文
async function setPassword(next) {
    const salt = randomBytes(16).toString('hex');
    auth = { isDefault: false, salt, hash: hashPassword(next, salt), changedAt: new Date().toISOString() };
    await saveAuthFile(auth);
    sessions.clear(); // 改密码后所有已登录设备需重新登录
}

function parseCookies(request) {
    const out = {};
    const raw = request.headers.cookie;
    if (!raw) return out;
    for (const part of String(raw).split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function hasValidSession(request) {
    const token = parseCookies(request)[SESSION_COOKIE] || '';
    if (!token) return false;
    const exp = sessions.get(token);
    if (!exp) return false;
    if (Date.now() > exp) { sessions.delete(token); return false; }
    return true;
}

// 本机 = 管理员：免密 + 可改密码
function isAdmin(request) { return isLocalRequest(request); }
function isAuthenticated(request) { return isAdmin(request) || hasValidSession(request); }

// 简单 CSRF 防护：浏览器发起的跨站请求会带 Origin，这里要求它与 Host 同源。
// 否则任意网页都能在你浏览器里悄悄 POST /api/auth/change-password 改掉本机密码。
function isSameOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true; // 非浏览器请求（curl / 本机脚本）
    try { return new URL(origin).host === (request.headers.host || ''); } catch { return false; }
}

function jsonResponse(res, code, obj, extraHeaders = {}) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
    res.end(JSON.stringify(obj));
}

async function readJsonBody(request, limit = 64 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        total += chunk.length;
        if (total > limit) throw new Error('请求体过大');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handleLogin(request, response) {
    const ip = request.socket?.remoteAddress || 'unknown';
    const rec = loginFails.get(ip);
    if (rec && rec.count >= LOGIN_MAX_FAILS && Date.now() < rec.until) {
        const sec = Math.ceil((rec.until - Date.now()) / 1000);
        return jsonResponse(response, 429, { ok: false, message: '尝试次数过多，请 ' + sec + ' 秒后再试' });
    }
    let body;
    try { body = await readJsonBody(request); } catch { return jsonResponse(response, 400, { ok: false, message: '请求无效' }); }
    if (!verifyPassword(body.password || '')) {
        const cur = loginFails.get(ip) || { count: 0, until: 0 };
        cur.count += 1;
        cur.until = Date.now() + LOGIN_LOCK_MS;
        loginFails.set(ip, cur);
        return jsonResponse(response, 401, { ok: false, message: '密码不正确' });
    }
    loginFails.delete(ip);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    jsonResponse(response, 200, { ok: true }, {
        'Set-Cookie': SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
    });
}

function loginPageHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ElainaChat Open · 需要访问密码</title>
<style>
  /* 配色取自应用实际渲染值（pixso 主题）：
     橄榄绿画布 #a8b974 / 白色面板 / 米色输入框 #f8f5f2 / 绿色药丸按钮 #a7bb6c / 棕色文字 #4c3123 */
  * { box-sizing: border-box; }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px;
    background: #a8b974;
    color: #4c3123;
    font-family: "Outfit Variable", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* 与应用内 .modal-panel 一致 */
  .card {
    width:100%; max-width:380px; padding:30px 28px;
    background: #ffffff;
    border: 1px solid #d9c7c0;
    border-radius: 26px;
    box-shadow: 0 26px 70px rgba(58, 39, 29, 0.24);
  }
  /* 橙色小标，和应用的欢迎弹窗同款 */
  .eyebrow { font-size:11px; font-weight:700; letter-spacing:.08em; color:#ff7d4d; margin-bottom:8px; }
  h1 { margin:0 0 8px; font-size:21px; font-weight:700; color:#4c3123; }
  .sub { margin:0 0 20px; font-size:13px; line-height:1.7; color:#765e52; }
  /* 输入框：与应用内 .modal-input 一致 */
  input {
    width:100%; padding:12px 14px; border-radius:13px; outline:none;
    background: #f8f5f2;
    border: 1px solid #d9c7c0;
    color: #4c3123; font-size:14px; line-height:1.5; font-family:inherit;
    transition: all .18s ease;
  }
  input::placeholder { color: #a89a92; }
  input:focus { background:#ffffff; border-color:#a7bb6c; box-shadow:0 0 0 3px rgba(167,187,108,.25); }
  /* 按钮：与应用内 .btn-primary 一致（绿色药丸） */
  button {
    width:100%; margin-top:12px; padding:12px; cursor:pointer; font-family:inherit;
    border:none; border-radius:999px;
    background: #a7bb6c; color:#ffffff; font-size:15px; font-weight:600;
    transition: all .18s ease;
  }
  button:hover { background:#98ad5c; }
  button:active { transform: translateY(1px); }
  .err { min-height:18px; margin:10px 0 0; font-size:12px; color:#d9541f; }
  .divider { height:1px; background:#e9ddda; margin:18px 0 14px; }
  .hint { margin:0; font-size:11.5px; line-height:1.75; color:#765e52; }
  code { background:#f8f5f2; border:1px solid #e9ddda; color:#738746; padding:1px 6px; border-radius:6px; font-size:11px; }
</style>
</head>
<body>
  <div class="card">
    <div class="eyebrow">ElainaChat Open · 局域网访问</div>
    <h1>需要访问密码</h1>
    <p class="sub">这台设备不是本机，请输入访问密码后进入。</p>
    <form id="loginForm">
      <input id="pwd" type="password" placeholder="访问密码" autocomplete="current-password" autofocus>
      <button type="submit">进入</button>
    </form>
    <p class="err" id="err"></p>
    <div class="divider"></div>
    <p class="hint">
      密码显示在服务端启动的 cmd 窗口里（形如 <code>访问密码: xxxxxxxx</code>）。<br>
      如果你已经改过密码，请用改后的那个。
    </p>
  </div>
<script>
  document.getElementById('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = document.getElementById('err');
    err.textContent = '';
    try {
      var res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('pwd').value })
      });
      var json = await res.json();
      if (json.ok) { location.href = '/'; return; }
      err.textContent = json.message || '密码不正确';
    } catch (e2) {
      err.textContent = '网络错误：' + e2.message;
    }
  });
</script>
</body>
</html>`;
}

const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url || '/', `http://${host}`);
        const pathname = decodeURIComponent(url.pathname);

        // CSRF：非 GET 的跨站请求一律拒绝（详见 isSameOrigin 说明）
        if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameOrigin(request)) {
            return jsonResponse(response, 403, { ok: false, message: '跨站请求被拒绝' });
        }

        // 登录页（无需鉴权）
        if (pathname === '/login') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return response.end(loginPageHtml());
        }
        // 登录
        if (pathname === '/api/auth/login' && request.method === 'POST') {
            return await handleLogin(request, response);
        }
        // 退出登录
        if (pathname === '/api/auth/logout' && request.method === 'POST') {
            const token = parseCookies(request)[SESSION_COOKIE] || '';
            if (token) sessions.delete(token);
            return jsonResponse(response, 200, { ok: true }, {
                'Set-Cookie': SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
            });
        }

        // 访问控制：本机（管理员）放行，其余必须已登录
        if (!isAuthenticated(request)) {
            if (pathname.startsWith('/api/')) {
                return jsonResponse(response, 401, { ok: false, message: '需要访问密码', needLogin: true });
            }
            response.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
            return response.end();
        }

        // 鉴权状态（供设置页展示：是否本机管理员、是否仍是初始随机密码）
        if (pathname === '/api/auth/status' && request.method === 'GET') {
            return jsonResponse(response, 200, {
                ok: true,
                isAdmin: isAdmin(request),
                isDefaultPassword: Boolean(auth && auth.isDefault),
                passwordHint: (auth && auth.isDefault && auth.password) ? auth.password : '',
            });
        }
        // 修改访问密码（仅本机管理员；这也是忘记密码时的找回入口）
        if (pathname === '/api/auth/change-password' && request.method === 'POST') {
            if (!isAdmin(request)) {
                return jsonResponse(response, 403, { ok: false, message: '只有本机（管理员）可以修改访问密码' });
            }
            let body;
            try { body = await readJsonBody(request); } catch { return jsonResponse(response, 400, { ok: false, message: '请求无效' }); }
            const next = String(body.next || '');
            if (next.length < 6) return jsonResponse(response, 400, { ok: false, message: '新密码至少 6 位' });
            if (next.length > 128) return jsonResponse(response, 400, { ok: false, message: '新密码过长' });
            await setPassword(next);
            console.log('[鉴权] 访问密码已更新（局域网设备需重新登录）');
            return jsonResponse(response, 200, { ok: true, message: '访问密码已更新，局域网设备需要重新登录' });
        }

        // API：上传模型
        if (pathname === '/api/live2d/upload' && request.method === 'POST') {
            return await handleUpload(request, response);
        }
        // API：列出模型
        if (pathname === '/api/live2d/models' && request.method === 'GET') {
            return await listModels(response);
        }
        // API：删除模型
        const delMatch = pathname.match(/^\/api\/live2d\/models\/([^/]+)$/);
        if (delMatch && request.method === 'DELETE') {
            return await deleteModel(delMatch[1], response);
        }
        // API：AI Agent 文件操作（权限模式：app=仅应用文件夹；computer=允许操作电脑）
        const isLocal = isLocalRequest(request);
        if (pathname === '/api/agent/ls' && request.method === 'GET') {
            return await agentLs(url.searchParams, response, isLocal);
        }
        if (pathname === '/api/agent/read' && request.method === 'GET') {
            return await agentRead(url.searchParams, response, isLocal);
        }
        if (pathname === '/api/agent/write' && request.method === 'POST') {
            return await agentWrite(request, response, isLocal);
        }

        const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        // 禁止访问隐藏文件：否则 .local-auth.json（访问密码）会被直接下载走
        if (relative.split('/').some(seg => seg.startsWith('.'))) {
            response.writeHead(403).end('Forbidden');
            return;
        }
        const target = path.resolve(root, relative);
        const allowRoots = [root, MODELS_DIR];
        const allowed = allowRoots.some(r => target.startsWith(r + path.sep));
        if (!allowed && target !== path.join(root, 'index.html')) {
            response.writeHead(403).end('Forbidden');
            return;
        }
        const info = await stat(target);
        if (!info.isFile()) throw new Error('Not a file');
        response.writeHead(200, {
            'Content-Type': contentTypes.get(path.extname(target).toLowerCase()) || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        createReadStream(target).pipe(response);
    } catch {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
});

// 启动前准备访问密码（node web/serve.mjs --reset-password 可强制重新生成）
if (process.argv.includes('--reset-password')) {
    await rm(AUTH_FILE, { force: true });
    console.log('[鉴权] 已按 --reset-password 清除旧密码，将重新生成');
}
const authInfo = await ensureAuth();

server.listen(port, host, () => {
    console.log('');
    console.log('  本机访问:   http://127.0.0.1:' + port + '   （免密码）');
    // 监听 0.0.0.0 时额外打印局域网地址，方便手机/平板访问
    if (host === '0.0.0.0' || host === '::') {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name] || []) {
                if (net.family === 'IPv4' && !net.internal) {
                    console.log('  局域网访问: http://' + net.address + ':' + port + '   （需要访问密码）');
                }
            }
        }
    }
    console.log('');
    if (authInfo.isDefault) {
        console.log('  访问密码: ' + authInfo.password + (authInfo.generated ? '   （本次新生成）' : ''));
        console.log('  可在「设置 → 高级 → 访问密码」改成自己的，改完这里就不再显示。');
    } else {
        console.log('  访问密码: 已由你自行设置（不再显示）');
        console.log('  忘记密码：在本机打开上面的地址重设，或加 --reset-password 重启。');
    }
    console.log('');
});
