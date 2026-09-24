// 回归检查：多主题系统（源码层）。
//
// 浏览器端的行为验证在 android-app/test/theme.test.mjs（那里有 playwright）。
// 这里只做静态检查 —— 根目录脚本不依赖浏览器，这是本项目的既有约定。
//
// 盯住的几个点（都是踩过的）：
//   · 默认主题必须"不设属性"，否则覆盖层会对默认外观生效（破坏"原样不动"）
//   · 覆盖规则权重必须够 —— 项目里已有一层用 ID 选择器覆盖 indigo 类的规则，
//     类级选择器压不住它
//   · 底色在 #mainContent 而不是 body
//   · themes.css 必须排在所有样式之后
//
// 用法：node scripts/check-theme.mjs
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

console.log('=== 1. 文件与接线 ===');
{
    const themeJs = path.join(WEB, 'js', 'theme.js');
    const themesCss = path.join(WEB, 'css', 'themes.css');
    ok(existsSync(themeJs), 'web/js/theme.js 存在');
    ok(existsSync(themesCss), 'web/css/themes.css 存在');

    const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
    ok(/<script src="\/js\/theme\.js"><\/script>/.test(html), 'index.html 引入 theme.js');
    ok(/<link rel="stylesheet" href="\/css\/themes\.css">/.test(html), 'index.html 引入 themes.css');

    // ★ themes.css 必须排在所有内联 <style> 之后（同权重靠后加载胜出）
    const cssLinkIdx = html.indexOf('/css/themes.css');
    const lastStyleEnd = html.lastIndexOf('</style>');
    ok(cssLinkIdx > lastStyleEnd, '★ themes.css 排在所有内联 <style> 之后',
        'link@' + cssLinkIdx + ' lastStyleEnd@' + lastStyleEnd);

    // 设置界面容器
    ok(/id="themePickerBox"/.test(html), '设置里有 #themePickerBox');
    ok(/id="themeDarkToggle"/.test(html), '设置里有深色开关');
}

console.log('\n=== 2. 默认主题不改变外观（关键语义）===');
{
    const js = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
    // 默认主题必须走"移除属性"这条路径
    ok(/removeAttribute\('data-theme-template'\)/.test(js),
        '★ 默认主题走 removeAttribute（不设属性 → 覆盖规则一条都不生效）');
    ok(/tpl === 'elaina'/.test(js), '粉紫被显式识别为默认主题');
    // 5 套模板
    const ids = [...js.matchAll(/\{\s*id:\s*'(\w+)',\s*name:/g)].map((m) => m[1]);
    ok(ids.length === 5, '定义了 5 套模板，实得 ' + ids.length, ids.join(','));
    for (const id of ['elaina', 'ios', 'claude', 'sage', 'sakura']) {
        ok(ids.includes(id), '含模板 ' + id);
    }
}

console.log('\n=== 3. 覆盖权重（踩过的坑）===');
{
    const css = readFileSync(path.join(WEB, 'css', 'themes.css'), 'utf8');

    // ★ 必须用 html[data-theme-template] body/ID 形式提升权重
    ok(/html\[data-theme-template\]\s+body\s+\.text-indigo-950/.test(css),
        '★ 用 html[attr] body .类 的形式（类级选择器压不住项目里已有的 ID 级规则）');
    // ★ 侧边栏与弹窗面板那几条 ID 级规则要单独压
    ok(/html\[data-theme-template\]\s+#sidebar\s+\.text-indigo-950/.test(css),
        '★ 单独覆盖 #sidebar 下的 indigo 类');
    ok(/html\[data-theme-template\]\s+\.modal-panel\s+\.text-indigo-950/.test(css),
        '★ 单独覆盖 .modal-panel 下的 indigo 类');

    // ★ 底色在 #mainContent 而不是 body
    ok(/html\[data-theme-template\]\s+#mainContent/.test(css),
        '★ 覆盖 #mainContent 的渐变（实测 body.backgroundImage 是 none）');

    // 深色同样要提权
    ok(/html\[data-theme="dark"\]\s+body\s+\.text-indigo-950/.test(css),
        '★ 深色模式的规则同样提权');

    // !important 必须普遍使用（Tailwind 运行时注入，同权重下它后加载胜出）
    const importantCount = (css.match(/!important/g) || []).length;
    ok(importantCount >= 30, '★ 覆盖规则普遍使用 !important（实得 ' + importantCount + ' 处）');

    // 深色与模板正交
    ok(/html\[data-theme="dark"\]/.test(css), '有 html[data-theme="dark"] 规则');
    ok(/html\[data-theme-template="ios"\]/.test(css) && /html\[data-theme-template="sakura"\]/.test(css),
        '四套液态玻璃模板都有变量定义');
}

console.log('\n=== 4. 同步（APK 端要用）===');
{
    const sync = readFileSync(path.join(ROOT, 'scripts', 'sync-web.mjs'), 'utf8');
    ok(/collectCssFiles/.test(sync), '★ sync-web.mjs 会同步 web/css/（否则 APK 里主题切换无效）');
    ok(/theme\.js/.test(sync) || /collectJsFiles/.test(sync),
        'js/ 是自动发现的，theme.js 会被带上');
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
