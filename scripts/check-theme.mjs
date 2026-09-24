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
    ok(/id="themeDarkMode"/.test(html), '设置里有深色模式控件（三态下拉）');
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
    // 5 套预设 + 1 个 DIY「自定义」（颜色由用户定，变量在运行时注入）
    ok(ids.length === 6, '定义了 6 套模板（5 预设 + 自定义），实得 ' + ids.length, ids.join(','));
    for (const id of ['elaina', 'ios', 'claude', 'sage', 'sakura', 'custom']) {
        ok(ids.includes(id), '含模板 ' + id);
    }
}

console.log('\n=== 3. 覆盖权重（踩过的坑）===');
{
    const css = readFileSync(path.join(WEB, 'css', 'themes.css'), 'utf8');

    // ★★ 最关键的一条：必须覆盖 --pixso-* 变量
    //
    // 第一版只覆盖了 --color-* 与 text-indigo-*，结果切主题只有聊天区变色 ——
    // 侧栏/外框/按钮/强调色全不动，视觉上"割裂"。根因是这套界面的真实配色
    // 来自另一组 --pixso-* 变量（橄榄绿/深棕方案），被引用 224 次。
    const pixsoCount = (css.match(/--pixso-/g) || []).length;
    ok(pixsoCount >= 40, '★ 覆盖 --pixso-* 变量（配色割裂的根因，实得 ' + pixsoCount + ' 处）');
    for (const v of ['--pixso-canvas', '--pixso-brown', '--pixso-green', '--pixso-orange',
        '--pixso-cream', '--pixso-line', '--pixso-panel-soft']) {
        ok(css.includes(v + ':'), '★ 覆盖 ' + v);
    }

    // ★★★ 颜色值必须与上游一致（第二版是"自己猜颜色"，导致看着难受）
    //
    // 上游那套配色是成体系调过的：主色柔和（#7aa7f0 而非饱和的 #007aff）、
    // 正文不是纯黑（#253040）、卡片底带冷调（#f7f9fc 而非纯白）。
    // 这些细节决定"看着舒不舒服"，所以逐个钉住。
    const upstreamColors = [
        ['#7aa7f0', '主按钮（上游 --pixso-green，柔和蓝）'],
        ['#4f7cf0', '主按钮深色（--pixso-green-dark）'],
        ['#dce2ea', '页面外框（--pixso-canvas）'],
        ['#253040', '正文（--pixso-brown，不是纯黑）'],
        ['#566070', '次要文字（--pixso-brown-soft）'],
        ['#f7f9fc', '卡片底（--pixso-cream，带冷调不是纯白）'],
        ['#e9eef5', '面板底（--pixso-panel）'],
        ['#d5dce6', '边框（--pixso-line）'],
        ['#0d1015', '深色页面底'],
        ['#dfe6f0', '深色正文'],
        ['#0a84ff', '深色主色'],
        ['#1c232d', '深色侧栏竖栏渐变起'],
    ];
    for (const [hex, label] of upstreamColors) {
        ok(css.includes(hex), '★ 配色照抄上游：' + label + ' = ' + hex);
    }

    // ★ 侧栏竖栏不能复用文字色变量
    //   宿主里 #sidebar::before 用的是 var(--pixso-brown)（文字色），
    //   深色下它变浅 → 竖栏变浅灰白，非常刺眼。必须单独指定。
    ok(/html\[data-theme="dark"\]\s+#sidebar::before/.test(css),
        '★ 深色下单独指定 #sidebar::before 背景（不能复用文字色变量）');

    // ★ 深色三态（浅色/深色/跟随系统）
    const themeJs = readFileSync(path.join(WEB, 'js', 'theme.js'), 'utf8');
    ok(/DARK_MODES\s*=\s*\[[^\]]*'system'/.test(themeJs), '★ theme.js 支持三态（含 system）');
    ok(/prefers-color-scheme:\s*dark/.test(themeJs), '★ 用 matchMedia 检测系统深色偏好');
    ok(/addEventListener\('change'/.test(themeJs), '★ 监听系统主题变化（跟随系统要实时响应）');
    ok(/applyDarkMode/.test(themeJs), '落 DOM 的逻辑统一在一个入口（用户改 / 系统变都走它）');

    const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
    ok(/id="themeDarkMode"/.test(html), '★ 设置里有深色模式三态下拉');
    ok(/value="system">跟随系统</.test(html), '★ 下拉含「跟随系统」选项');
    ok(/id="themeDarkHint"/.test(html), '有"跟随系统"状态提示元素');

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

    // !important 仍需用于**类级**覆盖（Tailwind 运行时注入，同权重下它后加载胜出）。
    // 但注意：重写后主要靠覆盖 --pixso-* 变量生效，类级覆盖只是补充，
    // 所以这个数字**不该设得太高** —— 设高了会逼着以后往变量能解决的地方硬加 !important。
    const importantCount = (css.match(/!important/g) || []).length;
    ok(importantCount >= 20, '★ 类级覆盖使用了 !important（实得 ' + importantCount + ' 处）');

    // 深色与模板正交
    ok(/html\[data-theme="dark"\]/.test(css), '有 html[data-theme="dark"] 规则');
    ok(/html\[data-theme-template="ios"\]/.test(css) && /html\[data-theme-template="sakura"\]/.test(css),
        '四套液态玻璃模板都有变量定义');
}

console.log('\n=== 3.5 主题设置独立成「外观」分栏 ===');
{
    const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
    // 上游顶部导航里就有「外观」一项；埋在「高级」里要翻两层才找到
    ok(/data-settings-tab="tab-appearance">外观</.test(html), '★ 有独立的「外观」Tab');
    ok(/id="tab-appearance"/.test(html), '有 #tab-appearance 面板');
    ok(/id="tab-appearance" class="settings-tab-panel active-panel"/.test(html),
        '★ 外观是默认激活分栏（打开设置直接看到主题）');
    const advIdx = html.indexOf('id="tab-advanced"');
    const themeIdx = html.indexOf('themeSettingsSection');
    ok(themeIdx > 0 && themeIdx < advIdx, '★ 主题设置已从「高级」移到「外观」');
    ok(/id="themePickerBox"/.test(html) && /id="themeDarkMode"/.test(html),
        '外观分栏里有模板选择器与深色三态下拉');

    // ★★ 结构完整性：各分栏不能互相嵌套
    //
    // 这条是补的回归。搬移主题块时插入的 HTML 少了一个 `>`（写成 `</div`），
    // 浏览器把它当成"未闭合的 div 开始"，**后面 8 个分栏全被嵌进了 tab-appearance**。
    // 而 CSS 是 `.settings-tab-panel{display:none}` + `.active-panel{display:block}`，
    // 表现就是"除了外观，其他设置全都不见了"。
    //
    // 这里用 div 配对算出每个分栏的范围，检查有没有谁被包在别人里面。
    const overlayStart = html.indexOf('id="settingsOverlay"');
    if (overlayStart < 0) {
        ok(false, '找不到 settingsOverlay');
    } else {
        let depth = 0, i = html.lastIndexOf('<div', overlayStart), overlayEnd = -1;
        for (; i < html.length; i++) {
            if (html.startsWith('<div', i)) { depth++; i += 3; }
            else if (html.startsWith('</div>', i)) { depth--; i += 5; if (depth === 0) { overlayEnd = i; break; } }
        }
        const region = html.slice(overlayStart, overlayEnd > 0 ? overlayEnd : html.length);
        const ids = [...region.matchAll(/id="(tab-\w+)" class="settings-tab-panel/g)].map((m) => m[1]);
        ok(ids.length >= 9, `设置里有 ${ids.length} 个分栏（应 ≥9）`);

        const ranges = [];
        for (const id of ids) {
            const s = region.indexOf(`id="${id}"`);
            const divStart = region.lastIndexOf('<div', s);
            let d = 0, j = divStart, e = -1;
            for (; j < region.length; j++) {
                if (region.startsWith('<div', j)) { d++; j += 3; }
                else if (region.startsWith('</div>', j)) { d--; j += 5; if (d === 0) { e = j; break; } }
            }
            ranges.push({ id, s: divStart, e });
        }
        const nested = [];
        for (const a of ranges) {
            for (const b of ranges) {
                if (a.id === b.id) continue;
                if (a.s < b.s && b.e < a.e) nested.push(`${b.id} 嵌在 ${a.id} 里`);
            }
        }
        ok(nested.length === 0,
            '★ 各设置分栏互不嵌套（分栏被嵌套会导致"其他设置全消失"）',
            nested.slice(0, 3).join('; '));

        // 顺带查常见的标签残缺：`</div` 后面直接跟换行（少个 >）
        const brokenTag = /<\/div\s*\n/.test(region) || /<\/section\s*\n/.test(region);
        ok(!brokenTag, '★ 没有残缺的闭合标签（如 </div 少了 >）');
    }
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
