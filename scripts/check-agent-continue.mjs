/**
 * 回归检查：Agent 操作完成后自动续跑（不用用户手动说"继续"）。
 *
 * 背景（真实故障）：AI 读取/写入文件后就不动了，必须用户打一句"继续"才走下一步。
 *
 * 根因是一个**不对称**：
 *   · 失败路径 explainAgentFailure() 会调 callAI() —— AI 能自己解释并重试；
 *   · 成功路径只 insertAgentResult() 把结果塞进对话，**从不调 callAI()** ——
 *     AI 看不到"我刚做完的事"，自然不会有下一步。
 *
 * 日志铁证：执行完 `[操作:保存文件 D:\桌面\测试.txt|测试文件]` 之后，
 * 下一次请求的末条消息是 **user（244 字）**，也就是用户手动打的那句"继续"。
 *
 * 这个修复有三个容易写错的地方，本检查逐条锁住：
 *   1. **死循环**：续跑到上限时若用 insertAgentResult 插提示，会再次触发续跑 →
 *      又到上限 → 无限循环。（实现时先踩了一次。）
 *   2. **预算不重置**：不重置就是"整个页面会话共享 8 步"，用完后永远不再续跑，
 *      表现为"第一次能用、后面又不动了"——比原 bug 更难查。
 *   3. **提前收尾**：drive() 里的操作是异步的，若靠"等一下看定时器"判断有没有后续，
 *      会误判成"AI 已收尾"而提前 endRun，把多步任务腰斩。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'web', 'index.html'), 'utf8');

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond) { pass++; return; }
    failures.push(label + (extra ? `\n      ${extra}` : ''));
}

/** 按函数名抠出函数体 */
function extractFn(name) {
    let start = html.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('找不到函数: ' + name + '（重命名了？请同步更新本检查）');
    const am = html.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (am) start -= am[0].length;
    let i = html.indexOf('(', start);
    let paren = 0;
    for (; i < html.length; i++) {
        if (html[i] === '(') paren++;
        else if (html[i] === ')') { paren--; if (paren === 0) { i++; break; } }
    }
    let d = 0;
    i = html.indexOf('{', i);
    for (; i < html.length; i++) {
        const c = html[i];
        if (c === '{') d++;
        else if (c === '}') { d--; if (d === 0) { i++; break; } }
    }
    return html.slice(start, i);
}

// ---------- 一、成功路径必须触发续跑 ----------
console.log('\n— 成功路径触发续跑 —');
const insertFn = extractFn('insertAgentResult');
ok(/options\.continueLoop === true/.test(insertFn),
    'insertAgentResult 默认**不**续跑，只有显式 continueLoop:true 才续跑');
ok(/scheduleAgentContinue\(\)/.test(insertFn),
    'insertAgentResult 里确实会触发续跑（这是原 bug 的修复点）');

// 这个函数是 18 处调用的公共收口，其中大多数是「无权限 / 未启用 / 用户取消」这类
// **被拒绝**的结果。它们若也触发续跑，就变成"被拒绝 → 续跑 → 又试 → 又被拒绝"的
// 无效循环，用户看到 AI 对着做不到的事反复尝试。所以必须是"选择加入"而非"选择退出"。
// 统计**真实调用**（排除注释行与函数定义里的说明）
const continueCallSites = html.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .filter((l) => /insertAgentResult\(.*continueLoop: true/.test(l))
    .length;
ok(continueCallSites === 2,
    '只有"真的做完了"的两处开启续跑（文件成功 + 手机成功）',
    `实际 ${continueCallSites} 处`);
ok(/insertAgentResult\(resultText, \{ continueLoop: true \}\)/.test(html),
    '文件操作成功处开启续跑');
ok(/insertAgentResult\(await execPhoneOperation\(parsed\), \{ continueLoop: true \}\)/.test(html),
    '手机操作成功处开启续跑');
// 被拒绝/失败类的结果**不能**开启续跑
ok(!/已跳过[^)]*continueLoop: true/.test(html), '「已跳过」类结果不续跑');
ok(!/已取消写入[^)]*continueLoop: true/.test(html), '「已取消写入」不续跑');
ok(!/操作失败[^)]*continueLoop: true/.test(html), '失败说明不续跑');

// ---------- 二、死循环防护 ----------
//
// 最关键的回归项：达到上限时插入的提示**不能**再触发续跑。
console.log('\n— 死循环防护 —');
const loopFn = extractFn('continueAgentLoop');
ok(/AGENT_CONTINUE_MAX_STEPS/.test(loopFn), '续跑有步数上限');
// 默认就是"不续跑"，所以上限提示无需显式传参也不会递归 ——
// 但仍要确认上限分支里没有误开续跑。
const capBlock = loopFn.match(/if \(agentContinueUsed >= AGENT_CONTINUE_MAX_STEPS\)[\s\S]*?\n {8}\}/);
ok(!!capBlock, '找得到上限分支');
ok(!!capBlock && !/continueLoop: true/.test(capBlock[0]),
    '达到上限时的提示不开启续跑（否则"到上限→插提示→又调度→再到上限"无限循环）');
