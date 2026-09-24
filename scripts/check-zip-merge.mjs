// 回归检查：zip 解压实现已合并为**单一来源**。
//
// 背景：合并前有两份几乎相同的实现 ——
//   · web/serve.mjs 的 unzip（111 行）：体积上限 + 危险类型拦截 + GBK + zip64 回退
//   · server/zip.mjs 的 readZip（100 行）：体积上限 + GBK + zip64 回退
// 两者逐段重复。**两份实现意味着安全修复要改两处，漏一处就是个洞** ——
// 比如危险类型拦截只加在了 unzip 上，readZip 那条路（数据导入）就没有。
//
// 现已合并到 server/zip.mjs，serve.mjs 只留一个薄包装（保持 {files, blocked} 语义）。
//
// 这个脚本盯住：
//   ① 实现只有一份（serve.mjs 不该再有完整的 unzip）
//   ② 三条真实路径都还能正常解压：模型上传 / 数据导入 / mod 安装
//   ③ 危险类型拦截在**所有**路径上都生效（这是合并的主要收益）
//
// 用法：node scripts/check-zip-merge.mjs
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, createZip, BLOCKED_EXT, effectiveExt } from '../server/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

const zipSrc = readFileSync(path.join(ROOT, 'server', 'zip.mjs'), 'utf8');
const serveSrc = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');

