// ============================================================================
//  数据存储层：把运行时产生的数据分类落到 data/ 下
// ============================================================================
//
//  为什么要有这一层
//  ----------------
//  原来所有跨设备数据都挤在 data/store.json 一个文件里（12 个键、聊天记录占 34%、
//  人设卡占 55%）。三个问题：
//    1. 一个文件写坏 = 全部数据一起丢；
//    2. 人设卡/聊天记录没法单独分享或备份；
//    3. 用户看不出"哪些文件是我的数据"。
//
//  现在按用途分文件，**人设卡与聊天记录都是一条一个文件**：
//    data/store.json              设置 / API Key / UI 偏好（小、稳定、几乎不变）
//    data/characters/index.json     人设卡顺序 + 当前选中
//    data/characters/<id>.json      每张人设卡（可单独拷走分享）
//    data/conversations/index.json  对话顺序 + 分类
//    data/conversations/<id>.json   每个对话（可单独分享）
//    data/memory/<类目>.json        记忆（日记 / 承诺 / 偏好 / 计划 / 动机 / 关键记忆）
//
//  ★ 关键设计：前端一行都不用改
//  ----------------------------
//  前端仍然走"键值同步"（localStorage 包装 → POST /api/store）。
//  这一层负责把整块键值**拆成文件**（写入时）和**拼回键值**（读取时）。
//  所以拆分类只影响后端，前端、APK、data-sync.js 全都不动 —— 风险最低。
//
//  人设卡与聊天记录在前端都是**完整数组**，这一层把它们拆成一条一文件；
//  读的时候再拼回数组。对前端而言完全透明。

import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createZip, readZip } from './zip.mjs';

// ---------------------------------------------------------------------------
//  键 → 归属 的映射表
// ---------------------------------------------------------------------------
//  改这里就能调整"哪个键进哪个文件"。未列出的键一律留在 store.json。
const CHARACTER_KEYS = {
    list: 'elaina_open_character_cards',   // 人设卡数组（会被拆成一卡一文件）
    current: 'elaina_open_current_card',   // 当前选中的人设 id
    active: 'elaina_open_character_card',  // 当前生效那套的内容（旧版遗留，与 list 里的重复）
};

const CONVERSATION_KEY = 'elaina_open_conversations';   // 对话数组（会被拆成一对话一文件）
const MEMORY_KEY = 'elaina_open_memory_core';           // 记忆（会被按类目拆成一类一文件）

/**
 * 记忆的类目 —— 与前端 emptyMemoryCore() 的字段一一对应。
 * 每一类写成 memory/<名字>.json，这样"日记"和"承诺"互不干扰：
 * 日记会越写越长，而承诺/偏好通常很小且很少变，混在一个文件里每次都要整体重写。
 */
const MEMORY_CATEGORIES = ['diary', 'promise', 'preference', 'plan', 'motivation', 'pivotal_memory'];

const CHARACTERS_DIR = 'characters';
const CONVERSATIONS_DIR = 'conversations';
const MEMORY_DIR = 'memory';

/** 合法的 id（防止路径穿越：id 直接当文件名用） */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** 备份格式标识与版本 */
export const BACKUP_FORMAT = 'elainachat-backup';
export const BACKUP_VERSION = 2;   // v1 = 单 JSON；v2 = zip（本版）

