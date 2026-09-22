import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const sourceRoot = path.join(projectRoot, 'web');
const androidWebRoot = path.join(projectRoot, 'android-app', 'www');
const modelsSourceRoot = path.join(sourceRoot, 'live2d', 'models');
const modelsDestRoot = path.join(androidWebRoot, 'live2d', 'models');

// 同步到安卓 www 的文件（覆盖整个定制版 Web 前端）
// 注意：diag-param-bind.html 不在列表里 —— 它依赖服务端的 /api/live2d/models 列模型，
//       而 APK（Capacitor）没有这个服务端，同步过去也只会报"读取模型列表失败"。
const filesToCopy = [
    ['index.html', 'index.html'],
    ['diag-live2d.html', 'diag-live2d.html'],
    ['diag-asr.html', 'diag-asr.html'],
    ['live2d-video.js', 'live2d-video.js'],
    ['vendor/tailwind.js', 'vendor/tailwind.js'],
    ['vendor/live2dcubismcore.min.js', 'vendor/live2dcubismcore.min.js'],
    ['vendor/pixi-6.min.js', 'vendor/pixi-6.min.js'],
    ['vendor/pixi-live2d-display-cubism4.min.js', 'vendor/pixi-live2d-display-cubism4.min.js'],
];

// web/js/ 下的前端脚本：**自动发现**，不写死清单。
//
// 为什么要自动：这些文件是 index.html 用 <script src="/js/xxx.js"> 引用的，漏同步一个
// 就会在 APK 里 404 → 页面白屏，而且 Web 版一切正常、只有装机才暴露，极难查。
// 之前手写清单时，每加一个前端脚本都得记得回来改这里 —— 这个"记得"迟早会失效。
//
// 只收 .js（含子目录），跳过隐藏文件与 .map。
async function collectJsFiles(dir, prefix = '') {
    const out = [];
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
            out.push(...await collectJsFiles(path.join(dir, entry.name), rel));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            out.push(rel);
        }
    }
    return out;
}

const jsFiles = (await collectJsFiles(path.join(sourceRoot, 'js'))).sort();
for (const rel of jsFiles) {
    filesToCopy.push(['js/' + rel, 'js/' + rel]);
}

await mkdir(path.join(androidWebRoot, 'vendor'), { recursive: true });
for (const [src, dest] of filesToCopy) {
    const destPath = path.join(androidWebRoot, dest);
    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(path.join(sourceRoot, src), destPath);
}
console.log(`Synced ${filesToCopy.length} files (customized Web UI incl. Live2D) into the Android project.`);
if (jsFiles.length) console.log(`  frontend scripts: ${jsFiles.map((f) => 'js/' + f).join(', ')}`);

// ==================== 内置 Live2D 模型 ====================
// 仓库里 web/live2d/models/ 下的模型随 APK 分发：复制进安卓工程的 www/live2d/models/，
// 并生成 manifest.json。APK 里没有服务端，模型没法从接口取，只能打包进去：
// App 首次启动时按这份清单把模型"种"进应用数据目录（见 index.html 的 seedBundledLive2dModels），
// 之后列表与加载逻辑跟用户自己上传的模型走同一条路径，不需要额外适配。

/** 递归列出目录下所有文件（返回相对路径，正斜杠分隔） */
async function walk(dir, prefix = '') {
    const out = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) out.push(...await walk(path.join(dir, entry.name), rel));
        else out.push(rel);
    }
    return out;
}

let modelDirs = [];
try {
    modelDirs = (await readdir(modelsSourceRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
} catch { /* 没有模型目录就跳过，不影响前端同步 */ }

if (!modelDirs.length) {
    console.log('No Live2D model in web/live2d/models/ — nothing bundled.');
} else {
    // 先算出这次要写进去的完整文件集，再决定删什么。
    //
    // 原来是先 `rm -rf` 整个 models 目录再重建，但那样一次要删上百个文件，
    // 会撞上运行环境的批量删除保护（单次超过 50 个直接拒绝），整个 build 失败。
    // 改成"只删这次不会再写回去的旧文件"：既绕开了这个问题，也不用每次把没变过的模型重删一遍，
    // 而且中途失败不会留下半个空目录。
    const manifestModels = [];
    const desiredFiles = new Set(['manifest.json']);
    let totalFiles = 0;
    let totalBytes = 0;

    for (const name of modelDirs) {
        const srcDir = path.join(modelsSourceRoot, name);
        const files = (await walk(srcDir)).sort();
        const modelJson = files.find((f) => f.toLowerCase().endsWith('.model3.json'));
        if (!modelJson) {
            console.log(`  skip ${name} (no .model3.json)`);
            continue;
        }
        for (const rel of files) desiredFiles.add(name + '/' + rel);
        totalFiles += files.length;
        // 顺带记下每个文件的字节数：APK 首次启动播种时用它校验"数据目录里已种的文件是否完整"。
        // 只比文件名的话，上次播种中途失败写出的半截文件会被当成"已种过"，坏状态永远修不回来。
        const sizes = {};
        for (const rel of files) {
            const bytes = (await stat(path.join(srcDir, rel))).size;
            sizes[rel] = bytes;
            totalBytes += bytes;
        }
        manifestModels.push({ name, modelJson, files, sizes });
    }

    // 清理残留（模型已从仓库删掉的情况）
    let staleRemoved = 0;
    for (const rel of await walk(modelsDestRoot).catch(() => [])) {
        if (desiredFiles.has(rel)) continue;
        await rm(path.join(modelsDestRoot, rel), { force: true });
        staleRemoved++;
    }
    if (staleRemoved) console.log(`Removed ${staleRemoved} stale file(s) from the Android project.`);

    for (const { name } of manifestModels) {
        const srcDir = path.join(modelsSourceRoot, name);
        for (const rel of await walk(srcDir)) {
            const src = path.join(srcDir, rel);
            const dest = path.join(modelsDestRoot, name, rel);
            await mkdir(path.dirname(dest), { recursive: true });
            await copyFile(src, dest);
        }
    }

    await writeFile(
        path.join(modelsDestRoot, 'manifest.json'),
        JSON.stringify({ version: 1, models: manifestModels }, null, 2) + '\n',
        'utf8',
    );
    console.log(
        `Bundled ${manifestModels.length} Live2D model(s): ${totalFiles} files, `
        + `${(totalBytes / 1048576).toFixed(1)} MB (${manifestModels.map((m) => m.name).join(', ')})`,
    );
}
