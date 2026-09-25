import {
    createReadStream, appendFileSync, mkdirSync, renameSync, statSync,
    readdirSync, rmSync, existsSync, readFileSync, writeFileSync,
} from 'node:fs';
import { stat, lstat, mkdir, writeFile, readFile, readdir, rm, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomBytes, scrypt, createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify, inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import dns from 'node:dns';
import { createStore } from '../server/store.mjs';
import { synthesizeEdge, probeEdge } from '../server/edge-tts.mjs';
import { createModManager } from '../server/mods.mjs';
// "看电脑在干什么"（前台窗口 + 进程）—— 供桌宠让 AI 知道用户在做什么。
// 单独成模块：纯函数式便于测试，且以后"AI 操作电脑"要判断当前窗口时能直接复用。
import { activitySummaryCached } from '../server/activity.mjs';
// 电脑命令执行（全权限模式下 AI 跑 PowerShell / cmd）。危险命令的判定是纯函数，
// 单独成模块便于穷举断言 —— 判定错了后面所有防护都是空的（见 pc-command.mjs）。
import { classifyCommand, runCommand, formatCommandResult, availableShells } from '../server/pc-command.mjs';
// zip 解压 / 危险扩展名判定：**服务端唯一的实现**在 server/zip.mjs。
// 原先 serve.mjs 里还另有一份几乎相同的 unzip（含体积上限、危险类型拦截、GBK 解码、
// zip64 回退），与 zip.mjs 的 readZip 逐段重复 —— 两份实现意味着安全修复要改两处，
// 漏一处就是个洞。现已合并：这里只保留一个薄包装，语义（{files, blocked}）不变。
import { readZip, BLOCKED_EXT, effectiveExt } from '../server/zip.mjs';

const scryptAsync = promisify(scrypt);

const root = path.dirname(fileURLToPath(import.meta.url));
// 应用根目录（web 的上一级）与其下的 data/：
//   证书 + 端侧数据存储都放这里。因为它在 web/ 之外，静态文件服务够不到，
//   不会像放在 web/ 里那样被直接下载走。
const APP_ROOT = path.resolve(root, '..');
// DATA_DIR 可用环境变量覆盖：自动化检查要跑真实的读写与迁移，
// 如果直接写用户的 data/，每跑一次就会动到真实数据（甚至触发迁移）。
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(APP_ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const CERT_FILE = path.join(DATA_DIR, 'cert.pem');
const KEY_FILE = path.join(DATA_DIR, 'key.pem');
const STORE_MAX_BYTES = 32 * 1024 * 1024; // 端侧数据（聊天记录等）单次提交上限
// 默认监听 0.0.0.0：局域网内其他设备（手机/平板）可通过 http://<本机IP>:4173 访问。
// 可用 HOST 环境变量覆盖（如 HOST=127.0.0.1 仅本机）。
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4173);
const MODELS_DIR = path.join(root, 'live2d', 'models');
// 插件（mod）根目录。把 xxx.zip 丢进来就会被自动解压并写进 index.json，
// 前端只读清单 —— 因为浏览器没法列目录（详见 server/mods.mjs 的说明）。
const MODS_DIR = path.join(root, 'mods');
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
// BLOCKED_EXT / effectiveExt 已移到 server/zip.mjs（解压实现所在处），
// 这里通过上面的 import 使用 —— 危险类型清单属于"解压"的安全约束，
// 跟着实现走才能保证所有调用方（模型上传 / 数据导入 / mod 安装）都受保护。

/** 该路径是否是禁止在应用文件夹内写入的危险类型 */
function isBlockedWritePath(target) {
    return BLOCKED_EXT.has(effectiveExt(path.basename(String(target || ''))));
}

// ===== 日志系统 =====
//
// 格式参照 AstrBot（`astrbot/core/log.py`）：
//
//   控制台  [HH:mm:ss.SSS] [标签] [级别] [来源:行号]: 消息     （终端支持时带 ANSI 颜色）
//   文件    [YYYY-MM-DD HH:mm:ss.SSS] [标签] [级别] [来源:行号]: 消息
//
// 级别固定四位（DBUG/INFO/WARN/ERRO/CRIT），WARN 及以上再带 ` [v版本]` —— 都照 AstrBot 抄的，
// 等宽、能一眼扫出来、也好 grep。
//
// 时间用**本地时间**。旧实现用 toISOString()（UTC），于是文件名写着 20:04、行内却是 12:04，
// 差 8 小时对不上号 —— 日志最基础的可用性就是这个。
//
// 两个文件，各管一件事：
//   <启动时刻>.log         主日志：一行一条记录，方便 grep。服务、访问、中转摘要、Agent、页面报错。
//   <启动时刻>.trace.log   追踪日志：LLM 的完整请求消息 + 完整回复 + 完整上游报错。
//                          多行原样保留（这是给人读的），主日志里则压成一行并截断。
//
// 为什么分成两个：对话内容又长又私密。混在主日志里会把 grep 结果淹掉；而且排查问题时
// 主日志常常是要直接发出去的 —— 分开之后"要不要发对话内容"就变成一个明确的动作。
// 追踪日志默认开（`LOG_CHAT=0` 关掉），启动时会打一行提醒。
//
// 落盘策略：**每次启动一组文件**，文件名就是启动时刻；单个文件超过 LOG_MAX_BYTES 就拆 `_2`/`_3`；
// 只保留最近 LOG_KEEP 次启动（同一次启动的主日志与追踪日志一起留、一起删）。
//
// 不记录请求头：Authorization 就在里面，落盘等于把 API Key 写到磁盘上。
// 请求体/响应体里的凭据形态由 redactSecrets() 兜底。
// LOG_DIR 可以覆盖：自动化检查要起真实服务、跑真实的日志写入，
// 如果直接写用户的 data/logs，每跑一次就多一次"启动"、还会触发轮转删掉旧日志。
const LOG_DIR = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(DATA_DIR, 'logs');
const LOG_KEEP = 10;                       // 保留最近多少次启动的日志
const LOG_MAX_BYTES = 8 * 1024 * 1024;     // 单个日志文件上限，超出拆 _2/_3
const LOG_TO_FILE = String(process.env.LOG_TO_FILE ?? '1') !== '0';
// 完整对话内容是否写进追踪日志。默认开 —— 排查"AI 为什么这么答"时最缺的就是这个。
// 只作为**初始值**：运行中可在 设置 → 高级 → 日志 里切换（见 traceEnabled）。
const LOG_CHAT = String(process.env.LOG_CHAT ?? '1') !== '0';
const TRACE_MSG_MAX = 4000;                // 单条消息最多记多少字
const TRACE_BODY_MAX = 64 * 1024;          // 写进追踪日志的单次响应上限
// 内存里最多攒多少响应字节。比 TRACE_BODY_MAX 大，是因为非流式响应必须**完整**才能 JSON.parse
// 出回复正文；只攒 64KB 的话稍长一点的回复就解析失败，只能退化成贴一段原始 JSON。
const TRACE_ACCUM_MAX = 256 * 1024;

// 文件名：<时刻>.log / <时刻>.trace.log / <时刻>_2.log / <时刻>.trace_2.log / <时刻>-2.log（同秒再起一个实例）
const LOG_NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:[-._][A-Za-z0-9]+)*\.log$/;
const LOG_STAMP_LEN = 19;                  // `YYYY-MM-DD_HH-mm-ss` 的长度，用来按"启动"分组