export function createStore({ dataDir, log = () => {} }) {
    const STORE_FILE = path.join(dataDir, 'store.json');
    const charsDir = path.join(dataDir, CHARACTERS_DIR);
    const charsIndex = path.join(charsDir, 'index.json');
    const convDir = path.join(dataDir, CONVERSATIONS_DIR);
    const convIndex = path.join(convDir, 'index.json');
    const memoryDir = path.join(dataDir, MEMORY_DIR);

    let cache = null;
    let writeQueue = Promise.resolve();

    // ---------------------------------------------------------------- 工具
    /** 原子写：先写 .tmp 再 rename，避免写到一半崩溃留下半截文件 */
    async function writeJsonAtomic(file, obj) {
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
        await rename(tmp, file);
    }

    async function readJson(file) {
        try {
            return JSON.parse(await readFile(file, 'utf8'));
        } catch {
            return null;   // 不存在 / 损坏 → 由调用方决定怎么兜底
        }
    }

    /** 与旧实现一致的收敛：只收字符串值，限制键长与单键体积 */
    function normalize(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        for (const [k, v] of Object.entries(raw)) {
            if (typeof k !== 'string' || !k || k.length > 120) continue;
            if (typeof v !== 'string') continue;
            if (v.length > 8 * 1024 * 1024) continue;
            out[k] = v;
        }
        return out;
    }

    /** 确保条目有合法 id（没有就补一个），返回 id */
    function ensureId(item, prefix) {
        if (item && typeof item.id === 'string' && SAFE_ID.test(item.id)) return item.id;
        const id = prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        if (item && typeof item === 'object') item.id = id;
        return id;
    }

    /**
     * 通用的"数组 → 一条一文件 + index"写入。
     * @param raw     数组的 JSON 字符串
     * @param dir     目标目录
     * @param prefix  补 id 时的前缀
     * @param extra   额外写进 index 的字段（如 currentCardId）
     * @returns 成功与否（内容不是合法 JSON 时返回 false，不动磁盘）
     */
    async function writeCollection(raw, dir, prefix, extra = {}) {
        let items = [];
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) items = parsed.filter((x) => x && typeof x === 'object');
        } catch {
            return false;   // 非法 JSON → 不动磁盘，保留旧数据
        }

        const order = [];
        const keep = new Set();
        for (const item of items) {
            const id = ensureId(item, prefix);
            order.push(id);
            keep.add(id + '.json');
            await writeJsonAtomic(path.join(dir, id + '.json'), item);
        }

        // 清掉已被删除的条目（order 里不再出现的文件）
        try {
            for (const name of await readdir(dir)) {
                if (!name.endsWith('.json') || name === 'index.json') continue;
                if (keep.has(name)) continue;
                await rm(path.join(dir, name), { force: true });
            }
        } catch { /* 目录不存在等情况忽略 */ }

        await writeJsonAtomic(path.join(dir, 'index.json'), { version: 1, order, ...extra });
        return true;
    }

    /** 通用的"一条一文件 + index → 数组"读取；返回 JSON 字符串或 null */
    async function readCollection(dir, extraKeys = []) {
        const index = await readJson(path.join(dir, 'index.json'));
        if (!index || !Array.isArray(index.order)) return null;
        const items = [];
        for (const id of index.order) {
            if (!SAFE_ID.test(id)) continue;   // 跳过非法 id，不因一个坏文件全盘失败
            const item = await readJson(path.join(dir, id + '.json'));
            if (item && typeof item === 'object') items.push(item);
        }
        const out = { json: items.length ? JSON.stringify(items) : null, index };
        return out;
    }

    // ---------------------------------------------------- 记忆：按类目拆文件
    /**
     * 写：把记忆对象按类目拆成 memory/<类目>.json。
     *
     * 为什么按类目拆而不是整个塞一个文件：
     *   · 日记会越写越长（每条几百字），而承诺/偏好/计划通常很小且很少变；
     *     混在一起意味着"加一条日记"要把整个记忆重写一遍。
     *   · 拆开后用户可以单独看/备份/删掉某一类（比如只想清掉日记）。
     *
     * 未知类目也会写出去（不丢数据）—— 前端将来加字段时不用同步改这里。
     */
    async function writeMemory(raw) {
        let obj = null;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed;
        } catch {
            return false;   // 非法 JSON → 不动磁盘
        }

        const keep = new Set();
        for (const [name, value] of Object.entries(obj)) {
            // 类目名直接当文件名 —— 必须过白名单，防止记忆里混进 "../../x" 这种键
            if (!SAFE_ID.test(name)) continue;
            keep.add(name + '.json');
            await writeJsonAtomic(path.join(memoryDir, name + '.json'), { version: 1, value });
        }
        // 已删除的类目（比如前端去掉了某个字段）清掉残留文件
        try {
            for (const name of await readdir(memoryDir)) {
                if (!name.endsWith('.json')) continue;
                if (keep.has(name)) continue;
                await rm(path.join(memoryDir, name), { force: true });
            }
        } catch { /* 目录不存在等情况忽略 */ }
        return true;
    }

    /** 读：把 memory/<类目>.json 拼回一个对象（返回 JSON 字符串或 null） */
    async function readMemory() {
        let names = [];
        try {
            names = (await readdir(memoryDir)).filter((n) => n.endsWith('.json'));
        } catch {
            return null;   // 目录不存在 → 没有记忆
        }
        if (!names.length) return null;

        const obj = {};
        for (const name of names.sort()) {
            const category = name.slice(0, -'.json'.length);
            if (!SAFE_ID.test(category)) continue;
            const rec = await readJson(path.join(memoryDir, name));
            if (rec && rec.value !== undefined) obj[category] = rec.value;
        }
        return Object.keys(obj).length ? JSON.stringify(obj) : null;
    }

    // ------------------------------------------------------------ 读：拼回键值
    /**
     * 把 data/ 下的分类文件拼成一个键值对象。
     * 顺序很重要：先读分类文件，再读 store.json —— 这样迁移期两者都有时，
     * store.json 里的旧值不会覆盖已经分出去的新值（迁移逻辑会清掉旧键）。
     */
    async function loadStore() {
        if (cache) return cache;
        const out = {};

        // ① 记忆（按类目拆成一类一文件）
        const mem = await readMemory();
        if (mem) out[MEMORY_KEY] = mem;

        // ② 人设卡
        const chars = await readCollection(charsDir);
        if (chars && chars.json) {
            out[CHARACTER_KEYS.list] = chars.json;
            if (typeof chars.index.currentCardId === 'string') {
                out[CHARACTER_KEYS.current] = chars.index.currentCardId;
            }
        }

        // ③ 聊天记录
        const convs = await readCollection(convDir);
        if (convs && convs.json) out[CONVERSATION_KEY] = convs.json;

        // ④ 兜底：store.json 里的其它键（设置 / 密钥 / UI 偏好）
        const legacy = normalize(await readJson(STORE_FILE));
        for (const [k, v] of Object.entries(legacy)) {
            if (out[k] === undefined) out[k] = v;
        }

        cache = out;
        return cache;
    }

    // ------------------------------------------------------------ 写：拆成文件
    /**
     * 保存：把键值按映射表拆到各自的文件。
     * 只处理 store 里**存在**的键 —— 不因为"这次没提交"就把已有数据清掉。
     */
    async function saveStore() {
        writeQueue = writeQueue.then(async () => {
            await mkdir(dataDir, { recursive: true });
            const store = cache || {};

            // ① 记忆（按类目拆成一类一文件）
            if (typeof store[MEMORY_KEY] === 'string') {
                await writeMemory(store[MEMORY_KEY]);
            }

            // ② 人设卡
            if (typeof store[CHARACTER_KEYS.list] === 'string') {
                await writeCollection(store[CHARACTER_KEYS.list], charsDir, 'card', {
                    currentCardId: typeof store[CHARACTER_KEYS.current] === 'string' ? store[CHARACTER_KEYS.current] : '',
                });
            }

            // ③ 聊天记录
            if (typeof store[CONVERSATION_KEY] === 'string') {
                await writeCollection(store[CONVERSATION_KEY], convDir, 'conv');
            }

            // ④ 其余键 → store.json（分类键不再重复写进去）
            const misc = {};
            for (const [k, v] of Object.entries(store)) {
                if (k === MEMORY_KEY) continue;
                if (k === CONVERSATION_KEY) continue;
                if (Object.values(CHARACTER_KEYS).includes(k)) continue;
                misc[k] = v;
            }
            await writeJsonAtomic(STORE_FILE, misc);
        }).catch((err) => {
            log('error', '[store] 写入失败: ' + (err && err.message ? err.message : err));
        });
        return writeQueue;
    }

    // ------------------------------------------------------------ 迁移
    /**
     * 从旧的"全部挤在 store.json"迁移到分类文件。
     *
     * 只在检测到 store.json 里**还留着分类键**时才动手；迁移完这些键会从
     * store.json 里消失（saveStore 只写 misc），所以天然幂等，重复启动不会重复迁移。
     *
     * @returns 迁移了哪些类目（空数组 = 无需迁移）
     */
    async function migrateIfNeeded() {
        const legacy = normalize(await readJson(STORE_FILE));
        const moved = [];

        const hasMemKey = typeof legacy[MEMORY_KEY] === 'string';
        const hasCharKey = typeof legacy[CHARACTER_KEYS.list] === 'string';
        const hasConvKey = typeof legacy[CONVERSATION_KEY] === 'string';
        // 旧版（v1）把聊天记录放在单个 conversations.json 里，现在要拆成一对话一文件
        const legacySingleConv = await readJson(path.join(dataDir, 'conversations.json'));
        // v2 中期把记忆放在单个 memory.json 里，现在要拆成 memory/<类目>.json
        const legacySingleMem = await readJson(path.join(dataDir, 'memory.json'));

        if (!hasMemKey && !hasCharKey && !hasConvKey && !legacySingleConv && !legacySingleMem) return moved;

        // 记忆：两个来源（store.json 里的键 / 旧的单文件 memory.json）
        {
            const existing = await readMemory();
            if (!existing) {
                const source = hasMemKey
                    ? legacy[MEMORY_KEY]
                    : (legacySingleMem && typeof legacySingleMem.value === 'string' ? legacySingleMem.value : null);
                if (typeof source === 'string') {
                    const ok = await writeMemory(source);
                    if (ok) moved.push('memory');
                }
            }
        }

        // 人设卡
        if (hasCharKey) {
            const idx = await readJson(charsIndex);
            if (!idx || !Array.isArray(idx.order) || !idx.order.length) {
                const ok = await writeCollection(legacy[CHARACTER_KEYS.list], charsDir, 'card', {
                    currentCardId: typeof legacy[CHARACTER_KEYS.current] === 'string' ? legacy[CHARACTER_KEYS.current] : '',
                });
                if (ok) moved.push('characters');
            }
        }

        // 聊天记录：两个来源（store.json 里的键 / 旧的单文件 conversations.json）
        {
            const idx = await readJson(convIndex);
            const alreadySplit = idx && Array.isArray(idx.order) && idx.order.length;
            if (!alreadySplit) {
                const source = hasConvKey
                    ? legacy[CONVERSATION_KEY]
                    : (legacySingleConv && typeof legacySingleConv.value === 'string' ? legacySingleConv.value : null);
                if (typeof source === 'string') {
                    const ok = await writeCollection(source, convDir, 'conv');
                    if (ok) moved.push('conversations');
                }
            }
        }

        if (moved.length) {
            // 让 cache 反映迁移后的状态，并重写 store.json（分类键就此消失）
            cache = null;
            await loadStore();
            if (typeof legacy[MEMORY_KEY] === 'string' && cache[MEMORY_KEY] === undefined) {
                cache[MEMORY_KEY] = legacy[MEMORY_KEY];
            }
            if (typeof legacy[CHARACTER_KEYS.list] === 'string' && cache[CHARACTER_KEYS.list] === undefined) {
                cache[CHARACTER_KEYS.list] = legacy[CHARACTER_KEYS.list];
                if (typeof legacy[CHARACTER_KEYS.current] === 'string') {
                    cache[CHARACTER_KEYS.current] = legacy[CHARACTER_KEYS.current];
                }
            }
            await saveStore();
            log('info', `[store] 已迁移到分类存储: ${moved.join(', ')}`);
        }

        // 清掉旧的单文件。
        //
        // **这一步必须在 `if (moved.length)` 之外** —— 曾经放在里面，于是出现这个残留：
        // 上一次迁移已经把对话拆进 conversations/ 了（所以这次 alreadySplit 为真、
        // moved 为空），但旧的 conversations.json 因为某种原因没被删掉，
        // 结果它**永久留在磁盘上**：不会被读取（loadStore 只认 conversations/），
        // 也不会被清理，白占空间还让用户困惑"到底哪个才是我的数据"。
        //
        // 判据：只要新位置有内容（说明数据已经安全落位），旧文件就是冗余的，可以删。
        // 没内容时**不删** —— 那是唯一的数据来源。
        if (legacySingleConv) {
            const idx = await readJson(convIndex);
            const newHasData = idx && Array.isArray(idx.order) && idx.order.length > 0;
            if (newHasData) {
                await rm(path.join(dataDir, 'conversations.json'), { force: true });
                if (!moved.length) log('info', '[store] 清理了遗留的旧单文件 conversations.json（数据已在 conversations/ 里）');
            }
        }
        if (legacySingleMem) {
            const mem = await readMemory();
            if (mem) {
                await rm(path.join(dataDir, 'memory.json'), { force: true });
                if (!moved.length) log('info', '[store] 清理了遗留的旧单文件 memory.json（数据已在 memory/ 里）');
            }
        }

        return moved;
    }

    // ------------------------------------------------------------ 导入导出
    /**
     * 导出为 **zip**（标准格式，任何解压工具都能打开）。
     *
     * 目录结构：
     *   manifest.json           格式标识 / 版本 / 导出时间 / 统计
     *   settings.json           设置、API Key、UI 偏好
     *   characters/index.json   卡片顺序 + 当前选中
     *   characters/<id>.json    每张人设卡
     *   conversations/index.json
     *   conversations/<id>.json 每个对话
     *   memory/<类目>.json      记忆（日记 / 承诺 / 偏好 / 计划 / 动机 / 关键记忆）
     *
     * 这样用户解压后能直接看到"我的数据长什么样"，也能单独取出某一张卡/某一个对话。
     */
    async function exportZip() {
        const store = await loadStore();
        const entries = [];

        // manifest：给人和程序看的说明
        let cardCount = 0;
        let convCount = 0;
        try { cardCount = JSON.parse(store[CHARACTER_KEYS.list] || '[]').length; } catch { /* 忽略 */ }
        try { convCount = JSON.parse(store[CONVERSATION_KEY] || '[]').length; } catch { /* 忽略 */ }

        entries.push({
            name: 'manifest.json',
            data: JSON.stringify({
                format: BACKUP_FORMAT,
                version: BACKUP_VERSION,
                exportedAt: new Date().toISOString(),
                note: '这是 ElainaChat 的数据备份。导入时请选择本 zip 文件。',
                counts: { characters: cardCount, conversations: convCount },
            }, null, 2),
        });

        // 设置 / 密钥 / UI 偏好
        const settings = {};
        for (const [k, v] of Object.entries(store)) {
            if (k === MEMORY_KEY) continue;
            if (k === CONVERSATION_KEY) continue;
            if (Object.values(CHARACTER_KEYS).includes(k)) continue;
            settings[k] = v;
        }
        entries.push({ name: 'settings.json', data: JSON.stringify(settings, null, 2) });

        // 人设卡：一卡一文件
        const charsIdx = await readJson(charsIndex);
        if (charsIdx) {
            entries.push({ name: 'characters/index.json', data: JSON.stringify(charsIdx, null, 2) });
            for (const id of charsIdx.order || []) {
                if (!SAFE_ID.test(id)) continue;
                const card = await readJson(path.join(charsDir, id + '.json'));
                if (card) entries.push({ name: `characters/${id}.json`, data: JSON.stringify(card, null, 2) });
            }
        }

        // 聊天记录：一对话一文件
        const convIdx = await readJson(convIndex);
        if (convIdx) {
            entries.push({ name: 'conversations/index.json', data: JSON.stringify(convIdx, null, 2) });
            for (const id of convIdx.order || []) {
                if (!SAFE_ID.test(id)) continue;
                const conv = await readJson(path.join(convDir, id + '.json'));
                if (conv) entries.push({ name: `conversations/${id}.json`, data: JSON.stringify(conv, null, 2) });
            }
        }

        // 记忆：一类目一文件（与磁盘结构一致，用户解压后能直接看）
        try {
            const names = (await readdir(memoryDir)).filter((n) => n.endsWith('.json'));
            for (const name of names.sort()) {
                const rec = await readJson(path.join(memoryDir, name));
                if (rec) entries.push({ name: `memory/${name}`, data: JSON.stringify(rec, null, 2) });
            }
        } catch { /* 没有记忆目录就跳过 */ }

        return createZip(entries);
    }

    /**
     * 从备份导入。
     *
     * 接受两种输入：
     *   · zip（v2，推荐）—— 按上面的目录结构解析
     *   · 单个 JSON（v1 旧备份）—— 兼容老用户手里的备份文件
     *
     * @param buf   Buffer（zip 或 JSON 文本）
     * @param mode  'merge'（默认，按键覆盖）| 'replace'（清空后只留备份内容）
     */
    async function importBackup(buf, mode = 'merge') {
        const payload = await parseBackup(buf);
        const incoming = payload.data;
        const keys = Object.keys(incoming);
        if (!keys.length) return { ok: false, keys: 0, message: '备份里没有可导入的数据' };

        const store = await loadStore();
        if (mode === 'replace') {
            for (const k of Object.keys(store)) delete store[k];
        }
        Object.assign(store, incoming);
        await saveStore();
        return { ok: true, keys: keys.length, source: payload.source, message: `已导入 ${keys.length} 项数据（${mode === 'replace' ? '替换' : '合并'}模式）` };
    }

    /** 把 Buffer 解析成 { source, data:{键:字符串} }；zip 与旧 JSON 都支持 */
    async function parseBackup(buf) {
        if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf ?? ''), 'utf8');

        // zip：以 PK\x03\x04 开头
        if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
            const files = readZip(buf, { maxTotal: 256 * 1024 * 1024, maxEntry: 64 * 1024 * 1024 });
            const byName = new Map(files.map((f) => [f.name, f.data]));
            const data = {};

            const readText = (name) => {
                const b = byName.get(name);
                return b ? b.toString('utf8') : null;
            };

            // 设置
            const settingsText = readText('settings.json');
            if (settingsText) {
                try {
                    const obj = JSON.parse(settingsText);
                    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                        for (const [k, v] of Object.entries(obj)) {
                            if (typeof v === 'string') data[k] = v;
                        }
                    }
                } catch { /* 单个文件坏了不该让整包失败 */ }
            }

            // 人设卡：按 index.order 拼回数组（保持顺序）
            const charsIdxText = readText('characters/index.json');
            if (charsIdxText) {
                try {
                    const idx = JSON.parse(charsIdxText);
                    const cards = [];
                    for (const id of (idx && idx.order) || []) {
                        if (!SAFE_ID.test(id)) continue;
                        const t = readText(`characters/${id}.json`);
                        if (!t) continue;
                        try { cards.push(JSON.parse(t)); } catch { /* 跳过坏卡 */ }
                    }
                    if (cards.length) {
                        data[CHARACTER_KEYS.list] = JSON.stringify(cards);
                        if (typeof idx.currentCardId === 'string') data[CHARACTER_KEYS.current] = idx.currentCardId;
                    }
                } catch { /* 忽略 */ }
            }

            // 聊天记录
            const convIdxText = readText('conversations/index.json');
            if (convIdxText) {
                try {
                    const idx = JSON.parse(convIdxText);
                    const convs = [];
                    for (const id of (idx && idx.order) || []) {
                        if (!SAFE_ID.test(id)) continue;
                        const t = readText(`conversations/${id}.json`);
                        if (!t) continue;
                        try { convs.push(JSON.parse(t)); } catch { /* 跳过坏项 */ }
                    }
                    if (convs.length) data[CONVERSATION_KEY] = JSON.stringify(convs);
                } catch { /* 忽略 */ }
            }

            // 记忆：一类目一文件 → 拼回一个对象。
            // 同时兼容两种旧形态：
            //   · memory/<类目>.json      （当前格式）
            //   · memory.json {value:…}   （v2 中期的单文件形态）
            const memObj = {};
            for (const f of files) {
                if (!/^memory\/[A-Za-z0-9_-]+\.json$/.test(f.name)) continue;
                const category = f.name.slice('memory/'.length, -'.json'.length);
                try {
                    const rec = JSON.parse(f.data.toString('utf8'));
                    if (rec && rec.value !== undefined) memObj[category] = rec.value;
                } catch { /* 跳过坏文件 */ }
            }
            if (Object.keys(memObj).length) {
                data[MEMORY_KEY] = JSON.stringify(memObj);
            } else {
                const legacyMem = readText('memory.json');
                if (legacyMem) {
                    try {
                        const rec = JSON.parse(legacyMem);
                        if (rec && typeof rec.value === 'string') data[MEMORY_KEY] = rec.value;
                    } catch { /* 忽略 */ }
                }
            }

            return { source: 'zip', data };
        }

        // 旧版单 JSON 备份
        let parsed;
        try {
            parsed = JSON.parse(buf.toString('utf8'));
        } catch {
            throw new Error('这个文件既不是 zip 也不是有效的 JSON 备份');
        }
        const raw = parsed && typeof parsed === 'object' && parsed.data ? parsed.data : parsed;
        return { source: 'json', data: normalize(raw) };
    }

    /** 让调用方丢弃缓存（导入 / 外部改动后强制重读） */
    function invalidate() { cache = null; }

    return {
        loadStore, saveStore, migrateIfNeeded,
        exportZip, importBackup,
        invalidate,
        CHARACTER_KEYS, CONVERSATION_KEY, MEMORY_KEY, MEMORY_CATEGORIES,
    };
}
