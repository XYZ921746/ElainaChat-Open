// 把 dist/ 里的扩展包上传到 GitHub Releases。
//
// ── 为什么用 curl 而不是 Node fetch ──────────────────────────────────────
//
// 本机 Node 的 fetch 报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`（找不到签发者证书），
// 因为 Node 不带系统 CA 库、而这里没配 NODE_EXTRA_CA_CERTS。curl 用系统证书库，
// 实测正常（HTTP 200）。所以走 curl —— 比在 Node 里 `rejectUnauthorized:false`
// 安全（后者等于不验证证书）。
//
// ── 凭据从哪来 ───────────────────────────────────────────────────────────
//
// 从 git 的凭据管理器读（`git credential fill`）—— Windows 上 git 把 GitHub token
// 存在凭据管理器里，读出来的就是它。好处是不用在命令行里传 token（那会进历史记录）。
//
// ── 用法 ─────────────────────────────────────────────────────────────────
//
//   node scripts/upload-release.mjs                    # 上传 dist/ 下全部 zip
//   node scripts/upload-release.mjs --tag v1.3.0       # 指定 tag
//   node scripts/upload-release.mjs --dry-run          # 只看会传什么
//   node scripts/upload-release.mjs --repo owner/name  # 换仓库
//
// 行为：tag 对应的 Release 不存在就创建，存在则复用；已存在的同名附件会**覆盖**
// （先删旧的再传新的）—— 否则重复运行会因"附件已存在"报 422。
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPO = 'XYZ921746/ElainaChat-mod';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const repoArg = args[args.indexOf('--repo') + 1];
const repo = args.includes('--repo') ? repoArg : DEFAULT_REPO;
const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : 'v1.3.0-mod';

function ghToken() {
    try {
        const out = execFileSync('git', ['credential', 'fill'], {
            input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
        });
        const m = out.match(/password=(.*)/);
        return m ? m[1].trim() : '';
    } catch { return ''; }
}

/** 调 GitHub API（用 curl，见文件头说明） */
function api(method, endpoint, { body, contentType, raw } = {}) {
    const token = ghToken();
    if (!token) throw new Error('拿不到 GitHub token（git credential fill 失败）');
    const url = endpoint.startsWith('http') ? endpoint : 'https://api.github.com' + endpoint;
    const curlArgs = ['-s', '-X', method, '-H', 'Authorization: Bearer ' + token,
        '-H', 'User-Agent: elainachat-release', '-H', 'Accept: application/vnd.github+json'];
    if (contentType) curlArgs.push('-H', 'Content-Type: ' + contentType);
    let tmpFile = null;
    if (body !== undefined) {
        if (Buffer.isBuffer(body) || raw) {
            // 二进制体：写临时文件后 --data-binary @file（避免命令行长度限制与转义问题）
            tmpFile = path.join(os.tmpdir(), 'gh-upload-' + Date.now() + '.bin');
            writeFileSync(tmpFile, body);
            curlArgs.push('--data-binary', '@' + tmpFile);
        } else {
            curlArgs.push('-d', typeof body === 'string' ? body : JSON.stringify(body));
        }
    }
    curlArgs.push('-w', '\n%{http_code}', url);
    try {
        const out = execFileSync('curl', curlArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
        const lines = out.trimEnd().split('\n');
        const status = Number(lines.pop());
        return { status, text: lines.join('\n') };
    } finally {
        if (tmpFile) { try { rmSync(tmpFile, { force: true }); } catch { /* 忽略 */ } }
    }
}

/** 上传单个文件到 upload_url（GitHub 的 uploads 域名，不是 api.github.com） */
function uploadAsset(uploadUrl, filePath, fileName) {
    const token = ghToken();
    const base = uploadUrl.replace('{?name,label}', '');
    const url = base + '?name=' + encodeURIComponent(fileName);
    const out = execFileSync('curl', [
        '-s', '-X', 'POST',
        '-H', 'Authorization: Bearer ' + token,
        '-H', 'User-Agent: elainachat-release',
        '-H', 'Content-Type: application/zip',
        '--data-binary', '@' + filePath,
        '-w', '\n%{http_code}',
        url,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 1800000 });
    const lines = out.trimEnd().split('\n');
    const status = Number(lines.pop());
    return { status, text: lines.join('\n') };
}

// ============================================================ 主流程
console.log('════════ GitHub Releases 上传 ════════');
console.log('  仓库: ' + repo);
console.log('  tag : ' + tag);
console.log('  模式: ' + (dryRun ? '试运行（不实际上传）' : '实际上传'));

// 1. 收集要上传的文件
//
// ★ 优先传**拆开的**单个包（`dist/assets/*.zip`），而不是合并的大包。
//
//   理由：用户常常只需要其中一个（比如只装桌宠，或只补一个 Live2D 模型）。
//   上线一个 22.6MB 的合并包的话，他得先下完再解压才能拿到想要的那个文件。
//   拆开传 = 每个包一个直链，按需下载。
//
//   如果 dist/assets/ 不存在（比如用户手工整理了 dist/），才退回到
//   dist/ 下的 zip（那种情况通常就是合并包）。
const assetsDir = path.join(ROOT, 'dist', 'assets');
const useSplit = existsSync(assetsDir);
const dirs = useSplit ? [assetsDir] : [path.join(ROOT, 'dist')];

const files = [];
const skipped = [];
for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.zip')) continue;
        const p = path.join(dir, f);
        if (!statSync(p).isFile()) continue;
        // ★ 只接受纯 ASCII 文件名。
        //
        //   实测：`live2d-伊蕾娜·默认.zip` 经 curl 传上去后变成了 `live2d-.zip`
        //   —— 中文在「Windows 命令行 → curl → GitHub API」这条链路上丢了，
        //   结果是附件名残缺、下载链接也没法用。
        //   与其传上去一个坏名字，不如在这里明确拦住并提示重新打包
        //   （pack-assets.mjs 已保证产物名是 ASCII）。
        if (/[^\x20-\x7E]/.test(f)) { skipped.push(f); continue; }
        files.push({ name: f, path: p, size: statSync(p).size });
    }
}
if (skipped.length) {
    console.log('\n  ⚠️ 跳过 ' + skipped.length + ' 个非 ASCII 文件名（上传后会变残缺，如 live2d-.zip）：');
    for (const s of skipped) console.log('      ' + s);
    console.log('      请跑 `npm run pack:assets` 重新打包（产物名已改为 ASCII）');
}
if (!files.length) {
    console.error('\n❌ 没找到可上传的 .zip。先跑 `npm run pack:assets`。');
    process.exit(1);
}
console.log('\n  来源: ' + path.relative(ROOT, dirs[0]) + (useSplit ? '（拆分的单个包，便于按需下载）' : '（合并包）'));
console.log('  待上传 ' + files.length + ' 个文件：');
let totalSize = 0;
for (const f of files) { totalSize += f.size; console.log(`    ${f.name.padEnd(30)} ${(f.size / 1048576).toFixed(2)} MB`); }
console.log(`    ${'合计'.padEnd(30)} ${(totalSize / 1048576).toFixed(2)} MB`);

