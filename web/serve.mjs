import { createReadStream } from 'node:fs';
import { stat, lstat, mkdir, writeFile, readFile, readdir, rm, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomBytes, scrypt, createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const scryptAsync = promisify(scrypt);

const root = path.dirname(fileURLToPath(import.meta.url));
// 应用根目录（web 的上一级）与其下的 data/：
//   证书 + 端侧数据存储都放这里。因为它在 web/ 之外，静态文件服务够不到，
//   不会像放在 web/ 里那样被直接下载走。
const APP_ROOT = path.resolve(root, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const CERT_FILE = path.join(DATA_DIR, 'cert.pem');
const KEY_FILE = path.join(DATA_DIR, 'key.pem');
const STORE_MAX_BYTES = 32 * 1024 * 1024; // 端侧数据（聊天记录等）单次提交上限
// 默认监听 0.0.0.0：局域网内其他设备（手机/平板）可通过 http://<本机IP>:4173 访问。
// 可用 HOST 环境变量覆盖（如 HOST=127.0.0.1 仅本机）。
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4173);
const MODELS_DIR = path.join(root, 'live2d', 'models');
// 模型目录名 = 显示名（真改文件夹）。URL 与文件名都走 encodeURIComponent / decodeURIComponent，
// 所以中文、空格、emoji 都能用；下面 sanitizeModelDirName 只挡掉文件系统层面真正不合法的字符。
// 之所以不做"目录名保持 id + 另存显示名"的映射表：多一层状态就多一处会不同步的地方，
// 用户看到的文件夹名和界面里的名字不一致反而更难排查。
const MODEL_NAME_MAX = 60;
// Windows 保留设备名，做目录名会失败
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_UPLOAD = 200 * 1024 * 1024;      // 上传的压缩包大小上限 200MB
const MAX_EXTRACTED = 512 * 1024 * 1024;   // 解压后总大小上限（防 zip bomb：200KB 的包可膨胀到数百 MB）
const MAX_ENTRY_SIZE = 256 * 1024 * 1024;  // 解压后单文件上限
// 不允许解压落盘的危险类型：这些文件一旦被上传到 web/ 下，就会以同源身份被浏览器执行/渲染
const BLOCKED_EXT = new Set([
    '.html', '.htm', '.xhtml', '.shtml', '.hta', '.mhtml',
    '.js', '.mjs', '.cjs', '.jsx', '.ts',
    '.svg', '.xml', '.xsl',
    '.exe', '.dll', '.com', '.scr', '.msi', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.wsf', '.jar', '.sh',
]);

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

/** 从尾部找 EOCD（中央目录结束记录），找不到返回 -1 */
function findEocd(buf) {
    const min = Math.max(0, buf.length - (0xFFFF + 22));
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
    }
    return -1;
}

/** 条目名是否不安全（绝对路径 / 路径穿越） */
function isUnsafeEntryName(name) {
    if (!name) return true;
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true;
    return name.split('/').some(seg => seg === '..');
}

/**
 * zip 解压（deflate/store，无依赖）。
 *
 * - **以中央目录为准**读取条目名 / 压缩大小 / 数据偏移，因此天然正确支持带 data descriptor
 *   （bit 3）的 zip（PowerShell Compress-Archive 等）。
 *   旧实现靠扫描 0x08074b50 签名来定位描述符：只要压缩数据里恰好出现这 4 个字节，该条目
 *   就会被截断、并且后续条目会被整体丢弃（实测 54 字节的文件解出 5 字节，第二个条目直接消失，
 *   接口却仍返回 ok）。
 * - 中文文件名：UTF-8 标志位（bit 11）+ GBK 兜底。
 * - 解压体积硬上限（单文件 + 总量），防压缩炸弹。
 * - 危险扩展名（.html/.js/.svg/.exe…）跳过不落盘，并在结果里回报，避免上传后被同源执行。
 * - 路径穿越（..）/ 绝对路径条目跳过。
 *
 * 返回 { files: [{name, data}], blocked: [name] }
 */