console.log('=== 1. 实现只有一份 ===');
{
    // serve.mjs 不该再有完整的 unzip 实现（它应该只是薄包装）
    const hasFullUnzip = /^function unzip\(/m.test(serveSrc)
        && /inflateRawSync/.test(serveSrc.slice(serveSrc.indexOf('function unzip('), serveSrc.indexOf('function unzip(') + 3000));
    ok(!hasFullUnzip, '★ serve.mjs 不再自带完整解压实现（已合并到 zip.mjs）');
    ok(/readZip\(buf, \{ \.\.\.opts, returnBlocked: true \}\)/.test(serveSrc),
        'serve.mjs 保留薄包装（维持 {files, blocked} 语义，不动调用点）');
    ok(/from '\.\.\/server\/zip\.mjs'/.test(serveSrc), 'serve.mjs 从 zip.mjs 引入');
    ok(/export function readZip/.test(zipSrc), 'zip.mjs 是导出的唯一实现');
    // serve.mjs 不该再有自己的 GBK/EOCD 实现
    ok(!/^function findEocd\(/m.test(serveSrc), '★ serve.mjs 不再自带 findEocd');
    ok(!/^function gbkDecode\(/m.test(serveSrc), '★ serve.mjs 不再自带 gbkDecode');
    ok(!/const BLOCKED_EXT = new Set/.test(serveSrc), 'BLOCKED_EXT 已移出 serve.mjs');
    ok(/export const BLOCKED_EXT/.test(zipSrc), 'BLOCKED_EXT 定义在 zip.mjs 并导出');
}

console.log('\n=== 2. 危险类型拦截在实现内部（所有调用方都受保护）===');
{
    // 这是合并的主要收益：拦截写在 readZip 里，而不是各调用方自己写
    const fnStart = zipSrc.indexOf('export function readZip');
    const fnBody = zipSrc.slice(fnStart, fnStart + 6000);
    ok(/isBlocked\(name\)/.test(fnBody), '★ readZip 内部做危险类型拦截');
    ok(/blocked\.push\(name\)/.test(fnBody), '被拦的条目记入 blocked');
    ok(/effectiveExt/.test(fnBody), '★ 用 effectiveExt（能识破 x.html::$DATA 这类写法）');

    // 默认拦脚本；mod 安装显式开启
    ok(/allowScripts/.test(fnBody), '有 allowScripts 开关');
    ok(/SCRIPT_EXTS/.test(fnBody), '脚本类扩展名被单独识别');

    // 数据导入路径（store.mjs）没有传 allowScripts → 默认受保护
    const storeSrc = readFileSync(path.join(ROOT, 'server', 'store.mjs'), 'utf8');
    ok(/readZip\(/.test(storeSrc), 'store.mjs（数据导入）用 readZip');
    ok(!/allowScripts/.test(storeSrc), '★ 数据导入没开 allowScripts（默认受危险类型保护）');
}

console.log('\n=== 3. 三条真实路径都能正常工作 ===');
{
    const tmp = mkdtempSync(path.join(tmpdir(), 'elaina-zip-'));

    // ---- ① 普通解压（数据导入形态）：返回数组 ----
    const plain = createZip([
        { name: 'manifest.json', data: Buffer.from('{"v":2}') },
        { name: 'settings.json', data: Buffer.from('{"a":1}') },
        { name: 'characters/card_a.json', data: Buffer.from('{"id":"a"}') },
    ]);
    const files = readZip(plain);
    ok(Array.isArray(files), '① 默认返回数组（兼容旧调用方）');
    ok(files.length === 3, '三个条目都解出来', 'count=' + files.length);
    ok(files.some((f) => f.name === 'characters/card_a.json'), '保留子目录路径');
    ok(files.every((f) => Buffer.isBuffer(f.data)), 'data 是 Buffer');

    // ---- ② 需要 blocked 回报（模型上传 / mod 安装形态）----
    const withBad = createZip([
        { name: 'model.model3.json', data: Buffer.from('{}') },
        { name: 'evil.html', data: Buffer.from('<script>x</script>') },
        { name: 'evil.exe', data: Buffer.from('MZ') },
        { name: 'texture.png', data: Buffer.from('PNG') },
    ]);
    const r = readZip(withBad, { returnBlocked: true });
    ok(r && Array.isArray(r.files) && Array.isArray(r.blocked), '② returnBlocked 时返回 {files, blocked}');
    ok(r.files.length === 2, '只解出 2 个合法文件', 'count=' + r.files.length);
    ok(r.blocked.length === 2, '★ 拦下 2 个危险类型（.html / .exe）', 'blocked=' + r.blocked.join(','));
    ok(r.blocked.includes('evil.html'), '拦了 evil.html');
    ok(r.blocked.includes('evil.exe'), '拦了 evil.exe');
    ok(r.files.some((f) => f.name === 'model.model3.json'), '合法文件正常解出');

    // ---- ③ mod 安装形态：allowScripts 允许 .js ----
    const modZip = createZip([
        { name: 'manifest.json', data: Buffer.from('{"id":"x"}') },
        { name: 'index.js', data: Buffer.from('console.log(1)') },
        { name: 'style.css', data: Buffer.from('.x{}') },
        { name: 'bad.exe', data: Buffer.from('MZ') },
    ]);
    const mod = readZip(modZip, { allowScripts: true, returnBlocked: true });
    ok(mod.files.length === 3, '★ allowScripts 时 .js 可以落盘（3 个文件）', 'count=' + mod.files.length);
    ok(mod.files.some((f) => f.name === 'index.js'), 'index.js 被解出');
    ok(mod.blocked.includes('bad.exe'), '★ 即使开了 allowScripts，.exe 仍被拦', 'blocked=' + mod.blocked.join(','));

    // ---- ④ 路径穿越必须仍被拦（合并不能丢这个）----
    const traversal = createZip([
        { name: 'ok.json', data: Buffer.from('{}') },
        { name: '../../web/serve.mjs', data: Buffer.from('HACKED') },
        { name: '/abs/path.json', data: Buffer.from('{}') },
    ]);
    const tv = readZip(traversal, { returnBlocked: true });
    ok(!tv.files.some((f) => f.name.includes('..')), '★ 路径穿越条目被拦');
    ok(!tv.files.some((f) => f.name.startsWith('/')), '★ 绝对路径条目被拦');
    ok(tv.files.length === 1, '只解出 1 个合法文件', 'count=' + tv.files.length);

    // ---- ⑤ 体积上限 ----
    let threw = false;
    try {
        readZip(plain, { maxTotal: 5 });
    } catch (e) { threw = true; }
    ok(threw, '★ 体积上限仍然生效');

    rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== 4. effectiveExt 的绕过防护（合并后仍生效）===');
{
    const cases = ['x.html::$DATA', 'x.html.', 'x.html ', 'x.js::$DATA'];
    for (const c of cases) {
        ok(BLOCKED_EXT.has(effectiveExt(c)), '★ ' + JSON.stringify(c) + ' 仍被判为危险类型');
    }
    ok(!BLOCKED_EXT.has(effectiveExt('note.txt')), '正常文本不被误拦');
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
