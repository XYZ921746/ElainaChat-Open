// 登录防爆破 —— 失败计数、指数退避、全局限流。
//
// ── 为什么单独成模块（不写进 serve.mjs）────────────────────────────────
//
//  ① **可测**：锁定策略算错了，密码强度再高也是空的。这里全是可注入时钟的纯逻辑，
//     能脱离 HTTP 层穷举断言"第 N 次失败该锁多久""换 IP 能不能绕开"。
//  ② serve.mjs 已 2900+ 行，安全判定该往外挪（与 pc-command.mjs / activity.mjs 同一理由）。
//  ③ 策略会长期演进（分布式爆破的手法在变），集中一处才好维护。
//
// ── 为什么这块在"局域网可执行命令"之后变得关键 ────────────────────────
//
//  放开之前，局域网设备即使猜中密码，也只能聊天 + 读写 web/；
//  放开之后，**它可以直接在这台电脑上执行任意 PowerShell 命令**。
//  也就是说：密码从"聊天室的钥匙"变成了"整台电脑的钥匙"，
//  而密码是唯一还站着的那道门 —— 所以暴力破解防护不再是加分项，是必需项。
//
// ── 三层防护，缺一不可 ─────────────────────────────────────────────────
//
//  ① **单 IP 指数退避**：连续失败后锁定时间逐次翻倍（30s → 1m → 2m … 上限 1h）。
//     固定窗口（旧实现的"5 次 / 锁 60 秒"）等于告诉攻击者"每 60 秒可以试 5 次" ——
//     保持低频就能无限试下去，一天能试七千多次。
//  ② **全局限流**：所有来源的失败汇总计数，超阈值临时冻结**全部**登录。
//     只按 IP 锁挡不住换 IP 的爆破（局域网里换地址尤其容易，DHCP 续租就行）。
//  ③ **计数只在成功时清零**：锁定到期**不重置**计数，所以持续攻击的锁定时间只增不减。
//     若到期即归零，攻击者每轮都能拿满 5 次机会，指数退避就形同虚设。
//
//  另外，每次校验都走 scrypt（见 serve.mjs 的 verifyPassword）—— 单次尝试本身就
//  要几十毫秒 CPU。这道"固有成本"配合上面的限流，才让 8 位以上的密码真正安全。

/** 密码最短长度。6 位在离线爆破下是秒级，配合"局域网可执行命令"不可接受。 */
export const PWD_MIN_LEN = 8;

/** 密码最长长度（scrypt 的输入长度上限，防超大 body）。 */
export const PWD_MAX_LEN = 128;

/**
 * 极常见弱口令。不追求穷尽字典（那是离线爆破的事），
 * 只挡住"用户图省事直接敲的"那几条 —— 它们占了真实弱密码的绝大多数。
 */
const WEAK_PASSWORDS = new Set([
    'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd',
    '12345678', '123456789', '1234567890', '87654321',
    'qwerty123', 'qwertyui', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm1',
    'abc12345', 'abcd1234', 'a1234567', 'admin123', 'administrator1',
    'letmein1', 'iloveyou1', 'welcome1', 'monkey123', 'dragon123',
    'elaina123', 'elainachat1', 'sunshine1', 'princess1', 'football1',
]);

/** 整串就是顺子/键盘序（12345678、abcdefgh、qwertyui…） */
const SEQUENCES = [
    '0123456789', '9876543210',
    'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba',
    'qwertyuiop', 'poiuytrewq', 'asdfghjkl', 'lkjhgfdsa', 'zxcvbnm', 'mnbvcxz',
];

/**
 * 校验新密码强度。
 *
 * 规则（按用户要求）：至少 8 位，且**同时**含数字、小写字母、大写字母。
 * 在此之上再挡两条最常见的敷衍写法：纯重复字符、纯顺子/键盘序，
 * 以及一小份极常见弱口令表。
 *
 * 刻意**不**强制特殊字符：那会把人逼去写 `Password1!` 这类可预测的形态，
 * 收益低于"更长 + 三类字符"本身。
 *
 * @param {string} pwd
 * @returns {{ok:true} | {ok:false, message:string}}
 */
