// 打包 mod 与 Live2D 模型，产出可上传到 GitHub Releases 的 zip。
//
// 为什么需要这个脚本：mod 与模型都是**二进制资源**（图片、moc3），
// 不适合放在 git 仓库里（Git 对二进制无法有效增量压缩，每次改一张图
// 历史里就多存一整份）。所以改为"源码留仓库、资源走 Releases"。
//
// 用法：
//   node scripts/pack-assets.mjs              # 打包全部
//   node scripts/pack-assets.mjs galgame      # 只打某个 mod
//   node scripts/pack-assets.mjs --list       # 只列出会打包什么
//
// 产物放在 dist/assets/（已 gitignore）。
//
// ── 打包格式的约定（很重要，装的时候靠它）──────────────────────────────
//
//   mod：zip 根目录**直接是 mod 的文件**（manifest.json / index.js / img/…），
//        不要多一层同名目录。因为安装时服务端会剥掉"唯一的顶层目录"
//        （见 server/mods.mjs 的 stripTop），多一层虽然也能装，
//        但少一层更不容易出意外。
//
//   模型：zip 根目录**必须是一个以模型名命名的目录**
//        （如 `伊蕾娜·默认/xxx.model3.json`）。因为模型是按目录名识别的
//        （/api/live2d/models 返回的就是目录名），少这层会导致解压后
//        文件散落在 models/ 下、识别不出模型。
import { readdirSync, statSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../server/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS_DIR = path.join(ROOT, 'web', 'mods');
const MODELS_DIR = path.join(ROOT, 'web', 'live2d', 'models');
const OUT_DIR = path.join(ROOT, 'dist', 'assets');

/** 递归收集目录下的文件（返回相对路径 + 内容） */
function collectFiles(dir, prefix = '', out = []) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;                 // 跳过隐藏文件
        if (e.name === 'index.json') continue;                // 服务端自动生成的清单，不该打包
        const rel = prefix ? prefix + '/' + e.name : e.name;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collectFiles(full, rel, out);
        else if (e.isFile()) out.push({ rel, full });
    }
    return out;
}

const mb = (b) => (b / 1048576).toFixed(2) + ' MB';