function unzip(buf) {
    if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error('不是有效的 zip 文件');

    const decodeName = (nameRaw, flags) => {
        if (flags & 0x800) return nameRaw.toString('utf8');
        const utf8 = nameRaw.toString('utf8');
        return utf8.includes('\uFFFD') ? gbkDecode(nameRaw) : utf8;
    };

    // 1) 优先从中央目录读取条目表（这是 zip 的权威元数据）
    const entries = [];
    let fromCentral = false;
    const eocdOff = findEocd(buf);
    if (eocdOff >= 0) {
        const total = buf.readUInt16LE(eocdOff + 10);
        const cdSize = buf.readUInt32LE(eocdOff + 12);
        const cdOff = buf.readUInt32LE(eocdOff + 16);
        const isZip64 = cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || total === 0xFFFF;
        if (!isZip64 && cdOff + cdSize <= buf.length) {
            let off = cdOff;
            let ok = true;
            for (let i = 0; i < total; i++) {
                if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) { ok = false; break; }
                const flags = buf.readUInt16LE(off + 8);
                const method = buf.readUInt16LE(off + 10);
                const compSize = buf.readUInt32LE(off + 20);
                const nameLen = buf.readUInt16LE(off + 28);
                const extraLen = buf.readUInt16LE(off + 30);
                const commentLen = buf.readUInt16LE(off + 32);
                const localOff = buf.readUInt32LE(off + 42);
                const nameRaw = buf.subarray(off + 46, off + 46 + nameLen);
                entries.push({ name: decodeName(nameRaw, flags), method, compSize, localOff });
                off += 46 + nameLen + extraLen + commentLen;
            }
            fromCentral = ok;
            if (!ok) entries.length = 0;
        }
    }

    // 2) 回退：没有可用中央目录（流式/损坏/ZIP64）时按 local header 顺序走。
    //    带 data descriptor 的条目无法从头部得知数据长度，宁可直接报错，也不要靠猜导致静默损坏。
    if (!fromCentral) {
        let off = 0;
        while (off + 30 <= buf.length) {
            if (buf.readUInt32LE(off) !== 0x04034b50) break;
            const flags = buf.readUInt16LE(off + 6);
            const method = buf.readUInt16LE(off + 8);
            const compSize = buf.readUInt32LE(off + 18);
            const nameLen = buf.readUInt16LE(off + 26);
            const extraLen = buf.readUInt16LE(off + 28);
            const nameRaw = buf.subarray(off + 30, off + 30 + nameLen);
            if (flags & 0x8) {
                throw new Error('该 zip 缺少可用的中央目录，且条目使用了 data descriptor（无法确定数据长度）。请用 7-Zip / zipfile 等标准工具重新打包后上传。');
            }
            entries.push({ name: decodeName(nameRaw, flags), method, compSize, localOff: off });
            off = off + 30 + nameLen + extraLen + compSize;
        }
    }

    if (!entries.length) throw new Error('zip 内没有文件');

    // 3) 逐条解压（带体积上限与类型/路径校验）
    const files = [];
    const blocked = [];
    let extracted = 0;
    for (const e of entries) {
        if (e.name.endsWith('/') || e.name.endsWith('\\')) continue; // 目录项
        const name = e.name.replace(/\\/g, '/');
        if (isUnsafeEntryName(name)) continue;
        if (BLOCKED_EXT.has(path.posix.extname(name).toLowerCase())) { blocked.push(name); continue; }

        if (e.localOff + 30 > buf.length || buf.readUInt32LE(e.localOff) !== 0x04034b50) continue;
        const lNameLen = buf.readUInt16LE(e.localOff + 26);
        const lExtraLen = buf.readUInt16LE(e.localOff + 28);
        const dataStart = e.localOff + 30 + lNameLen + lExtraLen;
        const data = buf.subarray(dataStart, dataStart + e.compSize);

        if (e.method !== 0 && e.method !== 8) throw new Error(`不支持的压缩方式: ${e.method}（${name}）`);
        const remaining = MAX_EXTRACTED - extracted;
        if (e.compSize > MAX_ENTRY_SIZE || e.compSize > remaining) {
            throw new Error(`解压后体积超过上限（单文件上限 ${Math.round(MAX_ENTRY_SIZE / 1024 / 1024)}MB，总计 ${Math.round(MAX_EXTRACTED / 1024 / 1024)}MB），已拒绝上传`);
        }
        let content;
        if (e.method === 0) {
            content = Buffer.from(data);
        } else {
            try {
                content = inflateRawSync(data, { maxOutputLength: Math.min(MAX_ENTRY_SIZE, remaining) });
            } catch (err) {
                if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || /too large/i.test(String(err.message)))) {
                    throw new Error(`解压后体积超过上限（单文件上限 ${Math.round(MAX_ENTRY_SIZE / 1024 / 1024)}MB，总计 ${Math.round(MAX_EXTRACTED / 1024 / 1024)}MB），已拒绝上传`);
                }
                throw new Error(`条目解压失败：${name}（${err.message}）`);
            }
        }
        extracted += content.length;
        if (extracted > MAX_EXTRACTED) throw new Error('解压后总大小超过上限，已拒绝上传（疑似压缩炸弹）');
        files.push({ name, data: content });
    }
    if (!files.length) throw new Error('zip 内没有可用文件');
    return { files, blocked };
}