if (dryRun) { console.log('\n（试运行结束，未上传）'); process.exit(0); }

// 2. 找或建 Release
console.log('\n── 查找 Release ──');
let rel = api('GET', `/repos/${repo}/releases/tags/${tag}`);
let release = null;
if (rel.status === 200) {
    release = JSON.parse(rel.text);
    console.log('  已存在（id=' + release.id + '），复用');
} else if (rel.status === 404) {
    console.log('  不存在，创建新 Release');
    const create = api('POST', `/repos/${repo}/releases`, {
        contentType: 'application/json',
        body: {
            tag_name: tag,
            name: tag + ' 扩展包（插件 + Live2D 模型）',
            body: [
                '## 扩展包（插件 + Live2D 模型）',
                '',
                '程序本体不含这些资源，按需下载后安装（见 README 的「扩展包」章节）。',
                '',
                '### 插件（放 `插件/`）',
                '- `elaina-avatar` — 立绘与情绪识别，**公共依赖**，Galgame 与桌宠都要它',
                '- `galgame` — 全屏剧情界面（31 张场景背景）',
                '- `pet` — 桌宠悬浮层',
                '',
                '### Live2D 模型（放 `live2d/`）',
                '- `live2d-deepseek`、`live2d-伊蕾娜·默认`',
                '',
                '### 安装',
                '1. 下载需要的 `.zip`（**不要解压**）',
                '2. 程序内：设置 → 插件 → 上传安装（模型走 设置 → Live2D → 上传模型）',
                '3. 装完在列表里打开开关（插件默认关闭）',
                '',
                '> `galgame` 与 `pet` 依赖 `elaina-avatar`，只装前者会没有立绘。',
            ].join('\n'),
            draft: false,
            prerelease: false,
        },
    });
    if (create.status !== 201) {
        console.error('  创建失败 HTTP ' + create.status + '：' + create.text.slice(0, 300));
        process.exit(1);
    }
    release = JSON.parse(create.text);
    console.log('  已创建（id=' + release.id + '）');
} else {
    console.error('  查询失败 HTTP ' + rel.status + '：' + rel.text.slice(0, 300));
    process.exit(1);
}

// 3. 逐个上传（同名先删，否则 422）
console.log('\n── 上传附件 ──');
let uploaded = 0, failed = 0;
for (const f of files) {
    // 已存在同名 → 先删
    const old = (release.assets || []).find((a) => a.name === f.name);
    if (old) {
        const del = api('DELETE', `/repos/${repo}/releases/assets/${old.id}`);
        console.log(`  ${f.name}：已存在，先删除旧版（HTTP ${del.status}）`);
    }
    process.stdout.write(`  ${f.name} … `);
    const r = uploadAsset(release.upload_url, f.path, f.name);
    if (r.status === 201) {
        uploaded++;
        console.log('✅');
    } else {
        failed++;
        console.log('❌ HTTP ' + r.status + ' ' + r.text.slice(0, 200));
    }
}

console.log('\n════════ 结果 ════════');
console.log(`  成功 ${uploaded}   失败 ${failed}`);
console.log(`  下载页：https://github.com/${repo}/releases/tag/${tag}`);
if (failed) process.exit(1);
