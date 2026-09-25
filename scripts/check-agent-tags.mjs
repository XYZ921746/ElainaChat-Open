// 标签协议解耦：证明"没有 Live2D 时，标签剥离与操作分发仍然工作"。
//
// 为什么必须有这个检查：这套逻辑原先整个长在 web/live2d-video.js 里，
// 而它**是全部 [操作:] 标签的唯一分发器**（文件/命令/手机/记忆）。
// 宿主各处又都写成 `if (window.Live2DCall) { ... }` ——
// 于是"Live2D 不在"= "整个 Agent 系统失效 + 标签漏给用户看"。
// 这个检查用**故意不提供 window.Live2DCall** 的沙箱跑一遍：
// 剥离要干净、操作要照常分发、表现层缺失不许抛异常。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意 ROOT 要**上跳一级** —— 本文件在 scripts/ 下，而 web/ 在仓库根
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'web', 'js', 'agent-tags.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

// 沙箱：**故意不提供 window.Live2DCall** —— 模拟 Live2D 被卸掉
const calls = [];
const sandbox = {
    console,
    window: {
        agentActions: {
            openVideoCall: () => calls.push('openVideoCall'),
            closeVideoCall: () => calls.push('closeVideoCall'),
            organizeMemory: () => calls.push('organizeMemory'),
            agentPhoneOperation: (v) => calls.push('phone:' + v),
            agentCommandOperation: (v) => calls.push('cmd:' + v),
            agentFileOperation: (v) => calls.push('file:' + v),
        },
    },
};
sandbox.window.window = sandbox.window;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const T = sandbox.window.ElainaTags;

console.log('=== 1. 剥离：没有 Live2D 也要剥干净 ===');
{
    ok(Boolean(T), 'ElainaTags 已就绪（不依赖 Live2D）');
    const cases = [
        ['你好[表情:开心]世界', '你好世界'],
        ['[情绪:平静] 早安', '早安'],
        ['文本 [动作:跳舞] 后续', '文本  后续'],
        ['[位置:left][大小:大]说话', '说话'],
        ['[背景:深蓝]背景', '背景'],
        ['[操作:列出文件 %DESKTOP%]好的', '好的'],
        ['[任务:每天09:00 提醒我]收到', '收到'],
        ['无标签纯文本', '无标签纯文本'],
    ];
    const bad = [];
    for (const [input, want] of cases) {
        const got = T.strip(input);
        if (got !== want) bad.push(`${JSON.stringify(input)} → ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`);
    }
    ok(bad.length === 0, `全部标签都被剥掉（${cases.length} 例）`, bad.join('; '));
}

console.log('\n=== 2. 分发：没有 Live2D 也要能执行操作 ★核心 ===');
{
    T.drive('[操作:电脑命令 git status]');
    ok(calls.includes('cmd:电脑命令 git status'), '★ 电脑命令被分发（不经过 Live2D）', JSON.stringify(calls));

    T.drive('[操作:列出文件 %DESKTOP%]');
    ok(calls.includes('file:列出文件 %DESKTOP%'), '★ 文件操作被分发');

    T.drive('[操作:手机点击 500 800]');
    ok(calls.includes('phone:手机点击 500 800'), '★ 手机操作被分发');

    T.drive('[操作:整理记忆]');
    ok(calls.includes('organizeMemory'), '整理记忆被分发');

    T.drive('[操作:打开视频通话]');
    ok(calls.includes('openVideoCall'), '打开视频通话被分发');

    // ★ 顺序：电脑命令必须排在文件操作之前，否则 `git status` 里的
    //   「查看文件」类词会把命令正文吃掉
    calls.length = 0;
    T.drive('[操作:电脑命令 git status --short]');
    ok(calls.length === 1 && calls[0].startsWith('cmd:'),
        '★ 命令正文不会被文件分支误吃（顺序正确）', JSON.stringify(calls));

    // 一条回复多个操作标签
    calls.length = 0;
    T.drive('[操作:打开视频通话][操作:整理记忆]');
    ok(calls.length === 2, '一条回复里的多个操作标签都被执行', JSON.stringify(calls));
}

console.log('\n=== 3. 表现层可选：Live2D 不在也不报错 ===');
{
    let threw = null;
    try { T.drive('[表情:开心][情绪:高兴][位置:left][操作:整理记忆]'); }
    catch (e) { threw = e; }
    ok(threw === null, '★ 表现标签存在但 Live2D 缺失时不抛异常', threw && threw.message);
    ok(calls.includes('organizeMemory'), '★ 同一条回复里的操作仍然被执行（表现被跳过）');
}

console.log('\n=== 4. 表现层在场时被调用 ===');
{
    const sandbox2 = {
        console,
        window: {
            agentActions: {},
            Live2DCall: { drivePresentation: (t) => calls.push('present:' + t.slice(0, 12)) },
        },
    };
    sandbox2.window.window = sandbox2.window;
    sandbox2.globalThis = sandbox2;
    vm.createContext(sandbox2);
    vm.runInContext(src, sandbox2);
    const T2 = sandbox2.window.ElainaTags;
    calls.length = 0;
    T2.drive('[表情:开心]你好');
    ok(calls.some((c) => c.startsWith('present:')), '有 Live2D 时表现层收到文本', JSON.stringify(calls));
}

console.log('\n=== 5. 扩展处理器（水印/静音挂在宿主链上）===');
{
    const sandbox3 = { console, window: { agentActions: {} } };
    sandbox3.window.window = sandbox3.window;
    sandbox3.globalThis = sandbox3;
    vm.createContext(sandbox3);
    vm.runInContext(src, sandbox3);
    const T3 = sandbox3.window.ElainaTags;
    let wm = 0;
    T3.registerOperationHandler((v) => /水印/.test(v), () => { wm++; });
    T3.drive('[操作:隐藏水印]');
    ok(wm === 1, '注册的扩展处理器被调用', String(wm));
    // 未知操作不该炸
    let threw = null;
    try { T3.drive('[操作:完全不存在的操作]'); } catch (e) { threw = e; }
    ok(threw === null, '未知操作只 warn 不抛异常');
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