const pad2 = (n) => String(n).padStart(2, '0');
/** 时刻 → 文件名里的那一段（本地时间） */
function logStampFor(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
        + `_${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`;
}
/** 时刻 → 日志行里的 `YYYY-MM-DD HH:mm:ss.SSS` */
function logTimeFull(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
        + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
        + `.${String(date.getMilliseconds()).padStart(3, '0')}`;
}
/** 时刻 → 控制台用的 `HH:mm:ss.SSS` */
function logTimeShort(date = new Date()) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
        + `.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

// ---- 级别（四位，对齐 AstrBot 的 short_levelname）----
const LEVEL_SHORT = { DEBUG: 'DBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERRO', CRITICAL: 'CRIT' };
const LEVEL_NO = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, CRITICAL: 50 };
// 级别从低到高。对外（设置界面 / API）一律用这套全名，短名只出现在日志行里。
const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];
// 用户可能填 AstrBot 那套短名或 logging 的全名，统一收敛
const LEVEL_INPUT_ALIASES = {
    DBUG: 'DEBUG', DEBUG: 'DEBUG',
    INFO: 'INFO', INFORMATION: 'INFO',
    WARN: 'WARN', WARNING: 'WARN',
    ERRO: 'ERROR', ERR: 'ERROR', ERROR: 'ERROR',
    CRIT: 'CRITICAL', CRITICAL: 'CRITICAL', FATAL: 'CRITICAL',
};

// ---- 落盘级别（运行时可改，设置界面 → 高级 → 日志）----
//
// 与 AstrBot 的分工一致：**控制台 sink 恒为 DEBUG（终端永远看全量），文件 sink 按级别过滤**。
// 这样"排查时终端不丢东西"和"日志文件不被 DEBUG 刷爆"可以同时成立。
//
// 为什么级别要可改而不是写死环境变量：这个应用是双击 `启动.bat` 跑的，用户改不了环境变量 ——
// 环境变量只作为**首次启动的初始值**，之后由设置界面写进 data/log-settings.json。
// 日志设置文件。跟着 LOG_DIR 走：自动化检查会用临时目录覆盖 LOG_DIR，
// 若这里写死 DATA_DIR，跑一次检查就会把用户真实的日志级别改掉。
const LOG_SETTINGS_FILE = path.join(LOG_DIR, 'log-settings.json');
let fileLevel = 'INFO';        // 当前落盘级别（低于它的记录只进控制台）
let traceEnabled = LOG_CHAT;   // 对话追踪日志开关（运行时可切）

/** 把任意写法收敛成标准级别名；非法值返回 null（调用方决定回落到什么） */
function normalizeLevelName(raw) {
    return LEVEL_INPUT_ALIASES[String(raw || '').trim().toUpperCase()] || null;
}

/** 读持久化的日志设置（缺失/损坏都返回空对象，由调用方回落默认值） */
function readSavedLogSettings() {
    try {
        const saved = JSON.parse(readFileSync(LOG_SETTINGS_FILE, 'utf8'));
        return (saved && typeof saved === 'object') ? saved : {};
    } catch { return {}; }
}

// 初始化：环境变量 > data/log-settings.json > 默认。
// 环境变量优先是刻意的 —— 自动化检查要能强制指定级别，而不受本机已保存的值干扰。
{
    const saved = readSavedLogSettings();
    fileLevel = normalizeLevelName(process.env.LOG_LEVEL)
        || normalizeLevelName(saved.level)
        || 'INFO';
    if (process.env.LOG_CHAT === undefined && typeof saved.trace === 'boolean') {
        traceEnabled = saved.trace;
    }
}

/** 当前级别是否该落盘（控制台不受它约束） */
function shouldLogToFile(level) {
    return (LEVEL_NO[level] || 20) >= (LEVEL_NO[fileLevel] || 20);
}

/** 落盘级别的持久化。改级别是低频操作，直接同步写，省掉一套异步队列 */
function persistLogSettings() {
    if (!LOG_TO_FILE) return;
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        writeFileSync(LOG_SETTINGS_FILE, JSON.stringify({
            level: fileLevel, trace: traceEnabled, updatedAt: new Date().toISOString(),
        }, null, 2), 'utf8');
    } catch { /* 写不进去不影响本次运行，只是下次启动回到旧值 */ }
}

/** 运行中改落盘级别。返回是否真的变了（没变就不用重挂 sink / 写盘） */
function setFileLogLevel(next) {
    const level = normalizeLevelName(next);
    if (!level || level === fileLevel) return false;
    fileLevel = level;
    persistLogSettings();
    return true;
}

/**
 * 运行中开关对话追踪日志。
 * 打开时若文件还没建过就补建一个 —— 否则用户打开开关、去目录里找却什么都没有，
 * 会以为开关没生效（启动时只建过一次，那时是关的）。
 */
function setTraceEnabled(on) {
    const next = Boolean(on);
    if (next === traceEnabled) return false;
    traceEnabled = next;
    if (next && LOG_TO_FILE && !traceSink.file) {
        try {
            traceSink.file = sinkPath(traceSink);
            appendFileSync(traceSink.file, '');
        } catch { /* 建不出来就只影响追踪日志 */ }
    }
    persistLogSettings();
    return true;
}
// AstrBot 的级别色：DEBUG 亮蓝 / INFO 亮青 / WARN 亮黄 / ERROR 红 / CRIT 亮红
const LEVEL_COLOR = {
    DEBUG: '\x1b[1;34m', INFO: '\x1b[1;36m', WARN: '\x1b[1;33m',
    ERROR: '\x1b[31m', CRITICAL: '\x1b[1;31m',
};
const ANSI_RESET = '\x1b[0m';
const ANSI_TIME = '\x1b[32m';   // 时间绿色，同 AstrBot 的 <green>{time}</green>

// 版本号：WARN 及以上会附在级别后面（同 AstrBot 的 astrbot_version_tag）。
// 这个项目频繁重打包，出问题时能一眼对上"这份日志是哪一版产生的"。
let APP_VERSION = '0.0.0';
try {
    APP_VERSION = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || APP_VERSION;
} catch { /* 读不到就算了 */ }

// 消息开头的 [xxx] 会被抽出来当标签，正文里不再重复 —— 所以调用点照旧写
// `console.log('[relay] ...')` 即可。这里把历史遗留的标签收敛成一套固定词汇，
// 免得日志里同时出现 [boot]/[log]/[HTTPS]/[鉴权] 四种风格。
const TAG_ALIASES = {
    boot: 'Core', log: 'Core', store: 'Store', relay: 'Relay', live2d: 'Live2D',
    agent: 'Agent', chat: 'Chat', http: 'HTTP', page: 'Page',
    鉴权: 'Auth', auth: 'Auth', https: 'Cert', tls: 'Cert', cert: 'Cert',
    tts: 'TTS', asr: 'ASR', vision: 'Vision',
};
function normalizeTag(raw) {
    const key = String(raw || '').trim();
    if (!key) return 'Core';
    const hit = TAG_ALIASES[key] || TAG_ALIASES[key.toLowerCase()];
    if (hit) return hit;
    // 未知标签原样保留（首字母大写），免得新写的标签被悄悄吞掉
    return key.length <= 12 ? key[0].toUpperCase() + key.slice(1) : 'Core';
}

// 来源位置：取调用栈里第一条**不属于日志模块自己**的帧。
// 必须跳过内部帧，否则每条日志都会指向 emitLog 自己，等于没写。
// patchedConsoleLog 是下面那个 console 包装函数的名字 —— 得在这里就先登记上。
const LOG_INTERNAL_FNS = new Set(['emitLog', 'appendToFile', 'captureLocation', 'patchedConsoleLog', 'traceLine', 'logCritical']);
function captureLocation() {
    try {
        const lines = String(new Error().stack || '').split('\n');
        for (let i = 1; i < lines.length; i++) {
            const m = lines[i].match(/at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/);
            if (!m) continue;
            // 被赋成 console.log 之后，V8 把函数名渲染成 `console.patchedConsoleLog [as log]`。
            // 不剥掉 ` [as log]` 后缀的话，名字既不等于 `patchedConsoleLog`、也过不了
            // `^.*\.` 那一刀，于是包装层会被当成"真正的调用点" —— 结果是**每一条**日志
            // 都指向包装函数内部那一行，来源定位完全失效。
            const rawFn = (m[1] || '').replace(/\s*\[as\s+[^\]]*\]\s*$/, '').trim();
            if (LOG_INTERNAL_FNS.has(rawFn) || LOG_INTERNAL_FNS.has(rawFn.replace(/^.*\./, ''))) continue;
            const file = m[2].replace(/\\/g, '/');
            if (!file || file.startsWith('node:')) continue;
            const base = file.split('/').pop().replace(/\.(mjs|cjs|js)$/, '');
            if (!base) continue;
            return base + ':' + m[3];
        }
    } catch { /* 拿不到行号不影响日志本身 */ }
    return 'serve.mjs:?';
}

// 控制台是否上色。hasColors() 自己会尊重 NO_COLOR / FORCE_COLOR；非 TTY（重定向到文件）
// 时返回 false，所以把控制台重定向出去也不会带一堆转义码。
const CONSOLE_COLOR = (() => {
    try {
        if (!process.stdout.isTTY) return false;
        if (typeof process.stdout.hasColors === 'function') return process.stdout.hasColors();
        return !process.env.NO_COLOR;
    } catch { return false; }
})();

// 包装 console 之前先留一份原件：日志系统自己输出时要用它，否则会递归。
const consoleOriginal = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
};

// 老版本的日志是固定名 server.log（按 4MB 滚动成 server.log.1）。
// 直接放着不管会永远留一个不会再更新的孤儿文件，用户分不清哪个是新的；
// 按它的修改时间改名成新格式，让它作为一份历史日志正常参与轮转。
function adoptLegacyLogs() {
    for (const [legacy, tag] of [['server.log', ''], ['server.log.1', '_old']]) {
        const full = path.join(LOG_DIR, legacy);
        try {
            if (!existsSync(full)) continue;
            const stamp = logStampFor(statSync(full).mtime);
            let target = path.join(LOG_DIR, stamp + tag + '.log');
            for (let i = 2; existsSync(target); i++) target = path.join(LOG_DIR, `${stamp}${tag}_${i}.log`);
            renameSync(full, target);
            consoleOriginal.log(`[${logTimeShort()}] [Core] [INFO] [serve.mjs:?]: 旧日志 ${legacy} 已改名为 ${path.basename(target)}`);
        } catch { /* 改不动就留着，不影响启动 */ }
    }
}

// 只保留最近 LOG_KEEP **次启动**。
// 按"启动"分组而不是按文件数：一次启动现在会产出两个文件（主日志 + 追踪日志），
// 按文件数算的话"留 10 份"就只等于 5 次启动，用户设的保留量会凭空缩水一半。
function pruneOldLogs() {
    try {
        const sessions = new Map();
        for (const name of readdirSync(LOG_DIR)) {
            if (!LOG_NAME_RE.test(name)) continue;
            const key = name.slice(0, LOG_STAMP_LEN);   // 文件名前缀就是启动时刻
            if (!sessions.has(key)) sessions.set(key, []);
            sessions.get(key).push(name);
        }
        const stale = [...sessions.keys()].sort().slice(0, Math.max(0, sessions.size - LOG_KEEP));
        for (const key of stale) {
            for (const name of sessions.get(key)) {
                rmSync(path.join(LOG_DIR, name), { force: true });
                consoleOriginal.log(`[${logTimeShort()}] [Core] [INFO] [serve.mjs:?]: 清理旧日志 ${name}（只保留最近 ${LOG_KEEP} 次启动）`);
            }
        }
    } catch { /* 清理失败不影响启动 */ }
}

/**
 * 写进日志文件的文本要脱敏。
 *
 * 起因：启动横幅里有「访问密码: xxxxxxxx」，而它会被原样落盘。排查问题时这些日志
 * 是要发出去的（贴到聊天里、发给别人看），明文密码就跟着一起漏了。
 * 追踪日志里还有完整对话和上游请求体，更需要这一层。
 *
 * 只在**写文件**这一层脱敏，控制台输出保持原样 —— 用户本来就靠终端里那行密码登录，
 * 而 `启动.bat` 并没有把控制台重定向到文件，所以不存在"换个地方又漏出去"的口子。
 */
const SECRET_RULES = [
    // 启动横幅：只保留标签
    [/访问密码[:：]\s*\S+/g, '访问密码: ******（仅打印在控制台，不写入日志）'],
    // 兜底：万一日志里带上了 Authorization 头或 key=value 形式的凭据
    [/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1******'],
    [/((?:apiKey|api_key|api-key|accessKey|access_key|token|password|secret|authorization)"?\s*[:=]\s*"?)([A-Za-z0-9._\-]{12,})/gi, '$1******'],
    // 常见厂商的裸 key 形态（sk- / rc- 等），万一出现在对话或报错里
    [/\b(sk|rc|hk|ak)-[A-Za-z0-9._\-]{16,}/g, '$1-******'],
];

function redactSecrets(text) {
    let out = String(text);
    for (const [re, to] of SECRET_RULES) out = out.replace(re, to);
    return out;
}

// ---- 两个 sink 的文件状态 ----
// part=1 时文件名不带序号；超过 LOG_MAX_BYTES 后递增，变成 `_2`、`_3`……
// 同一秒内起两个实例时用 `-2` 挂在 base 上（不是 `_2`），免得和大小拆分的序号撞车。
const mainSink = { base: '', ext: '.log', part: 1, file: '', bytes: 0 };
const traceSink = { base: '', ext: '.trace.log', part: 1, file: '', bytes: 0 };
function sinkPath(sink) {
    return path.join(LOG_DIR, sink.base + (sink.part > 1 ? '_' + sink.part : '') + sink.ext);
}

function initLogFiles() {
    if (!LOG_TO_FILE) return;
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        adoptLegacyLogs();
        let base = logStampFor(new Date());
        for (let i = 2; existsSync(path.join(LOG_DIR, base + '.log')); i++) base = logStampFor(new Date()) + '-' + i;
        mainSink.base = base;
        traceSink.base = base;
        mainSink.file = sinkPath(mainSink);
        traceSink.file = sinkPath(traceSink);
        appendFileSync(mainSink.file, '');   // 立即建出空文件：这样它也会被算进"最近 N 次启动"
        // 追踪日志也先建出来。启动横幅里已经报了它的路径，用户照着去找却找不到会以为功能坏了；
        // 而且这样 `tail -f` 能从服务一启动就挂上，不用等第一次对话。
        if (traceEnabled) appendFileSync(traceSink.file, '');
    } catch { /* 目录不可写时退化为"只打控制台" */ }
}

/** 追加一行到某个 sink，必要时按大小换下一段 */
function appendToFile(sink, text) {
    if (!LOG_TO_FILE || !sink.file) return;
    try {
        const bytes = Buffer.byteLength(text);
        if (sink.bytes + bytes > LOG_MAX_BYTES) {
            sink.part += 1;
            sink.file = sinkPath(sink);
            sink.bytes = 0;
            consoleOriginal.log(`[${logTimeShort()}] [Core] [INFO] [serve.mjs:?]: 日志超过 `
                + `${Math.round(LOG_MAX_BYTES / 1024 / 1024)}MB，换到 ${path.basename(sink.file)}`);
        }
        appendFileSync(sink.file, text);
        sink.bytes += bytes;
    } catch { /* 日志写不进去也绝不能影响主流程 */ }
}

/**
 * 写一条主日志。
 *
 * 消息开头的 `[标签]` 会被抽出来当标签字段，正文里不再重复 —— 这样调用点还是
 * `console.log('[relay] ...')` 这种最自然的写法，输出却是 AstrBot 那种结构化的
 * `[时刻] [Relay] [INFO] [serve.mjs:1344]: ...`。
 */
function emitLog(level, args) {
    const text = args
        .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4, breakLength: Infinity })))
        .join(' ');
    const m = text.match(/^\s*\[([^\]\n]{1,16})\]\s*([\s\S]*)$/);
    const tag = m ? normalizeTag(m[1]) : 'Core';
    const body = (m ? m[2] : text).replace(/\s+$/, '');
    // 纯空白不落盘：旧实现会把 console.log('') 也写成一条空记录，翻日志时全是噪音
    if (!body.trim()) return;

    const now = new Date();
    const short = LEVEL_SHORT[level] || 'INFO';
    const loc = captureLocation();
    // AstrBot 只在 WARNING 及以上附版本号 —— 正常信息里塞版本号纯属噪音
    const verTag = (LEVEL_NO[level] || 20) >= 30 ? ` [v${APP_VERSION}]` : '';

    // 文件：一条记录一行（换行压成 ⏎），保证 grep / tail 的可用性。
    // 完整的多行内容在追踪日志里，那里不压。
    // 低于当前落盘级别的记录只进控制台 —— 终端始终是全量，级别只用来收窄文件。
    if (shouldLogToFile(level)) {
        const flat = body.replace(/\s*\n\s*/g, ' ⏎ ');
        appendToFile(mainSink, `[${logTimeFull(now)}] [${tag}] [${short}]${verTag} [${loc}]: ${redactSecrets(flat)}\n`);
    }

    // 控制台：正文保持原样（多行就多行），人看的
    const head = CONSOLE_COLOR
        ? `${ANSI_TIME}[${logTimeShort(now)}]${ANSI_RESET} [${tag}] ${LEVEL_COLOR[level] || ''}[${short}]${ANSI_RESET}${verTag} [${loc}]: `
        : `[${logTimeShort(now)}] [${tag}] [${short}]${verTag} [${loc}]: `;
    consoleOriginal.log(head + body);
}

/**
 * 写追踪日志：LLM 的完整请求消息、完整回复、完整上游报错。
 * 多行**原样保留**（这是给人读的）；主日志里对应的那条会压成一行并截断。
 * 只在开头带一个时间戳，正文块不再逐行加前缀，免得把内容切碎。
 */
function traceLine(text) {
    if (!traceEnabled) return;
    const body = String(text ?? '');
    if (!body.trim()) return;
    appendToFile(traceSink, `[${logTimeFull()}] ${redactSecrets(body)}\n`);
}

initLogFiles();

for (const [method, level] of [
    ['log', 'INFO'], ['info', 'INFO'], ['debug', 'DEBUG'], ['warn', 'WARN'], ['error', 'ERROR'],
]) {
    // 具名函数：captureLocation() 靠函数名跳过包装层，匿名箭头函数拿不到稳定的名字
    console[method] = function patchedConsoleLog(...args) {
        try {
            // 只走 emitLog —— 它已经负责格式化并调用 consoleOriginal 输出。
            // 这里若再 original(...args) 打一遍，控制台上每条日志会出现两行（原文 + 格式化），
            // 而落盘的只有格式化那行，两边对不上号。
            emitLog(level, args);
        } catch {
            // 日志系统自己出问题时必须把内容原样吐出来，否则等于把整条链路静音
            consoleOriginal[method === 'debug' ? 'log' : method](...args);
        }
    };
}

// CRITICAL 没有对应的 console 方法，用显式函数暴露。
// 之前 LEVEL_SHORT / LEVEL_NO / LEVEL_COLOR 里都定义了 CRITICAL，却没有任何代码能产生它 ——
// 是彻头彻尾的死配置。现在补上真正的产生路径，级别过滤里它才有意义。
function logCritical(...args) {
    try { emitLog('CRITICAL', args); } catch { consoleOriginal.error(...args); }
}

pruneOldLogs();   // 放在包装之后：清理动作本身也进日志

// 记录本次启动的标识，日志文件里能看出这份日志属于哪一次、跑了多久
const BOOT_AT = Date.now();
console.log(`[boot] serve.mjs 启动 pid=${process.pid} node=${process.version} 版本 v${APP_VERSION}`);
if (LOG_TO_FILE) {
    console.log(`[boot] 主日志: ${path.relative(APP_ROOT, mainSink.file)}`);
    // 落盘级别是运行时可改的，启动时把它说清楚 —— 否则用户会疑惑"我调成 WARN 了，怎么还有 INFO"
    console.log(`[boot] 落盘级别: ${fileLevel}（终端始终显示全部级别；可在 设置 → 高级 → 日志 里调整）`);
    // 追踪日志里有完整对话内容，用户排查时常常把日志直接发出去 —— 必须明确提醒一句
    console.log(traceEnabled
        ? `[boot] 追踪日志: ${path.relative(APP_ROOT, traceSink.file)}（含完整对话内容，对外分享前先看一眼）`
        : '[boot] 追踪日志已关闭，只记录访问与错误摘要（设置 → 高级 → 日志 可开启）');
    console.log(`[boot] 每次启动一组文件，只保留最近 ${LOG_KEEP} 次启动`);
} else {
    console.log('[boot] 本次不落盘（LOG_TO_FILE=0），日志只打在控制台');
}

// 收尾也留一行：日志文件的最后一个时间戳就是会话结束时刻，配合文件名就能知道"这次跑了多久"。
// 排查"服务是不是半夜自己挂了"时，这一行是唯一的判据。
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        try {
            const sec = Math.round((Date.now() - BOOT_AT) / 1000);
            console.log(`[boot] 收到 ${signal}，服务结束（本次运行 ${sec} 秒）`);
        } catch { /* 收尾日志失败也要能正常退出 */ }
        process.exit(0);
    });
}

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


/**
 * 兼容包装：原先 serve.mjs 自带的 unzip 已合并到 server/zip.mjs。
 *
 * 保留这个名字与返回形态（{files, blocked}）是为了不动调用点 ——
 * 模型上传与 mod 安装都按这个形态取值。实现只有一份，在 zip.mjs。
 */
function unzip(buf, opts = {}) {
    return readZip(buf, { ...opts, returnBlocked: true });
}

// ===== 插件（mod）管理器 =====
// 复用上面那份 unzip（它已带体积上限、危险类型拦截、路径穿越防护），
// 而不是另写一份解压 —— 解压是安全敏感代码，只该有一个实现。
const modManager = createModManager({
    modsDir: MODS_DIR,
    unzip,
    isUnsafeEntryName,
    effectiveExt,
    log: (msg) => console.log('[Mod] ' + msg),
});

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

/**
 * 递归收集模型目录下所有文件的相对路径（正斜杠分隔）。
 * 表情/动作并不保证放在固定子目录里：Cubism 只规定 *.exp3.json / *.motion3.json 的文件格式，
 * 放在哪由模型作者自己决定。仓库内置的 deepseek 就把 50 多个 *.exp3.json 直接堆在模型根目录、
 * 动作放在 motions/ 子目录 —— 早期"只扫 exp/ 子目录"的实现因此一个都看不到，
 * 表现为"打包进去的模型没有表情/动作"。
 * 限制递归深度，避免病态目录树把模型列表接口拖慢。
 */
async function collectModelFiles(dir, prefix = '', depth = 0) {
    if (depth > 3) return [];
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const entry of entries) {
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) out.push(...await collectModelFiles(path.join(dir, entry.name), rel, depth + 1));
        else out.push(rel);
    }
    return out;
}

/**
 * 列出已上传模型（附 model3.json 路径、exps 表情/motions 动作列表、vtube.json 路径，
 * 供 AI 表情决策与探测使用）。
 * exps/motions 里是「相对模型根目录的路径」（如 `脸红.exp3.json`、`motions/idle.motion3.json`），
 * 不是裸文件名 —— 客户端要按这个路径去拼资源地址。
 */
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
                const files = await collectModelFiles(path.join(MODELS_DIR, name));
                // model3.json / vtube.json 优先取根目录下的，避免纹理等子目录里的同名文件抢走
                const pickRoot = (pred) => files.find(f => !f.includes('/') && pred(f)) || files.find(pred) || null;
                modelJson = pickRoot(f => f.toLowerCase().endsWith('.model3.json'));
                vtube = pickRoot(f => f.toLowerCase().endsWith('.vtube.json'));
                exps = files.filter(f => f.toLowerCase().endsWith('.exp3.json')).sort();
                motions = files.filter(f => f.toLowerCase().endsWith('.motion3.json')).sort();
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

// ===== 外壳文件夹（桌面/文档/下载…）的真实位置 =====
// 为什么非要有这块：用户可以把桌面「移动」到任意位置（资源管理器 → 桌面属性 → 位置 → 移动），
// OneDrive 也会把桌面重定向到 OneDrive 下。此时 C:\Users\<用户名>\Desktop **根本不存在**，
// 而 AI 只会按惯例猜这个路径 —— 猜错就是一句「目录不存在」，然后它就没招了（实测踩过：
// 用户的桌面在 D:\桌面，AI 猜 C:\Users\Administrator\Desktop，404，操作终止）。
// 权威答案在注册表 HKCU\...\Explorer\User Shell Folders 里，这里读出来给 AI 用。
//
// fallback 是「注册表读不到」时的按惯例猜测（非 Windows、或安全策略拦住 reg.exe/PowerShell）。
const SHELL_FOLDER_SPECS = [
    { key: 'desktop', label: '桌面', reg: ['Desktop'], fallback: ['Desktop', '桌面', 'OneDrive/Desktop', 'OneDrive/桌面'], aliases: ['desktop', '桌面'] },
    { key: 'documents', label: '文档', reg: ['Personal'], fallback: ['Documents', '文档'], aliases: ['documents', '文档'] },
    { key: 'downloads', label: '下载', reg: ['{374DE290-123F-4565-9164-39C4925E467B}'], fallback: ['Downloads', '下载'], aliases: ['downloads', '下载'] },
    { key: 'pictures', label: '图片', reg: ['My Pictures'], fallback: ['Pictures', '图片'], aliases: ['pictures', '图片'] },
    { key: 'music', label: '音乐', reg: ['My Music'], fallback: ['Music', '音乐'], aliases: ['music', '音乐'] },
    { key: 'videos', label: '视频', reg: ['My Video'], fallback: ['Videos', '视频'], aliases: ['videos', '视频'] },
];

/** 展开 Windows 环境变量（%USERPROFILE% 之类），大小写不敏感 */
function expandWindowsEnv(value) {
    return String(value || '').replace(/%([^%\s]+)%/g, (whole, name) => {
        const hit = Object.keys(process.env).find(k => k.toLowerCase() === String(name).toLowerCase());
        return hit ? process.env[hit] : whole;
    });
}

/**
 * 把命令行程序的原始输出字节解成字符串。
 *
 * 为什么不能直接 `encoding: 'utf8'`：Windows 的控制台程序（reg.exe / powershell.exe）
 * 默认按**系统 ANSI 代码页**写 stdout，中文系统是 GBK。按 UTF-8 解会把 `D:\桌面`
 * 变成 `D:\����` —— 路径看起来"读到了"，实际是错的，比读不到更危险。
 * Node 自带完整 ICU，所以这里用「先 UTF-8，出现替换字符就按 GBK 重解」的启发式。
 */
function decodeCliText(buf) {
    const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''));
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    if (!utf8.includes('\uFFFD')) return utf8;
    try { return new TextDecoder('gbk').decode(bytes); } catch { return utf8; }
}

/** 读注册表里的 User Shell Folders。返回 { 值名: 路径 }，读不到就是空对象 */
function readUserShellFolders() {
    const out = {};
    if (process.platform !== 'win32') return out;
    const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';

    // ① PowerShell：输出用 Base64 包一层（见下），这样非 ASCII 路径不会被代码页打碎。
    //    放在前面是因为 reg.exe 没法控制输出编码，中文路径有被弄坏的风险。
    try {
        const script = "$p = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'"
            + " | Select-Object -Property * -Exclude PS* | ConvertTo-Json -Compress;"
            + " [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))";
        const raw = decodeCliText(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000, windowsHide: true }));
        const parsed = JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8') || '{}');
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    } catch { /* 没装 / 被策略拦住，走兜底 */ }

    // ② 兜底：reg.exe（PowerShell 被禁用时）。输出形如：    Desktop    REG_EXPAND_SZ    D:\桌面
    if (!Object.keys(out).length) {
        try {
            const raw = decodeCliText(execFileSync('reg.exe', ['query', regKey], { timeout: 5000, windowsHide: true }));
            for (const line of raw.split(/\r?\n/)) {
                const m = line.match(/^\s*(.+?)\s{2,}REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i);
                if (m) out[m[1].trim()] = m[2].trim();
            }
        } catch { /* 被安全策略拦住 / 不存在，交给上层按惯例猜 */ }
    }
    return out;
}

// 只解析一次（起进程不便宜，而且这些路径在一次运行里不会变）
const shellFolderCache = { resolved: false, roots: [], aliasMap: new Map() };

function resolveShellFolders() {
    if (shellFolderCache.resolved) return shellFolderCache;
    shellFolderCache.resolved = true; // 先置位：即使解析抛异常也不重复起进程
    const registry = readUserShellFolders();
    const home = os.homedir();
    const aliasMap = new Map();
    const roots = [];
    for (const spec of SHELL_FOLDER_SPECS) {
        let found = '';
        for (const name of spec.reg) {
            if (registry[name]) { found = expandWindowsEnv(registry[name]); break; }
        }
        if (!found) {
            for (const name of spec.fallback) {
                const candidate = path.resolve(home, name);
                if (existsSync(candidate)) { found = candidate; break; }
            }
        }
        if (!found) continue;
        roots.push({ key: spec.key, label: spec.label, path: found, exists: existsSync(found) });
        for (const alias of spec.aliases) aliasMap.set(alias.toLowerCase(), found);
    }
    aliasMap.set('userprofile', home);
    aliasMap.set('home', home);
    if (process.env.TEMP) aliasMap.set('temp', process.env.TEMP);
    if (process.env.APPDATA) aliasMap.set('appdata', process.env.APPDATA);
    if (process.env.LOCALAPPDATA) aliasMap.set('localappdata', process.env.LOCALAPPDATA);
    shellFolderCache.roots = roots;
    shellFolderCache.aliasMap = aliasMap;
    return shellFolderCache;
}

/**
 * 把 AI 写的路径别名换成真实路径。
 * 支持 `%DESKTOP%\a.txt`（大小写不敏感）与 `~desktop/a.txt` / `~/a.txt`。
 * 只认这两种显式写法 —— 不去猜「桌面\a.txt」这种裸词，否则一个恰好叫「桌面」的目录会被劫持。
 */
function expandPathAliases(raw) {
    const { aliasMap } = resolveShellFolders();
    let p = String(raw || '').trim();
    if (!p) return p;
    p = p.replace(/%([^%\s]{1,32})%/g, (whole, name) => aliasMap.get(String(name).trim().toLowerCase()) || whole);
    const tilde = p.match(/^~([A-Za-z_][A-Za-z0-9_]*)?(?=$|[\\/])/);
    if (tilde) {
        const hit = aliasMap.get(String(tilde[1] || 'home').toLowerCase());
        if (hit) p = hit + p.slice(tilde[0].length);
    }
    return p;
}

/** 给 AI 看的「真实位置」提示（路径不存在时附在错误里，让它下一轮能自己纠正） */
function shellFolderHint() {
    const { roots } = resolveShellFolders();
    if (!roots.length) return '';
    return '这台电脑的真实位置：' + roots.map(r => `${r.label}=${r.path}`).join('、')
        + '。路径不存在时请直接用上面的绝对路径，或用别名 %DESKTOP% / %DOCUMENTS% / %DOWNLOADS%。';
}

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

/**
 * 解析 Agent 路径，并区分"路径无效"与"越界"两种失败。
 *
 * 为什么要区分：越界是**可以申请的**（用户点一次「允许」即可），
 * 而路径无效（空、别名解析不出来）申请也没用。旧实现两者都返回 null，
 * 调用方只能笼统回一句"限制模式…请去改设置" —— 用户被迫去翻设置页，
 * 而其实他只需要就这一次点个「允许」。
 *
 * @param {string} rawPath
 * @param {string} permission 'app' | 'computer'
 * @param {boolean} isLocal 只有本机才可能放开
 * @param {boolean} allowOutside 用户已就本次操作批准越界（前端确认后回传）
 * @returns {{ok:true, path:string} | {ok:false, reason:'invalid'|'outside'|'remote'}}
 */
function resolveAgentPathEx(rawPath, permission, isLocal, allowOutside = false) {
    const p = expandPathAliases(rawPath);
    if (!p) return { ok: false, reason: 'invalid' };
    const resolved = path.resolve(p);

    // 全权限：本机即可
    if (isLocal && permission === 'computer') return { ok: true, path: resolved };

    // 限制模式：应用文件夹内直接放行
    if (resolved === AGENT_APP_ROOT || resolved.startsWith(AGENT_APP_ROOT + path.sep)) {
        return { ok: true, path: resolved };
    }

    // 越界。★ 只有**本机**请求才允许"申请越界" —— 局域网设备即使传
    //   allowOutside 也必须被拒（否则等于把 computer 模式送给了整个局域网，
    //   而 isLocal 检查的全部意义就在于此）。
    if (!isLocal) return { ok: false, reason: 'remote' };
    if (allowOutside === true) return { ok: true, path: resolved };
    return { ok: false, reason: 'outside' };
}

/** 旧签名保留：只要最终路径，拿不到就是 null（供不关心失败原因的调用方用） */
function resolveAgentPath(rawPath, permission, isLocal, allowOutside = false) {
    const r = resolveAgentPathEx(rawPath, permission, isLocal, allowOutside);
    return r.ok ? r.path : null;
}

/**
 * 统一的「路径被拒」响应。
 *
 * 越界时回 403 + needEscalation，让前端弹一次「是否允许访问这个位置」；
 * 而不是让用户自己去设置页切换全局模式 —— 那是一次性需求却要改全局配置，
 * 用户改完往往忘了改回来，等于把限制模式永久关掉了。
 */
function denyPath(res, reason, isLocal) {
    if (reason === 'outside') {
        return jsonResponse(res, 403, {
            ok: false,
            needEscalation: true,
            message: '这个位置在应用文件夹之外。需要你确认后才能访问。',
        });
    }
    if (reason === 'remote') {
        return jsonResponse(res, 403, { ok: false, message: PERM_DENIED_MSG });
    }
    return jsonResponse(res, 403, { ok: false, message: '路径无效' });
}

/**
 * 列目录。返回 [{ name, type, link }]。
 *
 * type 的判定必须走 stat 兜底：Windows 上的 junction（`C:\Users\All Users`、
 * `C:\Users\<用户>\My Documents` 这类兼容性链接）在 readdir 的 Dirent 里
 * **既不是目录也不是文件** —— `isDirectory()` 返回 false、`isSymbolicLink()` 返回 true。
 * 旧实现只看 isDirectory()，于是这 12 个 junction 全被标成「文件」，
 * 用户一看就觉得「和我电脑里的文件夹对不上」。
 */
async function listAgentEntries(target) {
    const entries = await readdir(target, { withFileTypes: true });
    const list = await Promise.all(entries.map(async (e) => {
        if (e.isDirectory()) return { name: e.name, type: 'dir', link: false };
        if (e.isFile()) return { name: e.name, type: 'file', link: false };
        // 符号链接 / junction：跟随一次，按真实类型归类，并标记 link 供界面区分
        const real = await stat(path.join(target, e.name)).catch(() => null);
        if (real && real.isDirectory()) return { name: e.name, type: 'dir', link: true };
        return { name: e.name, type: 'file', link: Boolean(e.isSymbolicLink()) };
    }));
    return list.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

async function agentLs(params, res, isLocal) {
    try {
        const permission = String(params.get('permission') || 'app');
        const allowOutside = params.get('allowOutside') === '1';
        const r = resolveAgentPathEx(params.get('path') || AGENT_APP_ROOT, permission, isLocal, allowOutside);
        if (!r.ok) return denyPath(res, r.reason, isLocal);
        const target = r.path;
        const full = (isLocal && permission === 'computer') || allowOutside;
        const info = await stat(target).catch(() => null);
        if (!info || !info.isDirectory()) {
            // 带上真实位置提示：AI 猜错路径时，下一轮能自己纠正（旧实现只回「目录不存在」，它就卡死了）
            const hint = full ? shellFolderHint() : '';
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, message: '目录不存在：' + target + (hint ? '。' + hint : '') }));
            return;
        }
        const list = await listAgentEntries(target);
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
        const allowOutside = params.get('allowOutside') === '1';
        const r = resolveAgentPathEx(params.get('path'), permission, isLocal, allowOutside);
        if (!r.ok) return denyPath(res, r.reason, isLocal);
        const target = r.path;
        const full = (isLocal && permission === 'computer') || allowOutside;
        const info = await stat(target).catch(() => null);
        if (!info || !info.isFile()) {
            const hint = full ? shellFolderHint() : '';
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, message: '文件不存在：' + target + (hint ? '。' + hint : '') }));
            return;
        }
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
        const allowOutside = body.allowOutside === true;
        const r = resolveAgentPathEx(body.path, permission, isLocal, allowOutside);
        if (!r.ok) return denyPath(res, r.reason, isLocal);
        const target = r.path;
        // 应用文件夹模式下禁写危险类型：这些文件一旦落进 web/，静态服务就会以同源身份
        // 执行/渲染它们（.html 直接构成存储型 XSS）。computer 模式本来就允许操作电脑
        // 任意路径（用户自担风险），不做这个限制。
        //
        // 判据走 isBlockedWritePath（剥掉 ADS / 尾随点 / 尾随空格后再取扩展名）——
        // 直接 path.extname(target) 会被 `x.html::$DATA` 这类写法绕过，落盘仍是 x.html。
        //
        // 注意 allowOutside **不能**参与这条判据，判据只看"目标是否在 web/ 内"：
        //   · 越界批准只可能发生在 web/ 之外（web/ 内的路径本来就放行，无需批准）；
        //   · 若写成 `!full && isBlockedWritePath(...)`，那么
        //     `{path:'web/x.html::$DATA', permission:'app', allowOutside:true}`
        //     会因为 allowOutside 把 full 顶成 true 而**跳过拦截**，落盘一个 web/ 内的
        //     .html —— 等于给同源代码注入开了后门。所以 in-web 的保护永不放宽。
        const inAppRoot = target === AGENT_APP_ROOT || target.startsWith(AGENT_APP_ROOT + path.sep);
        if (inAppRoot && !(isLocal && permission === 'computer') && isBlockedWritePath(target)) {
            return jsonResponse(res, 400, { ok: false, message: '应用文件夹内不允许写 .html/.js/.svg 等可执行类型的文件（防止同源代码注入）' });
        }
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

/**
 * AI 执行电脑命令（PowerShell / cmd）。
 *
 * 权限双模式在这里的落点：
 *   · app（限制）      → **直接拒绝**。命令能做的事远超文件读写，
 *                        在"仅应用文件夹"语义下没有安全的执行子集可给。
 *   · computer（全权限）→ 放行，但**危险命令仍强制要求 approved**。
 *
 * ★ 为什么危险判定必须在服务端再做一次：
 *   前端已经问过用户了，但前端可以被绕过（直接 POST 这个接口）。
 *   如果服务端只看 `approved` 字段，那"授权"就只是客户端的一个礼貌动作，
 *   攻击者传 approved:true 即可执行任意命令。所以服务端**自己判**，
 *   并且在前端没带 approved 时拒绝 —— 这样绕过前端也拿不到危险命令。
 */
async function agentExec(request, res, isLocal) {
    try {
        let body;
        try { body = await readJsonBody(request, 256 * 1024); } catch { return jsonResponse(res, 400, { ok: false, message: '请求体无效' }); }

        const permission = String(body.permission || 'app');
        // 限制模式：命令执行整体不可用（见上）
        if (!(isLocal && permission === 'computer')) {
            return jsonResponse(res, 403, { ok: false, message: PERM_DENIED_MSG });
        }
        const command = String(body.command || '').trim();
        if (!command) return jsonResponse(res, 400, { ok: false, message: '命令为空' });
        if (command.length > 8000) return jsonResponse(res, 400, { ok: false, message: '命令过长（上限 8000 字符）' });

        // 服务端权威判定：不信前端传来的 risk
        const verdict = classifyCommand(command);
        if (verdict.risk === 'dangerous' && body.approved !== true) {
            return jsonResponse(res, 403, {
                ok: false,
                needApproval: true,
                risk: 'dangerous',
                reasons: verdict.reasons,
                message: '这是危险命令，需要用户确认后才能执行。',
            });
        }

        // cwd 仍受权限约束：app 模式到不了这里，computer 模式允许指定目录
        let cwd;
        if (body.cwd) {
            const target = resolveAgentPath(body.cwd, permission, isLocal);
            if (!target) return jsonResponse(res, 403, { ok: false, message: '工作目录无效' });
            cwd = target;
        }

        const result = await runCommand(command, { shell: body.shell, cwd });
        return jsonResponse(res, 200, {
            ok: result.ok,
            risk: verdict.risk,
            reasons: verdict.reasons,
            shell: result.shell,
            code: result.code,
            timedOut: result.timedOut,
            truncated: result.truncated,
            stdout: result.stdout,
            stderr: result.stderr,
            text: formatCommandResult(result),
        });
    } catch (err) {
        jsonResponse(res, 500, { ok: false, message: String(err?.message || err) });
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
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    return p[0] === 10
        || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
        || (p[0] === 192 && p[1] === 168);
}

/**
 * 把 IPv4-mapped / IPv4-compatible 的 IPv6 地址还原成点分 IPv4。
 *
 * 为什么必须有这一步：只按字符串前缀判内网会漏掉 `::ffff:127.0.0.1` 这种写法 ——
 * 它**连的就是 127.0.0.1**（实测 TCP 可连通），但字符串既不 startsWith('127.')
 * 也不是 '::1'，`isPrivateIPv4` 又会因 split('.') 长度不是 4 而返回 false，
 * 于是整个内网判定被绕过。`::ffff:7f00:1` 是同一地址的十六进制写法。
 */
function mappedIPv4(ip) {
    const s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!s.includes(':')) return null;
    // 只处理 ::ffff:a.b.c.d 与 ::a.b.c.d 这两种带点的写法
    const dotted = s.match(/(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) return dotted[1];
    // 纯十六进制写法：::ffff:7f00:1 → 7f00:1 → 127.0.0.1
    const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
        const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
        return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
    }
    return null;
}

/** 该 IP 是否指向本机或内网（回环 / 私网 / 链路本地 / 唯一本地） */
function isInternalAddress(ip) {
    const raw = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
    const v4 = mappedIPv4(raw) || (/^\d+\.\d+\.\d+\.\d+$/.test(raw) ? raw : null);
    if (v4) {
        return v4.startsWith('127.')
            || v4.startsWith('169.254.')     // 链路本地，含云元数据 169.254.169.254
            || v4 === '0.0.0.0'
            || isPrivateIPv4(v4);
    }
    // IPv6：回环、链路本地 fe80::/10、唯一本地 fc00::/7、以及 IPv4 兼容写法
    return raw === '::1' || raw === '::'
        || /^fe[89ab]/.test(raw)             // fe80::/10
        || /^f[cd]/.test(raw);               // fc00::/7
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

// ===== 端侧数据存储（data/ 分类落盘）=====
// localStorage 是"每台设备各存一份"：电脑上聊的记录、填的 API Key，手机上完全看不到。
// 这里把需要跨设备共享的那几项落到服务端 data/ 目录，前端启动时拉取、写入时回推。
//
// 存储结构见 server/store.mjs —— 那边负责把整块键值拆成分类文件（人设卡一卡一文件、
// 聊天记录与记忆各自独立），读的时候再拼回键值。**前端仍然只看到键值**，所以
// data-sync.js 与 APK 侧一行都不用改。
const store = createStore({
    dataDir: DATA_DIR,
    log: (level, msg) => (level === 'error' ? console.error(msg) : console.log(msg)),
});
const loadStore = () => store.loadStore();
const saveStore = () => store.saveStore();

/**
 * 校验并收敛 POST /api/store 提交上来的补丁。
 * 只收字符串值（与 localStorage 语义一致）；限制键长与单键体积，
 * 避免一个超大键把 data/ 撑爆。分类拆分由 server/store.mjs 负责，这里只管"收得干净"。
 */
function normalizeStorePatch(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof k !== 'string' || !k || k.length > 120) continue;
        if (typeof v !== 'string') continue;
        if (v.length > 8 * 1024 * 1024) continue;         // 单键 8MB 上限
        out[k] = v;
    }
    return out;
}

// ===== 访问鉴权（局域网访问控制） =====
// 背景：服务默认监听 0.0.0.0（手机/平板可访问），而 Agent 文件接口没有鉴权、权限模式又由请求方
// 自己传参决定。如果不设访问控制，同一局域网内任何设备都能打开应用、甚至读写本机文件。
//
// 规则：
//   · 本机（127.0.0.1）自动视为管理员：免密进入，且可修改访问密码 —— 这也是忘记密码时的找回入口。
//   · 局域网设备必须登录，登录后种 HttpOnly Cookie 会话（默认 7 天）。
//   · 首次启动生成随机密码并在控制台打印；用户改过密码后只存加盐哈希，控制台不再打印。
//
// 文件位置：data/auth.json。
// 它原先放在 web/.local-auth.json —— 那是"运行时私密数据混在源码目录里"，
// 只靠 .gitignore 单独排除 + 静态服务的"禁止访问隐藏文件"规则兜住，位置本身就不对。
// 现在统一收进 data/（和 store.json、证书、日志同一处），老文件首次启动自动搬过来。
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const LEGACY_AUTH_FILE = path.join(root, '.local-auth.json');
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
    } catch { /* 文件不存在或损坏 → 继续看老位置 */ }

    // 一次性迁移：老位置有就搬到新位置。
    // 搬不动（权限等）也不能让用户被锁在门外，退回用老内容继续跑。
    try {
        const legacy = JSON.parse(await readFile(LEGACY_AUTH_FILE, 'utf8'));
        if (legacy && typeof legacy === 'object') {
            try {
                await mkdir(DATA_DIR, { recursive: true });
                await rename(LEGACY_AUTH_FILE, AUTH_FILE);
                console.log('[鉴权] 访问密码文件已迁移：web/.local-auth.json → data/auth.json');
            } catch (err) {
                console.error('[鉴权] 访问密码文件迁移失败，暂时沿用旧位置:', String(err?.message || err));
            }
            return legacy;
        }
    } catch { /* 老位置也没有 → 视为未初始化 */ }

    return null;
}

async function saveAuthFile(o) {
    await mkdir(DATA_DIR, { recursive: true });
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

// 把 response 包一层，结束时打一行。
// 静态资源且成功的不打 —— 否则窗口会被 js / css / 图片刷满，真正的信息反而被埋掉。
// 状态码决定级别：5xx 记 ERRO、4xx 记 WARN、其余 INFO，这样在日志里能直接按级别筛出问题。
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
        const line = ipOf(request).padEnd(15) + ' '
            + String(request.method || '?').padEnd(5) + ' '
            + (rawPath.length > 52 ? rawPath.slice(0, 49) + '...' : rawPath).padEnd(52) + ' '
            + String(code).padEnd(4) + String(ms).padStart(5) + 'ms'
            + (response.__logNote ? '   ' + response.__logNote : '')
            + (code >= 500 ? '   << 服务端错误' : code >= 400 ? '   << 请求失败' : '');
        // 时间戳由日志系统统一加，这里不再自己拼一个 —— 旧实现两份时间格式混在一行里
        console[code >= 500 ? 'error' : code >= 400 ? 'warn' : 'log']('[http] ' + line);
    });
}

// 302 跳转（可选带一条 Set-Cookie），用于 http → https 升级
function redirect(res, location, setCookie) {
    // Location 里的请求路径是攻击者可控输入，过滤控制字符与引号，防止响应分割/注入
    const safeLocation = String(location).replace(/[\r\n"'<>\\]/g, '');
    res.__logNote = '=> ' + safeLocation;
    const headers = { Location: safeLocation, 'Cache-Control': 'no-store' };
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

/**
 * 读原始请求体（二进制安全）。给数据导入用 —— zip 是二进制，
 * 走 readJsonBody 会被 JSON.parse 弄坏。
 */
async function readRawBody(request, limit = 64 * 1024) {
    const chunks = [];
    let total = 0;
    let overflow = false;
    for await (const chunk of request) {
        total += chunk.length;
        if (total > limit) { overflow = true; chunks.length = 0; continue; }
        chunks.push(chunk);
    }
    if (overflow) throw new Error('请求体过大');
    return Buffer.concat(chunks);
}

// ===== 本地中转 /api/relay =====
//
// 为什么需要它：BYOK 的"直连"是让浏览器自己去请求服务商，而浏览器会强制 CORS。
// 大量中转站（自建 OneAPI、厂商内测网关、Ollama 之类）根本不发 Access-Control-Allow-Origin，
// 预检 OPTIONS 甚至直接 405 —— 这时 fetch() 只会抛一句 "Failed to fetch"，
// 看不出任何原因。而 ChatBox / Cherry Studio 这些原生客户端不受 CORS 约束，
// 于是同一个 Key、同一个地址在它们那儿正常，在网页里就是连不上。
//
// 中转把请求搬到 Node 侧发出（Node 没有 CORS 这回事），前端只跟**同源**的 /api/relay 说话，
// 连预检都不会触发。Key 只经过本机进程内存，不落盘、不发给任何第三方 —— 与 BYOK 一致。
// 对话历史、语音 base64、图片 base64 都会走这条通道，给宽一点（和端侧数据同一个量级）。
const RELAY_BODY_LIMIT = 32 * 1024 * 1024;
const RELAY_TIMEOUT_MAX = 10 * 60 * 1000;
// 超过这个大小的请求体不再解析内容（JSON.parse 一个 32MB 的图片请求要几百毫秒，
// 平白给对话加延迟）。此时只记大小，不记消息。
const RELAY_TRACE_PARSE_MAX = 16 * 1024 * 1024;
// 这些地址是云厂商元数据服务，被中转当作跳板去读会泄露本机凭据，直接封掉。
const RELAY_DENY_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.tencent.internal']);

// ===== 对话追踪 =====
//
// 为什么埋在中转这一层：`/api/relay` 是**所有对外 AI 请求的唯一出口**（三种对话格式、
// 获取模型、语音、视觉全走它），在这一层埋点就能覆盖全部，前端一行都不用改。
//
// 主日志只留一行摘要（提问 / 回复各截一段），完整内容进 `<启动时刻>.trace.log`。
// 旧日志只有「谁在什么时候调了哪个接口」—— 出问题时根本还原不出当时问了什么、答了什么、
// 上游到底为什么拒，这正是这次要补上的。

/** 把消息内容拍平成可读文本；图片等二进制只记大小，绝不记 base64（否则日志瞬间膨胀） */
function flattenContent(content) {
    if (typeof content === 'string') return content;
    if (content === null || content === undefined) return '';
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            const type = String(part.type || '');
            if (/image/i.test(type)) {
                const data = String(part.image_url?.url || part.source?.data || part.data || '');
                return data ? `[图片 约 ${Math.round(data.length * 3 / 4)} 字节]` : '[图片]';
            }
            if (part.text !== undefined) return String(part.text);
            if (part.content !== undefined) return flattenContent(part.content);
            return `[${type || '未知片段'}]`;
        }).filter(Boolean).join('\n');
    }
    if (typeof content === 'object') {
        if (content.text !== undefined) return String(content.text);
        return JSON.stringify(content);
    }
    return String(content);
}

/** 从请求体里抽「模型 + 消息列表」，兼容三种对话格式；不是对话请求就返回 null */
function summarizeChatRequest(json) {
    if (!json || typeof json !== 'object') return null;
    const messages = [];
    // Anthropic 把系统提示放在顶层的 system 字段
    if (json.system !== undefined) messages.push({ role: 'system', text: flattenContent(json.system) });
    const list = Array.isArray(json.messages) ? json.messages
        : (Array.isArray(json.input) ? json.input : null);   // OpenAI Responses 用 input[]
    if (!list) return messages.length ? { model: String(json.model || ''), messages } : null;
    for (const m of list) {
        if (!m || typeof m !== 'object') continue;
        messages.push({
            role: String(m.role || (m.type === 'message' ? 'assistant' : 'user')),
            text: flattenContent(m.content !== undefined ? m.content : m),
        });
    }
    return { model: String(json.model || ''), messages };
}

/** 从响应体里抽回复正文（三种格式，含流式分片） */
function extractReplyText(json) {
    if (!json || typeof json !== 'object' || json.error) return '';
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    if (choice) {
        const text = flattenContent((choice.message || choice.delta || {}).content);
        if (text) return text;
    }
    // Anthropic 流式：{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}
    if (json.delta && typeof json.delta === 'object' && typeof json.delta.text === 'string' && json.delta.text) {
        return json.delta.text;
    }
    // OpenAI Responses 流式：{"type":"response.output_text.delta","delta":"…"}
    if (typeof json.delta === 'string' && json.delta) return json.delta;
    if (typeof json.output_text === 'string' && json.output_text) return json.output_text;
    if (Array.isArray(json.output)) {
        const parts = [];
        for (const item of json.output) {
            for (const c of (item && Array.isArray(item.content) ? item.content : [])) {
                if (c && typeof c.text === 'string') parts.push(c.text);
            }
        }
        if (parts.length) return parts.join('\n');
    }
    if (Array.isArray(json.content)) {
        const parts = json.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text);
        if (parts.length) return parts.join('\n');
    }
    return '';
}

/** 抽错误原因。FastAPI 系网关会把真正的文案套在 detail.error.message 里，必须挖到底 */
function extractErrorText(json, rawText) {
    if (json && typeof json === 'object') {
        const candidates = [
            json.error?.message, json.error?.error?.message,
            json.detail?.error?.message, json.detail?.message,
            typeof json.detail === 'string' ? json.detail : '', json.message,
        ];
        for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
        if (json.error && typeof json.error === 'object') return JSON.stringify(json.error);
    }
    return String(rawText || '').trim();
}

const clip = (text, max, label) => (text.length > max ? `${text.slice(0, max)}…（${label}，共 ${text.length} 字）` : text);

/** 从 SSE 文本里把分片拼回完整回复（流式对话的响应体不是 JSON，直接读会得到一坨 data: 行） */
function parseSseReply(rawText) {
    const parts = [];
    for (const line of String(rawText).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;    // event: / id: / 心跳注释行直接跳过
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const piece = extractReplyText(JSON.parse(payload));
            if (piece) parts.push(piece);
        } catch { /* 被截断的最后一行、或非 JSON 的心跳，忽略 */ }
    }
    return parts.join('');
}

/**
 * 流式响应里的报错，状态码常常是 200 —— 错在 `data:` 行里。
 * 这类"看起来成功、其实一个字都没回"的情况不特意挖一下，用户只会看到"AI 不回话"，
 * 而日志里一片祥和，完全无从下手。
 */
function parseSseError(rawText) {
    for (const line of String(rawText).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const json = JSON.parse(payload);
            if (json && (json.error || json.type === 'error')) return extractErrorText(json, payload);
        } catch { /* 同上 */ }
    }
    return '';
}

/** 「问了什么」：请求全文进追踪日志，主日志只留最后一问（一眼看出这次聊了什么） */
function traceRelayRequest({ method, target, reqJson, reqRaw }) {
    const where = `${target.host}${target.pathname}`;
    const summary = summarizeChatRequest(reqJson);
    if (!summary || !summary.messages.length) return null;
    const lines = [`===== 请求 ${method} ${where} =====`];
    lines.push(`模型 ${summary.model || '(未指定)'} · ${summary.messages.length} 条消息 · ${Buffer.byteLength(String(reqRaw || ''))} 字节`);
    summary.messages.forEach((m, i) => {
        lines.push(`[${i + 1}/${summary.messages.length}] ${m.role}（${m.text.length} 字）\n`
            + clip(m.text, TRACE_MSG_MAX, '本条已截断'));
    });
    traceLine(lines.join('\n'));
    const lastUser = [...summary.messages].reverse().find((m) => m.role === 'user');
    if (lastUser && lastUser.text.trim()) {
        console.log('[chat] 提问：' + clip(lastUser.text.replace(/\s+/g, ' ').trim(), 200, '已截断'));
    }
    return summary;
}

/**
 * 一次中转的完整记录：请求 + 响应。
 *
 * 主日志留一行（谁、哪家、什么状态、多久、为什么失败），追踪日志留全文。
 * 这是这次日志改造的核心 —— 旧日志只有「什么地址在什么时间调用了什么 API」，
 * 出问题时还原不出当时问了什么、答了什么、上游到底为什么拒。
 */
function traceRelayExchange({ method, target, reqJson, reqRaw, status, ms, respJson, respRaw }) {
    const where = `${target.host}${target.pathname}`;
    const isChat = /\/chat\/completions|\/responses|\/messages/i.test(target.pathname);
    const summary = traceRelayRequest({ method, target, reqJson, reqRaw });
    const raw = String(respRaw || '');
    const tail = `${method} ${where} -> ${status} 上游 ${ms}ms`;

    // 请求体没能解析（超大 / 非 JSON）时至少留个大小，
    // 否则追踪日志里会出现"只有响应、没有请求"，反而更难读
    if (!summary && isChat) {
        traceLine(`===== 请求 ${method} ${where} =====\n（请求体未解析或为空，${Buffer.byteLength(String(reqRaw || ''))} 字节）`);
    }

    // ① 上游报错：完整报错进追踪日志，主日志那一行直接带上原因，不用再翻文件
    if (status >= 400) {
        traceLine(`===== 响应 ${status} · ${ms}ms（上游报错）=====\n`
            + clip(raw || '(空响应)', TRACE_BODY_MAX, '响应过大已截断'));
        const reason = extractErrorText(respJson, raw) || '(上游没有给出原因)';
        console.error(`[relay] ${tail} << 上游报错：` + clip(reason.replace(/\s+/g, ' '), 400, '已截断'));
        return;
    }

    // ② 回复正文：非流式直接读 JSON，流式把 data: 分片拼回去
    let reply = extractReplyText(respJson);
    if (!reply && raw) reply = parseSseReply(raw);
    if (reply) {
        traceLine(`===== 响应 ${status} · ${ms}ms =====\n` + clip(reply, TRACE_MSG_MAX, '回复已截断'));
        console.log(`[relay] ${tail}`);
        console.log('[chat] 回复：' + clip(reply.replace(/\s+/g, ' ').trim(), 200, '已截断'));
        return;
    }

    // ③ 状态码 200、却一个字都没抽出来 —— 流式接口把报错塞在 data: 行里就是这种形态
    const sseError = raw ? parseSseError(raw) : '';
    if (sseError) {
        traceLine(`===== 响应 ${status} · ${ms}ms（流式响应内报错）=====\n`
            + clip(raw, TRACE_BODY_MAX, '响应过大已截断'));
        console.error(`[relay] ${tail} << 响应内报错：` + clip(sseError.replace(/\s+/g, ' '), 400, '已截断'));
        return;
    }

    // ④ 非对话接口（获取模型等）成功时不再把响应体倒进追踪日志，否则模型列表会把对话内容淹掉
    if (raw && isChat) traceLine(`===== 响应 ${status} · ${ms}ms =====\n` + clip(raw, TRACE_BODY_MAX, '响应过大已截断'));
    console.log(`[relay] ${tail}`);
}

async function handleRelay(request, response) {
    let payload;
    try { payload = await readJsonBody(request, RELAY_BODY_LIMIT); }
    catch {
        // 这些校验失败以前是完全静默的 —— 前端只会拿到一句中文提示，
        // 日志里连"发生过这件事"都没有，用户报"对话发不出去"时无从查起。
        console.warn('[relay] 请求体无效或过大，已拒绝');
        return jsonResponse(response, 400, { ok: false, relayError: true, message: '中转请求体无效或过大' });
    }

    let target;
    try { target = new URL(String(payload?.url || '')); }
    catch {
        console.warn('[relay] 目标地址无效：' + String(payload?.url || '(空)').slice(0, 200));
        return jsonResponse(response, 400, { ok: false, relayError: true, message: '中转目标地址无效' });
    }

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        console.warn(`[relay] 不支持的协议 ${target.protocol}//${target.host}，只允许 http/https`);
        return jsonResponse(response, 400, { ok: false, relayError: true, message: '中转只支持 http/https' });
    }
    if (RELAY_DENY_HOSTS.has(target.hostname.toLowerCase())) {
        console.warn(`[relay] 拒绝访问云元数据地址 ${target.host}（防本机凭据泄露）`);
        return jsonResponse(response, 403, { ok: false, relayError: true, message: '该地址不允许通过中转访问' });
    }
    // 局域网设备不能把本机当中转跳板去打本机的其它服务（SSRF）。
    // 本机自己发起的请求放行 —— Ollama 这类就住在 127.0.0.1。
    if (!isLocalRequest(request) && isLoopbackHostname(target.hostname)) {
        console.warn(`[relay] 拒绝非本机请求访问本机地址 ${target.host}（防 SSRF）`);
        return jsonResponse(response, 403, { ok: false, relayError: true, message: '本机地址只能由本机发起中转' });
    }
    // 只拦字面回环主机名还不够：攻击者可以让自己的域名解析到 127.0.0.1（DNS rebinding），
    // 或直接填局域网地址、或用 ::ffff:127.0.0.1 这类 IPv4-mapped IPv6 写法绕开前缀比较。
    // 先解析成 IP 再判一遍 —— 解析不出来就放行（真连不上时 fetch 自己会报错）。
    if (!isLocalRequest(request)) {
        let targetIps = [];
        try { targetIps = await dns.promises.lookup(target.hostname, { all: true }); } catch { /* DNS 失败交给 fetch 报错 */ }
        const dangerous = targetIps.some(({ address }) => isInternalAddress(address));
        if (dangerous) {
            console.warn(`[relay] 拒绝非本机请求访问内网地址 ${target.host} -> ${targetIps.map(i => i.address).join(',')}（防 SSRF）`);
            return jsonResponse(response, 403, { ok: false, relayError: true, message: '本机与内网地址只能由本机发起中转' });
        }
    }

    const method = String(payload?.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        console.warn(`[relay] 不支持的请求方法 ${method}`);
        return jsonResponse(response, 400, { ok: false, relayError: true, message: '中转不支持的请求方法' });
    }

    const headers = {};
    const rawHeaders = payload?.headers;
    if (rawHeaders && typeof rawHeaders === 'object') {
        for (const [k, v] of Object.entries(rawHeaders)) {
            const key = String(k);
            // Host / Content-Length 交给 undici 自己算；Cookie、Origin 之类浏览器身份信息不该外发。
            if (/^(host|content-length|cookie|origin|referer|connection|transfer-encoding)$/i.test(key)) continue;
            if (v === null || v === undefined) continue;
            headers[key] = String(v);
        }
    }
    // 不让上游压缩：一是 SSE 要能逐块透传，二是省得再解一遍。
    headers['accept-encoding'] = 'identity';

    const timeoutMs = Math.min(Math.max(Number(payload?.timeoutMs) || 120000, 1000), RELAY_TIMEOUT_MAX);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let abortedByClient = false;
    response.on('close', () => {
        if (!response.writableEnded) { abortedByClient = true; controller.abort(); }
    });

    const sendBody = !(method === 'GET' || method === 'HEAD');
    const bodyValue = typeof payload?.body === 'string'
        ? payload.body
        : (payload?.body === undefined || payload?.body === null ? undefined : JSON.stringify(payload.body));
    const reqRaw = typeof bodyValue === 'string' ? bodyValue : '';
    // 解析请求体**只为了记日志**。超大请求（图片 / 语音 base64）跳过：JSON.parse 一个几十 MB 的
    // 对象要几百毫秒，为了日志给每次对话平白加延迟不划算 —— 那种情况只记大小。
    let reqJson = null;
    if (reqRaw && Buffer.byteLength(reqRaw) <= RELAY_TRACE_PARSE_MAX) {
        try { reqJson = JSON.parse(reqRaw); } catch { reqJson = null; }
    }

    let upstream;
    const relayStartedAt = Date.now();
    try {
        upstream = await fetch(target, {
            method,
            headers,
            body: sendBody ? bodyValue : undefined,
            signal: controller.signal,
            // 不跟随上游重定向：302 Location 是攻击者可控的，跟随它可以把"对公网 API 的请求"
            // 重定向到本机/内网地址，绕过上面的 SSRF 校验。3xx 原样透传给前端自己处理。
            redirect: 'manual',
        });
    } catch (err) {
        clearTimeout(timer);
        if (abortedByClient) return;                       // 客户端自己走了，不用回话
        const cause = err?.cause;
        // 这一句比浏览器那句 "Failed to fetch" 有用得多：能看出是 DNS、TLS 还是连接被拒。
        // 带上 cause.code（ENOTFOUND / ECONNREFUSED / UND_ERR_CONNECT_TIMEOUT …），方便直接 grep。
        const detail = err?.name === 'AbortError'
            ? `超过 ${Math.round(timeoutMs / 1000)} 秒没有响应`
            : String(cause?.message || err?.message || err) + (cause?.code ? ` [${cause.code}]` : '');
        // 连不上时把**请求内容**也写进追踪日志：否则只看到"连接被拒"，
        // 不知道当时问的是什么、模型名有没有写错 —— 而这恰恰是最常见的原因。
        traceRelayRequest({ method, target, reqJson, reqRaw });
        traceLine(`===== 请求失败 ${method} ${target.href} =====\n${detail}（${Date.now() - relayStartedAt}ms）`);
        console.error(`[relay] 请求失败 ${method} ${target.href} -> ${detail} (${Date.now() - relayStartedAt}ms)`);
        return jsonResponse(response, 502, { ok: false, relayError: true, message: `本地中转无法连接目标：${detail}` });
    }

    response.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });

    // 边透传边攒一份给日志用。攒到上限就停止记录（**继续透传**），
    // 免得一个长回答把内存吃掉；流式的正文稍后由 parseSseReply 从 data: 行拼回来。
    const traceChunks = [];
    let traceBytes = 0;
    if (upstream.body) {
        try {
            for await (const chunk of upstream.body) {
                if (abortedByClient) break;
                response.write(chunk);
                if (traceBytes < TRACE_ACCUM_MAX) {
                    traceChunks.push(chunk);
                    traceBytes += chunk.length;
                }
            }
        } catch (err) {
            if (!abortedByClient) console.error('[relay] 透传响应中断:', String(err?.message || err));
        }
    }
    clearTimeout(timer);
    response.end();

    if (abortedByClient) return;
    // 每个中转请求留一条完整记录：目标是哪家、什么状态、耗时多少、问了什么、答了什么 / 为什么失败。
    // 排查"偶发失败"时这是唯一能还原现场的东西 —— 旧日志只有一行状态码，看不出原因。
    const respRaw = traceChunks.length ? Buffer.concat(traceChunks).toString('utf8') : '';
    let respJson = null;
    if (respRaw) {
        try { respJson = JSON.parse(respRaw); } catch { respJson = null; }
    }
    traceRelayExchange({
        method, target, reqJson, reqRaw,
        status: upstream.status,
        ms: Date.now() - relayStartedAt,
        respJson, respRaw,
    });
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

        // 登录页（无需鉴权）。同样加防嵌套头 —— 登录页能被 iframe 嵌套就等于给了
        // 点击劫持一个落点（诱导用户在伪造页面上输入访问密码）。
        if (pathname === '/login') {
            response.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Frame-Options': 'DENY',
                'Referrer-Policy': 'no-referrer',
                'X-Content-Type-Options': 'nosniff',
            });
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

        // 本地中转：把浏览器发不出去的跨域请求搬到 Node 侧（见 handleRelay 的说明）。
        // 放在鉴权之后 —— 它会把请求原样转发到任意 http(s) 地址，不能让未登录的访客当跳板用。
        if (pathname === '/api/relay' && request.method === 'POST') {
            return await handleRelay(request, response);
        }

        // 前端日志上报：把浏览器控制台里的错误转到启动窗口。
        // 前端的问题（ASR 起不来、模型加载失败）平时只出现在浏览器控制台里，
        // 拿手机排查时根本看不到；转过来就能和请求日志对照着看。
        if (pathname === '/api/client-log' && request.method === 'POST') {
            let body;
            try { body = await readJsonBody(request, 64 * 1024); } catch { return jsonResponse(response, 400, { ok: false }); }
            const items = Array.isArray(body && body.items) ? body.items.slice(0, 20) : [];
            for (const it of items) {
                const rawLevel = String((it && it.level) || 'log').toLowerCase();
                const level = ['debug', 'info', 'warn', 'error'].includes(rawLevel) ? rawLevel : 'log';
                const page = String((it && it.page) || '').slice(0, 36);
                const text = String((it && it.text) || '').trim();
                if (!text) continue;
                // 主日志压成一行。旧实现截到 300 字符 —— 恰好把最关键的上游报错砍在半截
                // （`requestedModel":"Qwen3.8-` 就断了），查问题时等于没有。放宽到 2000。
                const oneLine = text.replace(/\s+/g, ' ');
                const clipped = oneLine.length > 2000
                    ? oneLine.slice(0, 2000) + ' …（已截断，完整内容见追踪日志）'
                    : oneLine;
                // 浏览器的 console.debug 现在真的记成 DBUG（以前被压成 INFO，
                // 于是"把级别调到 DEBUG"也看不到前端调试信息）
                const method = { debug: 'debug', info: 'log', warn: 'warn', error: 'error' }[level] || 'log';
                console[method]('[page] ' + ipOf(request).padEnd(15) + ' '
                    + (page ? page + '  ' : '') + clipped);
                // 完整原文一行不丢地进追踪日志 —— 浏览器控制台里的报错往往带着真正的错误原因
                traceLine(`===== 浏览器上报 · ${page || '/'} · ${level.toUpperCase()} =====\n${text}`);
            }
            return jsonResponse(response, 200, { ok: true });
        }

        // 日志设置：读取当前状态 / 运行时调整级别与对话追踪。
        // 放在鉴权之后 —— 它会改服务端行为，不能让未登录的局域网设备操作。
        if (pathname === '/api/logs/settings' && request.method === 'GET') {
            return jsonResponse(response, 200, {
                ok: true,
                level: fileLevel,
                levels: LEVEL_NAMES,
                trace: traceEnabled,
                fileEnabled: LOG_TO_FILE,
                logDir: path.relative(APP_ROOT, LOG_DIR) || '.',
                mainFile: mainSink.file ? path.relative(APP_ROOT, mainSink.file) : '',
                traceFile: traceSink.file ? path.relative(APP_ROOT, traceSink.file) : '',
                keep: LOG_KEEP,
                maxMb: Math.round(LOG_MAX_BYTES / 1024 / 1024),
            });
        }
        if (pathname === '/api/logs/settings' && request.method === 'POST') {
            let body;
            try { body = await readJsonBody(request, 8 * 1024); } catch { return jsonResponse(response, 400, { ok: false, message: '请求格式无效' }); }
            const notes = [];
            if (body && body.level !== undefined) {
                const want = normalizeLevelName(body.level);
                if (!want) return jsonResponse(response, 400, { ok: false, message: '级别无效，可选：' + LEVEL_NAMES.join(' / ') });
                if (setFileLogLevel(want)) notes.push(`落盘级别已改为 ${want}`);
            }
            if (body && body.trace !== undefined) {
                if (setTraceEnabled(body.trace)) notes.push(body.trace ? '对话追踪已开启' : '对话追踪已关闭');
            }
            // 这次调整本身也要留下痕迹：否则日志级别被改过、事后却看不出来，
            // 排查"怎么少了那么多日志"时会先怀疑代码而不是设置。
            if (notes.length) {
                console.log(`[log] 日志设置已更新：${notes.join('；')}（操作者 ${ipOf(request)}）`);
            }
            return jsonResponse(response, 200, {
                ok: true, level: fileLevel, trace: traceEnabled, changed: notes,
            });
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
            const patch = normalizeStorePatch(body && body.data);
            const current = await loadStore();
            Object.assign(current, patch);   // 按键合并：只覆盖本次提交的键，不动其它设备的其它键
            await saveStore();
            return jsonResponse(response, 200, { ok: true, keys: Object.keys(patch).length });
        }

        // 数据导出：把 data/ 下的全部分类数据打包成一个 JSON 文件下载。
        // 用途：换机器、重装、版本升级前备份 —— 用户最怕的"更新一次聊天记录没了"。
        if (pathname === '/api/data/export' && request.method === 'GET') {
            const body = await store.exportZip();
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            const filename = `elainachat-backup-${stamp}.zip`;
            // 刻意**不发** Content-Disposition: attachment。
            //
            // 原因：迅雷/FDM 这类下载器会往 Chrome 里装机器级扩展（HKLM 注册表强制安装，
            // 任何 profile 都躲不掉），只要看到 attachment 就把这个 URL 抢走转给自己的
            // 下载引擎 —— 结果是浏览器里拿到一个被改写的空响应（实测是 204 + 0 字节），
            // 用户既拿不到文件、也不知道为什么，还会被弹一个下载器窗口。
            //
            // 改成：这里只把字节正常发出去，前端 fetch 成 blob 后用 <a download> 触发保存。
            // blob: 是内存地址，外部下载器无从接管，也不会弹窗。
            // 文件名通过自定义头带过去（自定义头不触发下载器识别）。
            response.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Length': body.length,
                'X-Backup-Filename': filename,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            });
            return response.end(body);
        }
        // 数据导入：接受 zip（推荐）或 v1 的单 JSON 旧备份，按 merge（默认）或 replace 合并进 data/。
        // 这里收**原始字节**而不是 JSON —— zip 是二进制，走 readJsonBody 会被解析坏。
        if (pathname === '/api/data/import' && request.method === 'POST') {
            let raw;
            try {
                raw = await readRawBody(request, STORE_MAX_BYTES);
            } catch {
                return jsonResponse(response, 400, { ok: false, message: '备份文件过大' });
            }
            // mode 走 query（body 是二进制，塞不进 JSON 字段）
            const mode = url.searchParams.get('mode') === 'replace' ? 'replace' : 'merge';
            try {
                const result = await store.importBackup(raw, mode);
                if (!result.ok) return jsonResponse(response, 400, { ok: false, message: result.message || '备份里没有可导入的数据' });
                return jsonResponse(response, 200, {
                    ok: true, mode, keys: result.keys, source: result.source,
                    message: result.message || `已导入 ${result.keys} 项数据`,
                });
            } catch (err) {
                return jsonResponse(response, 400, { ok: false, message: '导入失败：' + (err && err.message ? err.message : '未知错误') });
            }
        }
        // 数据位置信息：告诉用户"我的数据在哪、有哪些"，配合导入导出用
        if (pathname === '/api/data/info' && request.method === 'GET') {
            const storeData = await loadStore();
            const keys = Object.keys(storeData);
            const counts = { characters: 0, conversations: 0, memoryEntries: 0 };
            try { counts.characters = JSON.parse(storeData['elaina_open_character_cards'] || '[]').length; } catch { /* 忽略 */ }
            try { counts.conversations = JSON.parse(storeData['elaina_open_conversations'] || '[]').length; } catch { /* 忽略 */ }
            try {
                const mem = JSON.parse(storeData['elaina_open_memory_core'] || '{}');
                counts.memoryEntries = Array.isArray(mem.diary) ? mem.diary.length : 0;
            } catch { /* 忽略 */ }
            return jsonResponse(response, 200, {
                ok: true,
                dir: path.relative(APP_ROOT, DATA_DIR) || 'data',
                layout: {
                    settings: 'store.json（设置 / API Key / UI 偏好）',
                    characters: 'characters/（一卡一文件）',
                    conversations: 'conversations/（一对话一文件）',
                    memory: 'memory.json',
                    logs: 'logs/',
                },
                counts,
                keys: keys.length,
            });
        }

        // ==================== Edge TTS（免费语音合成） ====================
        //
        // 为什么由服务端代合成：微软这个端点校验浏览器指纹（User-Agent 等），
        // 缺了就 403；而浏览器的 `new WebSocket()` **不允许自定义请求头**，
        // 网页里直接连必失败。Node 没这个限制 —— 所以电脑版走这里，
        // 手机版走原生插件（android-app 的 EdgeTtsPlugin，同样原因）。
        //
        // 零依赖：server/edge-tts.mjs 里手写 WebSocket 握手与帧编解码。
        if (pathname === '/api/tts/edge' && request.method === 'POST') {
            let payload;
            try {
                payload = JSON.parse((await readRawBody(request, 64 * 1024)).toString('utf8'));
            } catch {
                return jsonResponse(response, 400, { ok: false, message: '请求体不是合法 JSON' });
            }
            const text = String(payload?.text || '').trim();
            if (!text) return jsonResponse(response, 400, { ok: false, message: '缺少 text' });
            if (text.length > 2000) return jsonResponse(response, 400, { ok: false, message: '文本过长（上限 2000 字）' });
            const voice = String(payload?.voice || 'zh-CN-XiaoxiaoNeural').trim() || 'zh-CN-XiaoxiaoNeural';
            const ratePct = Number.isFinite(Number(payload?.ratePct)) ? Number(payload.ratePct) : 0;
            try {
                const mp3 = await synthesizeEdge({ text, voice, ratePct, timeoutMs: 25000 });
                if (!mp3 || !mp3.length) {
                    return jsonResponse(response, 502, { ok: false, message: 'Edge TTS 没有返回音频（服务端可能改了协议或限流）' });
                }
                response.writeHead(200, {
                    'Content-Type': 'audio/mpeg',
                    'Content-Length': String(mp3.length),
                    'Cache-Control': 'no-store',
                });
                response.end(mp3);
                return;
            } catch (error) {
                const message = String(error && error.message || error);
                console.warn('[EdgeTTS] 合成失败: ' + message);
                return jsonResponse(response, 502, { ok: false, message });
            }
        }
        // 自检：只做握手，用于设置页的"测试"按钮
        if (pathname === '/api/tts/edge/probe' && request.method === 'POST') {
            const result = await probeEdge({ timeoutMs: 12000 });
            return jsonResponse(response, 200, result);
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

        // ===== 插件（mod）接口 =====
        //
        // 列出插件：每次请求都重新扫描目录。为什么不在启动时扫一次就够 ——
        // 用户完全可能在服务运行期间把 zip 拷进 mods/（那正是"丢个 zip 就装好"
        // 的用法），启动时扫一次会让他以为没生效。扫描本身很轻（一次 readdir）。
        if (pathname === '/api/plugins' && request.method === 'GET') {
            try {
                const result = await modManager.scanAndSync();
                return jsonResponse(response, 200, {
                    ok: true,
                    plugins: result.installed,
                    // 回报安装结果：zip 解压失败时必须让用户看到原因，
                    // 否则"我把 zip 放进去了但没反应"会变成无从排查的问题
                    installResults: result.results,
                });
            } catch (err) {
                return jsonResponse(response, 500, { ok: false, message: '扫描插件目录失败：' + String((err && err.message) || err) });
            }
        }
        // 卸载插件（删除目录）。仅本机管理员 —— 它能删文件，不该让局域网访客调。
        const plugDel = pathname.match(/^\/api\/plugins\/([^/]+)$/);
        if (plugDel && request.method === 'DELETE') {
            if (!isLocalRequest(request)) {
                return jsonResponse(response, 403, { ok: false, message: '只有本机可以卸载插件' });
            }
            try {
                await modManager.uninstall(decodeURIComponent(plugDel[1]));
                return jsonResponse(response, 200, { ok: true });
            } catch (err) {
                return jsonResponse(response, 400, { ok: false, message: String((err && err.message) || err) });
            }
        }
        // 上传安装插件：POST /api/plugins/install?name=xxx
        //
        // 为什么需要这个接口：原先只能"把 zip 拷进 mods/ 目录"再让服务端扫描。
        // 那条路在电脑上可行，但**手机/平板用户根本碰不到文件系统**（尤其 APK，
        // 连服务端都没有）。所以补一个应用内上传的入口。
        //
        // 请求体就是 zip 原始字节（不是 multipart）—— 前端用 fetch 直接把
        // File 对象当 body 发，省掉解析 multipart 的一整套代码，也不引入依赖。
        // 插件名从 query 取（zip 文件名），与"丢文件进目录"那条路命名规则一致。
        if (pathname === '/api/plugins/install' && request.method === 'POST') {
            if (!isLocalRequest(request)) {
                return jsonResponse(response, 403, { ok: false, message: '只有本机可以安装插件' });
            }
            const rawName = String(url.searchParams.get('name') || '').trim();
            if (!rawName) {
                return jsonResponse(response, 400, { ok: false, message: '缺少插件名（请把 zip 文件名作为 name 参数）' });
            }
            // ★ 先拒绝"名字里带路径成分"的请求，**再**净化。
            //
            //   顺序很重要：如果先净化（`replace(/^.*[\\/]/, '')`）再校验，
            //   `../../hack.zip` 会被静默改成 `hack` 并安装成功 —— 用户意图被曲解，
            //   而且掩盖了一次路径穿越尝试（实测踩到：非法名返回了 HTTP 200）。
            //   这里明确报错，让调用方知道名字不合法。
            if (/[\\/]/.test(rawName) || rawName.includes('..')) {
                return jsonResponse(response, 400, { ok: false, message: '插件名不能包含路径成分（/ \\ ..）' });
            }
            const id = rawName.replace(/\.zip$/i, '');
            if (!id) {
                return jsonResponse(response, 400, { ok: false, message: '缺少插件名（请把 zip 文件名作为 name 参数）' });
            }
            let buf;
            try {
                buf = await readRawBody(request, MAX_UPLOAD);
            } catch (err) {
                return jsonResponse(response, 413, { ok: false, message: '上传失败或文件过大：' + String((err && err.message) || err) });
            }
            if (!buf || buf.length < 22) {
                return jsonResponse(response, 400, { ok: false, message: '文件为空或不是有效的 zip' });
            }
            try {
                const r = await modManager.installFromBuffer(buf, id);
                await modManager.scanAndSync();
                console.log(`[Mod] 已通过上传安装插件：${id}（${r.written} 个文件${r.skipped ? '，跳过 ' + r.skipped + ' 个' : ''}）`);
                return jsonResponse(response, 200, {
                    ok: true, id: r.id, files: r.written, skipped: r.skipped,
                    message: '已安装 ' + r.id + '（' + r.written + ' 个文件）',
                });
            } catch (err) {
                return jsonResponse(response, 400, { ok: false, message: String((err && err.message) || err) });
            }
        }

        // API：AI Agent 文件操作（权限模式：app=仅应用文件夹；computer=允许操作电脑）
        const isLocal = isLocalRequest(request);
        if (pathname === '/api/agent/roots' && request.method === 'GET') {
            // 把「桌面/文档/下载…到底在哪」告诉前端 —— 用户可以把桌面移动到任意位置，
            // 让 AI 按惯例猜 C:\Users\<用户名>\Desktop 是会猜错的（实测踩过）。
            const { roots } = resolveShellFolders();
            const visible = (isLocal && url.searchParams.get('permission') === 'computer')
                ? roots
                : roots.map(r => ({ ...r, path: undefined })); // 非本机不泄露宿主机的真实路径
            return jsonResponse(response, 200, { ok: true, platform: process.platform, roots: visible });
        }
        if (pathname === '/api/agent/ls' && request.method === 'GET') {
            return await agentLs(url.searchParams, response, isLocal);
        }
        if (pathname === '/api/agent/read' && request.method === 'GET') {
            return await agentRead(url.searchParams, response, isLocal);
        }
        if (pathname === '/api/agent/write' && request.method === 'POST') {
            return await agentWrite(request, response, isLocal);
        }
        // 电脑命令执行（全权限模式）。危险命令由服务端强制要求 approved（见 agentExec）。
        if (pathname === '/api/agent/exec' && request.method === 'POST') {
            return await agentExec(request, response, isLocal);
        }
        // 看电脑在干什么（前台窗口 + 进程）—— 供桌宠让 AI"知道你在做什么"并主动搭话。
        //
        // ★ 仅本机：这是"用户在看什么"的隐私数据，绝不能经局域网泄露。
        //   即使对方有访问密码也不该给 —— 密码保护的是"能聊天"，
        //   不是"能窥探宿主机在跑什么"。
        if (pathname === '/api/agent/activity' && request.method === 'GET') {
            if (!isLocal) {
                return jsonResponse(response, 403, { ok: false, message: '只有本机可以读取电脑活动状态' });
            }
            const force = url.searchParams.get('force') === '1';
            return jsonResponse(response, 200, activitySummaryCached(force));
        }

        // 浏览器会自己请求 /favicon.ico，没这个文件就每开一次页面刷一条 404，淹没真正的日志。
        // 回 204（表示"没有图标"）即可，安静且语义正确。
        if (pathname === '/favicon.ico') {
            response.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
            return response.end();
        }

        const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        // 禁止访问隐藏文件：这条规则仍然必要 —— 它挡住的是 .env / .git / 各类点文件，
        // 以及历史上曾经放在这里的 .local-auth.json（访问密码，现已迁到 data/ 下）。
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
            // HTML 页面不许被第三方页面 iframe 嵌套（点击劫持），也不该把页面 URL
            // 通过 Referer 泄给外链目标 —— 页面 URL 里会带着 ?stay=http 这类参数。
            ...(ctype.startsWith('text/html') ? {
                'X-Frame-Options': 'DENY',
                'Referrer-Policy': 'no-referrer',
            } : {}),
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

// 端口被占用等启动错误：给出可读提示，而不是抛一串裸栈。
// 用 CRITICAL —— 服务根本没起来，这是最高级别的失败，不该和普通报错混在一个档次里。
// （不写空行分隔：日志系统会丢弃纯空白记录，写了也是白写。）
function printListenError(err, which, usedPort) {
    if (err && err.code === 'EADDRINUSE') {
        logCritical('  ✗ ' + which + ' 端口 ' + usedPort + ' 已被占用，服务没能启动。');
        logCritical('    可能是之前已经开着一个 ElainaChat 服务（或其它程序占用了这个端口）。');
        logCritical('    解决办法：关掉那个进程，或换个端口启动，例如：');
        logCritical('      set PORT=4175 && set HTTPS_PORT=4176 && node web/serve.mjs');
    } else {
        logCritical('  ✗ ' + which + ' 服务启动失败：' + (err && err.message ? err.message : err));
    }
    process.exitCode = 1;
}

// 启动前准备访问密码（node web/serve.mjs --reset-password 可强制重新生成）
if (process.argv.includes('--reset-password')) {
    // 新旧两个位置都清，否则迁移逻辑会把老文件又搬回来，"重置"等于没重置
    await rm(AUTH_FILE, { force: true });
    await rm(LEGACY_AUTH_FILE, { force: true });
    console.log('[鉴权] 已按 --reset-password 清除旧密码，将重新生成');
}
const authInfo = await ensureAuth();

// 数据存储迁移：旧的 data/store.json 把聊天记录/人设卡/记忆全挤在一个文件里，
// 现在按类别拆开（见 server/store.mjs）。这一步在监听之前跑完，保证第一个请求
// 读到的就是迁移后的数据。幂等：没有旧数据时什么都不做。
try {
    const moved = await store.migrateIfNeeded();
    if (moved.length) {
        console.log(`[store] 数据已迁移到分类存储：${moved.join('、')}（原始数据未删除，见 data/）`);
    }
} catch (err) {
    // 迁移失败不能挡住启动 —— 旧数据仍在 store.json 里，服务照常可用
    console.error('[store] 迁移失败（服务继续启动，旧数据未受影响）:', err && err.message ? err.message : err);
}

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
        console.warn('[tls] ' + addr.padEnd(15) + ' TLS 握手失败   '
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
            // Host 与请求路径都是攻击者可控的输入（Host 头可随意伪造、路径可带脚本），
            // 原样拼进 HTML 就是反射 XSS。这里按 HTML 属性值转义，Location 头另按 RFC 只留
            // 合法字符 —— 双保险。
            const to = 'https://' + hostHeader + target;
            const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            const toHeader = to.replace(/[\r\n"'<>\s]/g, '');
            const body = '<!doctype html><meta charset="utf-8"><title>跳转到 HTTPS</title>'
                + '<p style="font:15px/1.7 system-ui,sans-serif;padding:40px">'
                + '正在跳转到 <a href="' + esc(to) + '">' + esc(to) + '</a></p>';
            socket.end('HTTP/1.1 302 Found\r\n'
                + 'Location: ' + toHeader + '\r\n'
                + 'Content-Type: text/html; charset=utf-8\r\n'
                + 'Content-Length: ' + Buffer.byteLength(body) + '\r\n'
                + 'Cache-Control: no-store\r\n'
                + 'Connection: close\r\n\r\n' + body);
        });
    });
    legacyServer.on('error', (err) => printListenError(err, 'HTTPS(兼容入口)', HTTPS_PORT));
    legacyServer.listen(HTTPS_PORT, host);
}
