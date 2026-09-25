// "看电脑在干什么" —— 读取前台窗口标题/文本、正在运行的进程。
//
// ── 这个模块解决什么 ────────────────────────────────────────────────────
//
// 用户要求：桌宠模式让 AI **知道你在干什么**，从而主动搭话。
// 上游桌宠（C# / WPF）用 `UiTextReader.cs` 做这件事 —— 靠 .NET 的
// `System.Windows.Automation`（UIAutomation）读前台窗口的标题与控件文本。
//
// 我们是 Web 应用，浏览器里拿不到 UIAutomation。但**服务端可以** ——
// `web/serve.mjs` 就跑在同一台电脑上，而它本来就在调 PowerShell
// （见 resolveShellFolders）。所以走 PowerShell 调 .NET，能力等价，
// 且**不需要新增任何依赖**（powershell.exe 是 Windows 自带）。
//
// ── 为什么单独成模块（不直接写进 serve.mjs）────────────────────────────
//
// ① 可测：纯函数式，输入输出清晰，能脱离 HTTP 层单测
// ② 可复用：以后"AI 操作电脑"要判断"当前在哪个窗口"，直接调这里
// ③ serve.mjs 已经 2600+ 行，安全相关的逻辑该往外挪
//
// ── 安全边界 ───────────────────────────────────────────────────────────
//
//   · **只读**：本模块不执行写操作、不启动程序、不改变系统状态
//   · **只本机**：调用方（serve.mjs）必须限制 isLocalRequest —— 这是
//     "用户在看什么"的隐私数据，绝不能经局域网泄露
//   · **长度上限**：窗口文本截断，避免一个超大文档把提示词撑爆
//   · **超时**：外部进程调用统一超时，避免卡死请求
import { execFileSync } from 'node:child_process';

/** 窗口文本上限（字符）。与上游 UiTextReader 的 MaxChars 一致（8000）。 */
const MAX_WINDOW_TEXT = 8000;

/** 外部命令超时（毫秒）。UIAutomation 遍历控件可能慢，给宽一点。 */
const CMD_TIMEOUT = 8000;

/**
 * 解码命令行输出。
 *
 * Windows 上 powershell.exe 的输出编码**取决于控制台代码页**（中文系统是 GBK/936），
 * 直接 toString('utf8') 会得到乱码。这里与 serve.mjs 的 decodeCliText 同思路：
 * 先按 UTF-8 试，出现替换字符就退回 GBK。
 */
function decode(buf) {
    const utf8 = buf.toString('utf8');
    if (!utf8.includes('\uFFFD')) return utf8;
    try { return new TextDecoder('gbk').decode(buf); } catch { return utf8; }
}

