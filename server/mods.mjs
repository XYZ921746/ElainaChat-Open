// 插件（mod）的服务端支持：扫描目录 / 自动解压 zip / 生成清单 / 安装与卸载。
//
// ── 为什么需要服务端参与 ──────────────────────────────────────────────────
//
// 浏览器**无法列目录**。前端想知道"有哪些 mod"，只有两条路：
//   ① 有一份清单文件（谁生成？手工维护最容易忘）
//   ② 服务端扫描目录后生成清单（Node 能列目录）
//
// 这里走 ②：把 `xxx.zip` 丢进 web/mods/ 就会被自动解压、写进清单，
// 前端只管读清单。这样"装一个 mod"真的就是"丢个 zip 进去"。
//
// ── 安全（这是 mod 系统最大的风险面）──────────────────────────────────────
//
// mod 的本质是**在同源下执行第三方 JS** —— 和我们修过的 `.html::$DATA`
// 存储型 XSS 是同一类风险。所以解压必须严防三件事：
//
//   ① **路径穿越**：zip 里写 `../../web/serve.mjs` 就能覆盖宿主代码。
//      防护：复用 isUnsafeEntryName + 解析后的绝对路径必须仍在插件目录内（双保险）。
//   ② **覆盖宿主文件**：插件只能写进 mods/<id>/，不能碰 index.html / app-*.js。
//      防护：解压目标目录写死，且拒绝任何逃逸路径。
//   ③ **危险类型**：插件**必须**能带 .js（它就是代码），所以这里**不能**套用
//      BLOCKED_EXT 那套黑名单 —— 那是给 Live2D 模型用的（模型不该带脚本）。
//      插件的取舍是：允许 .js，但**限制在插件自己的目录里**，
//      并且在界面上明确告知用户"安装 mod = 信任它的代码"。
//      同时仍然拦掉 .exe/.dll/.bat 这类**本机可执行**文件 —— 它们在浏览器里
//      本来也不会被执行，但会被下载到磁盘，属于不必要的风险。
//
// ── 与 Live2D 上传的区别 ─────────────────────────────────────────────────
// Live2D 走的是"用户在界面上传 zip"（handleUpload）。插件这里是
// "文件已经在 mods/ 目录里了，服务端自己去发现" —— 因为用户可能是
// 直接用文件管理器把 zip 拷进去的，没有经过浏览器。

import { readdir, stat, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * 插件 **id** 的合法性：只允许字母数字、连字符、下划线、点（且不能是 . / ..）。
 *
 * ★ id 与目录名的约束**不同**，别混用（2026-09 踩过）：
 *   · id 是**身份**：要进 localStorage 键名、要拼资源 URL、要做依赖匹配，
 *     所以收得紧（纯 ASCII、无空格）—— 中文 id 会让 `/mods/<id>/…` 这种
 *     URL 与 localStorage 键都变得难处理。
 *   · 目录名是**磁盘位置**：用户完全可能把它改成中文（"桌宠"）或带空格
 *     （"my pet"）。这类目录**必须照样能识别** —— 它只要是个安全的目录名即可。
 *   旧实现两者共用这一个正则，于是把插件目录改成中文后**直接扫不到**
 *   （连 manifest 都不读），表现为"改个名字插件就消失了"。
 */
const MOD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 插件**目录名**的合法性（比 id 宽松）。
 *
 * 允许中文、空格、括号等常见字符 —— 用户会这样命名。只挡掉真正危险的东西：
 *   · 路径分隔符 `/` `\` 与 `..`（目录穿越）
 *   · 以 `.` 开头（隐藏目录，且 `.`/`..` 本身）
 *   · Windows 非法字符 `<>:"|?*` 与控制字符（建不出这种目录，或建出来无法访问）
 *   · 首尾空白与尾随点（Windows 会静默吃掉，导致名字与预期不符）
 * 长度上限 128，避免异常长的名字。
 */
const MOD_DIR_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,128}$/;
function isSafeModDirName(name) {
    const n = String(name || '');
    if (!n || n === '.' || n === '..') return false;
    if (n.startsWith('.')) return false;              // 隐藏目录 / . ..
    if (n !== n.trim()) return false;                 // 首尾空白
    if (/[. ]$/.test(n)) return false;                // 尾随点/空格（Windows 会吃掉）
    if (n.includes('..')) return false;               // 防穿越（配合上面的分隔符检查）
    return MOD_DIR_RE.test(n);
}