export function validatePasswordStrength(pwd) {
    const s = String(pwd == null ? '' : pwd);
    if (s.length < PWD_MIN_LEN) return { ok: false, message: `新密码至少 ${PWD_MIN_LEN} 位` };
    if (s.length > PWD_MAX_LEN) return { ok: false, message: '新密码过长' };

    const missing = [];
    if (!/[0-9]/.test(s)) missing.push('数字');
    if (!/[a-z]/.test(s)) missing.push('小写字母');
    if (!/[A-Z]/.test(s)) missing.push('大写字母');
    if (missing.length) {
        return { ok: false, message: `新密码必须同时包含${missing.join('、')}（当前缺${missing.join('、')}）` };
    }

    const lower = s.toLowerCase();
    // ① 精确命中常见弱口令
    if (WEAK_PASSWORDS.has(lower)) {
        return { ok: false, message: '这个密码太常见了，很容易被猜到，请换一个' };
    }
    // ② 弱口令 + 少量后缀/前缀（admin123a、password1x 这类"加个尾巴"的写法）
    //
    //    实测必要性：不拦这个，`admin123a` 会因为"多了一个 a"而通过 ——
    //    而它在任何字典攻击里都是第一梯队。
    for (const w of WEAK_PASSWORDS) {
        if (w.length < 6) continue;
        if (lower.startsWith(w) && lower.length - w.length <= 2) {
            return { ok: false, message: '这个密码是在常见弱口令后面加了几位，很容易被猜到，请换一个' };
        }
        if (lower.endsWith(w) && lower.length - w.length <= 2) {
            return { ok: false, message: '这个密码是在常见弱口令前面加了几位，很容易被猜到，请换一个' };
        }
    }
    // ③ 短模式重复（Ab1Ab1Ab1、abcabcabc 这类）
    //    注：单字符重复（aaaaaaaa）到不了这里 —— 它已经因为"缺数字/大写"被上面挡掉了。
    if (/^(.{1,4})\1+$/.test(s)) {
        return { ok: false, message: '新密码是同一段内容重复，请换一个' };
    }
    // ③b 字符种类太少（Aaa1aaaa：只有 a/A/1 三种，熵极低但字面满足"三类字符"）
    //
    //     实测必要性：上面所有规则都拦不住它，而它的实际强度远低于"8 位随机"。
    //     要求至少 4 种不同字符是个便宜的兜底 —— 正常密码（Elaina2024、MyPc-2024）
    //     都远超这个数，只有刻意敷衍的才会卡住。
    const distinct = new Set(s).size;
    if (distinct < 4) {
        return { ok: false, message: '新密码用到的字符太少了（至少要用 4 种不同字符），请换一个' };
    }
    // ④ 顺子 / 键盘序：找**最长**的连续段，若去掉它之后剩不下什么，就是敷衍写法。
    //
    //    为什么按"最长连续段"判、而不是"是否包含某个 6 连"：
    //    `12345678aA` 里含 '123456'，但用"包含即拒"会把 `xKp123456zQ`
    //    这种正常密码也误杀。按"剩余长度"判既能拦住顺子为主体的密码，
    //    又不会伤到"顺子只是碰巧出现"的密码。
    const longest = longestSequentialRun(lower);
    if (longest >= 6 && s.length - longest <= 2) {
        return { ok: false, message: '新密码里几乎全是连续顺序（如 12345678、qwertyui），请换一个' };
    }
    return { ok: true };
}

/**
 * 找出密码里"最长的一段连续顺序"有多长。
 *
 * 做法：对每个已知序列（数字顺、字母顺、各键盘行），枚举长度 >= 6 的连续子串，
 * 检查它是否原样出现在密码里；取命中里最长的那个。
 *
 * 复杂度很低（序列总长不过几百，密码上限 128），每次改密码才调用一次，无需优化。
 */
function longestSequentialRun(lower) {
    let best = 0;
    for (const seq of SEQUENCES) {
        for (let start = 0; start < seq.length; start++) {
            // 只需考虑比当前最优更长的段，且长度至少 6
            for (let len = Math.max(6, best + 1); start + len <= seq.length; len++) {
                if (lower.includes(seq.slice(start, start + len))) {
                    if (len > best) best = len;
                } else {
                    break; // 该起点再长也不会命中
                }
            }
        }
    }
    return best;
}

