// 回归检查：消息渲染（Markdown + LaTeX）。
//
// 从上游 v1.3.1 合并过来的能力，必须盯住两件事：
//
//   ① **安全**：marked 会照单全收 `[x](javascript:...)`，生成可点击的
//      `href="javascript:..."` —— 那等于把"点一下就执行任意代码"送给模型输出
//      （模型输出受提示词影响，而提示词可被对话内容影响）。
//      必须先 escapeHtml 再 marked，并在渲染后清洗危险协议。
//      上游那份实现**没有**这层清洗，是本项目补上的。
//
//   ② **回落**：marked / katex 任一缺失（vendor 没同步、离线失败）时，
//      必须静默降级为纯文本转义，而不是抛错或白屏。
//
// 用法：node scripts/check-message-render.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFrontend();
const ui = readFileSync(path.join(ROOT, 'web', 'js', 'app-04-ui.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

console.log('=== 1. 实现与 vendor ===');
ok(/function renderMessageText/.test(ui), 'app-04-ui.js 里有 renderMessageText');
ok(/window\.marked/.test(ui), '使用 marked 做 Markdown 渲染');
ok(/window\.katex/.test(ui), '使用 katex 做公式渲染');
ok(/<script src="\/vendor\/marked\/marked\.min\.js">/.test(html), 'index.html 引入 marked');
ok(/<script src="\/vendor\/katex\/katex\.min\.js">/.test(html), 'index.html 引入 katex');
ok(/katex\.min\.css/.test(html), 'index.html 引入 katex 样式');

console.log('\n=== 2. 安全（关键）===');
// 顺序：必须先 escapeHtml，再交给 marked
const escIdx = ui.indexOf('escapeHtml(raw)');
const mdIdx = ui.indexOf('mdParse(safe');
ok(escIdx > 0 && mdIdx > 0 && escIdx < mdIdx, '★ 先 escapeHtml 再 marked（顺序反了就是 XSS）');
ok(/javascript\|data\|vbscript\|file/.test(ui), '★ 清洗危险协议的链接');
ok(/<a\\b\[\^>\]\*href/.test(ui) || /href\\s\*=\\s\*"\(\[\^"\]\*\)"/.test(ui), '★ 检查 <a href> 的协议');
ok(/<img\\b\[\^>\]\*src/.test(ui) || /src\\s\*=\\s\*"\(\[\^"\]\*\)"/.test(ui), '★ 检查 <img src> 的协议');

console.log('\n=== 3. 回落（vendor 缺失时不崩）===');
ok(/if \(!hasMd \|\| !mdParse\) return escapeHtml\(raw\);/.test(ui), '★ 无 marked 时回落纯文本');
ok(/catch \(e\) \{ return escapeHtml\(raw\); \}/.test(ui), '★ marked 抛错时回落纯文本');
ok(/window\.katex && typeof window\.katex\.renderToString === 'function'/.test(ui), '★ katex 缺失时跳过公式渲染');

console.log('\n=== 4. 已知缺口（上游有、本项目已补）===');
ok(/\(\\^\|\\n\)\\s\*\\\|\[\^\\n\]\*\\\|/.test(ui) || /\\s\*\\\|\[\^\\n\]\*\\\|/.test(ui),
    '★ hasMd 检测覆盖表格（上游漏了，表格会原样露出管道符）');
ok(/BT0|\\uE200/.test(ui), '★ 反引号占位符处理（escapeHtml 会把 ` 转成 &#96; 导致代码块失效）');

console.log('\n=== 5. 消息渲染点已接入 ===');
const callSites = (ui.match(/renderMessageText\(message\.text\)/g) || []).length;
ok(callSites >= 2, '两处消息渲染都改用 renderMessageText（用户气泡 + AI 气泡）', 'count=' + callSites);
ok(!/whitespace-pre-wrap">\$\{escapeHtml\(message\.text\)\}/.test(ui),
    '★ 旧的纯文本渲染已被替换（否则 Markdown 不生效）');

console.log('\n=== 6. 场景标记剥离（Galgame 依赖）===');
ok(/<scene>/.test(ui), '剥离独占行的 <scene> 标记');
ok(/syncSceneHint|__galgameSceneHint|sceneHint/.test(readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8')) ||
    /setPromptHint/.test(readFileSync(path.join(ROOT, 'web', 'js', 'mods.js'), 'utf8')),
    'mod 系统提供 system 提示词注入（场景切换指令靠它送达模型）');

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