/** 处理上传的模型 zip：解压到 models/<name>/ 下 */
async function handleUpload(req, res) {
    const chunks = [];
    let total = 0;
    let overflow = false;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_UPLOAD) { overflow = true; chunks.length = 0; continue; } // 继续读掉剩余数据再回包
        chunks.push(chunk);
    }
    if (overflow) {
        return jsonResponse(res, 413, { ok: false, message: `压缩包超过 ${Math.round(MAX_UPLOAD / 1024 / 1024)}MB 上限` });
    }
    try {
        const { files, blocked } = unzip(Buffer.concat(chunks));
        // 展示名 = 顶层文件夹名 或 model3.json 所在文件夹
        let displayName = '';
        const modelFile = files.find(f => f.name.toLowerCase().endsWith('.model3.json'));
        if (modelFile) {
            const dir = path.posix.dirname(modelFile.name);
            displayName = dir === '.' ? path.posix.basename(modelFile.name, '.model3.json') : dir.split('/').pop();
        }
        if (!displayName) displayName = (files[0].name.split('/')[0] || 'model');
        // 目录名直接用 zip 里的模型名 —— 用户能在文件夹里和界面里对上号，不再是一串 model_xxx。
        // 拿不到合法名字时退回随机 id；重名自动加 " (2)"。
        const wanted = sanitizeModelDirName(displayName);
        const modelName = wanted
            ? await uniqueDirName(wanted, '')
            : 'model_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        if (!modelName) throw new Error('无法为该模型生成合法目录名，请把 zip 里的文件夹改个名字再传');
        const targetDir = path.join(MODELS_DIR, modelName);
        await mkdir(targetDir, { recursive: true });
        // 公共顶层目录（去掉它，把文件平铺到模型目录）
        const topDir = modelFile ? path.posix.dirname(modelFile.name).split('/')[0] : null;
        let written = 0;
        for (const f of files) {
            let rel = f.name;
            if (topDir && rel.startsWith(topDir + '/')) rel = rel.slice(topDir.length + 1);
            else if (topDir === '.') rel = rel.replace(/^\.\//, '');
            if (!rel || isUnsafeEntryName(rel)) continue;
            const outPath = path.join(targetDir, rel);
            // 双保险：解析后的绝对路径必须仍在目标目录内
            if (outPath !== targetDir && !outPath.startsWith(targetDir + path.sep)) continue;
            await mkdir(path.dirname(outPath), { recursive: true });
            await writeFile(outPath, f.data);
            written++;
        }
        if (!written) {
            await rm(targetDir, { recursive: true, force: true }).catch(() => {});
            throw new Error('zip 内没有可用的模型文件（文件类型可能都被拦截了）');
        }
        // 目录名就是显示名，不需要额外记映射
        jsonResponse(res, 200, { ok: true, modelName, displayName: modelName, files: written, blocked });
    } catch (err) {
        jsonResponse(res, 400, { ok: false, message: err.message || String(err) });
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

/**
 * 把用户输入的名字洗成合法目录名。
 * 允许中文/空格/emoji；只挡文件系统层面真正不合法的东西：
 *   路径分隔符与 Windows 非法字符、控制字符、首尾点与空格、`.`/`..`、Windows 保留设备名、超长。
 * 返回空串表示不可用（调用方给 400）。
 */
function sanitizeModelDirName(input) {
    let s = String(input == null ? '' : input);
    s = s.replace(/[\u0000-\u001f\u007f]/g, '');          // 控制字符
    s = s.replace(/[\\/:*?"<>|]/g, '_');                  // Windows 非法字符 → 下划线
    s = s.replace(/\s+/g, ' ').trim();                    // 压缩空白
    s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');  // 首尾的点/空格（Windows 不允许尾点/尾空格）
    if (s.length > MODEL_NAME_MAX) s = s.slice(0, MODEL_NAME_MAX).trim();
    if (!s || s === '.' || s === '..') return '';
    if (WIN_RESERVED.test(s)) return '';                  // CON / NUL / COM1…
    return s;
}

/** 目录名合法性（去路径分隔符 + 必须落在 MODELS_DIR 内），非法返回空串。用于已存在的目录名。 */
function safeModelDirName(name) {
    const safe = String(name || '').replace(/[\\/]/g, '');
    if (!safe || safe === '.' || safe === '..') return '';
    const target = path.join(MODELS_DIR, safe);
    return target.startsWith(MODELS_DIR + path.sep) ? safe : '';
}

/** 目标名被占用时依次试 " (2)"、" (3)"…；exclude 是自己（原地改名不算冲突） */
async function uniqueDirName(desired, exclude) {
    const taken = async (n) => {
        if (n === exclude) return false;
        const st = await stat(path.join(MODELS_DIR, n)).catch(() => null);
        return Boolean(st);
    };
    if (!(await taken(desired))) return desired;
    for (let i = 2; i < 1000; i++) {
        const cand = desired + ' (' + i + ')';
        if (!(await taken(cand))) return cand;
    }
    return '';
}

/** 重命名模型：真改文件夹（目录名即显示名） */
async function renameModel(body, res) {
    const safe = safeModelDirName(body && body.name);
    if (!safe) return jsonResponse(res, 400, { ok: false, message: '模型名无效' });
    const oldPath = path.join(MODELS_DIR, safe);
    const info = await stat(oldPath).catch(() => null);
    if (!info || !info.isDirectory()) return jsonResponse(res, 404, { ok: false, message: '模型不存在' });

    const desired = sanitizeModelDirName(body && body.displayName);
    if (!desired) return jsonResponse(res, 400, { ok: false, message: '名字不能为空（也不能只含 . / \\ : * ? " < > | 这类字符）' });
    if (desired === safe) return jsonResponse(res, 200, { ok: true, name: safe, newName: safe, unchanged: true });

    const target = await uniqueDirName(desired, safe);
    if (!target) return jsonResponse(res, 500, { ok: false, message: '重名太多，换个名字试试' });
    const newPath = path.join(MODELS_DIR, target);
    if (!newPath.startsWith(MODELS_DIR + path.sep)) return jsonResponse(res, 400, { ok: false, message: '名字无效' });

    try {
        await rename(oldPath, newPath);
    } catch (err) {
        // 目标被占用（Windows 上 rename 到已存在目录会失败）或文件被锁
        return jsonResponse(res, 500, { ok: false, message: '重命名失败：' + (err.message || err) });
    }
    console.log(`[Live2D] 模型重命名: ${safe} → ${target}`);
    return jsonResponse(res, 200, { ok: true, name: safe, newName: target, displayName: target });
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
const AGENT_WRITE_LIMIT = 1024 * 1024; // 写请求体上限 1MB

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
        // 读请求体并限制大小（旧实现无上限，一个超大 body 就能把进程内存吃满）
        const chunks = [];
        let total = 0;
        for await (const chunk of request) {
            total += chunk.length;
            if (total > AGENT_WRITE_LIMIT) {
                request.resume();
                return jsonResponse(res, 413, { ok: false, message: `写入内容超过 ${Math.round(AGENT_WRITE_LIMIT / 1024)}KB 上限` });
            }
            chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return jsonResponse(res, 400, { ok: false, message: '请求体无效' }); }
        const permission = String(body.permission || 'app');
        const target = resolveAgentPath(body.path, permission, isLocal);
        if (!target) { return jsonResponse(res, 403, { ok: false, message: (permission === 'computer' && isLocal) ? '路径无效' : PERM_DENIED_MSG }); }
        // 只在目录不存在时创建（Windows 对盘符根目录如 D:\ 执行 mkdir 会报 EPERM）
        const dir = path.dirname(target);
        try {
            await stat(dir);
        } catch {
            try { await mkdir(dir, { recursive: true }); } catch (e) { /* 忽略已存在等错误 */ }
        }
        await writeFile(target, String(body.content ?? ''), 'utf8');
        jsonResponse(res, 200, { ok: true, path: target });
    } catch (err) {
        jsonResponse(res, 500, { ok: false, message: err.message });
    }
}

// ===== 来源校验：Host 白名单 + 同站校验 =====
// 为什么需要：Agent 文件接口的权限模式由**请求方自己传参**决定，"是否本机"又只看 remoteAddress。
// 攻击者可以让自己的域名解析到 127.0.0.1（DNS rebinding），此时浏览器发出的请求同时满足
//   remoteAddress = 127.0.0.1（被当成本机管理员）
//   Origin.host === Host 头（两者都是攻击者的域名 → 旧的 CSRF 校验也会放行）
// 从而拿到任意文件读写能力。因此必须校验 Host 头本身。
const EXTRA_ALLOWED_HOSTS = String(process.env.ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const allowedHostNames = (() => {
    const set = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    try { set.add(String(os.hostname()).toLowerCase()); } catch { /* ignore */ }
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
            // IPv6 链路本地地址会带 %zone，Host 头里不会有
            set.add(String(net.address || '').split('%')[0].toLowerCase());
        }
    }
    for (const h of EXTRA_ALLOWED_HOSTS) set.add(h);
    set.delete('');
    return set;
})();

function hostnameOfHostHeader(raw) {
    const h = String(raw || '').trim().toLowerCase();
    if (!h) return '';
    if (h.startsWith('[')) {                       // IPv6 字面量：[::1]:4173
        const end = h.indexOf(']');
        return end > 0 ? h.slice(0, end + 1) : h;
    }
    const i = h.lastIndexOf(':');
    return i > 0 ? h.slice(0, i) : h;
}

function isAllowedHost(request) {
    const hostname = hostnameOfHostHeader(request.headers.host);
    if (!hostname) return false; // HTTP/1.1 必须带 Host
    return allowedHostNames.has(hostname);
}

// 本机回环地址：它们本身就是浏览器的安全上下文（localhost 豁免），
// 为了麦克风跳到 https 没有意义，只会白多一次证书警告。
function isLoopbackHostname(h) {
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

// 同站校验：第三方页面用 <img> / <script> / <a> 发起的 GET 不会带 Origin，
// 但一定会带 Sec-Fetch-Site: cross-site —— 这正是"任意网页都能读本机文件"的口子。
// 少数浏览器 / 旧版本不带 Sec-Fetch-*，所以再补一条：只要带了 Origin 且与 Host 不同源，
// 同样按跨站处理（不依赖方法，GET 也拦）。
// 非浏览器客户端（curl / 本机脚本 / Capacitor 原生插件）两者都不带，不参与判定。
function isCrossSiteRequest(request) {
    const sfs = String(request.headers['sec-fetch-site'] || '').toLowerCase();
    if (sfs) return sfs !== 'same-origin' && sfs !== 'none';
    const origin = request.headers.origin;
    if (!origin) return false;
    try { return new URL(origin).host !== (request.headers.host || ''); } catch { return true; }
}

// ===== HTTPS（手机端麦克风需要 secure context） =====
// 浏览器只允许在 https:// 或 localhost 下调 getUserMedia。手机通过 http://<局域网IP>:4173
// 访问时 navigator.mediaDevices 直接就是 undefined，所以语音输入在手机上必然不可用 ——
// 这是浏览器的硬性规定，前端没有任何绕过办法，只能补一个 HTTPS 端口。
// 证书自签，首次启动时生成到 data/ 下；手机上会提示"证书不受信任"，点继续即可。
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 4174);

function isPrivateIPv4(ip) {
    const p = String(ip).split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false;
    return p[0] === 10
        || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
        || (p[0] === 192 && p[1] === 168);
}

function localIPv4List() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list || []) {
            if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
        }
    }
    // 私有网段排前面：手机/平板能连上的通常是 192.168.x.x / 10.x / 172.16-31.x，
    // 而 VPN、虚拟网卡（常常是公网段，比如 26.x）手机根本连不到，
    // 日志里把它排前面会把人带偏。
    return out.sort((a, b) => (isPrivateIPv4(b) ? 1 : 0) - (isPrivateIPv4(a) ? 1 : 0));
}

