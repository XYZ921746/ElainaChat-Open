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

await mkdir(path.join(androidWebRoot, 'vendor'), { recursive: true });
for (const [src, dest] of filesToCopy) {
    await copyFile(path.join(sourceRoot, src), path.join(androidWebRoot, dest));
}
console.log(`Synced ${filesToCopy.length} files (customized Web UI incl. Live2D) into the Android project.`);

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
    // 先整体清掉上次同步的模型，避免已从仓库删除的模型残留在 APK 里
    await rm(modelsDestRoot, { recursive: true, force: true });

    const manifestModels = [];
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
        for (const rel of files) {
            const src = path.join(srcDir, rel);
            const dest = path.join(modelsDestRoot, name, rel);
            await mkdir(path.dirname(dest), { recursive: true });
            await copyFile(src, dest);
            totalBytes += (await stat(src)).size;
        }
        totalFiles += files.length;
        manifestModels.push({ name, modelJson, files });
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
