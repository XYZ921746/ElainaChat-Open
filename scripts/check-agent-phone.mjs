/**
 * 回归检查：AI 手机操作的能力声明是否真的注入了系统提示词。
 *
 * 背景（真实故障）：执行链路早就完整 ——
 *   标签解析（live2d-video.js 的 handleAgentOperation）
 *   → window.agentActions.agentPhoneOperation
 *   → runAgentPhoneOperation（停止检查 + 风险授权）
 *   → 原生 ElainaDevice.exec
 *   → 结果以「【AI 操作结果】」回灌
 * 但**系统提示词里从来没有告诉模型"你能操作手机"**：
 * LIVE2D_TAG_GUIDE 的【操作标签】只列了 7 个应用内操作，一个 `手机*` 都没有，
 * 文件操作有专门注入、手机操作零注入。模型不知道标签存在 → 永远不输出 →
 * 用户看到的现象就是"AI 好像不能操作手机"。
 *
 * 这类 bug 的可怕之处：**没有任何报错**。链路每一环单独看都是好的，
 * 只有"提示词里有没有这句话"这一条断了，而且断了不影响任何其它功能，
 * 所以既不会被现有检查发现，也不会在手动点界面时暴露。
 *
 * 本检查就盯住三件事：
 *   1. 提示词里必须出现手机操作能力说明（在两条构建路径上都要有）；
 *   2. 能力清单里的每个标签，都必须真的被解析器认识（防止"说了但做不到"）；
 *   3. 未启用时不得声称能操作，且必须明确禁止输出标签（防止模型空谈/编造）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFrontend();
const live2d = readFileSync(path.join(root, 'web', 'live2d-video.js'), 'utf8');

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond) { pass++; return; }
    failures.push(label + (extra ? `\n      ${extra}` : ''));
}
const has = (haystack, needle) => String(haystack).includes(needle);

/** 按函数名抠出函数体（与 check-model-list.mjs 同一套做法） */
function extractFn(name, src = html) {
    let start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('找不到函数: ' + name + '（重命名了？请同步更新本检查）');
    const asyncMatch = src.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (asyncMatch) start -= asyncMatch[0].length;
    let i = src.indexOf('(', start);
    let paren = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') paren++;
        else if (src[i] === ')') { paren--; if (paren === 0) { i++; break; } }
    }
    let depth = 0;
    i = src.indexOf('{', i);
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

// ---------- 一、能力声明函数存在，且三档分明 ----------
console.log('\n— 能力声明函数 —');
const skillFn = extractFn('agentPhoneSkillText');
ok(skillFn.length > 200, 'agentPhoneSkillText() 存在且不是空壳');

// 没有原生设备层（网页版）→ 必须返回空串，不注入。
// 否则网页版会让模型以为自己能操作手机，然后每次都被拒绝，白烧 token 还骗用户。
ok(/if \(!deviceBridge\(\)\) return '';/.test(skillFn),
    '没有原生设备层（网页版）时不注入能力说明');

