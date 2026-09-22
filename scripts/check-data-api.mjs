// 回归检查：数据导入导出 API（端到端，zip 备份）。
//
// 为什么需要：导出/导入是"用户数据最后一道保险"。它出错的表现很隐蔽 ——
// 导出的包少几个文件、导入时静默丢数据，用户往往在换机器时才发现，那时已经晚了。
// 这个检查起一个**真实服务**（用独立 data 目录，不碰用户数据），走真实 HTTP，
// 断言 zip 内容完整、导入能还原、旧版备份仍兼容、边界情况有明确报错。
//
// 用法：node scripts/check-data-api.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip, readZip } from '../server/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label, detail) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'elaina-dataapi-'));
const dataDir = path.join(sandbox, 'data');
const logDir = path.join(sandbox, 'logs');
await mkdir(dataDir, { recursive: true });

const PORT = 4391;

// 造一份"旧版" store.json（分类键全挤在里面）+ 旧的单文件 conversations.json
const legacyCards = [
    { id: 'card_x', name: '测试卡一', title: 'T1', worldSetting: 'W1', characterPrompt: 'P1' },
    { id: 'card_y', name: '测试卡二', title: 'T2', worldSetting: 'W2', characterPrompt: 'P2' },
];
await writeFile(path.join(dataDir, 'store.json'), JSON.stringify({
    elaina_open_character_cards: JSON.stringify(legacyCards),
    elaina_open_current_card: 'card_x',
    elaina_open_memory_core: JSON.stringify({ diary: [{ date: '2026-09-22', content: '记忆一' }], promise: [] }),
    elaina_open_settings: JSON.stringify({ model: 'test-model' }),
    elainachat_open_api_secrets: JSON.stringify({ apiKey: 'sk-test' }),
}), 'utf8');
// 旧版把聊天记录放单个文件
await writeFile(path.join(dataDir, 'conversations.json'), JSON.stringify({
    version: 1,
    value: JSON.stringify([{ id: 'conv1', title: '测试对话', messages: [{ role: 'user', text: '你好' }] }]),
}), 'utf8');

