// ============================================================================
//  数据备份：导出 / 导入（APK 侧）
// ============================================================================
//
//  为什么单独一个文件：APK 里没有 Node 后端（serve.mjs 不进 APK），
//  所以 /api/data/* 那几个接口在 APK 里根本不存在 —— 「我的数据」整块原本是隐藏的。
//  但**用户数据在 APK 里反而更危险**：它存在应用私有目录（WebView 的 localStorage），
//  卸载即丢失，用户连手动拷出来都做不到。所以 APK 侧比 Web 侧更需要备份。
//
//  做法：直接用 localStorage 生成/还原备份，格式与 Web 版**完全一致**（同一套 zip 结构），
//  这样两边可以互相导入：
//      APK 导出 → 传到电脑 → Web 版导入   ✅
//      Web 版导出 → 传进手机 → APK 导入   ✅
//
//  zip 用一份零依赖的最小实现（store 模式，不压缩）——
//  浏览器里没有 node:zlib，而引第三方库会破坏"零依赖"。备份体积本来就不大，
//  不压缩完全可以接受（几 MB 的对话记录压完也就小一半，不值得为它引依赖）。
//
//  依赖注入：需要主脚本提供 SYNC_KEYS / 读 localStorage 的能力。
//  这里只用标准 API（localStorage + Blob），不需要注入。