function findOpenssl() {
    const candidates = [
        process.env.OPENSSL_PATH,
        'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
        'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
        'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
        '/usr/bin/openssl',
        '/usr/local/bin/openssl',
    ].filter(Boolean);
    for (const c of candidates) {
        try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* 换下一个 */ }
    }
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return 'openssl'; } catch { /* 没有 */ }
    return null;
}

// 读出证书还剩多少天、以及它是不是我们自己生成的。
// 自签证书默认 825 天（这是 Chrome / Safari 接受的上限），到期后浏览器会报
// ERR_CERT_DATE_INVALID —— 所以剩余不足 30 天时自动换新，不用等它坏了再来查。
function describeCert(certBuf) {
    try {
        const x = new X509Certificate(certBuf);
        return {
            daysLeft: (new Date(x.validTo).getTime() - Date.now()) / 86400000,
            selfMade: String(x.subject || '').includes('ElainaChat'),
        };
    } catch {
        return { daysLeft: Infinity, selfMade: false };
    }
}

async function ensureCertificate(force = false) {
    if (!force) {
        try {
            const [cert, key] = await Promise.all([readFile(CERT_FILE), readFile(KEY_FILE)]);
            if (cert.length && key.length) {
                const info = describeCert(cert);
                // 用户自己换的证书一律不动；只有我们自己签的才做自动续期
                if (!info.selfMade || info.daysLeft >= 30) {
                    return { cert, key, generated: false, daysLeft: info.daysLeft };
                }
                console.log('[HTTPS] 自签证书还有 ' + Math.max(0, Math.floor(info.daysLeft)) + ' 天到期，自动换新');
            }
        } catch { /* 还没有证书，往下生成 */ }
    }

    const openssl = findOpenssl();
    if (!openssl) return null;

    try {
        await mkdir(DATA_DIR, { recursive: true });
        // SAN 必须带上局域网 IP，否则手机访问时证书主体对不上，浏览器连"继续访问"都不给
        const sans = ['DNS:localhost', 'IP:127.0.0.1'];
        for (const ip of localIPv4List()) sans.push('IP:' + ip);
        execFileSync(openssl, [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', KEY_FILE, '-out', CERT_FILE,
            '-days', '825',
            '-subj', '/CN=ElainaChat',
            '-addext', 'subjectAltName=' + sans.join(','),
        ], { stdio: 'ignore', timeout: 60000 });
        const [cert, key] = await Promise.all([readFile(CERT_FILE), readFile(KEY_FILE)]);
        return { cert, key, generated: true, daysLeft: describeCert(cert).daysLeft };
    } catch (err) {
        console.warn('  ! HTTPS 自签证书生成失败：' + (err && err.message ? err.message : err));
        return null;
    }
}

// ===== 端侧数据存储（data/store.json） =====
// localStorage 是"每台设备各存一份"：电脑上聊的记录、填的 API Key，手机上完全看不到。
// 这里把需要跨设备共享的那几项落到服务端 data/ 目录，前端启动时拉取、写入时回推。
function normalizeStore(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof k !== 'string' || !k || k.length > 120) continue;
        if (typeof v !== 'string') continue;              // 只收字符串，与 localStorage 语义一致
        if (v.length > 8 * 1024 * 1024) continue;         // 单键 8MB 上限
        out[k] = v;
    }
    return out;
}

