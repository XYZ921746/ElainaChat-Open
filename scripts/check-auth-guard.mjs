// 登录防爆破 + 密码强度：纯逻辑穷举断言。
//
// ── 为什么这个检查必须存在 ──────────────────────────────────────────────
//
// 本轮把「电脑操作权限」放开给了已登录的局域网设备（文件读写 + 执行命令）。
// 这等于承认：**密码就是唯一那道门**。门本身的强度（密码规则）与
// 撞门的代价（锁定策略）都要有回归保护 —— 否则某次"顺手简化"就能让
// 整台电脑重新变成几秒钟可破。
//
// 时钟是注入的，所以"连续失败 12 次后的锁定是 1 小时"这种断言能在毫秒内跑完，
// 不需要真的等。
import {
    createLoginGuard, validatePasswordStrength, PWD_MIN_LEN, PWD_MAX_LEN, __test__,
} from '../server/auth-guard.mjs';

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
    if (c) { pass++; console.log('  PASS  ' + label); }
    else { fail++; failures.push(label); console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

// ============================================================ 1. 密码强度
console.log('=== 1. 密码强度规则（至少 8 位 + 数字 + 大小写） ===');
{
    // ---- 必须通过 ----
    //
    // 注意：这里刻意不用 `passWord99` / `admin123a` 这类"弱口令+尾数"的写法 ——
    // 它们会被规则②正确拦下（那正是字典攻击的第一梯队）。测试夹具不能拿
    // 弱密码当"合格"样本，否则等于把规则往松的方向逼。
    const good = [
        'Elaina2024', 'MyPc-2024', 'aB3xY9zQ', 'Str0ngPassword', 'x7Kp2mNq',
        'Weather7Sun', 'DeepSeek8Ai', 'Zz9!aaaa', 'Tr4velBug',
    ];
    const rejected = [];
    for (const p of good) {
        const r = validatePasswordStrength(p);
        if (!r.ok) rejected.push(`${p}（被误拒：${r.message}）`);
    }
    ok(rejected.length === 0, `合格密码全部通过（${good.length} 条）`, rejected.join('; '));

    // ---- 必须拒绝：长度 ----
    ok(validatePasswordStrength('Ab1').ok === false, '少于 8 位被拒');
    ok(validatePasswordStrength('Abc123').ok === false, '6 位被拒（旧规则允许，本轮收紧）');
    ok(validatePasswordStrength('Abc1234').ok === false, '7 位仍被拒（边界）');
    ok(validatePasswordStrength('Abcd1234').ok === false, '8 位但属弱口令表 → 拒');
    // 8 位的下界：恰好 8 位、不在弱口令表、字符够杂 → 通过
    ok(validatePasswordStrength('xKp7mNq2').ok === true, '8 位且字符够杂 → 通过（下界）');
    ok(validatePasswordStrength('A1' + 'b'.repeat(PWD_MAX_LEN)).ok === false, '超长被拒');

    // ---- 必须拒绝：缺字符类 ----
    ok(validatePasswordStrength('abcdefg1').ok === false, '缺大写被拒');
    ok(validatePasswordStrength('ABCDEFG1').ok === false, '缺小写被拒');
    ok(validatePasswordStrength('Abcdefgh').ok === false, '缺数字被拒');
    {
        // 报错文案要说清缺什么（用户才知道怎么改）
        const m = validatePasswordStrength('abcdefg1').message;
        ok(/大写/.test(m), '缺大写时提示里点名"大写"', m);
        const m2 = validatePasswordStrength('ABCDEFG1').message;
        ok(/小写/.test(m2), '缺小写时提示里点名"小写"', m2);
        const m3 = validatePasswordStrength('Abcdefgh').message;
        ok(/数字/.test(m3), '缺数字时提示里点名"数字"', m3);
    }

    // ---- 必须拒绝：敷衍写法 ----
    ok(validatePasswordStrength('11111111').ok === false, '纯重复字符被拒（且缺大小写）');
    ok(validatePasswordStrength('Aaa1aaaa').ok === false, '★ 字符种类太少被拒（Aaa1aaaa 只有 3 种字符）');
    ok(validatePasswordStrength('12345678aA').ok === false, '数字顺子+尾缀被拒');
    ok(validatePasswordStrength('1234567890aA').ok === false, '完整数字顺子被拒');
    ok(validatePasswordStrength('Qwertyui1A').ok === false, '键盘序+尾缀被拒');
    ok(validatePasswordStrength('password').ok === false, '常见弱口令被拒');
    ok(validatePasswordStrength('Password123').ok === false, '弱口令表命中（忽略大小写）');
    ok(validatePasswordStrength('ADMIN123a').ok === false, 'admin123 大小写变体被拒');
    ok(validatePasswordStrength('Abc12345').ok === false, 'abc12345 命中弱口令表');
    // 弱口令 + 尾巴（字典攻击的第一梯队）
    ok(validatePasswordStrength('admin123aA').ok === false, '★ 弱口令加一位后缀也被拒');

    // ---- 边界：不该被误伤 ----
    ok(validatePasswordStrength('Aa1!aaaa').ok === true, '含特殊字符的正常密码通过');
    ok(validatePasswordStrength('   ').ok === false, '空白被拒');
    ok(validatePasswordStrength('').ok === false, '空串被拒');
    ok(validatePasswordStrength(null).ok === false, 'null 不抛异常，按不通过处理');
    ok(validatePasswordStrength(undefined).ok === false, 'undefined 不抛异常');
    ok(validatePasswordStrength(12345678).ok === false, '数字类型不抛异常');
    ok(PWD_MIN_LEN === 8, '最短长度常量是 8', String(PWD_MIN_LEN));

    // 弱口令表本身要有一定规模（否则防不住"图省事"的常见选择）
    ok(__test__.WEAK_PASSWORDS.size >= 20, '弱口令表有足够条目', String(__test__.WEAK_PASSWORDS.size));
}

// ============================================================ 2. 单 IP 指数退避
console.log('\n=== 2. 登录失败锁定：单 IP 指数退避 ===');
{
    let now = 1_000_000;
    const g = createLoginGuard({ now: () => now, maxFails: 5, baseLockMs: 30_000, maxLockMs: 3_600_000, globalMaxFails: 9999 });

    // 前 4 次失败：还不锁
    for (let i = 1; i <= 4; i++) {
        g.fail('1.2.3.4');
        ok(g.status('1.2.3.4').blocked === false, `第 ${i} 次失败后仍未锁定（阈值 5）`);
    }
    // 第 5 次：达到阈值 → 锁 30 秒
    g.fail('1.2.3.4');
    let st = g.status('1.2.3.4');
    ok(st.blocked === true, '第 5 次失败后锁定');
    ok(st.retryAfterSec === 30, '首次锁定 30 秒', String(st.retryAfterSec));

    // 别的 IP 不受影响（按 IP 隔离）
    ok(g.status('5.6.7.8').blocked === false, '其它 IP 不受影响（按 IP 隔离）');

    // 锁定期间再失败 → 时间翻倍
    now += 31_000;                       // 首次锁定已过期
    ok(g.status('1.2.3.4').blocked === false, '锁定到期后放行（但计数未清零）');
    g.fail('1.2.3.4');                   // 第 6 次
    st = g.status('1.2.3.4');
    ok(st.blocked === true, '第 6 次失败再次锁定');
    ok(st.retryAfterSec === 60, '★ 第二次锁定翻倍到 60 秒（指数退避）', String(st.retryAfterSec));

    now += 61_000;
    g.fail('1.2.3.4');                   // 第 7 次
    st = g.status('1.2.3.4');
    ok(st.retryAfterSec === 120, '★ 第三次锁定 120 秒（继续翻倍）', String(st.retryAfterSec));

    // ★ 计数只在成功时清零：这是"越试越久"的关键。
    //   若到期即归零，攻击者每轮都能拿满 5 次机会，指数退避形同虚设。
    now += 121_000;
    g.fail('1.2.3.4');                   // 第 8 次（若不累积，这里只会锁 30 秒）
    st = g.status('1.2.3.4');
    ok(st.retryAfterSec === 240, '★ 锁定到期不清零计数（第 8 次锁 240 秒）', String(st.retryAfterSec));

    // 成功 → 清零，恢复正常
    g.succeed('1.2.3.4');
    ok(g.status('1.2.3.4').blocked === false, '登录成功后解锁');
    for (let i = 1; i <= 4; i++) g.fail('1.2.3.4');
    ok(g.status('1.2.3.4').blocked === false, '成功清零后重新从 0 计数（手滑的用户不会被越锁越久）');

    // 上限封顶
    let t2 = 0;
    const g2 = createLoginGuard({ now: () => t2, maxFails: 2, baseLockMs: 1000, maxLockMs: 8000, globalMaxFails: 9999 });
    for (let i = 0; i < 20; i++) { g2.fail('9.9.9.9'); t2 += 100_000; }
    g2.fail('9.9.9.9');
    const capped = g2.status('9.9.9.9').retryAfterSec;
    ok(capped <= 8, '★ 锁定时间封顶（不会无限翻倍到把用户永久锁死）', String(capped));
}

// ============================================================ 3. 全局限流
console.log('\n=== 3. 全局限流：换 IP 也挡得住 ===');
{
    let now = 5_000_000;
    const g = createLoginGuard({
        now: () => now, maxFails: 3, baseLockMs: 30_000,
        globalMaxFails: 10, globalLockMs: 300_000,
    });

    // 用 10 个不同 IP 各失败 1 次（每个都没到自己 3 次的阈值）
    for (let i = 0; i < 10; i++) g.fail('10.0.0.' + i);
    const st = g.status('10.0.0.99');
    ok(st.blocked === true, '★ 多 IP 分散失败后触发全局冻结（换 IP 绕不过）');
    ok(st.scope === 'global', '冻结范围标记为 global', JSON.stringify(st));
    ok(st.retryAfterSec === 300, '全局冻结 300 秒', String(st.retryAfterSec));

    // 冻结期间连正常来源也被挡（这正是全局冻结的意义，也是它的代价）
    ok(g.status('192.168.1.50').blocked === true, '冻结期间正常来源同样被挡（全局限流固有的代价）');

    // 到期后恢复
    now += 301_000;
    ok(g.status('192.168.1.50').blocked === false, '全局冻结到期后恢复');

    // reset 清空（改密码时调用）
    g.reset();
    ok(g.status('10.0.0.1').blocked === false, 'reset 后所有锁定被清空');
}

// ============================================================ 4. serve.mjs 接线
console.log('\n=== 4. serve.mjs 接线：别只在模块里正确 ===');
{
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const serve = readFileSync(path.join(ROOT, 'web', 'serve.mjs'), 'utf8');

    // 模块被真正 import，而不是定义了没人用
    ok(/createLoginGuard/.test(serve), 'serve.mjs 引入了 createLoginGuard');
    ok(/validatePasswordStrength/.test(serve), 'serve.mjs 引入了 validatePasswordStrength');
    ok(/const loginGuard = createLoginGuard\(\)/.test(serve), '创建了全局守卫实例');
    ok(/loginGuard\.status\(ip\)/.test(serve), 'handleLogin 先查锁定状态');
    ok(/loginGuard\.fail\(ip\)/.test(serve), '密码错误时记失败');
    ok(/loginGuard\.succeed\(ip\)/.test(serve), '登录成功时清零');
    ok(/loginGuard\.reset\(\)/.test(serve), '改密码后清空失败记录');

    // 旧的固定窗口实现要被彻底移除（留着就会和新的并存）
    ok(!/LOGIN_MAX_FAILS/.test(serve), '★ 旧的固定窗口常量 LOGIN_MAX_FAILS 已移除');
    ok(!/loginFails/.test(serve), '★ 旧的 loginFails Map 已移除');
    ok(/Retry-After/.test(serve), '被拦时回 Retry-After 头（客户端可据此退避）');

    // 密码强度校验接在改密码上
    ok(/const strength = validatePasswordStrength\(next\)/.test(serve),
        '★ 改密码走了强度校验');
    ok(!/next\.length < 6/.test(serve), '★ 旧的"至少 6 位"规则已移除');

    // ★ 局域网放开的落点：privileged 不能再是"仅本机"
    ok(/function hasComputerGrant\(request\)/.test(serve), '有 hasComputerGrant（操作电脑的授权判据）');
    ok(/return isAuthenticated\(request\)/.test(serve), '★ 授权判据是"已认证"（本机或已登录），不再是"仅本机"');
    ok(/const privileged = hasComputerGrant\(request\)/.test(serve), '路由里用 hasComputerGrant 计算 privileged');
    // 不能还有"agent 操作仍按 isLocal 判定"的残留
    const agentSection = serve.slice(serve.indexOf('const privileged = hasComputerGrant'), serve.indexOf('/favicon.ico'));
    ok(!/agentExec\(request, response, isLocal\)/.test(agentSection),
        '★ /api/agent/exec 不再按 isLocal 判定（否则局域网放开是假的）');
    ok(/agentExec\(request, response, privileged\)/.test(agentSection), '/api/agent/exec 按 privileged 判定');
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：\n    · ' + failures.join('\n    · '));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
