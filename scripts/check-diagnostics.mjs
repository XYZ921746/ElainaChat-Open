// 回归检查：诊断输出（server/diagnostics.mjs）+ 多行日志落盘格式。
//
// ── 这个检查防的是什么 ──────────────────────────────────────────────────
//
// 用户的要求原话："就算不知道是什么软件也可以通过日志知道是哪里有问题、
// 软件在做什么事情"。这翻译成可测的断言就是：
//
//   ① 日志开头必须**自报家门**（这是什么软件、在干什么、怎么用）
//   ② 每条问题必须包含 **what（发生了什么）/ why（为什么）/ how（怎么办）**
//      —— 缺了 how，用户就卡在"知道坏了但不知道做什么"
//   ③ how 必须是**能照做的**（含具体命令 / 界面位置），不能是"请检查配置"
//   ④ 正常状态与故障要**分开**，不能把"默认关闭"当故障报警
//   ⑤ 不用内部标识符当句子主语（说「桌宠（pet）」而不是裸 `pet`）
//   ⑥ 多行诊断块落盘时**不能被压成一行**（压了就没法读了）
//
// 这些是文案质量约束，靠人眼盯盯不住 —— 所以写成断言。
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { banner, usage, section, checklist, techInfo, problem, summary, describePlugins, MARK, MOD_STATE_LABEL } from '../server/diagnostics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};
const freePort = () => new Promise((res, rej) => {
    const s = createNetServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 1. 横幅：必须自报家门（但要**短**）
// ============================================================
console.log('=== 1. 启动头：自报家门，且不啰嗦 ===');
{
    const t = banner({
        name: 'ElainaChat Mod', version: '9.9.9',
        tagline: '本地运行的 AI 角色聊天应用',
    });
    ok(/ElainaChat Mod v9\.9\.9/.test(t), '有软件名与版本号');
    ok(/本地运行的 AI 角色聊天应用/.test(t), '有一句话定位');
    // ★ 横幅要短：上一版在这里写了「这是什么」「现在在做什么」两大段，
    //   那是文档该干的活 —— 每次启动都要滚过去的日志里放这些纯属噪音。
    ok(t.split('\n').length <= 6, '★ 横幅足够短（≤6 行，不把日志刷屏）',
        t.split('\n').length + ' 行');
    ok(!/现在在做什么/.test(t), '★ 不再有冗长的「现在在做什么」段落');

    // 默认 tagline 必须交代**数据流向** —— 用户最关心的就是
    // "我的聊天记录和 API Key 会不会被传到别处"。
    const def = banner({ name: 'X', version: '1.0.0' });
    ok(/不经过第三方|不经过任何第三方/.test(def), '★ 默认定位交代了数据流向');
    ok(/这台电脑|本机|你自己/.test(def), '★ 默认定位交代了"跑在你自己电脑上"');
}

// ============================================================
// 1b. 「怎么用」块：要照着敲的东西单独成块
// ============================================================
console.log('\n=== 1b. 「怎么用」块 ===');
{
    const t = usage([
        { state: 'ok', label: '在这台电脑上打开', value: 'http://127.0.0.1:4173', hint: '用浏览器打开。' },
        { state: 'warn', label: '手机连进来要输这个密码', value: 'abcd1234', hint: '建议改掉。' },
    ]);
    ok(/【怎么用】/.test(t), '有「怎么用」分组标题');
    ok(/http:\/\/127\.0\.0\.1:4173/.test(t), '地址单独成行（不和说明混排）');
    ok(/abcd1234/.test(t), '密码单独成行');
    // 地址/密码必须比说明文字**更突出**：单独一行、缩进 6 格
    ok(/\n {6}http:\/\/127\.0\.0\.1:4173\n/.test(t), '★ 地址独占一行且缩进（不会被看漏）');
    ok(/\n {6}abcd1234\n/.test(t), '★ 密码独占一行且缩进');
}

// ============================================================
// 1c. 技术信息块：排查信息收在最后
// ============================================================
console.log('\n=== 1c. 技术信息块 ===');
{
    const t = techInfo([['进程号', '1234'], ['运行环境', 'Node v1.0.0'], ['空值', ''], ['未定义', undefined]]);
    ok(/【技术信息/.test(t), '有技术信息分组');
    ok(/进程号：1234/.test(t), '进程号在里面');
    ok(!/空值/.test(t) && !/未定义/.test(t), '★ 空值/未定义项被跳过（不打无意义的行）');
    ok(/复制给别人/.test(t), '★ 说明了这个块的用途（排查时整份复制）');
}

// ============================================================
// 2. 问题报告：what / why / how 三段齐全
// ============================================================
console.log('\n=== 2. 问题报告：三段式必须齐全 ===');
{
    const t = problem({
        what: '端口 4173 已被占用，服务没能启动',
        where: 'web/serve.mjs',
        why: '上一次启动的实例还开着',
        how: '关掉它，或换个端口',
    });
    ok(/端口 4173 已被占用/.test(t), 'what 在');
    ok(/原因：/.test(t), '★ why 有标签');
    ok(/怎么办：/.test(t), '★ how 有标签');
    ok(/位置：/.test(t), 'where 有标签（便于定位到文件）');
    ok(t.startsWith(MARK.bad), '以故障图标开头（可扫读）');

    // 多个方案要编号
    const multi = problem({
        what: 'X 失败', why: 'Y', how: ['方案一', '方案二', '方案三'],
    });
    ok(/任选一种/.test(multi), '多个方案时提示"任选一种"');
    ok(/1\) 方案一/.test(multi) && /3\) 方案三/.test(multi), '多个方案被编号列出');

    // 没有 how 时不该崩（但要能看出缺了）
    const bare = problem({ what: '只有标题' });
    ok(/只有标题/.test(bare), '缺 why/how 时不崩');
    ok(!/undefined|null/.test(bare), '★ 不会把 undefined/null 打进日志');
}