let storeCache = null;
let storeWriteQueue = Promise.resolve();

async function loadStore() {
    if (storeCache) return storeCache;
    try {
        storeCache = normalizeStore(JSON.parse(await readFile(STORE_FILE, 'utf8')));
    } catch {
        storeCache = {};   // 文件不存在 / 内容损坏 → 从空开始，不阻塞启动
    }
    return storeCache;
}

// 串行写入 + 先写临时文件再 rename：并发提交不会把文件写成半截
function saveStore() {
    storeWriteQueue = storeWriteQueue.then(async () => {
        await mkdir(DATA_DIR, { recursive: true });
        const tmp = STORE_FILE + '.tmp';
        await writeFile(tmp, JSON.stringify(storeCache), 'utf8');
        await rename(tmp, STORE_FILE);
    }).catch((err) => {
        console.error('[store] 写入失败:', err && err.message ? err.message : err);
    });
    return storeWriteQueue;
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

// 定期清理过期会话与登录失败记录。
// 旧实现只在"该 token / 该 IP 再次被访问"时顺带清理，长期运行会缓慢堆积内存。
const pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, exp] of sessions) if (now > exp) sessions.delete(token);
    for (const [ip, rec] of loginFails) if (rec.until && now > rec.until + LOGIN_LOCK_MS) loginFails.delete(ip);
}, 10 * 60 * 1000);
pruneTimer.unref?.();

// 去掉容易看错的字符（0/O、1/l/I），方便手输
const PWD_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomPassword(len = 12) {
    const bytes = randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) out += PWD_CHARS[bytes[i] % PWD_CHARS.length];
    return out;
}

function hashPassword(password, salt) {
    return scryptAsync(String(password), String(salt), 64).then(buf => Buffer.from(buf).toString('hex'));
}

/** 定长摘要后再比较：避免"长度不等直接 return"泄漏信息 */
function safeEqualText(a, b) {
    const ha = createHash('sha256').update(String(a)).digest();
    const hb = createHash('sha256').update(String(b)).digest();
    return timingSafeEqual(ha, hb);
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

// 校验密码。scrypt 是本服务里最重的计算，必须异步执行，
// 否则并发登录请求会把事件循环整块占住（同步 scryptSync 每次阻塞数十毫秒）。
async function verifyPassword(password) {
    if (!auth) return false;
    if (auth.isDefault && auth.password) return safeEqualText(password, auth.password);
    if (auth.salt && auth.hash) return safeEqualHex(await hashPassword(password, auth.salt), auth.hash);
    return false;
}

// 改成加盐哈希保存，之后控制台不再打印明文
async function setPassword(next) {
    const salt = randomBytes(16).toString('hex');
    auth = { isDefault: false, salt, hash: await hashPassword(next, salt), changedAt: new Date().toISOString() };
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

// ===== 请求日志 =====
// 目的：启动窗口里直接能看到「谁、什么时候、访问了什么、结果如何」，
// 排查手机连不上 / 接口报错时不用再去开浏览器控制台。
const QUIET_FILE_RE = /\.(?:js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|map)$/i;

function ipOf(request) {
    const raw = (request && request.socket && request.socket.remoteAddress) || '';
    if (raw === '::1') return '127.0.0.1';
    if (raw.startsWith('::ffff:')) return raw.slice(7);
    return raw || '?';
}

function timeStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// 把 response 包一层，结束时打一行。
// 静态资源且成功的不打 —— 否则窗口会被 js / css / 图片刷满，真正的信息反而被埋掉。
function attachRequestLog(request, response) {
    const started = Date.now();
    const origWriteHead = response.writeHead;
    response.writeHead = function (code, ...rest) {
        if (!response.__logStatus) response.__logStatus = code;
        return origWriteHead.call(this, code, ...rest);
    };
    response.on('finish', () => {
        const code = response.__logStatus || response.statusCode || 0;
        const rawPath = String(request.url || '/');
        if (code < 400 && QUIET_FILE_RE.test(rawPath.split('?')[0])) return;
        const ms = Date.now() - started;
        console.log('[' + timeStamp() + '] '
            + ipOf(request).padEnd(15) + ' '
            + String(request.method || '?').padEnd(5) + ' '
            + (rawPath.length > 52 ? rawPath.slice(0, 49) + '...' : rawPath).padEnd(52) + ' '
            + String(code).padEnd(4) + String(ms).padStart(5) + 'ms'
            + (response.__logNote ? '   ' + response.__logNote : '')
            + (code >= 500 ? '   << 服务端错误' : code >= 400 ? '   << 请求失败' : ''));
    });
}

// 302 跳转（可选带一条 Set-Cookie），用于 http → https 升级
function redirect(res, location, setCookie) {
    res.__logNote = '=> ' + location;
    const headers = { Location: location, 'Cache-Control': 'no-store' };
    if (setCookie) headers['Set-Cookie'] = setCookie;
    res.writeHead(302, headers);
    res.end();
}

function jsonResponse(res, code, obj, extraHeaders = {}) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders,
    });
    res.end(JSON.stringify(obj));
}