(function () {
    'use strict';

    // 与 web/js/data-sync.js 的 SYNC_KEYS 保持一致（那边是权威清单）。
    // 两处不一致会导致"导出漏了某项" —— 所以下面有个断言会检查这一点。
    const BACKUP_KEYS = [
        'elaina_open_settings',
        'elainachat_open_api_secrets',
        'elaina_open_conversations',
        'elaina_open_categories',
        'elaina_open_favorites',
        'elaina_open_liked_quotes',
        'elaina_open_character_card',
        'elaina_open_character_cards',
        'elaina_open_current_card',
        'elaina_open_memory_core',
        'live2d.bg',
        'live2d.mouseFollow',
        'live2d.mouseFollowScale',
    ];

    const FORMAT = 'elainachat-backup';
    const VERSION = 2;   // 与后端一致：v2 = zip

    // ------------------------------------------------------------------ CRC32
    // zip 要求每个条目带 CRC32。浏览器没有内置实现，这里用标准查表法（约 15 行）。
    let crcTable = null;
    function makeCrcTable() {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    }
    function crc32(bytes) {
        if (!crcTable) crcTable = makeCrcTable();
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    // ------------------------------------------------------------------ 写 zip
    /**
     * 打包成 zip（只用 store 模式，不压缩）。
     * @param entries [{ name: string, text: string }]
     * @returns Blob
     */
    function buildZip(entries) {
        const enc = new TextEncoder();
        const parts = [];
        const central = [];
        let offset = 0;

        for (const e of entries) {
            const nameBytes = enc.encode(e.name);
            const dataBytes = enc.encode(e.text);
            const crc = crc32(dataBytes);
            const size = dataBytes.length;

            const local = new Uint8Array(30 + nameBytes.length);
            const lv = new DataView(local.buffer);
            lv.setUint32(0, 0x04034b50, true);
            lv.setUint16(4, 20, true);
            lv.setUint16(6, 0x0800, true);       // UTF-8 文件名
            lv.setUint16(8, 0, true);            // store（不压缩）
            lv.setUint16(10, 0, true);
            lv.setUint16(12, 0x21, true);
            lv.setUint32(14, crc, true);
            lv.setUint32(18, size, true);
            lv.setUint32(22, size, true);
            lv.setUint16(26, nameBytes.length, true);
            lv.setUint16(28, 0, true);
            local.set(nameBytes, 30);

            const cen = new Uint8Array(46 + nameBytes.length);
            const cv = new DataView(cen.buffer);
            cv.setUint32(0, 0x02014b50, true);
            cv.setUint16(4, 20, true);
            cv.setUint16(6, 20, true);
            cv.setUint16(8, 0x0800, true);
            cv.setUint16(10, 0, true);
            cv.setUint16(12, 0, true);
            cv.setUint16(14, 0x21, true);
            cv.setUint32(16, crc, true);
            cv.setUint32(20, size, true);
            cv.setUint32(24, size, true);
            cv.setUint16(28, nameBytes.length, true);
            cv.setUint16(30, 0, true);
            cv.setUint16(32, 0, true);
            cv.setUint16(34, 0, true);
            cv.setUint16(36, 0, true);
            cv.setUint32(38, 0, true);
            cv.setUint32(42, offset, true);
            cen.set(nameBytes, 46);

            parts.push(local, dataBytes);
            central.push(cen);
            offset += local.length + dataBytes.length;
        }

        const centralBytes = concat(central);
        const localBytes = concat(parts);
        const eocd = new Uint8Array(22);
        const ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(8, central.length, true);
        ev.setUint16(10, central.length, true);
        ev.setUint32(12, centralBytes.length, true);
        ev.setUint32(16, localBytes.length, true);

        return new Blob([localBytes, centralBytes, eocd], { type: 'application/zip' });
    }

    function concat(arrays) {
        let total = 0;
        for (const a of arrays) total += a.length;
        const out = new Uint8Array(total);
        let at = 0;
        for (const a of arrays) { out.set(a, at); at += a.length; }
        return out;
    }

    // ------------------------------------------------------------------ 读 zip
    /**
     * 解出 zip 里的所有条目。
     * @param bytes Uint8Array
     * @returns [{ name, text }]
     */
    function readZip(bytes) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length < 22 || dv.getUint32(0, true) !== 0x04034b50) {
            throw new Error('不是有效的 zip 文件');
        }
        // 从尾部找 EOCD
        let eocd = -1;
        const min = Math.max(0, bytes.length - 22 - 0xFFFF);
        for (let i = bytes.length - 22; i >= min; i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('zip 缺少中央目录');

        const total = dv.getUint16(eocd + 10, true);
        const cdOff = dv.getUint32(eocd + 16, true);
        const dec = new TextDecoder('utf-8');
        const out = [];

        let off = cdOff;
        for (let i = 0; i < total; i++) {
            if (dv.getUint32(off, true) !== 0x02014b50) break;
            const method = dv.getUint16(off + 10, true);
            const compSize = dv.getUint32(off + 20, true);
            const nameLen = dv.getUint16(off + 28, true);
            const extraLen = dv.getUint16(off + 30, true);
            const commentLen = dv.getUint16(off + 32, true);
            const localOff = dv.getUint32(off + 42, true);
            const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));

            // local header 里的名字/extra 长度可能与中央目录不同，必须按 local 的算
            const lNameLen = dv.getUint16(localOff + 26, true);
            const lExtraLen = dv.getUint16(localOff + 28, true);
            const dataStart = localOff + 30 + lNameLen + lExtraLen;
            const payload = bytes.subarray(dataStart, dataStart + compSize);

            if (method === 0) {
                out.push({ name, text: dec.decode(payload) });
            } else if (method === 8) {
                // deflate：交给 DecompressionStream（浏览器/现代 WebView 内置）
                out.push({ name, deflated: payload });
            } else {
                throw new Error(`备份里有不支持的压缩方式 ${method}（${name}）`);
            }
            off += 46 + nameLen + extraLen + commentLen;
        }
        return out;
    }

    /** 把 deflate 条目解出来（异步，因为要用 DecompressionStream） */
    async function inflateEntry(bytes) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('这个备份用了压缩，当前环境不支持解压（请用 Web 版导入）');
        }
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        return await new Response(stream).text();
    }

    // ------------------------------------------------------------------ 导出
    /** 收集当前 localStorage 里属于备份范围的键 */
    function collectLocalData() {
        const data = {};
        for (const k of BACKUP_KEYS) {
            try {
                const v = localStorage.getItem(k);
                if (typeof v === 'string') data[k] = v;
            } catch { /* 隐私模式等：跳过 */ }
        }
        return data;
    }

    /**
     * 生成备份 zip（与 Web 版同构：manifest / settings / characters / conversations / memory）。
     * 好处：用户能解压开直接看，也能拿去 Web 版导入。
     */
    async function buildBackupBlob() {
        const data = collectLocalData();
        const entries = [];

        // 人设卡 / 对话 / 记忆从 localStorage 里拆出来（与后端 store.mjs 的目录结构对齐）
        let cards = [];
        let convs = [];
        try { cards = JSON.parse(data['elaina_open_character_cards'] || '[]'); } catch { /* 忽略 */ }
        try { convs = JSON.parse(data['elaina_open_conversations'] || '[]'); } catch { /* 忽略 */ }

        entries.push({
            name: 'manifest.json',
            text: JSON.stringify({
                format: FORMAT,
                version: VERSION,
                exportedAt: new Date().toISOString(),
                source: 'apk',
                note: '这是 ElainaChat（安卓版）的数据备份，可在 Web 版导入。',
                counts: { characters: cards.length, conversations: convs.length },
            }, null, 2),
        });

        // settings.json：除人设卡/对话/记忆之外的键
        const settings = {};
        for (const [k, v] of Object.entries(data)) {
            if (k === 'elaina_open_character_cards' || k === 'elaina_open_conversations' || k === 'elaina_open_memory_core') continue;
            settings[k] = v;
        }
        entries.push({ name: 'settings.json', text: JSON.stringify(settings, null, 2) });

        // characters/
        if (Array.isArray(cards) && cards.length) {
            const order = [];
            for (const card of cards) {
                if (!card || typeof card !== 'object') continue;
                const id = (typeof card.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(card.id)) ? card.id : ('card_' + order.length);
                order.push(id);
                entries.push({ name: `characters/${id}.json`, text: JSON.stringify(card, null, 2) });
            }
            entries.push({
                name: 'characters/index.json',
                text: JSON.stringify({ version: 1, currentCardId: data['elaina_open_current_card'] || '', order }, null, 2),
            });
        }

        // conversations/
        if (Array.isArray(convs) && convs.length) {
            const order = [];
            for (const conv of convs) {
                if (!conv || typeof conv !== 'object') continue;
                const id = (typeof conv.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(conv.id)) ? conv.id : ('conv_' + order.length);
                order.push(id);
                entries.push({ name: `conversations/${id}.json`, text: JSON.stringify(conv, null, 2) });
            }
            entries.push({ name: 'conversations/index.json', text: JSON.stringify({ version: 1, order }, null, 2) });
        }

        // memory/：与后端同构 —— 按类目拆成一类一文件。
        // 记忆在前端是一个对象 { diary, promise, preference, plan, motivation, pivotal_memory }，
        // 这里逐类目写出去（未知类目也写，不丢数据）。
        if (typeof data['elaina_open_memory_core'] === 'string') {
            try {
                const memObj = JSON.parse(data['elaina_open_memory_core']);
                if (memObj && typeof memObj === 'object' && !Array.isArray(memObj)) {
                    for (const [category, value] of Object.entries(memObj)) {
                        if (!/^[A-Za-z0-9_-]{1,80}$/.test(category)) continue;   // 类目名当文件名，必须过白名单
                        entries.push({
                            name: `memory/${category}.json`,
                            text: JSON.stringify({ version: 1, value }, null, 2),
                        });
                    }
                }
            } catch { /* 记忆不是合法 JSON 就跳过，不阻塞其它数据 */ }
        }

        return buildZip(entries);
    }

    // ------------------------------------------------------------------ 导入
    /**
     * 解析备份（zip 或 v1 单 JSON），返回 { source, data }。
     */
    async function parseBackup(file) {
        const buf = new Uint8Array(await file.arrayBuffer());
        const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;

        if (!isZip) {
            // v1：单个 JSON
            let parsed;
            try {
                parsed = JSON.parse(new TextDecoder('utf-8').decode(buf));
            } catch {
                throw new Error('这个文件既不是 zip 也不是有效的 JSON 备份');
            }
            const raw = parsed && typeof parsed === 'object' && parsed.data ? parsed.data : parsed;
            const data = {};
            for (const [k, v] of Object.entries(raw || {})) if (typeof v === 'string') data[k] = v;
            return { source: 'json', data };
        }

        const raw = readZip(buf);
        const byName = new Map();
        for (const e of raw) {
            byName.set(e.name, e.deflated ? await inflateEntry(e.deflated) : e.text);
        }
        const get = (n) => (byName.has(n) ? byName.get(n) : null);
        const data = {};

        const settingsText = get('settings.json');
        if (settingsText) {
            try {
                const obj = JSON.parse(settingsText);
                for (const [k, v] of Object.entries(obj || {})) if (typeof v === 'string') data[k] = v;
            } catch { /* 单个文件坏了不该让整包失败 */ }
        }

        const charsIdx = get('characters/index.json');
        if (charsIdx) {
            try {
                const idx = JSON.parse(charsIdx);
                const cards = [];
                for (const id of (idx && idx.order) || []) {
                    const t = get(`characters/${id}.json`);
                    if (!t) continue;
                    try { cards.push(JSON.parse(t)); } catch { /* 跳过坏卡 */ }
                }
                if (cards.length) {
                    data['elaina_open_character_cards'] = JSON.stringify(cards);
                    if (typeof idx.currentCardId === 'string') data['elaina_open_current_card'] = idx.currentCardId;
                    // 当前生效的那套 = 当前选中的卡（Web 版也是这么维护的）
                    const cur = cards.find((c) => c && c.id === idx.currentCardId) || cards[0];
                    if (cur) data['elaina_open_character_card'] = JSON.stringify(cur);
                }
            } catch { /* 忽略 */ }
        }

        const convIdx = get('conversations/index.json');
        if (convIdx) {
            try {
                const idx = JSON.parse(convIdx);
                const convs = [];
                for (const id of (idx && idx.order) || []) {
                    const t = get(`conversations/${id}.json`);
                    if (!t) continue;
                    try { convs.push(JSON.parse(t)); } catch { /* 跳过坏项 */ }
                }
                if (convs.length) data['elaina_open_conversations'] = JSON.stringify(convs);
            } catch { /* 忽略 */ }
        }

        // memory/：一类目一文件 → 拼回一个对象。
        // 同时兼容 v2 中期的单文件 memory.json（{value:…}），老备份照样能导。
        const memObj = {};
        for (const e of raw) {
            if (!/^memory\/[A-Za-z0-9_-]+\.json$/.test(e.name)) continue;
            const category = e.name.slice('memory/'.length, -'.json'.length);
            try {
                const text = e.deflated ? await inflateEntry(e.deflated) : e.text;
                const rec = JSON.parse(text);
                if (rec && rec.value !== undefined) memObj[category] = rec.value;
            } catch { /* 跳过坏文件 */ }
        }
        if (Object.keys(memObj).length) {
            data['elaina_open_memory_core'] = JSON.stringify(memObj);
        } else {
            const legacyMem = get('memory.json');
            if (legacyMem) {
                try {
                    const rec = JSON.parse(legacyMem);
                    if (rec && typeof rec.value === 'string') data['elaina_open_memory_core'] = rec.value;
                } catch { /* 忽略 */ }
            }
        }

        return { source: 'zip', data };
    }

    /**
     * 导入：把备份写回 localStorage（合并模式）。
     * @returns { keys, source }
     */
    async function applyBackup(file) {
        const { source, data } = await parseBackup(file);
        const keys = Object.keys(data);
        if (!keys.length) throw new Error('备份里没有可导入的数据');
        // 只认备份范围内的键，避免把奇怪的键写进 localStorage
        const allowed = new Set(BACKUP_KEYS);
        let written = 0;
        for (const [k, v] of Object.entries(data)) {
            if (!allowed.has(k)) continue;
            try { localStorage.setItem(k, v); written++; } catch { /* 配额满等：跳过 */ }
        }
        if (!written) throw new Error('备份里的数据都不在可导入范围内');
        return { keys: written, source };
    }

    window.ChatBackup = {
        BACKUP_KEYS,
        buildBackupBlob,
        parseBackup,
        applyBackup,
        /** 供测试：断言与 data-sync.js 的 SYNC_KEYS 一致 */
        _keys: BACKUP_KEYS,
    };
})();