// 未启用档：必须明确"不能"+"不要输出标签"
ok(/未启用/.test(skillFn), '有「未启用」这一档');
ok(/不要\*\*输出 \[操作:手机…\] 标签|不要\*\*输出/.test(skillFn) || /不要.{0,4}输出 \[操作:手机/.test(skillFn),
    '未启用时明确禁止模型输出手机标签（否则它会空谈/编造）');
ok(/设置 → 高级 → 手机操作/.test(skillFn), '未启用时引导用户去正确的位置开启');

// 可用档：必须列出真实标签
const phoneTags = [
    '手机状态', '手机查看界面', '手机截图', '手机等待',
    '手机点击', '手机滑动', '手机输入', '手机按键', '手机打开', '手机命令',
];
const missingTags = phoneTags.filter((t) => !has(skillFn, '[操作:' + t));
ok(missingTags.length === 0, '可用档列出了全部 10 个手机操作标签', '缺少: ' + missingTags.join('、'));

// ---------- 一之二、能力清单必须按实现方式区分 ----------
//
// 无障碍后端**做不到**「手机打开」与「手机命令」（原生层明确回失败）。
// 提示词把它俩写成通用能力，就会造成"说了却做不到" —— 模型反复尝试、用户看到一连串失败。
// 这正是本次要避免的那类问题，所以必须锁住。
console.log('\n— 按实现方式区分能力 —');
ok(/const isAccessibility = backend === 'accessibility'/.test(skillFn),
    '能力清单按实现方式分支（无障碍 / 其它）');
ok(/不支持\*\* \[操作:手机打开\]|不支持.*手机打开/.test(skillFn),
    '无障碍档明确说明**不支持**「手机打开」（原生确实做不到）');
ok(/手机命令/.test(skillFn) && /不支持|做不到/.test(skillFn),
    '无障碍档明确说明不支持「手机命令」');
ok(/换成 Shizuku \/ Root \/ 模块|改用 root \/ Shizuku \/ 模块/.test(skillFn),
    '无障碍档给出可行替代（换实现方式 / 点图标）');
ok(/不要重复尝试/.test(skillFn),
    '明确要求模型遇到「不支持」时不要反复重试（否则会刷屏失败）');
// 非无障碍档才承诺「手机打开 / 手机命令」
ok(/else \{[\s\S]*手机打开 包名/.test(skillFn),
    '非无障碍档才列出「手机打开 / 手机命令」');

// ---------- 二、注入点：两条构建路径都要有 ----------
console.log('\n— 注入点 —');
const layered = extractFn('buildLayeredRoleplayMessages');
const legacy = extractFn('buildLegacyRoleplayMessages');
ok(/agentPhoneSkillText\(\)/.test(layered), '分层版（layered-v2）注入了手机操作能力');
ok(/agentPhoneSkillText\(\)/.test(legacy),
    '回滚版（legacy-v1）也注入了 —— 只补一边会让切回 legacy 后"又不能操作手机了"');

// ---------- 三、说的必须做得到：清单里的标签解析器都认识 ----------
//
// 这一条是本检查最有价值的部分：提示词与解析器是两处独立维护的清单，
// 任何一边加/改标签而另一边没跟上，都会造成"AI 照做了却没人接"。
console.log('\n— 清单与解析器一致 —');
const opsMatch = html.match(/const AGENT_PHONE_OPS = \[([\s\S]*?)\];/);
ok(!!opsMatch, '找得到 AGENT_PHONE_OPS（解析器认识的标签清单）');
if (opsMatch) {
    const parsed = [...opsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const notParsed = phoneTags.filter((t) => !parsed.includes(t));
    ok(notParsed.length === 0,
        '提示词里承诺的每个标签，解析器都认识', '解析器不认识: ' + notParsed.join('、'));
    const notAdvertised = parsed.filter((t) => !has(skillFn, '[操作:' + t));
    ok(notAdvertised.length === 0,
        '解析器认识的每个标签，提示词里都告知了模型', '提示词漏了: ' + notAdvertised.join('、'));
}

// 每个标签都要有风险分级，否则 requestApproval 拿不到级别（会当 safe 放行）
const riskMatch = html.match(/const AGENT_RISK = \{([\s\S]*?)\};/);
ok(!!riskMatch, '找得到 AGENT_RISK（风险分级表）');
if (riskMatch && opsMatch) {
    const parsed = [...opsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const ungraded = parsed.filter((t) => !has(riskMatch[1], "'" + t + "'"));
    ok(ungraded.length === 0, '每个手机操作都有风险分级', '缺分级: ' + ungraded.join('、'));
}

// ---------- 四、分发链路的每一环都还在 ----------
//
// 这几环任一断掉，提示词写得再全也没用。它们分散在两个文件里，最容易在重构时被拆散。
console.log('\n— 分发链路 —');
ok(/window\.agentActions\s*=\s*\{/.test(html), '主应用定义了 window.agentActions');
ok(/agentPhoneOperation\(raw\)/.test(html), 'agentActions 上有 agentPhoneOperation');
ok(/async function runAgentPhoneOperation\(/.test(html), 'runAgentPhoneOperation 存在');
// 判据行与调用行是分开的两句：`if (window.agentActions?.agentPhoneOperation)` 之后
// 才 `window.agentActions.agentPhoneOperation(v)` —— 断言要认这个真实形状。
ok(/window\.agentActions\?\.agentPhoneOperation/.test(live2d)
    && /window\.agentActions\.agentPhoneOperation\(v\)/.test(live2d),
    'live2d-video.js 会把 [操作:手机…] 转发给主应用');
ok(/\^\(手机\|设备\)/.test(live2d), 'live2d-video.js 的转发判据认得「手机」前缀');
ok(/ElainaDevice/.test(html) && /@CapacitorPlugin\(name = "ElainaDevice"\)/.test(
    readFileSync(path.join(root, 'android-app', 'android', 'app', 'src', 'main', 'java',
        'com', 'elainachat', 'opensource', 'ElainaShellPlugin.java'), 'utf8')),
    '原生插件名与前端查找的名字一致（ElainaDevice）');
ok(/registerPlugin\(ElainaShellPlugin\.class\)/.test(
    readFileSync(path.join(root, 'android-app', 'android', 'app', 'src', 'main', 'java',
        'com', 'elainachat', 'opensource', 'MainActivity.java'), 'utf8')),
    'MainActivity 注册了原生插件（没注册就永远拿不到设备层）');

// ---------- 五、静态标签指南不得把手机操作说成"总是可用" ----------
console.log('\n— 不产生误导 —');
const guideMatch = html.match(/const LIVE2D_TAG_GUIDE = `([\s\S]*?)`;/);
ok(!!guideMatch, '找得到 LIVE2D_TAG_GUIDE');
if (guideMatch) {
    // 静态指南里不该直接列出手机标签（它的可用性随设备/设置变化，由动态注入负责说）
    ok(!/\[操作:手机点击\]/.test(guideMatch[1]),
        '静态指南没有把手机标签写成"总是可用"（可用性随设备变化，交给动态注入）');
    ok(/系统会单独告知/.test(guideMatch[1]),
        '静态指南说明了手机/文件操作由系统单独告知（避免模型凭这里猜）');
}

console.log(`\n手机 Agent 能力声明检查：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
}