ok(!!capBlock && /\breturn;/.test(capBlock[0]),
    '达到上限后立即 return（不再发起请求）');
ok(!!capBlock && /rt\.endRun\(\)/.test(capBlock[0]),
    '达到上限时收起运行状态条（否则状态条会一直挂着）');

// ---------- 三、预算必须按"用户请求"重置 ----------
console.log('\n— 预算重置 —');
const resetFn = extractFn('resetAgentContinueBudget');
ok(/agentContinueUsed = 0/.test(resetFn), '重置函数把已用步数归零');
ok(/clearTimeout\(agentContinueTimer\)/.test(resetFn), '重置时也清掉待触发的续跑定时器');
// 调用点必须在 handleUserInput 里
const handleFn = extractFn('handleUserInput');
ok(/resetAgentContinueBudget\(\)/.test(handleFn),
    '每条新的用户消息都重置预算（否则整个会话共享 8 步，用完永远不再续跑）');

// ---------- 四、不能提前收尾 ----------
console.log('\n— 不提前收尾 —');
ok(/const hasMoreOps = \/\\\[操作\[:：\]\/\.test/.test(loopFn),
    '用**同步**判断回复里有没有操作标签（drive() 是异步的，靠定时器判断会误判）');
// 有后续操作时先 drive() 再 return；注释可能夹在中间，所以放宽匹配范围
ok(/if \(hasMoreOps[\s\S]{0,300}?drive\(raw \|\| ''\);[\s\S]{0,80}?return;/.test(loopFn),
    '有后续操作时 return，交给下一轮 insertAgentResult 接力');
ok(/rt\.endRun\(\);\s*\n\s*\}/.test(loopFn),
    '没有操作标签时才 endRun（AI 认为任务完成）');

// ---------- 五、停止必须能拦住续跑 ----------
console.log('\n— 停止优先 —');
const haltedChecks = (loopFn.match(/isHalted\(\)\) return;/g) || []).length;
ok(haltedChecks >= 2,
    '续跑前后都检查 isHalted（用户按停止后绝不能再自动往下走）', `实际检查 ${haltedChecks} 次`);
ok(/rt\.isHalted/.test(loopFn), '续跑入口就检查停止标志');

// ---------- 六、授权记忆不被续跑清空 ----------
//
// beginRun() 会 approvedThisRun.clear()，无条件调用会让
//「同一次运行内允许过就不再问」在每次续跑时失效（用户点了允许，下一步又问）。
console.log('\n— 授权记忆 —');
ok(/if \(!rt\.isRunning\(\)\) rt\.beginRun\(\)/.test(loopFn),
    '只在未运行时 beginRun（无条件调用会清空"本次已授权"，导致反复弹确认）');

// ---------- 七、续跑提示词要说清"做完了就别再发标签" ----------
//
// 否则模型会为了"继续"而没完没了地发操作标签，撞到上限才停。
console.log('\n— 续跑提示词 —');
// 提示词常量是**多行字符串拼接**，末尾才是 `;` —— 非贪婪匹配会在第一个 `;` 处截断。
// 另外文件是 **CRLF** 行尾（Windows 上 git 检出的结果），所以不能用 `;\n` 收尾，
// 必须容忍 `\r`。这里统一用 `;\r?\n`。
const promptMatch = html.match(/const AGENT_CONTINUE_PROMPT = ([\s\S]*?;\r?\n)/);
ok(!!promptMatch, '找得到 AGENT_CONTINUE_PROMPT');
if (promptMatch) {
    const p = promptMatch[1];
    ok(/不要再输出任何操作标签|不要再输出/.test(p),
        '提示词要求"任务完成就别再发标签"（否则会一直撞上限）');
    ok(/失败|不支持/.test(p), '提示词要求遇到失败/不支持时换方式而非重复');
    ok(/不要提及/.test(p), '提示词要求不要暴露"系统通知/标签"这类内部词');
}

// ---------- 八、失败路径的既有重试机制必须保留 ----------
//
// 修复成功路径时不要顺手把失败路径的重试删掉 —— 那是另一个独立机制。
console.log('\n— 失败路径不受影响 —');
ok(/AGENT_FAILURE_MAX_RETRY/.test(html), '失败重试预算仍在');
ok(/explainAgentFailure/.test(html), 'explainAgentFailure 仍在');
const failFn = extractFn('explainAgentFailure');
ok(/callAI\(prompt\)/.test(failFn), '失败路径仍然会调 callAI（AI 自己解释+纠正）');

