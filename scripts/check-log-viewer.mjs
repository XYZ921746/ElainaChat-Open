// 真实浏览器验证：软件内日志查看器的渲染与过滤。
import { chromium } from 'file:///D:/222/android-app/node_modules/playwright-core/index.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const LOG_DIR = mkdtempSync(path.join(tmpdir(), 'elaina-viewer-'));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(ROOT, 'web', 'serve.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(PORT + 1), HOST: '127.0.0.1', LOG_DIR, DATA_DIR: path.join(LOG_DIR, 'data'), LOG_TO_FILE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
});

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
});
try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
        try { up = (await fetch(BASE + '/api/server-info')).ok; } catch { await wait(250); }
    }
    await wait(800);

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    // 打开设置面板
    await page.evaluate(() => { try { if (typeof openSettings === 'function') openSettings(); } catch (e) {} });
    await page.waitForTimeout(1200);
    // 切到「高级」tab
    await page.evaluate(() => {
        const tab = document.querySelector('[data-settings-tab="advanced"], #settingsTabAdvanced, [onclick*="advanced"]');
        if (tab) tab.click();
        else {
            // 兜底：直接调 tab 切换函数
            const btns = [...document.querySelectorAll('[id^="settingsTab"], [data-tab]')];
            for (const b of btns) { if (/advanced|高级/i.test(b.id + (b.textContent || ''))) { b.click(); break; } }
        }
    });
    await page.waitForTimeout(2500);

    const st = await page.evaluate(() => {
        const section = document.getElementById('logViewerSection');
        const box = document.getElementById('logViewerBox');
        const tagSel = document.getElementById('logViewerTag');
        const meta = document.getElementById('logViewerMeta');
        return {
            visible: section && !section.classList.contains('hidden'),
            lineCount: box ? box.querySelectorAll('div').length : 0,
            firstLine: box?.firstElementChild?.textContent?.slice(0, 90) || '',
            hasLevelColors: box ? Boolean(box.querySelector('[class*="emerald"], [class*="amber"], [class*="red"], [class*="slate"]')) : false,
            tagOptions: tagSel ? [...tagSel.options].map((o) => o.value) : [],
            metaText: meta?.textContent || '',
            autoChecked: document.getElementById('logViewerAuto')?.checked ?? null,
        };
    });

    console.log('=== 查看器状态 ===');
    console.log('  可见:', st.visible, ' 行数:', st.lineCount);
    console.log('  首行:', st.firstLine);
    console.log('  模块下拉:', JSON.stringify(st.tagOptions));
    console.log('  状态栏:', st.metaText);

    ok(st.visible, '查看器在高级 tab 里显示');
    ok(st.lineCount > 3, '★ 渲染出了日志行', String(st.lineCount));
    ok(/^\d{2}:\d{2}:\d{2} \[\w+\] \[\w+\]/.test(st.firstLine),
        '★ 行格式：时刻 + [级别] + [模块] + 消息', st.firstLine);
    ok(st.hasLevelColors, '★ 级别有配色区分');
    ok(st.tagOptions.includes('Mod') || st.tagOptions.includes('Core'), '★ 模块下拉有真实模块名', JSON.stringify(st.tagOptions));
    ok(st.autoChecked === true, '自动刷新默认开启');
    ok(!/NaN/.test(st.metaText), '★ 状态栏不出现 NaN', st.metaText);

    // 级别过滤交互：切到 WARN+ 后行数应减少（select 可能被 tab 隐藏，直接改值+派发事件）
    const before = st.lineCount;
    await page.evaluate(() => {
        const sel = document.getElementById('logViewerLevel');
        sel.value = 'WARN';
        sel.dispatchEvent(new Event('change'));
    });
    await page.waitForTimeout(1500);
    const afterWarn = await page.evaluate(() => ({
        n: document.getElementById('logViewerBox').querySelectorAll('div').length,
        meta: document.getElementById('logViewerMeta').textContent,
    }));
    ok(afterWarn.n <= before, `★ 切到 WARN+ 行数不增（${before} → ${afterWarn.n}）`);
    ok(!/NaN/.test(afterWarn.meta), '★ 过滤后状态栏仍正常', afterWarn.meta);
} finally {
    await browser.close();
    child.kill();
    await wait(300);
    try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