/**
 * 创建一个登录守卫。
 *
 * 时钟与全部阈值都可注入 —— 测试里把 now 换成手动推进的函数，
 * 就能在毫秒内断言"连续失败 12 次后的锁定是 1 小时"。
 *
 * @param {object} [opts]
 * @param {number} [opts.maxFails]        单 IP 几次失败后开始锁定
 * @param {number} [opts.baseLockMs]      首次锁定基础时长
 * @param {number} [opts.maxLockMs]       单 IP 锁定上限
 * @param {number} [opts.globalWindowMs]  全局失败计数的滑动窗口
 * @param {number} [opts.globalMaxFails]  窗口内累计多少次失败触发全局冻结
 * @param {number} [opts.globalLockMs]    全局冻结时长
 * @param {() => number} [opts.now]       时钟（默认 Date.now）
 */
export function createLoginGuard(opts = {}) {
    const cfg = {
        maxFails: opts.maxFails ?? 5,
        baseLockMs: opts.baseLockMs ?? 30_000,
        maxLockMs: opts.maxLockMs ?? 60 * 60 * 1000,
        globalWindowMs: opts.globalWindowMs ?? 10 * 60 * 1000,
        globalMaxFails: opts.globalMaxFails ?? 30,
        globalLockMs: opts.globalLockMs ?? 5 * 60 * 1000,
        now: opts.now ?? (() => Date.now()),
    };

    const perIp = new Map();     // ip -> { count, lockUntil }
    let globalFails = [];        // 失败时间戳（滑动窗口）
    let globalLockUntil = 0;

    function pruneGlobal(now) {
        const cutoff = now - cfg.globalWindowMs;
        let i = 0;
        while (i < globalFails.length && globalFails[i] < cutoff) i++;
        if (i) globalFails = globalFails.slice(i);
    }

    /** 当前是否被拦。先看全局冻结（它连正常用户一起挡，所以优先报出来） */
    function status(ip) {
        const now = cfg.now();
        pruneGlobal(now);
        if (globalLockUntil > now) {
            return {
                blocked: true,
                scope: 'global',
                retryAfterSec: Math.ceil((globalLockUntil - now) / 1000),
            };
        }
        const rec = perIp.get(ip);
        if (rec && rec.lockUntil > now) {
            return {
                blocked: true,
                scope: 'ip',
                retryAfterSec: Math.ceil((rec.lockUntil - now) / 1000),
            };
        }
        return { blocked: false, scope: null, retryAfterSec: 0 };
    }

    /**
     * 记一次失败。
     *
     * ★ count **只在成功时清零**（见 succeed）。锁定到期不重置计数 ——
     *   否则攻击者每轮都能重新拿满 maxFails 次机会，指数退避白做。
     */
    function fail(ip) {
        const now = cfg.now();
        pruneGlobal(now);
        const rec = perIp.get(ip) || { count: 0, lockUntil: 0 };
        rec.count += 1;
        if (rec.count >= cfg.maxFails) {
            const over = rec.count - cfg.maxFails;
            const lockMs = Math.min(cfg.baseLockMs * Math.pow(2, over), cfg.maxLockMs);
            rec.lockUntil = now + lockMs;
        }
        perIp.set(ip, rec);

        globalFails.push(now);
        if (globalFails.length >= cfg.globalMaxFails) {
            globalLockUntil = now + cfg.globalLockMs;
            globalFails = [];
            return { count: rec.count, lockMs: Math.max(0, rec.lockUntil - now), globalLocked: true };
        }
        return { count: rec.count, lockMs: Math.max(0, rec.lockUntil - now), globalLocked: false };
    }

    /** 登录成功 → 该 IP 的计数清零（正常用户不会因为早先手滑被越锁越久） */
    function succeed(ip) {
        perIp.delete(ip);
    }

    /** 全清（改密码时用：旧密码的失败记录不该留给新密码） */
    function reset() {
        perIp.clear();
        globalFails = [];
        globalLockUntil = 0;
    }

    return { status, fail, succeed, reset, _cfg: cfg, _perIp: perIp };
}

export const __test__ = { WEAK_PASSWORDS, SEQUENCES };