/**
 * 把 zip 文件名归一化成插件 id：剥掉尾部的版本号。
 *
 * ★ 这是修「资源包装了等于没装」的核心（2026-09 实测踩到）：
 *
 *   pack-assets.mjs 的产物名带版本号（`elaina-avatar-1.0.0.zip`），
 *   而旧逻辑直接拿 zip 文件名当插件 id —— 于是插件装进了
 *   `mods/elaina-avatar-1.0.0/`，后果是**两条**同时发生：
 *     ① 插件内部写死的资源 URL（`/mods/elaina-avatar/img/…`）404
 *        → 桌宠 / Galgame 显示不出人物；
 *     ② 依赖它的 mod 声明 `after: ["elaina-avatar"]`，匹配不上实际 id
 *        → 依赖解析失效，加载顺序失去保证。
 *
 *   为什么在**安装端**归一化、而不是让打包去掉版本号：版本号在
 *   Releases 文件名上有用（区分版本、避免浏览器缓存旧包），
 *   该保留的是产物名，该修的是"id 不能等于文件名"。
 *
 *   剥法**只认多段版本号**（`-1.0.0` / `-1.0`），不认单段（`-2`）。
 *   为什么这样划界：`my-mod-2`、`mod-2` 这类"名字里带个序号"的插件很常见，
 *   把 `-2` 当版本号剥掉会把 `my-mod-2` 变成 `my-mod` —— 误伤真实名字。
 *   而打包产物永远是 `x.y.z`（见 pack-assets 的 `${id}-${version}`，
 *   version 来自 manifest，本仓库三个包都是 `1.0.0`），所以只剥带点的形式
 *   既够用、又不会伤到用户自建的插件。
 *   若剥完不合法（比如剥成空串）则原样返回，交由调用方的白名单报错。
 */
function normalizeModId(rawName) {
    const base = String(rawName || '').replace(/\.zip$/i, '');
    // 至少两段数字才算版本号：-1.0 / -1.0.0 / -2.1.3
    const stripped = base.replace(/-[0-9]+\.[0-9]+(\.[0-9]+)*$/, '');
    return (MOD_ID_RE.test(stripped) && MOD_ID_RE.test(base)) ? stripped : base;
}

/** 插件目录里允许落盘的本机可执行类型（拦掉，避免用户误双击） */
const MOD_BLOCKED_EXT = new Set([
    '.exe', '.dll', '.com', '.scr', '.msi', '.bat', '.cmd',
    '.ps1', '.psm1', '.vbs', '.wsf', '.jar', '.sh', '.app', '.deb', '.rpm',
]);

/** 单个插件解压后体积上限（防 zip bomb） */
const MOD_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 插件管理器。
 *
 * @param {object} opts
 * @param {string} opts.modsDir  插件根目录（web/mods）
 * @param {Function} opts.unzip     解压函数（复用 serve.mjs 里那份，已含体积/类型校验）
 * @param {Function} opts.isUnsafeEntryName 条目名安全检查（同上）
 * @param {Function} opts.effectiveExt 取"最终落盘名"的扩展名（含 ADS/尾随点防护）
 * @param {Function} opts.log       日志函数
 */