// ============================================================
// 3. 检查清单：状态图标语义固定
// ============================================================
console.log('\n=== 3. 检查清单：状态可扫读 ===');
{
    const t = checklist([
        { state: 'ok', label: '正常项' },
        { state: 'note', label: '正常但值得知道' },
        { state: 'warn', label: '能跑但可能不是你要的' },
        { state: 'bad', label: '坏了' },
    ], '测试');
    ok(/【测试】/.test(t), '有分组标题');
    ok(t.includes(MARK.ok) && t.includes(MARK.note) && t.includes(MARK.warn) && t.includes(MARK.bad),
        '★ 四种状态图标都出现（正常/提示/警告/故障 可区分）');
    ok(/正常项/.test(t) && /坏了/.test(t), '各项标签都在');
    // hint 要缩进在下一行，不能挤在同一行
    const withHint = checklist([{ state: 'ok', label: 'L', hint: '这是提示' }]);
    ok(/L\n\s+这是提示/.test(withHint), 'hint 换行缩进显示（不挤在标签后面）');
}

// ============================================================
// 4. 收尾：只在真有问题时出现
// ============================================================
console.log('\n=== 4. 收尾汇总 ===');
{
    // ★ 正常时必须返回**空串**：上一版无论成败都打"一切正常，服务已就绪"，
    //   和前面那句"服务已启动，可以用了"重复 —— 同一件事说两遍纯占地方。
    const clean = summary([]);
    ok(clean === '', '★ 无问题时返回空串（不重复打"一切正常"）', JSON.stringify(clean));
    ok(summary(null) === '' && summary(undefined) === '', '空/undefined 输入也不打');

    const dirty = summary(['✘ 问题甲\n  细节', '✘ 问题乙\n  细节']);
    ok(/有 2 项需要处理/.test(dirty), '★ 有 N 项要处理');
    ok(/1\. ✘ 问题甲/.test(dirty) && /2\. ✘ 问题乙/.test(dirty), '问题被编号汇总');
    ok(!/细节/.test(dirty), '汇总只取标题，不重复细节（细节上面已打过）');
    ok(/重新启动/.test(dirty), '★ 给出了收尾动作（改完要重启）');
}

