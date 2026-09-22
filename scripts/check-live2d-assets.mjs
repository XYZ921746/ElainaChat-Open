/**
 * 回归检查：Live2D 表情/动作的「解析 + 资源 URL 拼接」。
 *
 * 为什么需要这个检查：
 *   模型并不都把 *.exp3.json / *.motion3.json 放在 exp/ 子目录里 —— Cubism 只规定文件格式，
 *   放哪由模型作者决定。仓库内置的 deepseek 把 44 个表情直接堆在模型根目录、8 个动作放在
 *   motions/，早期把 'exp/' 写死在 URL 上的实现因此让表情/动作全部 404，
 *   表现出来就是"打包进去的模型没有表情"。
 *
 * 做法：用字符串切片把 web/live2d-video.js 里的真实函数体抠出来，在 Node 里喂真实清单跑一遍。
 * 不复制逻辑（复制的话测的就不是真代码了），也不依赖浏览器。
 * 如果哪天重命名了这些函数，本检查会直接报错提醒同步更新。
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../web/live2d-video.js', import.meta.url), 'utf8');

/**
 * 按函数名抠出完整函数声明（靠大括号配对找结尾）。
 * 注意：必须把前面的 `async` 一起带上 —— `indexOf('function x(')` 会从 `async function x(` 的
 * 中间开始切，抠出来的就成了同步函数，里面所有 `await` 立刻变成语法错误。
 */
function extractFn(name) {
    let start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('在 web/live2d-video.js 里找不到函数: ' + name + '（重命名了？请同步更新本检查）');
    const asyncMatch = src.slice(Math.max(0, start - 12), start).match(/async\s+$/);
    if (asyncMatch) start -= asyncMatch[0].length;
    // **先跳过参数表**：`opts = {}` 这类默认值里就有大括号，直接找第一个 `{` 会抠出半截函数
    // （症状是 new Function 报一个和本函数毫无关系的 SyntaxError）。
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

/** 把被测函数放进一个带桩变量的作用域里求值 */
function buildHarness({ exps = [], motions = [], known = true }) {
    return new Function(`
        const EXP_SYNONYM_GROUPS = [];
        const EXPRESSION_MAP = { happy: '星星眼', sad: '哭哭', blush: '脸红', dizzy: '晕晕眼' };
        const MOTION_MAP = { wave: '常规', bow: '前倾' };
        const currentModelExps = ${JSON.stringify(exps)};
        const currentModelMotions = ${JSON.stringify(motions)};
        const modelAssetListKnown = ${JSON.stringify(known)};
        function modelBaseUrl(name) { return '/live2d/models/' + encodeURIComponent(name) + '/'; }
        ${extractFn('modelAssetUrl')}
        ${extractFn('sanitizeAssetName')}
        ${extractFn('fuzzyMatchFileName')}
        ${extractFn('resolveExpressionFile')}
        ${extractFn('resolveMotionFile')}
        return { modelAssetUrl, sanitizeAssetName, fuzzyMatchFileName, resolveExpressionFile, resolveMotionFile };
    `)();
}

// —— 真实清单（取自修复后的 /api/live2d/models）——
const EXPS = ['love.exp3.json', '兔兔贴纸.exp3.json', '脸红.exp3.json', '星星眼.exp3.json', '哭.exp3.json', '晕晕.exp3.json'];
const MOTIONS = ['aidale.motion3.json', 'motions/chuipaopao.motion3.json', 'motions/idle.motion3.json', 'motions/自拍.motion3.json'];

const L = buildHarness({ exps: EXPS, motions: MOTIONS, known: true });

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
    const ok = actual === expected;
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
    if (!ok) console.log(`        got  = ${JSON.stringify(actual)}\n        want = ${JSON.stringify(expected)}`);
}

// 1) URL 拼接：根目录文件 / 子目录文件 / 中文名 / 子目录+中文名
check('根目录中文表情 URL',
    L.modelAssetUrl('deepseek', '脸红.exp3.json'),
    '/live2d/models/deepseek/%E8%84%B8%E7%BA%A2.exp3.json');
check('子目录动作 URL（路径分隔符不能被编码成 %2F）',
    L.modelAssetUrl('deepseek', 'motions/idle.motion3.json'),
    '/live2d/models/deepseek/motions/idle.motion3.json');
check('子目录+中文动作 URL',
    L.modelAssetUrl('deepseek', 'motions/自拍.motion3.json'),
    '/live2d/models/deepseek/motions/%E8%87%AA%E6%8B%8D.motion3.json');
check('模型名带非 ASCII（· 是 U+00B7）',
    L.modelAssetUrl('伊蕾娜·默认', 'LSS.model3.json'),
    '/live2d/models/%E4%BC%8A%E8%95%BE%E5%A8%9C%C2%B7%E9%BB%98%E8%AE%A4/LSS.model3.json');

// 2) 注入防护仍然有效（表情名会被拼进 URL 路径）
check('路径穿越被挡', L.sanitizeAssetName('../../x'), '');
check('斜杠被挡', L.sanitizeAssetName('motions/idle'), '');
check('正常名放行', L.sanitizeAssetName('脸红'), '脸红');

// 3) 表情解析
check('精确名 -> 根目录表情', L.resolveExpressionFile('脸红'), '脸红');
check('语义映射 happy -> 星星眼', L.resolveExpressionFile('happy'), '星星眼');
check('语义映射 blush -> 脸红', L.resolveExpressionFile('blush'), '脸红');
check('模糊匹配 兔兔 -> 兔兔贴纸', L.resolveExpressionFile('兔兔'), '兔兔贴纸');
check('不存在的表情返回空串（不再发注定 404 的请求）', L.resolveExpressionFile('完全不存在的东西'), '');

// 4) 动作解析（关键修复点）
check('动作精确名 -> 根目录动作', L.resolveMotionFile('aidale'), 'aidale');
check('动作名 -> motions/ 子目录', L.resolveMotionFile('idle'), 'motions/idle');
check('语义映射 wave -> 常规（清单里没有 -> 空）', L.resolveMotionFile('wave'), '');

// 5) 解析结果拼 URL 后必须是清单里的真实路径
check('表情解析结果拼 URL 后可用',
    L.modelAssetUrl('deepseek', L.resolveExpressionFile('脸红') + '.exp3.json'),
    '/live2d/models/deepseek/%E8%84%B8%E7%BA%A2.exp3.json');
check('子目录动作解析结果拼 URL 后可用',
    L.modelAssetUrl('deepseek', L.resolveMotionFile('idle') + '.motion3.json'),
    '/live2d/models/deepseek/motions/idle.motion3.json');

// 6) 清单已知且为空 → 直接放弃，避免 404 风暴（伊蕾娜·默认 就是这种：模型里没有任何表情/动作文件）
const E = buildHarness({ exps: [], motions: [], known: true });
check('无表情模型：清单已知且为空 -> 放弃', E.resolveExpressionFile('脸红'), '');
check('无动作模型：清单已知且为空 -> 放弃', E.resolveMotionFile('idle'), '');

console.log(`\nLive2D 表情/动作解析检查：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