export function createModManager({ modsDir, unzip, isUnsafeEntryName, effectiveExt, log = () => {} }) {
    const INDEX_FILE = path.join(modsDir, 'index.json');

    /**
     * 读插件目录里的 manifest.json（优先）或从目录名推断。
     *
     * ★ id 的权威来源是 **manifest.id**，不是目录名（2026-09 改）。
     *
     *   旧实现反过来（`{ id: fallbackId, ...m, id: fallbackId }` 用目录名覆盖
     *   manifest 里写的 id），理由是"目录名是解压时定下的，避免 manifest 写错对不上"。
     *   但那条理由成立的前提是"目录名一定对"—— 而 pack-assets 的产物名带版本号，
     *   安装时曾把 `elaina-avatar-1.0.0` 当目录名，于是**目录名才是错的那个**：
     *   插件内部写死的资源 URL 与依赖它的 `after` 全都对不上。
     *
     *   现在改成：manifest.id 合法就用它（它是插件作者声明的身份，也是
     *   资源路径与依赖引用的基准），只有缺失/非法时才回落到目录名。
     *
     * ★ 回落时还会对目录名做 normalizeModId（剥版本号尾），这样
     *   "没写 id 的插件 + 带版本号的目录名"也能得到干净的 id。
     *   `MOD_ID_RE` 校验必须保留 —— manifest 是外部输入，不能直接信。
     */
    async function readManifest(dir, fallbackId) {
        const mf = path.join(dir, 'manifest.json');
        try {
            const raw = await readFile(mf, 'utf8');
            const m = JSON.parse(raw);
            if (m && typeof m === 'object') {
                const declared = typeof m.id === 'string' ? m.id.trim() : '';
                if (declared && MOD_ID_RE.test(declared)) return { ...m, id: declared };
                if (declared) {
                    log(`插件 ${fallbackId} 的 manifest.id 不合法（${declared}），回落到目录名`);
                }
                // 没写 id / 写得不合法 → 用目录名，并剥掉可能的版本号尾
                return { ...m, id: normalizeModId(fallbackId) };
            }
        } catch (e) {
            if (e && e.code !== 'ENOENT') log('插件 manifest.json 解析失败：' + dir + ' —— ' + e.message);
        }
        // 没有 manifest 时给一份最小可用清单：让"只有 index.js 的 mod"也能跑
        return {
            id: normalizeModId(fallbackId),
            name: fallbackId, version: '', description: '', entry: 'index.js',
        };
    }

    /**
     * 解压一个插件 zip 到 mods/<id>/。
     *
     * 安全要点全在这里：
     *   · id 先做白名单校验（挡住 `..` / 绝对路径 / 奇怪字符）
     *   · 目标目录写死为 mods/<id>，且每条目解析后必须仍在其内（双保险）
     *   · 危险的本机可执行类型跳过
     *   · 总解压体积封顶
     */
    /**
     * 从**内存里的 zip** 安装插件（供「应用内上传」用）。
     *
     * 与 extractPluginZip 的区别只在于数据来源：那个从磁盘文件读，这个直接收
     * Buffer。安全逻辑**完全一致**（路径穿越 / 绝对路径 / 危险类型 / 体积上限），
     * 因为两者最终都走同一段解压循环 —— 这是刻意的：安全规则只该有一份。
     *
     * @param {Buffer} buf       zip 内容
     * @param {string} id        插件 id（来自 zip 文件名，会做白名单校验）
     * @returns {Promise<{id, written, skipped}>}
     */
    async function installFromBuffer(buf, id) {
        if (!MOD_ID_RE.test(id)) throw new Error('插件名不合法：' + id);
        if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip 文件');
        return writePluginFiles(buf, id);
    }

    /**
     * 解压并落盘（extractPluginZip 与 installFromBuffer 的公共实现）。
     * 把这段单独抽出来，是为了让"从文件装"和"从上传装"走**同一条安全路径**。
     */
    async function writePluginFiles(buf, id) {
        // ★ allowScripts: true —— mod 的本质就是 JS。
        //   默认的黑名单会把 .js/.mjs 拦掉（那是为 Live2D 模型设计的：模型不该带脚本），
        //   用它解 mod 包会得到"只有 manifest.json、插件跑不起来"的怪现象。
        //   开了这个选项后，路径穿越 / 绝对路径 / 体积上限 / .exe 等仍然全部拦截。
        const { files } = unzip(buf, { allowScripts: true });

        const targetDir = path.join(modsDir, id);
        // 先清空旧目录（重装场景：避免残留上一版的文件）
        await rm(targetDir, { recursive: true, force: true });
        await mkdir(targetDir, { recursive: true });

        // zip 内可能有一层与插件同名的顶层目录 —— 去掉它，把文件平铺到插件目录
        const topCandidates = new Set(files.map((f) => f.name.split('/')[0]));
        const stripTop = topCandidates.size === 1 && files.every((f) => f.name.includes('/'));

        let written = 0;
        let total = 0;
        const skipped = [];
        for (const f of files) {
            let rel = f.name;
            if (stripTop) rel = rel.slice(rel.indexOf('/') + 1);
            if (!rel || rel.endsWith('/')) continue;
            if (isUnsafeEntryName(rel)) { skipped.push(f.name); continue; }

            const outPath = path.join(targetDir, rel);
            // 双保险：解析后的绝对路径必须仍在插件目录内
            if (outPath !== targetDir && !outPath.startsWith(targetDir + path.sep)) {
                skipped.push(f.name);
                continue;
            }
            // 拦掉本机可执行类型（用 effectiveExt：能识破 x.exe::$DATA 这类写法）
            if (MOD_BLOCKED_EXT.has(effectiveExt(path.basename(rel)))) {
                skipped.push(f.name);
                continue;
            }
            total += f.data.length;
            if (total > MOD_MAX_BYTES) {
                await rm(targetDir, { recursive: true, force: true }).catch(() => {});
                throw new Error('插件解压后超过 ' + Math.round(MOD_MAX_BYTES / 1024 / 1024) + 'MB 上限');
            }
            await mkdir(path.dirname(outPath), { recursive: true });
            await writeFile(outPath, f.data);
            written++;
        }
        if (!written) {
            await rm(targetDir, { recursive: true, force: true }).catch(() => {});
            throw new Error('zip 内没有可用文件');
        }
        if (skipped.length) log('插件 ' + id + ' 跳过 ' + skipped.length + ' 个不安全/不允许的条目');
        return { id, written, skipped: skipped.length };
    }

    /** 从磁盘上的 zip 文件安装（扫描目录时自动调用） */
    async function extractPluginZip(zipPath, id) {
        if (!MOD_ID_RE.test(id)) throw new Error('插件名不合法：' + id);
        const buf = await readFile(zipPath);
        return writePluginFiles(buf, id);
    }

    /**
     * 扫描插件目录：解压待安装的 zip，收集已安装的插件，生成 index.json。
     *
     * 什么时候调用：
     *   · 服务启动时（把用户刚拷进来的 zip 装上）
     *   · 前端请求 /api/plugins 时（用户可能在服务运行期间拷了 zip 进来）
     */
    async function scanAndSync() {
        await mkdir(modsDir, { recursive: true }).catch(() => {});
        const entries = await readdir(modsDir, { withFileTypes: true }).catch(() => []);

        const installed = [];   // { id, dir }
        const zips = [];
        for (const e of entries) {
            if (e.name === 'index.json') continue;
            if (e.isDirectory()) {
                // ★ 目录名用 isSafeModDirName（宽松，允许中文/空格），
                //   而不是 MOD_ID_RE（严格 ASCII）—— 用户把插件目录改成
                //   「桌宠」是完全合理的，旧实现会**直接跳过**它。
                if (!isSafeModDirName(e.name)) {
                    log(`跳过目录 ${e.name}：名字含不安全字符或非法形式`);
                    continue;
                }
                installed.push({ id: e.name, dir: path.join(modsDir, e.name) });
            } else if (e.isFile() && /\.zip$/i.test(e.name)) {
                zips.push(e.name);
            }
        }

        // 解压待安装的 zip。id = zip 文件名去掉扩展名。
        //
        // ★ 装成功后**删掉 zip**（一次性安装包）。
        //
        // 为什么必须删：zip 是"待安装"的源，只要它还在目录里，**每次扫描都会
        // 重新解压安装**。于是用户手动删掉插件目录后，下一次扫描（打开设置就会触发）
        // 又把它装回来 —— 表现就是"我明明卸载了，插件列表里还在"。
        // 点「卸载」按钮那条路是对的（它会删 zip），但用户直接删目录时就没辙了。
        //
        // 删掉之后语义就清楚了：目录存在 = 已安装；要重装就再放一次 zip。
        // 这也让"删目录"变成真正有效的卸载方式。
        const installResults = [];
        for (const z of zips) {
            // ★ id 要先过 normalizeModId 剥掉版本号 ——
            //   pack-assets 的产物名是 `elaina-avatar-1.0.0.zip`，
            //   直接拿文件名当 id 会装进 elaina-avatar-1.0.0/，
            //   资源 URL 与 after 依赖同时失效（见 normalizeModId 的说明）。
            const id = normalizeModId(z);
            if (!MOD_ID_RE.test(id)) {
                installResults.push({ zip: z, ok: false, error: '插件名不合法（只允许字母数字、- _ .）' });
                continue;
            }
            // 若归一化后的目录已存在（用户重复放了不同版本的包），明确报出来
            // 而不是静默覆盖 —— 覆盖会把旧版本的用户设置一并带走。
            const targetDir = path.join(modsDir, id);
            const alreadyInstalled = installed.some((i) => i.id === id);
            if (alreadyInstalled) {
                installResults.push({ zip: z, ok: false, error: `插件 ${id} 已安装（如需更新请先删除旧版）` });
                await rm(path.join(modsDir, z), { force: true }).catch(() => {});
                log(`跳过 ${z}：${id} 已安装，安装包已清理`);
                continue;
            }
            try {
                const r = await extractPluginZip(path.join(modsDir, z), id);
                installResults.push({ zip: z, ok: true, id: r.id, files: r.written });
                if (!alreadyInstalled) installed.push({ id, dir: targetDir });
                // 装好即清理安装包（见上面的说明）
                await rm(path.join(modsDir, z), { force: true }).catch(() => {});
                log('已安装插件：' + id + '（' + r.written + ' 个文件，安装包已清理）');
            } catch (err) {
                installResults.push({ zip: z, ok: false, error: String((err && err.message) || err) });
                log('插件安装失败：' + z + ' —— ' + installResults[installResults.length - 1].error);
                // 失败的 zip **保留** —— 用户要能看到它、修好再重试。
                // 删掉的话"装失败"就变成"文件凭空消失"，更难排查。
            }
        }

        // 收集已安装插件的清单
        //
        // ★ 这里同时给出两个名字，各有各的用途（2026-09 修）：
        //   id  —— 归一化后的**身份**：依赖匹配（after）与资源 URL 的基准。
        //          它等于 manifest.id（缺失时才回落到目录名）。
        //   dir —— 磁盘上的**实际目录名**：前端按它拼脚本/样式的 URL。
        // 二者不一致的情况真实存在（历史版本把 `elaina-avatar-1.0.0` 当目录名装过），
        // 只给一个名字必然有一处 404 —— 要么脚本加载不到，要么图片加载不到。
        const list = [];
        for (const it of installed) {
            const m = await readManifest(it.dir, it.id);
            const dirName = path.basename(it.dir);
            list.push({
                id: m.id,
                dir: dirName,
                name: m.name || m.id,
                version: m.version || '',
                description: m.description || '',
                entry: m.entry || 'index.js',
                styles: Array.isArray(m.styles) ? m.styles : [],
                defaultEnabled: m.defaultEnabled !== false,
                after: Array.isArray(m.after) ? m.after : [],
                hidden: m.hidden === true,
                hasManifest: await exists(path.join(it.dir, 'manifest.json')),
            });
        }

        // 写清单。**注意**：保留手工维护的额外字段（比如注释），只覆盖 plugins 数组。
        let prev = {};
        try { prev = JSON.parse(await readFile(INDEX_FILE, 'utf8')); } catch { /* 首次运行 */ }
        const out = {
            ...(prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}),
            comment: '本文件由服务端扫描 mods/ 自动生成（见 server/mods.mjs）。手工改动会在下次扫描时被覆盖。',
            generatedAt: new Date().toISOString(),
            plugins: list,
        };
        await writeFile(INDEX_FILE, JSON.stringify(out, null, 2), 'utf8');

        return { installed: list, results: installResults };
    }

    async function exists(p) {
        try { await stat(p); return true; } catch { return false; }
    }

    /**
     * 卸载：删除插件目录**以及对应的安装包**。
     *
     * 为什么必须连 zip 一起删：目录里那份 `xxx.zip` 是"待安装"的源。
     * 如果只删目录，紧接着的 scanAndSync() 会立刻把它重新解压装回来 ——
     * 用户点「卸载」，mod 转一圈又出现了，看起来像卸载功能坏了。
     * （这个坑是端到端测试抓到的：断言"目录已删除"时发现它又回来了。）
     */
    async function uninstall(id) {
        if (!MOD_ID_RE.test(id)) throw new Error('插件名不合法');
        const dir = path.join(modsDir, id);
        // 双保险：目录必须真的在 modsDir 下
        if (!dir.startsWith(modsDir + path.sep)) throw new Error('路径越界');
        await rm(dir, { recursive: true, force: true });
        // 连同安装包一起删（大小写两种扩展名都试）
        for (const ext of ['.zip', '.ZIP']) {
            await rm(path.join(modsDir, id + ext), { force: true }).catch(() => {});
        }
        await scanAndSync();
        return true;
    }

    return { scanAndSync, uninstall, extractPluginZip, installFromBuffer, MOD_ID_RE };
}
