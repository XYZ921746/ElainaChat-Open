import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const sourceRoot = path.join(projectRoot, 'web');
const androidWebRoot = path.join(projectRoot, 'android-app', 'www');

// 同步到安卓 www 的文件（覆盖整个定制版 Web 前端）
// 注意：live2d/models/ 不随 APK 分发（用户模型本地，运行时上传）
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