/** 跑一段 PowerShell，返回输出（失败返回空串，不抛） */
function runPowerShell(script) {
    try {
        const raw = execFileSync('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { timeout: CMD_TIMEOUT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
        return decode(raw);
    } catch {
        // 失败不抛：这是"锦上添花"的能力，拿不到就返回空，
        // 让上层决定怎么提示（不要因为读不到窗口就把整个请求搞成 500）
        return '';
    }
}

/**
 * 读当前**前台窗口**的标题与可见文本。
 *
 * 用的是 UIAutomation（与上游 UiTextReader 同一套 API）：
 *   ① GetForegroundWindow 拿前台窗口句柄
 *   ② AutomationElement.FromHandle 拿到自动化元素树
 *   ③ 递归收集 Name 属性（控件可读文本），带去重与深度保护
 *
 * 为什么不用 OCR/截图：用户要的是"知道你在干什么"，界面文本比像素更直接、
 * 更省 token，也不需要视觉模型。截图那条路留给"AI 操作电脑"再看。
 *
 * @returns {{ ok: boolean, title?: string, text?: string, reason?: string }}
 */
export function readForegroundWindow() {
    if (process.platform !== 'win32') {
        return { ok: false, reason: '仅支持 Windows（本机是 ' + process.platform + '）' };
    }

    const script = `
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

    $sig = @'
using System;
using System.Runtime.InteropServices;
public class FgWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
    if (-not ('FgWin' -as [type])) { Add-Type -TypeDefinition $sig }

    $hwnd = [FgWin]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"reason":"拿不到前台窗口"}'; exit 0 }

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $root) { Write-Output '{"ok":false,"reason":"无法访问该窗口（可能权限不足）"}'; exit 0 }

    $title = ''
    try { $title = $root.Current.Name } catch {}

    # 递归收集文本：深度与同级数量都设上限，避免大页面卡死
    $sb = New-Object System.Text.StringBuilder
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $maxChars = ${MAX_WINDOW_TEXT}
    $maxDepth = 12
    $maxSiblings = 800

    function Collect($el, $depth) {
        if ($null -eq $el -or $depth -gt $maxDepth -or $sb.Length -ge $maxChars) { return }
        $name = $null
        try { $name = $el.Current.Name } catch {}
        if ($name -and $name.Trim().Length -gt 0) {
            if ($seen.Add($name)) { [void]$sb.AppendLine($name.Trim()) }
        }
        try {
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            $child = $walker.GetFirstChild($el)
            $n = 0
            while ($null -ne $child -and $n -lt $maxSiblings -and $sb.Length -lt $maxChars) {
                Collect $child ($depth + 1)
                $child = $walker.GetNextSibling($child)
                $n++
            }
        } catch {}
    }
    Collect $root 0

    $text = $sb.ToString()
    if ($text.Length -gt $maxChars) { $text = $text.Substring(0, $maxChars) }

    $out = [ordered]@{ ok = $true; title = $title; text = $text }
    ConvertTo-Json -InputObject $out -Compress -Depth 3
} catch {
    Write-Output ('{"ok":false,"reason":"' + ($_.Exception.Message -replace '"', "'") + '"}')
}
`;
    const out = runPowerShell(script).trim();
    if (!out) return { ok: false, reason: 'PowerShell 无输出（可能被安全策略拦截）' };
    try {
        const j = JSON.parse(out);
        if (j && j.ok) {
            return {
                ok: true,
                title: String(j.title || ''),
                text: String(j.text || '').slice(0, MAX_WINDOW_TEXT),
            };
        }
        return { ok: false, reason: String((j && j.reason) || '未知错误') };
    } catch {
        return { ok: false, reason: '输出解析失败：' + out.slice(0, 120) };
    }
}

/**
 * 列出正在运行的进程（按内存占用降序）。
 *
 * 用途：AI 判断"用户在干什么"（在写代码？在看视频？在玩游戏？），
 * 以及桌宠主动搭话时的场景线索。
 *
 * **刻意不返回命令行参数** —— 那里面常有密钥、路径等敏感信息，
 * 而判断"在用什么程序"只需要进程名。
 *
 * @param {number} limit 最多返回多少个（默认 30）
 * @returns {{ ok: boolean, processes?: Array<{name, memMB, cpu}> , reason?: string }}
 */
export function listProcesses(limit = 30) {
    if (process.platform !== 'win32') {
        return { ok: false, reason: '仅支持 Windows（本机是 ' + process.platform + '）' };
    }
    const n = Math.max(1, Math.min(Number(limit) || 30, 100));
    // 按工作集（内存）降序取前 N 个：占用大的通常是"正在用的"程序，
    // 比按名字排更有参考价值。CPU 瞬时值需要两次采样，这里不取（代价大、意义有限）。
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$list = Get-Process | Where-Object { $_.WorkingSet64 -gt 0 } |
    Sort-Object WorkingSet64 -Descending | Select-Object -First ${n} |
    ForEach-Object {
        [ordered]@{
            name  = $_.ProcessName
            memMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
            title = $(if ($_.MainWindowTitle) { $_.MainWindowTitle } else { '' })
        }
    }
ConvertTo-Json -InputObject @($list) -Compress -Depth 3
`;
    const out = runPowerShell(script).trim();
    if (!out) return { ok: false, reason: 'PowerShell 无输出' };
    try {
        const arr = JSON.parse(out);
        const list = (Array.isArray(arr) ? arr : [arr]).filter(Boolean).map((p) => ({
            name: String(p.name || ''),
            memMB: Number(p.memMB) || 0,
            // 只保留有窗口标题的（能说明"用户在看什么"），且截断
            title: String(p.title || '').slice(0, 120),
        }));
        return { ok: true, processes: list };
    } catch {
        return { ok: false, reason: '输出解析失败：' + out.slice(0, 120) };
    }
}

/**
 * 汇总"当前在干什么"，供拼进提示词。
 *
 * 把前台窗口与进程列表压成一小段文本 —— 提示词要省 token，
 * 不该把整份进程表塞进去。
 *
 * @returns {{ ok: boolean, summary?: string, foreground?: object, processes?: array, reason?: string }}
 */
export function activitySummary() {
    const fg = readForegroundWindow();
    const ps = listProcesses(20);
    if (!fg.ok && !ps.ok) {
        return { ok: false, reason: fg.reason || ps.reason || '无法读取' };
    }

    const lines = [];
    if (fg.ok) {
        lines.push('当前前台窗口：' + (fg.title || '(无标题)'));
        const body = String(fg.text || '').trim();
        if (body) lines.push('窗口内可见文本（截断）：\n' + body.slice(0, 1200));
    }
    if (ps.ok) {
        // 只列名字与内存，且去掉常见后台进程噪音
        const noisy = /^(svchost|conhost|dllhost|RuntimeBroker|SearchIndexer|ctfmon|Taskmgr)$/i;
        const top = ps.processes.filter((p) => !noisy.test(p.name)).slice(0, 12);
        lines.push('占用内存较高的进程：' + top.map((p) => p.name + '(' + p.memMB + 'MB)').join('、'));
    }
    return {
        ok: true,
        summary: lines.join('\n'),
        foreground: fg.ok ? { title: fg.title, textLength: String(fg.text || '').length } : null,
        processes: ps.ok ? ps.processes : [],
    };
}

export const __test__ = { MAX_WINDOW_TEXT, CMD_TIMEOUT, decode };

// ============================================================================
//  缓存
//
//  ── 为什么需要 ────────────────────────────────────────────────────────
//
//  实测单次调用耗时：读前台窗口 ~2.6s、列进程 ~1.7s（PowerShell 启动 +
//  UIAutomation 遍历控件树）。如果每次拼提示词都同步调，每轮对话要多等
//  4 秒 —— 不可接受。
//
//  ── 缓存策略 ──────────────────────────────────────────────────────────
//
//  · 有 TTL（默认 10 秒）：避免"完全实时"带来的性能问题，同时保证
//    "AI 看到的"不会太旧（10 秒前你在干什么，基本还是现在在干什么）
//  · 失败结果**也缓存**但 TTL 短（3 秒）：读不到时不要立刻反复重试
//    （每次都要 2.6 秒），但也不能缓存太久 —— 用户可能刚切了窗口
//  · 提供 force 参数绕过缓存（需要精确判断时用）
// ============================================================================

const CACHE_TTL_OK = 10_000;
const CACHE_TTL_FAIL = 3_000;
const cache = new Map();   // key → { at, value }

function cached(key, ttlOk, producer) {
    const hit = cache.get(key);
    const now = Date.now();
    if (hit) {
        const ttl = hit.value && hit.value.ok ? ttlOk : CACHE_TTL_FAIL;
        if (now - hit.at < ttl) return hit.value;
    }
    const value = producer();
    cache.set(key, { at: now, value });
    return value;
}

/** 带缓存的读前台窗口 */
export function foregroundCached(force = false) {
    if (force) cache.delete('fg');
    return cached('fg', CACHE_TTL_OK, readForegroundWindow);
}

/** 带缓存的列进程 */
export function processesCached(limit = 30, force = false) {
    const key = 'ps:' + limit;
    if (force) cache.delete(key);
    return cached(key, CACHE_TTL_OK, () => listProcesses(limit));
}

/**
 * 带缓存的"当前在干什么"汇总（给提示词用）。
 *
 * 这是给 AI 用的主入口 —— 它内部走的也是上面两个缓存，
 * 所以一轮对话里多处调用不会重复付 4 秒的代价。
 */
export function activitySummaryCached(force = false) {
    if (force) { cache.delete('fg'); cache.delete('sum'); }
    return cached('sum', CACHE_TTL_OK, () => {
        const fg = foregroundCached(false);
        const ps = processesCached(20, false);
        if (!fg.ok && !ps.ok) {
            return { ok: false, reason: fg.reason || ps.reason || '无法读取' };
        }
        const lines = [];
        if (fg.ok) {
            lines.push('当前前台窗口：' + (fg.title || '(无标题)'));
            const body = String(fg.text || '').trim();
            if (body) lines.push('窗口内可见文本（截断）：\n' + body.slice(0, 1200));
        }
        if (ps.ok) {
            const noisy = /^(svchost|conhost|dllhost|RuntimeBroker|SearchIndexer|ctfmon|Taskmgr)$/i;
            const top = ps.processes.filter((p) => !noisy.test(p.name)).slice(0, 12);
            lines.push('占用内存较高的进程：' + top.map((p) => p.name + '(' + p.memMB + 'MB)').join('、'));
        }
        return {
            ok: true,
            summary: lines.join('\n'),
            foreground: fg.ok ? { title: fg.title, textLength: String(fg.text || '').length } : null,
            processes: ps.ok ? ps.processes : [],
        };
    });
}