// ---------- 九、续跑产出的回复必须真的显示出来 ----------
//
// 真实故障：AI 完成后对话里**没有出现回复内容**，得再发一句话才能看见上次的回复。
//
// 根因：续跑路径自己拼了一套"存消息 + 渲染"，但漏了 handleUserInput 的
// commitAiMessageOnce 做过的几件事，尤其是 removeThinkingMessage() ——
// "伊蕾娜正在想…"气泡一直挂着，新回复被压在它下面，看起来就像 AI 没回。
console.log('\n— 续跑回复要真的显示 —');
ok(/removeThinkingMessage\(\)/.test(loopFn),
    '续跑渲染前移除"正在想"气泡（不移除会一直挂着，回复看起来没出现）');
ok(/state\.currentConversationId === conv\.id && !state\.notesMode && !state\.diaryMode/.test(loopFn),
    '渲染前判当前会话与 notes/diary 模式（与 commitAiMessageOnce 一致）');
ok(/!document\.getElementById\(`msg-\$\{aiMessage\.id\}`\)/.test(loopFn),
    '渲染前防重复插入同一节点（幂等）');
ok(/state\.voiceState = 'idle'/.test(loopFn), '续跑后把语音状态复位');
ok(/updateUI\(\)/.test(loopFn), '续跑后刷新 UI');

// ---------- 十、同源接口不能用"设备层"出口 ----------
//
// 真实故障：写文件永远失败，日志里是
//   `[Relay] [WARN] 目标地址无效：/api/agent/write`
//
// postJsonFromDevice 是给**外部服务商**用的（会走 /api/relay 绕 CORS），
// 而 /api/agent/write 是**同源本地接口** —— 把相对路径交给中转，
// 中转的 new URL() 解析失败。而 ls / read 走的是同源 fetch 所以正常，
// 表现为"读取能用、写入不行"，非常有迷惑性。
console.log('\n— 同源接口出口 —');
const fileFn = extractFn('doAgentFile');
ok(!/postJsonFromDevice\(\s*['"`]\/api\//.test(fileFn),
    'doAgentFile 不用 postJsonFromDevice 打同源 /api/ 接口（会当中转目标 → 地址无效）');
ok(/fetch\('\/api\/agent\/write'/.test(fileFn),
    '写文件走同源 fetch');
ok(/fetch\(`\/api\/agent\/\$\{action\}/.test(fileFn),
    '读/列目录也走同源 fetch（两边保持一致）');
// 全局扫一遍：任何 postJsonFromDevice / getJsonFromDevice 都不该拿相对路径当目标
const relativeDeviceCalls = html.split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .filter((l) => /(?:post|get)JsonFromDevice\(\s*['"`]\/api\//.test(l));
ok(relativeDeviceCalls.length === 0,
    '全项目没有"用设备层出口打同源 /api/ 接口"的写法',
    relativeDeviceCalls.join('\n      '));

// ---------- 十一、用户消息不得绕过 AI 直接触发操作 ----------
//
// 真实问题：`handleUserInput` 在把消息发给 AI **之前**先跑 maybeAutoFileWrite()，
// 命中「写入/保存 + 文件/盘/D:\/.txt」就直接执行 —— 用户打的字本身就是触发源。
// 三个后果：绕过 AI（它全程不知情）、正则误伤（聊到 D:\ 就可能被当指令）、
// 与授权脱节（写文件弹确认框、读目录却不弹，用户感觉"我就说句话它怎么动了"）。
//
// 现在一律交给 AI 判断要不要输出 [操作:…]。
console.log('\n— 用户消息不绕过 AI —');
const handleUserInputFn = extractFn('handleUserInput');
ok(!/maybeAutoFileWrite\(/.test(handleUserInputFn),
    'handleUserInput 不再调用 maybeAutoFileWrite（用户消息不直接触发文件操作）');
// 函数本体也必须删掉，否则留着一个"看起来能用"的入口，将来很容易被重新接上
const activeCode = html.split('\n').filter((l) => !l.trim().startsWith('//'));
ok(!activeCode.some((l) => /function maybeAutoFileWrite/.test(l)),
    'maybeAutoFileWrite 定义已删除（不是只断开调用）');
ok(!activeCode.some((l) => /function parseFileWriteIntent/.test(l)),
    'parseFileWriteIntent 定义已删除');
ok(!activeCode.some((l) => /let pendingAutoWrite|pendingAutoWrite =/.test(l)),
    'pendingAutoWrite 已删除（否则 commitAiMessageOnce 里那段是永不可达的死分支）');
// 表情触发保留：它只驱动 Live2D，不碰文件与系统，风险等级完全不同
ok(/maybeAutoExpression\(/.test(handleUserInputFn),
    'maybeAutoExpression 保留（只驱动 Live2D 表情，不碰文件系统）');

console.log(`\nAgent 自动续跑检查：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
}
