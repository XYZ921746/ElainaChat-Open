/**
 * 回归检查：发给服务商之前，开头连续的 system 消息必须被合并成一条。
 *
 * 背景（真实故障）：某些自建/中转网关**只接受一条 system 消息**。实测
 * `developer.amd.com.cn` 的 `self-dploy` 后端：
 *   [system, user]          → 200
 *   [system, system, user]  → 400 "System message must be at the beginning."
 * 报错文案有误导性 —— 它说的其实是"system 消息只能有一条，不能有第二条"。
 *
 * 而本应用的 layered-v2 提示词结构一次会发 4~10 条 system（核心协议 / 世界观 / 角色卡 /
 * Live2D 标签 / 会话设定 / 记忆规则 / 图片一致性 / 配音格式 / 回合锚点 / 模型可用表现 /
 * 水印 / Agent 权限），在这类网关上一个字都发不出去。
 *
 * 做法：把 index.html 里的真实函数体抠出来跑，不复制逻辑、不联网。
 */
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

/** 按函数名抠出完整函数声明；`async` 前缀必须一起带上，否则里面的 await 会语法错误 */
function extractFn(name) {
    let start = html.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('在 web/index.html 里找不到函数: ' + name + '（重命名了？请同步更新本检查）');
    const asyncMatch = html.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (asyncMatch) start -= asyncMatch[0].length;
    // **先跳过参数表**：`opts = {}` 这类默认值里就有大括号，直接找第一个 `{` 会抠出半截函数
    // （症状是 new Function 报一个和本函数毫无关系的 SyntaxError）。
    let i = html.indexOf('(', start);
    let paren = 0;
    for (; i < html.length; i++) {
        if (html[i] === '(') paren++;
        else if (html[i] === ')') { paren--; if (paren === 0) { i++; break; } }
    }
    let depth = 0;
    i = html.indexOf('{', i);
    for (; i < html.length; i++) {
        const c = html[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return html.slice(start, i);
}

const { mergeLeadingSystemMessages } = new Function(`
    ${extractFn('extractTextContent')}
    ${extractFn('mergeLeadingSystemMessages')}
    return { mergeLeadingSystemMessages };
`)();

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    const ok = a === b;
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
    if (!ok) console.log(`        got  = ${a}\n        want = ${b}`);
}

const S = (c) => ({ role: 'system', content: c });
const U = (c) => ({ role: 'user', content: c });
const A = (c) => ({ role: 'assistant', content: c });
const roles = (ms) => ms.map((m) => m.role);

// —— 不该动的情况 ——
check('空数组原样返回', mergeLeadingSystemMessages([]), []);
check('单条 system 不合并', roles(mergeLeadingSystemMessages([S('a'), U('x')])), ['system', 'user']);
check('没有 system 时不动', roles(mergeLeadingSystemMessages([U('x'), A('y')])), ['user', 'assistant']);
check('只有 user 时不动', roles(mergeLeadingSystemMessages([U('x')])), ['user']);
check('非数组入参不炸', mergeLeadingSystemMessages(null), []);

// —— 该合并的情况（核心修复）——
const many = [S('核心协议'), S('# 世界观\n魔法世界'), S('# 角色卡\n伊蕾娜'), S('# Live2D 标签'), U('你好'), A('你好呀'), U('只回复OK')];
const merged = mergeLeadingSystemMessages(many);
check('8 条 system + 历史 → 只剩 1 条 system', roles(merged), ['system', 'user', 'assistant', 'user']);
check('system 仍在位置 0', merged[0].role, 'system');
check('内容一条不少（空行分隔）', merged[0].content, '核心协议\n\n# 世界观\n魔法世界\n\n# 角色卡\n伊蕾娜\n\n# Live2D 标签');
check('历史消息未被改动', merged.slice(1), [U('你好'), A('你好呀'), U('只回复OK')]);

// —— 边界 ——
const withEmpty = mergeLeadingSystemMessages([S('a'), S('   '), S('b'), U('x')]);
check('空白的 system 被过滤掉', withEmpty[0].content, 'a\n\nb');
check('全是空白 system → 合成空串仍占一条（不产生 0 条 system 的怪状态）', roles(mergeLeadingSystemMessages([S(''), S(''), U('x')])), ['system', 'user']);

const arrayContent = mergeLeadingSystemMessages([S([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }]), S('丙'), U('x')]);
check('数组形式的 system 内容也能拍平', arrayContent[0].content, '甲乙\n\n丙');

// —— 关键：中间的 system 不该被这里掩盖（那是另一种错误，要留给服务商报出来）——
const middleSystem = [U('x'), S('s'), U('y')];
check('system 在中间时不动它（不掩盖别的错误）', roles(mergeLeadingSystemMessages(middleSystem)), ['user', 'system', 'user']);

// —— 模拟真实分层结构：12 条 system ——
const layered = [
    S('核心协议'), S('世界观'), S('角色卡'), S('Live2D 标签指南'), S('会话专属设定'), S('记忆规则'),
    S('图片一致性'), S('配音格式'), S('回合锚点'), S('模型可用表现'), S('水印提示'), S('Agent 权限'),
    U('你好'), A('你好呀'), U('只回复OK'),
];
const layeredMerged = mergeLeadingSystemMessages(layered);
check('真实分层结构：12 条 system → 1 条', layeredMerged.filter((m) => m.role === 'system').length, 1);
check('真实分层结构：总条数 15 → 4', layeredMerged.length, 4);
check('真实分层结构：位置 0 是 system', layeredMerged[0].role, 'system');
check('真实分层结构：每段内容都还在', layered.every((m) => m.role !== 'system' || layeredMerged[0].content.includes(m.content)), true);

console.log(`\n消息形状合并检查：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