// ============================================================
// 5. 插件描述：说人话
// ============================================================
console.log('\n=== 5. 插件清单描述：说人话，不用内部标识符当主语 ===');
{
    const { text, problems } = describePlugins([
        { id: 'elaina-avatar', name: '伊蕾娜立绘与情绪', state: 'ready', dir: '1111' },
        { id: 'pet', name: '桌宠', state: 'disabled', dir: 'pet' },
        { id: 'galgame', name: 'Galgame 界面', state: 'blocked', dir: 'galgame',
            error: '前置插件「elaina-avatar」未启用 —— 到「设置 → 插件」里把它的开关打开。' },
    ]);
    ok(/共 3 个/.test(text), '先给总数');
    ok(/可用 1/.test(text), '报可用数');
    ok(/未启用 1/.test(text), '报未启用数');
    ok(/有问题 1/.test(text), '报问题数');
    ok(/伊蕾娜立绘与情绪/.test(text), '★ 用显示名，不是裸 id');
    ok(/桌宠（pet）/.test(text), '★ 显示名 + id 备查（两者都有）');
    ok(/正常的/.test(text), '★ 明确说"未启用是正常的"（默认关闭不该报警）');
    ok(/设置 → 插件/.test(text), '★ 给出界面上的具体位置');
    ok(/实际装在目录 1111\//.test(text), '目录名与 id 不同时如实说明（便于排查）');
    ok(problems.length === 1, '只有真故障进 problems 列表', String(problems.length));
    ok(problems[0].includes(MARK.bad), 'problems 条目带故障图标');

    // 没有插件是正常状态，不是错误
    const empty = describePlugins([]);
    ok(empty.problems.length === 0, '★ 没有插件时不产生"问题"（那是正常状态）');
    ok(/没有安装任何插件/.test(empty.text), '如实说明"没有插件"');
    ok(/设置 → 插件|web\/mods/.test(empty.text), '给出安装插件的方法');
}

// ============================================================
// 6. 状态文案与前端一致
// ============================================================
console.log('\n=== 6. 状态文案与前端保持一致 ===');
{
    const modsJs = readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8');
    ok(/STATE_LABEL/.test(modsJs), '前端也有 STATE_LABEL（同一套状态名）');
    // 两边对同一状态的说法必须是同一句，否则对照着看会以为不是一回事
    ok(MOD_STATE_LABEL.ready.includes('已加载'), 'ready 说法一致');
    ok(MOD_STATE_LABEL.blocked.includes('拒绝加载'), 'blocked 说法一致');
    ok(MOD_STATE_LABEL.disabled.includes('未启用'), 'disabled 说法一致');
}

// ============================================================
// 7. 源码层：关键故障点确实用了结构化报告
// ============================================================
console.log('\n=== 7. 源码层：故障点用了结构化报告 ===');
{
    const serve = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');
    ok(/import \{[^}]*banner[^}]*\} from '\.\.\/server\/diagnostics\.mjs'/.test(serve),
        'serve.mjs 引入了诊断模块');
    ok(/printListenError[\s\S]{0,900}already in use/.test(serve),
        '★ 端口占用是英文事实行 + cause/fix 结构');
    // 端口占用的"怎么办"必须给出可照做的命令
    ok(/netstat -ano \| findstr/.test(serve), '★ 给了"找出占用者"的命令');
    ok(/taskkill \/PID/.test(serve), '★ 给了"结束进程"的命令');
    ok(/set PORT=/.test(serve), '★ 给了"换端口"的命令');
    // 给人的那一句中文仍在（fix 命令后面）
    ok(/端口被占用，多半是上一个实例还开着/.test(serve), '★ 保留一句中文说明（给人看）');
    ok(/banner\(\{/.test(serve), '启动时打自描述横幅');

    // ── 2026-09 二次调整：日志正文 = 英文事实行，说明文字移出日志流 ──
    //   用户明确要求："我要的是日志的详细，不是加不相干的信息" +
    //   "日志全英文（中文日志没有英文日志好用）"。
    //   启动事件现在是一行一个英文事实，引导文字只在最后保留一句中文指路。
    ok(/listening on \$\{urls\.join\(', '\)\}/.test(serve), '★ 启动事件：listening 行（英文，含全部地址）');
    ok(/\[mod\] installed: \$\{p\.id\}/.test(serve), '★ 启动事件：每个插件一行英文事实（id/dir/依赖）');
    ok(/LAN access password/.test(serve), '★ 访问密码行是英文事实行');
    ok(/就绪。日志可在应用内/.test(serve), '★ 只保留一句中文指路（软件内查看器入口）');
    // 反向：说明文字不再刷屏
    ok(!/usage\(usageItems\)/.test(serve), '★ 「怎么用」说明块已移出日志流');
    ok(!/techInfo\(\[/.test(serve), '★ 冗长的技术信息块已移除');
    ok(!/section\('插件（已安装）'\)/.test(serve), '★ 插件体检分段说明已移出（改为 [mod] 事实行）');

    // 英文事实行仍然进内存缓冲（软件内查看器的数据源）
    ok(/logBuffer\.push\(/.test(serve), '★ emitLog 把每条日志写入内存缓冲');
    ok(/api\/logs\/tail/.test(serve), '★ /api/logs/tail 接口存在（查看器数据源）');

    // ★ 多行结构必须保留（否则诊断块被压成一行，等于白做）
    ok(/function formatForFile/.test(serve), '★ 有 formatForFile（区分单行/多行）');
    ok(/if \(!safe\.includes\('\\n'\)\) return head \+ safe/.test(serve),
        '单行仍是一行一条（grep 可用）');
    ok(/const rest = lines\.slice\(1\)/.test(serve),
        '★ 多行保留换行（诊断块不被压扁）');
    // 旧的无条件压平必须已经消失
    ok(!/const flat = body\.replace\(\/\\s\*\\n\\s\*\/g, ' ⏎ '\)/.test(serve),
        '★ 旧的"无条件压平换行"已移除');
}

// ============================================================
// 8. 端到端：真的跑一次服务，检查落盘日志
// ============================================================
console.log('\n=== 8. 端到端：真实服务 + 真实落盘日志 ===');
{
    const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-diag-'));
    const PORT = await freePort();
    const HTTPS_PORT = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT),
            HOST: '127.0.0.1', LOG_DIR, DATA_DIR: path.join(LOG_DIR, 'data'),
            LOG_TO_FILE: '1', LOG_CHAT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    try {
        let up = false;
        for (let i = 0; i < 80 && !up; i++) {
            try { up = (await fetch(`http://127.0.0.1:${PORT}/api/server-info`)).ok; } catch { await wait(250); }
        }
        ok(up, '服务已启动', up ? '' : out.slice(-300));
        await wait(600);   // 让启动日志写完

        const logs = readdirSync(LOG_DIR).filter((n) => n.endsWith('.log') && !n.includes('trace'));
        ok(logs.length > 0, '产生了主日志文件', JSON.stringify(readdirSync(LOG_DIR)));
        if (logs.length) {
            const content = readFileSync(path.join(LOG_DIR, logs[0]), 'utf8');
            // ① 编码正确
            ok(!content.includes('\uFFFD'), '★ 日志文件是合法 UTF-8（没有替换字符）');
            // ② 英文事实行（2026-09 起）
            ok(/ElainaChat Mod v/.test(content), '★ 有软件名与版本');
            ok(/local AI chat server/.test(content), '★ 横幅是一行英文定位（含 pid/node/平台）');
            ok(/listening on http:\/\//.test(content), '★ listening 行（英文事实）');
            ok(/installed: .*\(dir=/.test(content), '★ 插件清单是英文事实行');
            // ③ 多行结构保留（关键：没被压成一行）
            ok(!/⏎/.test(content), '★ 没有出现压平标记 ⏎');
            // ④ 冗长说明不再刷屏
            ok(!/怎么用/.test(content), '★ 说明文字不再进日志流');
            ok(!/技术信息/.test(content), '★ 冗长技术信息块已移除');
            ok(!/现在在做什么/.test(content), '★ 没有冗长段落');
            // ⑤ 行首前缀仍完整（grep 可用）
            const withPrefix = content.split('\n').filter((l) => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[/.test(l));
            ok(withPrefix.length >= 3, '★ 多条记录带完整前缀（grep 仍可用）', String(withPrefix.length));
        }
    } finally {
        child.kill();
        await wait(300);
        try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
