// 回归检查：data/ 分类存储（人设卡与聊天记录都是一条一文件）+ zip 备份。
//
// 为什么需要：存储层一旦出错就是**用户数据丢失**（聊天记录 / 人设卡 / 记忆）。
// 这个检查用临时目录跑真实的读写，覆盖：
//   · 分类落盘（人设卡一卡一文件、聊天记录一对话一文件、记忆独立文件）
//   · 读回时拼成前端认识的键值形态
//   · 从旧的单文件 store.json / 旧的单文件 conversations.json 自动迁移（幂等）
//   · zip 备份导出 → 导入往返一致（含 v1 单 JSON 旧备份的兼容）
//   · 坏数据不导致崩溃、不覆盖好数据
//
// 用法：node scripts/check-store-layout.mjs

import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.mjs';
import { readZip } from '../server/zip.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label, detail) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

const KEY_CARDS = 'elaina_open_character_cards';
const KEY_CURRENT = 'elaina_open_current_card';
const KEY_CONV = 'elaina_open_conversations';
const KEY_MEM = 'elaina_open_memory_core';
const KEY_SETTINGS = 'elaina_open_settings';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'elaina-store-'));
let tmp2 = null;
const logs = [];
const mk = () => createStore({ dataDir: tmp, log: (lvl, msg) => logs.push(lvl + ':' + msg) });