const server = spawn(process.execPath, ['web/serve.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, LOG_DIR: logDir, LOG_TO_FILE: '0', LOG_CHAT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
server.stdout.on('data', (d) => { bootLog += d; });
server.stderr.on('data', (d) => { bootLog += d; });

const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
    try {
        if ((await fetch(base + '/api/server-info')).ok) { up = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
}
if (!up) {
    console.log('服务没能启动：\n' + bootLog.slice(0, 1500));
    server.kill();
    await rm(sandbox, { recursive: true, force: true });
    process.exit(1);
}

try {
    // ============================================================ 1. 迁移
    console.log('=== 1. 启动时自动迁移旧数据 ===');
    ok(bootLog.includes('数据已迁移到分类存储'), '启动日志报告已迁移', bootLog.split('\n').find((l) => l.includes('迁移')) || '(无)');
    ok(existsSync(path.join(dataDir, 'characters', 'card_x.json')), '人设卡迁移成独立文件');
    ok(existsSync(path.join(dataDir, 'conversations', 'conv1.json')), '旧单文件聊天记录拆成一对话一文件');
    ok(!existsSync(path.join(dataDir, 'conversations.json')), '旧的单文件 conversations.json 已删除');
    ok(existsSync(path.join(dataDir, 'memory', 'diary.json')), '记忆迁移成 memory/<类目>.json');
    {
        const misc = JSON.parse(await readFile(path.join(dataDir, 'store.json'), 'utf8'));
        ok(misc.elaina_open_settings !== undefined, 'store.json 保留设置');
        ok(misc.elainachat_open_api_secrets !== undefined, 'store.json 保留 API Key');
        ok(misc.elaina_open_character_cards === undefined, 'store.json 不再含人设卡');
    }

    // ============================================================ 2. 读回
    console.log('\n=== 2. /api/store 读回（前端视角不变）===');
    {
        const r = await fetch(base + '/api/store');
        const j = await r.json();
        ok(r.status === 200 && j.ok, 'GET /api/store 成功');
        const cards = JSON.parse(j.data.elaina_open_character_cards || '[]');
        ok(cards.length === 2, '人设卡读回 2 张', 'got ' + cards.length);
        ok(cards[0].name === '测试卡一', '卡片内容完整');
        ok(j.data.elaina_open_current_card === 'card_x', '当前卡片 id 读回');
        const convs = JSON.parse(j.data.elaina_open_conversations || '[]');
        ok(convs.length === 1, '聊天记录读回');
        ok(convs[0].messages[0].text === '你好', '对话消息完整');
        ok(JSON.parse(j.data.elaina_open_memory_core || '{}').diary.length === 1, '记忆读回');
        ok(JSON.parse(j.data.elaina_open_settings || '{}').model === 'test-model', '设置读回');
    }

    // ============================================================ 3. data/info
    console.log('\n=== 3. /api/data/info ===');
    {
        const r = await fetch(base + '/api/data/info');
        const j = await r.json();
        ok(r.status === 200 && j.ok, 'GET /api/data/info 成功');
        ok(j.counts.characters === 2, '统计人设卡数 = 2', 'got ' + j.counts.characters);
        ok(j.counts.conversations === 1, '统计聊天记录数 = 1', 'got ' + j.counts.conversations);
        ok(j.counts.memoryEntries === 1, '统计记忆条数 = 1', 'got ' + j.counts.memoryEntries);
        ok(typeof j.dir === 'string' && j.dir.length > 0, '返回数据目录');
        ok(/conversations\//.test(JSON.stringify(j.layout)), 'layout 说明聊天记录是一对话一文件');
    }

    // ============================================================ 4. 导出（zip）
    console.log('\n=== 4. 导出 zip ===');
    let zipBuf = null;
    {
        const r = await fetch(base + '/api/data/export');
        ok(r.status === 200, 'GET /api/data/export 成功');
        // **刻意不发 Content-Disposition: attachment** —— 迅雷/FDM 的机器级扩展
        // 看到它就会抢走这个 URL，导致浏览器里拿到被改写的空响应（实测 204 + 0 字节）。
        // 文件名改走自定义头，前端 fetch 成 blob 后用 <a download> 保存。
        const cd = r.headers.get('content-disposition') || '';
        ok(!/attachment/i.test(cd), '不发 attachment（避免被下载器扩展拦截）', cd || '(无)');
        const fn = r.headers.get('x-backup-filename') || '';
        ok(/^elainachat-backup-.*\.zip$/.test(fn), '用自定义头带文件名', fn);
        ok(/zip/.test(r.headers.get('content-type') || ''), 'Content-Type 是 zip');

        zipBuf = Buffer.from(await r.arrayBuffer());
        ok(zipBuf.readUInt32LE(0) === 0x04034b50, '是合法 zip（PK 头）');

        const files = readZip(zipBuf);
        const names = files.map((f) => f.name);
        const get = (n) => files.find((f) => f.name === n);

        const manifest = JSON.parse(get('manifest.json').data.toString('utf8'));
        ok(manifest.format === 'elainachat-backup', '格式标识正确');
        ok(manifest.version === 2, '版本号为 2（zip）', 'got ' + manifest.version);
        ok(typeof manifest.exportedAt === 'string', '含导出时间');
        ok(names.includes('settings.json'), 'zip 含 settings.json');
        ok(names.includes('characters/index.json'), 'zip 含 characters/index.json');
        ok(names.filter((n) => /^characters\/.+\.json$/.test(n) && !n.endsWith('index.json')).length === 2, 'zip 含 2 张卡（一卡一文件）');
        ok(names.includes('conversations/index.json'), 'zip 含 conversations/index.json');
        ok(names.filter((n) => /^conversations\/.+\.json$/.test(n) && !n.endsWith('index.json')).length === 1, 'zip 含 1 个对话（一对话一文件）');
        ok(names.some((n) => /^memory\/[A-Za-z0-9_-]+\.json$/.test(n)), 'zip 含 memory/<类目>.json');

        const settings = JSON.parse(get('settings.json').data.toString('utf8'));
        ok(settings.elaina_open_settings !== undefined, 'settings.json 含设置');
        ok(settings.elainachat_open_api_secrets !== undefined, 'settings.json 含 API Key');
        const memFile = names.find((n) => /^memory\/[A-Za-z0-9_-]+\.json$/.test(n));
        ok(typeof JSON.parse(get(memFile).data.toString('utf8')).value !== 'undefined', 'memory/<类目>.json 是 {value} 形态');
    }

    // ============================================================ 5. 写入后导出仍完整
    console.log('\n=== 5. 通过 /api/store 写入后再导出（新数据要能进备份）===');
    {
        const r = await fetch(base + '/api/store', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: {
                elaina_open_favorites: JSON.stringify([{ id: 'fav1' }]),
                elaina_open_settings: JSON.stringify({ model: 'changed' }),
            } }),
        });
        const j = await r.json();
        ok(r.status === 200 && j.ok, 'POST /api/store 成功');
        ok(j.keys === 2, '报告写入 2 个键', 'got ' + j.keys);

        const r2 = await fetch(base + '/api/data/export');
        const files = readZip(Buffer.from(await r2.arrayBuffer()));
        const settings = JSON.parse(files.find((f) => f.name === 'settings.json').data.toString('utf8'));
        ok(JSON.parse(settings.elaina_open_favorites || '[]').length === 1, '新写入的收藏进了备份');
        ok(JSON.parse(settings.elaina_open_settings).model === 'changed', '修改后的设置进了备份');
        const cardNames = files.map((f) => f.name).filter((n) => /^characters\/.+\.json$/.test(n) && !n.endsWith('index.json'));
        ok(cardNames.length === 2, '分类数据未被单键写入覆盖', 'got ' + cardNames.length);
    }

    // ============================================================ 6. 导入 zip（merge）
    console.log('\n=== 6. 导入 zip（merge 模式）===');
    {
        // 改一份 zip：加一张新卡、改设置，重新打包
        const files = readZip(zipBuf);
        const entries = files.map((f) => ({ name: f.name, data: f.data }));
        const setEntry = (name, data) => {
            const buf = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
            const i = entries.findIndex((e) => e.name === name);
            if (i >= 0) entries[i].data = buf; else entries.push({ name, data: buf });
        };
        const charsIdx = JSON.parse(files.find((f) => f.name === 'characters/index.json').data.toString('utf8'));
        charsIdx.order.push('card_z');
        setEntry('characters/index.json', charsIdx);
        setEntry('characters/card_z.json', { id: 'card_z', name: '备份里的新卡' });
        const settings = JSON.parse(files.find((f) => f.name === 'settings.json').data.toString('utf8'));
        settings.elaina_open_settings = JSON.stringify({ model: 'from-backup' });
        setEntry('settings.json', settings);
        const modZip = createZip(entries);

        const r = await fetch(base + '/api/data/import?mode=merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: modZip,
        });
        const j = await r.json();
        ok(r.status === 200 && j.ok, 'POST /api/data/import 成功', JSON.stringify(j));
        ok(j.mode === 'merge', '报告 merge 模式');
        ok(j.source === 'zip', '识别为 zip 来源', String(j.source));

        const s = (await (await fetch(base + '/api/store')).json()).data;
        ok(JSON.parse(s.elaina_open_settings).model === 'from-backup', '导入覆盖了设置');
        ok(JSON.parse(s.elaina_open_character_cards).length === 3, '导入后卡片变 3 张', 'got ' + JSON.parse(s.elaina_open_character_cards).length);
        ok(JSON.parse(s.elaina_open_favorites || '[]').length === 1, 'merge 不清掉备份里没有的键');
        ok(existsSync(path.join(dataDir, 'characters', 'card_z.json')), '导入的新卡落成独立文件');
    }

    // ============================================================ 7. 导入边界
    console.log('\n=== 7. 导入边界 ===');
    {
        const post = (body) => fetch(base + '/api/data/import', {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
        });

        ok((await post(JSON.stringify({ data: {} }))).status === 400, '空数据被拒绝（400）');
        ok((await post(JSON.stringify({ data: { k: 123 } }))).status === 400, '非字符串值被拒绝（400）');
        ok((await post(Buffer.from('既不是 zip 也不是 json 的一堆字节', 'utf8'))).status === 400, '非法内容被拒绝（400）');

        const s = (await (await fetch(base + '/api/store')).json()).data;
        ok(JSON.parse(s.elaina_open_character_cards || '[]').length === 3, '导入失败不影响已有数据');
    }

    // ============================================================ 8. v1 旧 JSON 备份兼容
    console.log('\n=== 8. 兼容 v1 单 JSON 旧备份 ===');
    {
        const v1 = Buffer.from(JSON.stringify({
            format: 'elainachat-backup',
            version: 1,
            data: { elaina_open_settings: JSON.stringify({ model: 'from-v1' }) },
        }), 'utf8');
        const r = await fetch(base + '/api/data/import?mode=merge', {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: v1,
        });
        const j = await r.json();
        ok(r.status === 200 && j.ok, 'v1 备份能导入', JSON.stringify(j));
        ok(j.source === 'json', '识别为 json 来源', String(j.source));
        const s = (await (await fetch(base + '/api/store')).json()).data;
        ok(JSON.parse(s.elaina_open_settings).model === 'from-v1', 'v1 备份的设置生效');
    }

    // ============================================================ 9. 落盘检查
    console.log('\n=== 9. 落盘检查（真正写到磁盘）===');
    {
        const idx = JSON.parse(await readFile(path.join(dataDir, 'characters', 'index.json'), 'utf8'));
        ok(Array.isArray(idx.order) && idx.order.length === 3, '磁盘上 index 有 3 张卡', 'got ' + (idx.order || []).length);
        ok(existsSync(path.join(dataDir, 'characters', 'card_z.json')), '磁盘上有新导入的卡');

        const vidx = JSON.parse(await readFile(path.join(dataDir, 'conversations', 'index.json'), 'utf8'));
        ok(Array.isArray(vidx.order) && vidx.order.length === 1, '磁盘上有 conversations/index.json');
        ok(existsSync(path.join(dataDir, 'conversations', vidx.order[0] + '.json')), '磁盘上有一对话一文件');

        const files = await readdir(path.join(dataDir, 'characters'));
        ok(!files.includes('card_x.json.tmp'), '没有遗留的 .tmp 临时文件');
        ok(!existsSync(path.join(dataDir, 'conversations.json')), '没有遗留的旧单文件 conversations.json');
    }
} finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：' + failures.join('、'));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