async function readJsonBody(request, limit = 64 * 1024) {
    const chunks = [];
    let total = 0;
    let overflow = false;
    for await (const chunk of request) {
        total += chunk.length;
        // 超限后继续把剩余数据读掉（丢弃），否则客户端可能拿不到这次响应而只看到连接被重置
        if (total > limit) { overflow = true; chunks.length = 0; continue; }
        chunks.push(chunk);
    }
    if (overflow) throw new Error('请求体过大');
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handleLogin(request, response) {
    const ip = request.socket?.remoteAddress || 'unknown';
    const rec = loginFails.get(ip);
    if (rec && rec.count >= LOGIN_MAX_FAILS && Date.now() < rec.until) {
        const sec = Math.ceil((rec.until - Date.now()) / 1000);
        request.resume(); // 丢弃请求体，避免客户端连接被重置
        return jsonResponse(response, 429, { ok: false, message: '尝试次数过多，请 ' + sec + ' 秒后再试' });
    }
    let body;
    try { body = await readJsonBody(request); } catch { return jsonResponse(response, 400, { ok: false, message: '请求无效' }); }
    if (!(await verifyPassword(body.password || ''))) {
        // 上一轮锁定已过期时重新计数，否则累计次数会永远停在高位
        const expired = !rec || Date.now() > rec.until;
        const count = expired ? 1 : rec.count + 1;
        loginFails.set(ip, { count, until: Date.now() + LOGIN_LOCK_MS });
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
  a { color:#738746; font-weight:600; text-decoration:underline; }
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
    <div class="divider" id="httpsDivider" style="display:none"></div>
    <p class="hint" id="httpsHint" style="display:none">
      要用语音输入？浏览器规定麦克风只能在 HTTPS 下调用，http 打开的页面一定用不了。<br>
      换成 <a id="httpsLink" href="#">这个 HTTPS 地址</a> 打开即可（首次会提示证书不受信任，
      点「高级」→「继续前往」）。只是聊天的话，现在这个地址就够了。
    </p>
  </div>
<script>
  // 手机通过「http + 局域网 IP」打开时，语音输入会被浏览器禁用（麦克风只在 https/localhost 下可用）。
  // 直接把可点的 HTTPS 地址摆出来，用户不用记端口号，也不用自己改协议。
  (function () {
    var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (location.protocol !== 'http:' || isLocal) return;
    fetch('/api/server-info')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var p = j && j.httpsPort;
        if (!p) return;
        // 登录页本身不该被带过去，指向根路径更合适（打开后没登录会自己跳回来）
        var path = location.pathname === '/login' ? '/' : location.pathname;
        var url = 'https://' + location.hostname + ':' + p + path + location.search;
        var a = document.getElementById('httpsLink');
        if (a) a.href = url;
        var d = document.getElementById('httpsDivider');
        var h = document.getElementById('httpsHint');
        if (d) d.style.display = 'block';
        if (h) h.style.display = 'block';
      })
      .catch(function () { /* 拿不到就不显示，不影响登录 */ });
  })();

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

// HTTP 与 HTTPS 共用的请求处理器（HTTPS 只是为了手机端能用麦克风，路由逻辑完全一致）
const requestHandler = async (request, response) => {
    attachRequestLog(request, response);
    try {
        const url = new URL(request.url || '/', `http://${host}`);
        const pathname = decodeURIComponent(url.pathname);

        // ① Host 白名单：防 DNS rebinding（详见 isAllowedHost 说明）。
        //    必须在其他所有处理之前，因为"是否本机"这个判断本身就依赖请求来源可信。
        if (!isAllowedHost(request)) {
            const msg = '禁止访问：请求的 Host「' + String(request.headers.host || '') + '」不在允许列表内。\n'
                + '如果你确实是通过主机名/域名访问，请用环境变量追加白名单后重启，例如：\n'
                + '  set ALLOWED_HOSTS=my-pc.local\n'
                + '（这是为了防止 DNS rebinding 让任意网页拿到本机管理员身份）';
            if (pathname.startsWith('/api/')) return jsonResponse(response, 403, { ok: false, message: msg });
            response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return response.end(msg);
        }

        // ①.5 HTTP → HTTPS 自动跳转
        // 手机用 http + 局域网 IP 打开时，浏览器一定不给麦克风（非安全上下文），
        // 与其让用户自己把地址改成 https，不如直接跳过去。四条边界：
        //   1. 只有 HTTPS 真的可用（证书就绪）时才跳，否则跳过去是打不开的
        //   2. 本机（localhost / 127.0.0.1）不跳 —— 它本来就是安全上下文
        //   3. /api/ 不跳 —— 前端 fetch 跟着跳转会因跨域失败
        //   4. 带 ?stay=http 可以留在 http（写 cookie 记住），给"只想聊天、不想点证书警告"的人一条退路；
        //      ?stay=https 恢复自动跳转
        if (!request.socket.encrypted) {
            let urlObj = null;
            try { urlObj = new URL(request.url || '/', 'http://' + (request.headers.host || 'localhost')); } catch { /* 忽略怪 URL */ }
            const stay = urlObj ? urlObj.searchParams.get('stay') : null;

            if (stay === 'http') {
                urlObj.searchParams.delete('stay');
                return redirect(response, urlObj.pathname + (urlObj.search || ''),
                    'elaina_stay_http=1; Path=/; Max-Age=31536000; SameSite=Lax');
            }
            if (stay === 'https') {
                return redirect(response, urlObj.pathname, 'elaina_stay_http=; Path=/; Max-Age=0; SameSite=Lax');
            }

            const reqHostname = hostnameOfHostHeader(request.headers.host);
            const canUpgrade = Boolean(certInfo)
                && !pathname.startsWith('/api/')                  // 接口不跳，否则前端 fetch 会炸
                && !isLoopbackHostname(reqHostname)               // 本机不跳
                && parseCookies(request)['elaina_stay_http'] !== '1'
                && /text\/html/i.test(String(request.headers.accept || '')); // 只跳页面导航，不跳静态资源
            if (canUpgrade) {
                // 跳到**同一个端口**的 https：每个端口都同时认两种协议，
                // 所以地址里只有协议变了，用户不用换端口号
                const hostHeader = String(request.headers.host || '');
                const colon = hostHeader.lastIndexOf(':');
                const reqPort = colon > 0 ? hostHeader.slice(colon + 1) : '443';
                return redirect(response, 'https://' + reqHostname + ':' + reqPort + (request.url || '/'));
            }
        }

        // ② CSRF：非 GET 的跨站请求一律拒绝（详见 isSameOrigin 说明）
        if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameOrigin(request)) {
            return jsonResponse(response, 403, { ok: false, message: '跨站请求被拒绝' });
        }
        // ③ 跨站 GET 也要拦：第三方页面的 <img>/<script>/跨域 fetch 请求都可能不带 Origin，
        //    但会带 Sec-Fetch-Site: cross-site（旧浏览器则带 Origin）。不拦的话
        //    /api/agent/read 这类 GET 接口可以被任意网页借本机浏览器读取本地文件。
        if (pathname.startsWith('/api/') && isCrossSiteRequest(request)) {
            return jsonResponse(response, 403, { ok: false, message: '跨站请求被拒绝' });
        }

        // 服务端信息（无需鉴权，只暴露端口号）：登录页也要用它 —— 手机用 http 打开时
        // 语音输入会被浏览器禁用，登录页得能给出可点的 HTTPS 地址。
        if (pathname === '/api/server-info' && request.method === 'GET') {
            return jsonResponse(response, 200, {
                ok: true,
                // 现在**同一个端口**就支持 https，所以返回主端口本身
                httpsPort: certInfo ? port : 0,
                httpPort: port,
            });
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

        // 前端日志上报：把浏览器控制台里的错误转到启动窗口。
        // 前端的问题（ASR 起不来、模型加载失败）平时只出现在浏览器控制台里，
        // 拿手机排查时根本看不到；转过来就能和请求日志对照着看。
        if (pathname === '/api/client-log' && request.method === 'POST') {
            let body;
            try { body = await readJsonBody(request, 64 * 1024); } catch { return jsonResponse(response, 400, { ok: false }); }
            const items = Array.isArray(body && body.items) ? body.items.slice(0, 20) : [];
            for (const it of items) {
                const level = String((it && it.level) || 'log').toUpperCase().slice(0, 5);
                const page = String((it && it.page) || '').slice(0, 36);
                const text = String((it && it.text) || '').replace(/\s+/g, ' ').slice(0, 300);
                if (!text) continue;
                console.log('[' + timeStamp() + '] ' + ipOf(request).padEnd(15) + ' 页面 '
                    + level.padEnd(5) + ' ' + (page ? page + '  ' : '') + text);
            }
            return jsonResponse(response, 200, { ok: true });
        }

        // 端侧数据存储：需要跨设备共享的那几项（设置 / 聊天记录 / API Key 等）走这里读写
        // data/store.json。已过上面的鉴权 —— 本机免密，手机端需要先登录。
        if (pathname === '/api/store' && request.method === 'GET') {
            return jsonResponse(response, 200, { ok: true, data: await loadStore() });
        }
        if (pathname === '/api/store' && request.method === 'POST') {
            let body;
            try {
                body = await readJsonBody(request, STORE_MAX_BYTES);
            } catch {
                return jsonResponse(response, 400, { ok: false, message: '提交内容过大或格式无效' });
            }
            const patch = normalizeStore(body && body.data);
            const store = await loadStore();
            Object.assign(store, patch);   // 按键合并：只覆盖本次提交的键，不动其它设备的其它键
            await saveStore();
            return jsonResponse(response, 200, { ok: true, keys: Object.keys(patch).length });
        }

        // 鉴权状态（供设置页展示：是否本机管理员、是否仍是初始随机密码）
        // 注意：初始明文密码只回给本机管理员，局域网会话拿不到（避免"能登录的人就能拿到明文密码"）
        if (pathname === '/api/auth/status' && request.method === 'GET') {
            const admin = isAdmin(request);
            return jsonResponse(response, 200, {
                ok: true,
                isAdmin: admin,
                isDefaultPassword: Boolean(auth && auth.isDefault),
                passwordHint: (admin && auth && auth.isDefault && auth.password) ? auth.password : '',
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
        // API：重命名模型（只改显示名，不动目录）
        if (pathname === '/api/live2d/rename' && request.method === 'POST') {
            let body;
            try { body = await readJsonBody(request); } catch { return jsonResponse(response, 400, { ok: false, message: '请求无效' }); }
            return await renameModel(body, response);
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

        // 浏览器会自己请求 /favicon.ico，没这个文件就每开一次页面刷一条 404，淹没真正的日志。
        // 回 204（表示"没有图标"）即可，安静且语义正确。
        if (pathname === '/favicon.ico') {
            response.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
            return response.end();
        }

        const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        // 禁止访问隐藏文件：否则 .local-auth.json（访问密码）会被直接下载走
        if (relative.split('/').some(seg => seg.startsWith('.'))) {
            response.writeHead(403, { 'X-Content-Type-Options': 'nosniff' }).end('Forbidden');
            return;
        }
        const target = path.resolve(root, relative);
        const allowRoots = [root, MODELS_DIR];
        const allowed = allowRoots.some(r => target.startsWith(r + path.sep));
        if (!allowed && target !== path.join(root, 'index.html')) {
            response.writeHead(403, { 'X-Content-Type-Options': 'nosniff' }).end('Forbidden');
            return;
        }
        // 用 lstat：符号链接一律不跟随，避免 web/ 内的软链把任意文件读出去
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('Not a regular file');

        // 模型目录里的文件一律按二进制流返回：
        // 用户上传的 zip 里若混入 .html/.svg，同源渲染就等于给了对方一个 XSS 执行点。
        // 应用自身的页面（不在 models 目录下）类型保持不变。
        const inModelsDir = target.startsWith(MODELS_DIR + path.sep);
        const ext = path.extname(target).toLowerCase();
        const ctype = inModelsDir ? 'application/octet-stream' : (contentTypes.get(ext) || 'application/octet-stream');

        response.writeHead(200, {
            'Content-Type': ctype,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        // 流式返回：pipe 不会转发错误，必须自己兜住，否则读取失败 / 客户端中途断开
        // 会变成未处理异常；同时保证客户端断开时释放文件句柄。
        const stream = createReadStream(target);
        stream.on('error', () => { try { response.destroy(); } catch { /* ignore */ } });
        response.on('close', () => { try { stream.destroy(); } catch { /* ignore */ } });
        stream.pipe(response);
    } catch {
        if (!response.headersSent) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }).end('Not found');
        } else {
            try { response.destroy(); } catch { /* ignore */ }
        }
    }
};

// 端口被占用等启动错误：给出可读提示，而不是抛一串裸栈
function printListenError(err, which, usedPort) {
    if (err && err.code === 'EADDRINUSE') {
        console.error('');
        console.error('  ✗ ' + which + ' 端口 ' + usedPort + ' 已被占用，服务没能启动。');
        console.error('    可能是之前已经开着一个 ElainaChat 服务（或其它程序占用了这个端口）。');
        console.error('    解决办法：关掉那个进程，或换个端口启动，例如：');
        console.error('      set PORT=4175 && set HTTPS_PORT=4176 && node web/serve.mjs');
        console.error('');
    } else {
        console.error('  ✗ ' + which + ' 服务启动失败：', err && err.message ? err.message : err);
    }
    process.exitCode = 1;
}

// 启动前准备访问密码（node web/serve.mjs --reset-password 可强制重新生成）
if (process.argv.includes('--reset-password')) {
    await rm(AUTH_FILE, { force: true });
    console.log('[鉴权] 已按 --reset-password 清除旧密码，将重新生成');
}
const authInfo = await ensureAuth();

// --reset-cert：强制换一张新的自签证书（比如 SAN 里的局域网 IP 变了、或者怀疑证书坏了）
const forceNewCert = process.argv.includes('--reset-cert');
if (forceNewCert) {
    await rm(CERT_FILE, { force: true });
    await rm(KEY_FILE, { force: true });
    console.log('[HTTPS] 已按 --reset-cert 清除旧证书，将重新生成');
}
const certInfo = await ensureCertificate(forceNewCert);

// ===== 监听入口：协议分路器 =====
// 为什么不各自 listen 一个端口：浏览器地址栏只输「192.168.0.200:4173」时，会自动补成 http://，
// 而麦克风只在 https / localhost 下可用。如果 https 必须走另一个端口，用户就得记住端口号、
// 还得手动敲 https:// 那 7 个字符 —— 这正是之前踩的坑。
// 所以让**同一个端口同时认两种协议**：首字节 0x16 是 TLS 握手（交给 https server），
// 其余（G/P/H 这些请求方法首字母）按明文 HTTP 处理。明文那一路由 requestHandler 里的
// 「HTTP → HTTPS 自动跳转」接走（本机地址除外）。
const httpServer = createServer(requestHandler);
const httpsServer = certInfo
    ? createSecureServer({ key: certInfo.key, cert: certInfo.cert }, requestHandler)
    : null;

if (httpsServer) {
    // TLS 握手失败：排查"手机连不上"时，有这一行就知道对方到底有没有连上来
    httpsServer.on('tlsClientError', (err, socket) => {
        const addr = (socket && socket.remoteAddress) ? socket.remoteAddress.replace('::ffff:', '') : '?';
        console.log('[' + timeStamp() + '] ' + addr.padEnd(15) + ' TLS 握手失败   '
            + String((err && err.message) || err).slice(0, 100));
    });
}

const muxSocket = (socket) => {
    socket.once('data', (buf) => {
        if (!buf || !buf.length) { socket.destroy(); return; }
        socket.pause();
        socket.unshift(buf);
        if (buf[0] === 0x16 && httpsServer) httpsServer.emit('connection', socket);
        else httpServer.emit('connection', socket);
        process.nextTick(() => socket.resume());
    });
};

const mainServer = createNetServer(muxSocket);
mainServer.on('error', (err) => printListenError(err, 'HTTP/HTTPS', port));

mainServer.listen(port, host, () => {
    // 只打地址。语音需要 https、证书警告、安全策略这些说明都放在应用里提示，
    // 启动窗口保持干净 —— 出问题时这一屏全是日志才看得清。
    console.log('');
    console.log('  本机:     http://127.0.0.1:' + port);
    if (host === '0.0.0.0' || host === '::') {
        for (const ip of localIPv4List()) {
            console.log('  局域网:   http://' + ip + ':' + port);
        }
    }
    // 只有还是初始随机密码时才打出来（否则用户没地方看密码）。
    // 自己改过之后不再显示 —— 改密码的入口在应用内的设置里。
    if (authInfo.isDefault) {
        console.log('');
        console.log('  访问密码: ' + authInfo.password);
    }
    console.log('');
});

// 兼容入口：老的 https://IP:4174 链接继续可用（两个端口都支持双协议）。
// 在这个端口上用明文 http 访问时，自动跳到同端口的 https。
if (httpsServer && HTTPS_PORT !== port) {
    const legacyServer = createNetServer((socket) => {
        socket.once('data', (buf) => {
            if (!buf || !buf.length) { socket.destroy(); return; }
            socket.pause();
            if (buf[0] === 0x16) {
                socket.unshift(buf);
                httpsServer.emit('connection', socket);
                process.nextTick(() => socket.resume());
                return;
            }
            // 明文：从请求头解析 Host 和目标路径，回 302 跳到同端口的 https
            const text = buf.toString('latin1');
            const hostMatch = /^host:\s*([^\r\n]+)/im.exec(text);
            const lineMatch = /^[A-Z]+\s+(\S+)/.exec(text);
            const hostHeader = (hostMatch ? hostMatch[1].trim() : '')
                || (String(socket.localAddress || '127.0.0.1') + ':' + HTTPS_PORT);
            let target = lineMatch ? lineMatch[1] : '/';
            if (!target.startsWith('/')) target = '/' + target;
            const to = 'https://' + hostHeader + target;
            const body = '<!doctype html><meta charset="utf-8"><title>跳转到 HTTPS</title>'
                + '<p style="font:15px/1.7 system-ui,sans-serif;padding:40px">'
                + '正在跳转到 <a href="' + to + '">' + to + '</a></p>';
            socket.end('HTTP/1.1 302 Found\r\n'
                + 'Location: ' + to + '\r\n'
                + 'Content-Type: text/html; charset=utf-8\r\n'
                + 'Content-Length: ' + Buffer.byteLength(body) + '\r\n'
                + 'Cache-Control: no-store\r\n'
                + 'Connection: close\r\n\r\n' + body);
        });
    });
    legacyServer.on('error', (err) => printListenError(err, 'HTTPS(兼容入口)', HTTPS_PORT));
    legacyServer.listen(HTTPS_PORT, host);
}