try {
    // ================================================================ 1. 全新写入
    console.log('=== 1. 全新写入（一条一文件）===');
    {
        const store = mk();
        const s = await store.loadStore();
        ok(Object.keys(s).length === 0, '空目录 → 空 store');

        const cards = [
            { id: 'card_a', name: '伊蕾娜', title: '灰之魔女' },
            { id: 'card_b', name: '深海', title: '鲛人' },
        ];
        const convs = [
            { id: 'conv_1', title: '第一个对话', messages: [{ role: 'user', text: '你好' }] },
            { id: 'conv_2', title: '第二个对话', messages: [] },
        ];
        s[KEY_CARDS] = JSON.stringify(cards);
        s[KEY_CURRENT] = 'card_a';
        s[KEY_CONV] = JSON.stringify(convs);
        s[KEY_MEM] = JSON.stringify({ diary: [{ date: '2026-09-22', content: '测试' }] });
        s[KEY_SETTINGS] = JSON.stringify({ model: 'x' });
        await store.saveStore();

        ok(existsSync(path.join(tmp, 'characters', 'card_a.json')), '人设卡一卡一文件（card_a）');
        ok(existsSync(path.join(tmp, 'characters', 'card_b.json')), '人设卡一卡一文件（card_b）');
        ok(existsSync(path.join(tmp, 'characters', 'index.json')), '生成 characters/index.json');
        ok(existsSync(path.join(tmp, 'conversations', 'conv_1.json')), '聊天记录一对话一文件（conv_1）');
        ok(existsSync(path.join(tmp, 'conversations', 'conv_2.json')), '聊天记录一对话一文件（conv_2）');
        ok(existsSync(path.join(tmp, 'conversations', 'index.json')), '生成 conversations/index.json');
        ok(existsSync(path.join(tmp, 'memory', 'diary.json')), '记忆按类目拆成 memory/diary.json');
        ok(!existsSync(path.join(tmp, 'memory.json')), '不再有旧的单文件 memory.json');
        ok(!existsSync(path.join(tmp, 'conversations.json')), '不再有旧的单文件 conversations.json');

        const misc = JSON.parse(await readFile(path.join(tmp, 'store.json'), 'utf8'));
        ok(misc[KEY_SETTINGS] !== undefined, 'store.json 保留设置键');
        ok(misc[KEY_CARDS] === undefined, 'store.json 不再含人设卡');
        ok(misc[KEY_CONV] === undefined, 'store.json 不再含聊天记录');
        ok(misc[KEY_MEM] === undefined, 'store.json 不再含记忆');

        const cidx = JSON.parse(await readFile(path.join(tmp, 'characters', 'index.json'), 'utf8'));
        ok(cidx.currentCardId === 'card_a', 'index 记录当前选中卡片');
        ok(cidx.order.join(',') === 'card_a,card_b', 'index 记录卡片顺序');
        const vidx = JSON.parse(await readFile(path.join(tmp, 'conversations', 'index.json'), 'utf8'));
        ok(vidx.order.join(',') === 'conv_1,conv_2', 'index 记录对话顺序');
    }

    // ================================================================ 2. 读回
    console.log('\n=== 2. 读回（拼成前端认识的形态）===');
    {
        const store = mk();
        const s = await store.loadStore();
        const cards = JSON.parse(s[KEY_CARDS] || '[]');
        ok(cards.length === 2, '人设卡拼回数组（2 张）', 'got ' + cards.length);
        ok(cards[0].id === 'card_a' && cards[0].name === '伊蕾娜', '卡片内容完整');
        ok(s[KEY_CURRENT] === 'card_a', '当前卡片 id 读回');
        const convs = JSON.parse(s[KEY_CONV] || '[]');
        ok(convs.length === 2, '聊天记录拼回数组（2 个）', 'got ' + convs.length);
        ok(convs[0].messages[0].text === '你好', '对话消息完整');
        ok(JSON.parse(s[KEY_MEM] || '{}').diary.length === 1, '记忆读回');
        ok(JSON.parse(s[KEY_SETTINGS] || '{}').model === 'x', '设置读回');
    }

    // ================================================================ 3. 删除条目
    console.log('\n=== 3. 删除条目（残留文件要清掉）===');
    {
        const store = mk();
        const s = await store.loadStore();
        s[KEY_CARDS] = JSON.stringify([{ id: 'card_a', name: '伊蕾娜' }]);
        s[KEY_CONV] = JSON.stringify([{ id: 'conv_2', title: '留着的' }]);
        await store.saveStore();
        const cFiles = (await readdir(path.join(tmp, 'characters'))).filter((f) => f.endsWith('.json'));
        const vFiles = (await readdir(path.join(tmp, 'conversations'))).filter((f) => f.endsWith('.json'));
        ok(!cFiles.includes('card_b.json'), '删掉的卡片文件被清理');
        ok(cFiles.includes('card_a.json'), '保留的卡片文件还在');
        ok(!vFiles.includes('conv_1.json'), '删掉的对话文件被清理');
        ok(vFiles.includes('conv_2.json'), '保留的对话文件还在');
    }

    // ================================================================ 4. 坏数据
    console.log('\n=== 4. 坏数据不崩、不覆盖 ===');
    {
        const store = mk();
        const s = await store.loadStore();
        s[KEY_CARDS] = '这不是 JSON';
        const before = await readFile(path.join(tmp, 'characters', 'card_a.json'), 'utf8');
        await store.saveStore();
        const after = await readFile(path.join(tmp, 'characters', 'card_a.json'), 'utf8');
        ok(before === after, '非法 JSON 不破坏已有人设卡文件');

        const store2 = mk();
        const s2 = await store2.loadStore();
        s2[KEY_CARDS] = JSON.stringify([{ id: '../../evil', name: 'x' }]);
        await store2.saveStore();
        ok(!existsSync(path.join(tmp, '..', 'evil.json')), '非法 id 不会写到目录外');
    }

    // ================================================================ 5. 迁移
    console.log('\n=== 5. 从旧的单文件布局迁移 ===');
    tmp2 = await mkdtemp(path.join(os.tmpdir(), 'elaina-migrate-'));
    {
        const legacyCards = [{ id: 'old_1', name: '旧卡一' }, { id: 'old_2', name: '旧卡二' }];
        await writeFile(path.join(tmp2, 'store.json'), JSON.stringify({
            [KEY_CARDS]: JSON.stringify(legacyCards),
            [KEY_CURRENT]: 'old_2',
            [KEY_MEM]: JSON.stringify({ diary: [] }),
            [KEY_SETTINGS]: JSON.stringify({ model: 'legacy' }),
        }), 'utf8');
        // 旧版把聊天记录放在单个 conversations.json（{version,value} 形态）
        await writeFile(path.join(tmp2, 'conversations.json'), JSON.stringify({
            version: 1,
            value: JSON.stringify([{ id: 'oldconv', title: '旧对话', messages: [] }]),
        }), 'utf8');

        const store = createStore({ dataDir: tmp2, log: (lvl, msg) => logs.push(lvl + ':' + msg) });
        const moved = await store.migrateIfNeeded();
        ok(moved.length > 0, '检测到旧数据并迁移', 'moved=' + JSON.stringify(moved));
        ok(existsSync(path.join(tmp2, 'characters', 'old_1.json')), '旧卡迁移成独立文件');
        ok(existsSync(path.join(tmp2, 'conversations', 'oldconv.json')), '旧单文件聊天记录拆成一对话一文件');
        ok(!existsSync(path.join(tmp2, 'conversations.json')), '旧的单文件 conversations.json 已删除');
        ok(existsSync(path.join(tmp2, 'memory', 'diary.json')), '旧记忆迁移成 memory/<类目>.json');

        const misc = JSON.parse(await readFile(path.join(tmp2, 'store.json'), 'utf8'));
        ok(misc[KEY_SETTINGS] !== undefined, '迁移后 store.json 保留设置');
        ok(misc[KEY_CARDS] === undefined, '迁移后 store.json 不再含人设卡');

        const store2 = createStore({ dataDir: tmp2 });
        const s = await store2.loadStore();
        ok(JSON.parse(s[KEY_CARDS] || '[]').length === 2, '迁移后卡片数量正确');
        ok(s[KEY_CURRENT] === 'old_2', '迁移后当前卡片 id 正确');
        ok(JSON.parse(s[KEY_CONV] || '[]')[0].id === 'oldconv', '迁移后聊天记录正确');
    }

    // ================================================================ 6. 幂等
    console.log('\n=== 6. 迁移幂等 ===');
    {
        const store = createStore({ dataDir: tmp2 });
        const moved2 = await store.migrateIfNeeded();
        ok(moved2.length === 0, '第二次启动不再迁移', 'moved=' + JSON.stringify(moved2));

        const s = await store.loadStore();
        const cards = JSON.parse(s[KEY_CARDS]);
        cards[0].name = '改过的名字';
        s[KEY_CARDS] = JSON.stringify(cards);
        await store.saveStore();

        const store3 = createStore({ dataDir: tmp2 });
        await store3.migrateIfNeeded();
        const s3 = await store3.loadStore();
        ok(JSON.parse(s3[KEY_CARDS])[0].name === '改过的名字', '迁移不会覆盖已更新的数据');
    }

    // ================================================================ 6b. 遗留旧文件的清理
    // 真实故障：上一次迁移已把对话拆进 conversations/，但旧的单文件 conversations.json
    // 因为"moved 为空就跳过删除"的逻辑**永久留在了磁盘上**。
    // 它不会被读取（loadStore 只认 conversations/），也不会被清理，白占空间还让人困惑。
    console.log('\n=== 6b. 清理遗留的旧单文件 conversations.json ===');
    {
        const tmpLegacy = await mkdtemp(path.join(os.tmpdir(), 'elaina-legacy-'));
        // 造出"已经拆好"的状态：conversations/ 有内容，同时旧的单文件还在
        await writeFile(path.join(tmpLegacy, 'store.json'), JSON.stringify({
            [KEY_SETTINGS]: JSON.stringify({ model: 'x' }),
        }), 'utf8');
        const seed = createStore({ dataDir: tmpLegacy });
        const s = await seed.loadStore();
        s[KEY_CONV] = JSON.stringify([{ id: 'kept_conv', title: '已在目录里的对话', messages: [] }]);
        await seed.saveStore();
        ok(existsSync(path.join(tmpLegacy, 'conversations', 'kept_conv.json')), '（准备）对话已拆进目录');
        // 再手工放一个遗留的旧单文件（内容与目录里不同，模拟"上次没删掉"）
        await writeFile(path.join(tmpLegacy, 'conversations.json'), JSON.stringify({
            version: 1,
            value: JSON.stringify([{ id: 'stale_conv', title: '遗留的旧数据' }]),
        }), 'utf8');
        ok(existsSync(path.join(tmpLegacy, 'conversations.json')), '（准备）旧单文件存在');

        // 启动一次：应该清理掉旧文件，且**不能**把 stale_conv 也导进去
        const store = createStore({ dataDir: tmpLegacy });
        const moved = await store.migrateIfNeeded();
        ok(moved.length === 0, '已拆好的状态不触发迁移（moved 为空）', JSON.stringify(moved));
        ok(!existsSync(path.join(tmpLegacy, 'conversations.json')), '遗留的旧单文件被清理掉');

        const s2 = await store.loadStore();
        const convs = JSON.parse(s2[KEY_CONV] || '[]');
        ok(convs.length === 1 && convs[0].id === 'kept_conv', '目录里的对话没被旧文件覆盖', JSON.stringify(convs.map((c) => c.id)));

        // 反向：目录为空时**绝不能**删旧文件（那是唯一的数据来源）
        const tmpOnlyLegacy = await mkdtemp(path.join(os.tmpdir(), 'elaina-only-'));
        await writeFile(path.join(tmpOnlyLegacy, 'conversations.json'), JSON.stringify({
            version: 1,
            value: JSON.stringify([{ id: 'only_source', messages: [] }]),
        }), 'utf8');
        const store2 = createStore({ dataDir: tmpOnlyLegacy });
        await store2.migrateIfNeeded();
        ok(existsSync(path.join(tmpOnlyLegacy, 'conversations', 'only_source.json')), '唯一数据来源被正确迁移');
        const s3 = await store2.loadStore();
        ok(JSON.parse(s3[KEY_CONV] || '[]').length === 1, '迁移后能读到');

        await rm(tmpLegacy, { recursive: true, force: true });
        await rm(tmpOnlyLegacy, { recursive: true, force: true });
    }

    // ================================================================ 7. zip 导出
    console.log('\n=== 7. zip 备份导出 ===');
    let zipBuf = null;
    {
        const store = createStore({ dataDir: tmp2 });
        zipBuf = await store.exportZip();
        ok(Buffer.isBuffer(zipBuf) && zipBuf.length > 0, '导出了 zip');
        ok(zipBuf.readUInt32LE(0) === 0x04034b50, '是合法 zip（PK 头）');

        const files = readZip(zipBuf);
        const names = files.map((f) => f.name);
        ok(names.includes('manifest.json'), 'zip 里有 manifest.json');
        ok(names.includes('settings.json'), 'zip 里有 settings.json');
        ok(names.includes('characters/index.json'), 'zip 里有 characters/index.json');
        ok(names.some((n) => /^characters\/old_\d\.json$/.test(n)), 'zip 里有一卡一文件');
        ok(names.includes('conversations/index.json'), 'zip 里有 conversations/index.json');
        ok(names.some((n) => n === 'conversations/oldconv.json'), 'zip 里有一对话一文件');
        ok(names.some((n) => /^memory\/[A-Za-z0-9_-]+\.json$/.test(n)), 'zip 里有 memory/<类目>.json');

        const manifest = JSON.parse(files.find((f) => f.name === 'manifest.json').data.toString('utf8'));
        ok(manifest.format === 'elainachat-backup', 'manifest 格式标识正确');
        ok(manifest.version === 2, 'manifest 版本为 2（zip）', 'got ' + manifest.version);
        ok(typeof manifest.exportedAt === 'string', 'manifest 含导出时间');
        ok(manifest.counts.characters === 2, 'manifest 统计人设卡数', JSON.stringify(manifest.counts));

        // 单卡内容要能在 zip 里直接读到。
        // 注意：第 6 步（幂等检查）把 old_1 的名字改成了"改过的名字"，
        // 所以这里断言的是改后的值 —— 顺带证明导出读的是**当前**数据而不是旧快照。
        const cardFile = files.find((f) => f.name === 'characters/old_1.json');
        const card = JSON.parse(cardFile.data.toString('utf8'));
        ok(card.name === '改过的名字', 'zip 里单卡内容是最新的', 'got ' + card.name);
    }

    // ================================================================ 8. zip 导入
    console.log('\n=== 8. zip 导入往返 ===');
    {
        const tmp3 = await mkdtemp(path.join(os.tmpdir(), 'elaina-import-'));
        const store = createStore({ dataDir: tmp3 });
        const res = await store.importBackup(zipBuf, 'merge');
        ok(res.ok, 'zip 导入成功', JSON.stringify(res));
        ok(res.source === 'zip', '识别为 zip 来源');
        ok(res.keys > 0, '导入统计了键数', 'keys=' + res.keys);

        const s = await store.loadStore();
        ok(JSON.parse(s[KEY_CARDS] || '[]').length === 2, '导入后人设卡完整');
        ok(s[KEY_CURRENT] === 'old_2', '导入后当前卡片正确');
        ok(JSON.parse(s[KEY_CONV] || '[]')[0].id === 'oldconv', '导入后聊天记录完整');
        ok(existsSync(path.join(tmp3, 'characters', 'old_1.json')), '导入后落成一卡一文件');
        ok(existsSync(path.join(tmp3, 'conversations', 'oldconv.json')), '导入后落成一对话一文件');

        // merge 不清掉本机已有的其它键
        const store2 = createStore({ dataDir: tmp3 });
        const s2 = await store2.loadStore();
        s2['custom_key'] = JSON.stringify({ mine: true });
        await store2.saveStore();
        await store2.importBackup(zipBuf, 'merge');
        const s3 = await store2.loadStore();
        ok(s3['custom_key'] !== undefined, 'merge 模式保留本机独有键');

        await rm(tmp3, { recursive: true, force: true });
    }

    // ================================================================ 9. 旧 JSON 备份兼容
    console.log('\n=== 9. 兼容 v1 单 JSON 旧备份 ===');
    {
        const tmp4 = await mkdtemp(path.join(os.tmpdir(), 'elaina-v1-'));
        const store = createStore({ dataDir: tmp4 });
        const v1 = Buffer.from(JSON.stringify({
            format: 'elainachat-backup',
            version: 1,
            data: {
                [KEY_CARDS]: JSON.stringify([{ id: 'v1_card', name: '旧备份的卡' }]),
                [KEY_SETTINGS]: JSON.stringify({ model: 'v1' }),
            },
        }), 'utf8');
        const res = await store.importBackup(v1, 'merge');
        ok(res.ok, 'v1 JSON 备份能导入', JSON.stringify(res));
        ok(res.source === 'json', '识别为 json 来源');
        const s = await store.loadStore();
        ok(JSON.parse(s[KEY_CARDS] || '[]')[0].id === 'v1_card', 'v1 备份的人设卡导入成功');
        ok(JSON.parse(s[KEY_SETTINGS]).model === 'v1', 'v1 备份的设置导入成功');
        await rm(tmp4, { recursive: true, force: true });
    }

    // ================================================================ 10. 导入边界
    console.log('\n=== 10. 导入边界 ===');
    {
        const tmp5 = await mkdtemp(path.join(os.tmpdir(), 'elaina-edge-'));
        const store = createStore({ dataDir: tmp5 });
        let threw = false;
        try { await store.importBackup(Buffer.from('这不是 zip 也不是 json', 'utf8')); } catch { threw = true; }
        ok(threw, '非法内容被拒绝');

        const r1 = await store.importBackup(Buffer.from(JSON.stringify({ data: {} }), 'utf8'));
        ok(!r1.ok, '空数据被拒绝');
        const r2 = await store.importBackup(Buffer.from(JSON.stringify({ data: { k: 123 } }), 'utf8'));
        ok(!r2.ok, '非字符串值被拒绝（与 localStorage 语义一致）');
        await rm(tmp5, { recursive: true, force: true });
    }
} finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (tmp2) await rm(tmp2, { recursive: true, force: true }).catch(() => {});
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：' + failures.join('、'));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