/** 读 manifest（拿版本号，用于文件名） */
function readManifest(dir) {
    const p = path.join(dir, 'manifest.json');
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** 打包一个 mod */
async function packMod(id) {
    const dir = path.join(MODS_DIR, id);
    if (!existsSync(dir)) return { id, error: '目录不存在' };

    const files = collectFiles(dir);
    if (!files.length) return { id, error: '目录为空' };

    // 至少要有入口或清单，否则装了也跑不起来
    const hasEntry = files.some((f) => f.rel === 'index.js' || f.rel === 'manifest.json');
    if (!hasEntry) return { id, error: '缺少 index.js / manifest.json' };

    const manifest = readManifest(dir);
    const version = (manifest && manifest.version) || '0.0.0';

    const entries = [];
    let total = 0;
    for (const f of files) {
        const data = await readFile(f.full);
        total += data.length;
        // ★ mod：根目录直接放文件（不套一层同名目录）
        entries.push({ name: f.rel, data });
    }

    const zip = createZip(entries);
    const outName = `${id}-${version}.zip`;
    const outPath = path.join(OUT_DIR, outName);
    await writeFile(outPath, zip);

    return { id, kind: 'mod', version, files: files.length, raw: total, zip: zip.length, outName, outPath };
}

/** 打包一个 Live2D 模型 */
async function packModel(name) {
    const dir = path.join(MODELS_DIR, name);
    if (!existsSync(dir)) return { name, error: '目录不存在' };

    const files = collectFiles(dir);
    if (!files.length) return { name, error: '目录为空' };

    // 至少要有一个 model3.json，否则不是有效模型
    const hasModel3 = files.some((f) => f.rel.endsWith('.model3.json'));
    if (!hasModel3) return { name, error: '缺少 .model3.json（不是有效的 Live2D 模型）' };

    const entries = [];
    let total = 0;
    for (const f of files) {
        const data = await readFile(f.full);
        total += data.length;
        // ★ 模型：必须套一层以模型名命名的目录
        entries.push({ name: name + '/' + f.rel, data });
    }

    const zip = createZip(entries);
    // 文件名要安全：模型名可能含中文/空格/·。
    //
    // ★ 为什么把中文也换掉（而不只是替换非法字符）：
    //   实测上传到 GitHub Releases 时，`live2d-伊蕾娜·默认.zip` 经 curl 传输后
    //   变成了 `live2d-.zip` —— 中文在 Windows 命令行 → curl 的 → GitHub API
    //   这条链路上丢了。下载链接也会带一长串 %XX，既不好看也容易出错。
    //
    //   所以产物名统一用**纯 ASCII**：非 ASCII 字符转成下划线。
    //   模型在 zip **内部**仍保留原名（那是识别用的），只是外壳文件名变 ASCII。
    //   例如 `伊蕾娜·默认` → `live2d-elaina-default.zip`（下面有映射表）。
    const ASCII_ALIAS = {
        '伊蕾娜·默认': 'elaina-default',
        deepseek: 'deepseek',
    };
    const safe = ASCII_ALIAS[name]
        || name.replace(/[^\x20-\x7E]/g, '_').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
    const outName = `live2d-${safe}.zip`;
    const outPath = path.join(OUT_DIR, outName);
    await writeFile(outPath, zip);

    return { name, kind: 'model', files: files.length, raw: total, zip: zip.length, outName, outPath };
}

// ============================================================ 主流程
const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const wanted = args.filter((a) => !a.startsWith('--'));

const modIds = existsSync(MODS_DIR)
    ? readdirSync(MODS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
    : [];
const modelNames = existsSync(MODELS_DIR)
    ? readdirSync(MODELS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
    : [];

const pickMods = wanted.length ? modIds.filter((m) => wanted.includes(m)) : modIds;
const pickModels = wanted.length ? modelNames.filter((m) => wanted.includes(m)) : modelNames;

console.log('════════ 将打包 ════════');
console.log('  mods  : ' + (pickMods.join(', ') || '(无)'));
console.log('  模型  : ' + (pickModels.join(', ') || '(无)'));
console.log('  输出到: ' + path.relative(ROOT, OUT_DIR));

if (listOnly) process.exit(0);

if (!pickMods.length && !pickModels.length) {
    console.error('\n没有可打包的内容。检查 web/mods/ 与 web/live2d/models/ 是否存在。');
    process.exit(1);
}

await rm(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const results = [];
for (const id of pickMods) results.push(await packMod(id));
for (const name of pickModels) results.push(await packModel(name));

console.log('\n════════ 打包结果 ════════');
let totalZip = 0;
const rows = [];
for (const r of results) {
    const label = r.id || r.name;
    if (r.error) {
        console.log(`  ❌ ${label.padEnd(20)} ${r.error}`);
        continue;
    }
    totalZip += r.zip;
    rows.push(r);
    const ratio = r.zip < r.raw ? Math.round(r.zip / r.raw * 100) + '%' : '—';
    console.log(`  ✅ ${r.outName.padEnd(28)} ${r.files.toString().padStart(3)} 文件  `
        + `${mb(r.raw).padStart(9)} → ${mb(r.zip).padStart(9)} (压缩率 ${ratio})`);
}
console.log(`\n  合计 ${rows.length} 个 zip，共 ${mb(totalZip)}`);
console.log(`  输出目录：${OUT_DIR}`);

// 顺带写一份上传清单，方便手动传 Releases 时对照
const manifestOut = {
    comment: '由 scripts/pack-assets.mjs 生成。上传到 GitHub Releases 后，把下载链接填到下面。',
    generatedAt: new Date().toISOString(),
    assets: rows.map((r) => ({
        kind: r.kind,
        id: r.id || r.name,
        version: r.version || '',
        file: r.outName,
        sizeBytes: r.zip,
        downloadUrl: '',   // 上传后手动填（或让用户直接粘贴到应用里）
    })),
};
await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifestOut, null, 2), 'utf8');
console.log('  另写出 manifest.json（含上传清单，下载链接待填）');

if (results.some((r) => r.error)) process.exit(1);
