// 诊断输出：让**完全不了解本软件的人（或 AI）**也能从日志里看懂
// 「这是什么」「我该做什么」「哪里有问题」「怎么修」。
//
// ── 为什么单独成模块 ────────────────────────────────────────────────────
//
// ① **可测**：文案是纯函数产出，能穷举断言"每条问题都必须有原因和下一步"。
//    文案质量靠人眼盯是盯不住的 —— 漏了"怎么办"这一句，用户就卡住了。
// ② serve.mjs 已 3000 行，输出格式该往外挪。
// ③ 格式会长期演进，集中一处才改得动。
//
// ── 排版原则（这一版是重排过的，上一版被指出"还是不好读"）──────────────
//
//   ① **按"用户要做什么"排序，不按"程序有哪些模块"排序**。
//      用户打开这一屏最想知道的是「我怎么开始用」，所以地址在最上面；
//      Node 版本、进程号这类信息压到最后，只在贴给别人排查时才需要。
//   ② **一个意思只说一遍**。上一版先说"服务已启动，可以用了"，
//      结尾又说"一切正常，服务已就绪" —— 同一件事说了两遍，纯占地方。
//   ③ **该重的重**：地址、密码这类"要照着敲"的东西单独成块，不和说明文字混排。
//   ④ **技术细节降级**：进程号 / Node 版本 / 日志路径收进一个「技术信息」块，
//      普通用户可以直接跳过，排查的人一眼能找到。
//   ⑤ **每条问题三段式**：发生了什么（what）/ 为什么（why）/ 怎么办（how）。
//      怎么办必须**具体到能照做**（点哪个按钮、敲哪条命令），不能是"请检查配置"。
//   ⑥ **区分「正常」与「需要处理」**：默认关闭、还没配置是正常状态，
//      不该和真故障混在一起报警 —— 否则用户会对警告脱敏。
//   ⑦ **不用内部标识符当主语**：说「桌宠（pet）」而不是裸 `pet`。

/** 状态图标。四个符号语义固定，不要混用。 */
export const MARK = {
    ok: '✔',        // 正常
    note: '○',      // 正常，但用户可能想知道（如"默认关闭"）
    warn: '⚠',      // 能跑，但可能不是用户想要的状态
    bad: '✘',       // 坏了，功能不可用
};

/** 缩进常量：让多行输出对齐，扫读时不跳 */
const IND = '  ';
const SUB = '      ';
const RULE = '='.repeat(64);

/**
 * 启动头：**极简**，只回答"这是什么"。
 *
 * 上一版在这里写了「这是什么」「现在在做什么」两大段说明 —— 那是文档该干的活，
 * 放在每次启动都要滚过去的日志里，纯属噪音。现在压成三行。
 *
 * @param {object} ctx
 * @param {string} ctx.name 软件名
 * @param {string} ctx.version 版本
 * @param {string} [ctx.tagline] 一句话定位
 * @returns {string}
 */
export function banner(ctx) {
    return [
        RULE,
        ` ${ctx.name} v${ctx.version}`,
        ` ${ctx.tagline || '本地运行的 AI 角色聊天应用 —— 数据都存在这台电脑上，不经过第三方服务器'}`,
        RULE,
    ].join('\n');
}

/**
 * 「怎么用」块：把要照着敲的东西集中放在最前面。
 *
 * 为什么单独成块：地址和密码是**要照着输入**的内容，和说明文字混排时
 * 很容易被看漏。这里用缩进 + 图标把它们顶出来。
 *
 * @param {Array<{state?:string, label:string, value?:string, hint?:string}>} items
 * @param {string} [heading]
 * @returns {string}
 */
export function usage(items, heading = '怎么用') {
    const rows = [section(heading)];
    for (const it of items) {
        const mark = MARK[it.state || 'ok'];
        rows.push(`${IND}${mark} ${it.label}`);
        if (it.value) rows.push(`${SUB}${it.value}`);
        if (it.hint) rows.push(`${SUB}${it.hint}`);
    }
    return rows.join('\n');
}

/**
 * 分组标题。空行 + `【标题】`，让输出在视觉上分段。
 * @param {string} title
 * @returns {string}
 */
export function section(title) {
    return `\n【${title}】`;
}

/**
 * 检查清单：逐项给出状态与说明。
 * @param {Array<{state:'ok'|'note'|'warn'|'bad', label:string, detail?:string, hint?:string}>} items
 * @param {string} [title]
 * @returns {string}
 */
export function checklist(items, title = '启动检查') {
    const rows = [title ? section(title) : ''];
    for (const it of items) {
        const mark = MARK[it.state] || MARK.note;
        rows.push(`${IND}${mark} ${it.label}${it.detail ? '   ' + it.detail : ''}`);
        if (it.hint) rows.push(`${SUB}${it.hint}`);
    }
    return rows.join('\n');
}

/**
 * 技术信息块：给排查的人看的，普通用户可以跳过。
 *
 * 为什么收进一块：Node 版本、进程号、日志路径这些每次启动都打，
 * 但 99% 的时候用户不需要看 —— 放在最后、统一缩进，既不挡视线又好找。
 *
 * @param {Array<[string, string]>} pairs [标签, 值]
 * @returns {string}
 */
export function techInfo(pairs, heading = '技术信息（出问题时连同上面的内容一起复制给别人）') {
    const rows = [section(heading)];
    for (const [k, v] of pairs) {
        if (v === undefined || v === null || v === '') continue;
        rows.push(`${IND}${k}：${v}`);
    }
    return rows.join('\n');
}

/**
 * 单个问题的三段式报告。
 *
 * `what` 说清发生了什么，`why` 说清原因，`how` 给出**具体到能照做**的下一步。
 * 三者缺一，用户就得自己猜 —— 而"猜"正是这个模块要消灭的东西。
 *
 * @param {{what:string, why?:string, how?:string|string[], where?:string}} p
 * @returns {string}
 */
export function problem(p) {
    const rows = [`${MARK.bad} ${p.what}`];
    if (p.where) rows.push(`${IND}位置：${p.where}`);
    if (p.why) rows.push(`${IND}原因：${p.why}`);
    const how = Array.isArray(p.how) ? p.how : (p.how ? [p.how] : []);
    if (how.length === 1) {
        rows.push(`${IND}怎么办：${how[0]}`);
    } else if (how.length > 1) {
        rows.push(`${IND}怎么办（任选一种）：`);
        how.forEach((h, i) => rows.push(`${SUB}${i + 1}) ${h}`));
    }
    return rows.join('\n');
}

/**
 * 收尾：只在**真有问题**时出现。
 *
 * ★ 上一版无论成败都打一条"一切正常，服务已就绪" —— 和前面那句
 *   "服务已启动，可以用了"重复。现在正常时不打收尾（前面已经说清楚了），
 *   只有存在问题才汇总，把"要做什么"集中到一屏内。
 *
 * @param {string[]} problems 已经格式化好的问题文本（取首行做汇总）
 * @returns {string} 无问题时返回空串（调用方 console.log 空串会被日志系统丢弃）
 */
export function summary(problems) {
    if (!problems || !problems.length) return '';
    const rows = ['', RULE, `${MARK.bad} 有 ${problems.length} 项需要处理（逐条见上）：`];
    problems.forEach((t, i) => rows.push(`${IND}${i + 1}. ${String(t).split('\n')[0]}`));
    rows.push('');
    rows.push(`${IND}处理完后重新启动本程序即可。`);
    rows.push(RULE);
    return rows.join('\n');
}

/**
 * 插件状态的**中文说明**。
 *
 * 与 web/js/mods.js 的 STATE_LABEL 保持一致 —— 同一种状态在前端日志与
 * 服务端日志里必须是同一句话，否则对照着看会以为不是一回事。
 */
export const MOD_STATE_LABEL = {
    ready: '已加载',
    disabled: '未启用（插件默认关闭，属正常状态）',
    blocked: '已拒绝加载（它依赖的前置插件不可用）',
    error: '加载失败',
    pending: '正在加载',
};

/**
 * 把插件清单渲染成一段**人能读懂的**说明。
 *
 * 为什么不让调用点自己拼字符串：实测踩过 —— 之前打的是
 * `elaina-avatar=disabled galgame=ready pet=ready`，那是机器视角的键值对。
 * 换个不了解本项目的人看到，既不知道 `disabled` 是好是坏，
 * 也看不出"前置没启用、依赖它的却起来了"这个关键矛盾。
 *
 * @param {Array<{id:string, name?:string, state:string, dir?:string, error?:string}>} plugins
 * @returns {{text:string, problems:string[]}}
 */
export function describePlugins(plugins) {
    const problems = [];
    if (!plugins.length) {
        return {
            text: `${IND}${MARK.note} 没有安装任何插件（程序本体的文字聊天不受影响）。\n`
                + `${SUB}想加功能就到「设置 → 插件」上传扩展包。`,
            problems,
        };
    }

    const byState = { ready: [], disabled: [], bad: [] };
    const label = (p) => (p.name && p.name !== p.id ? `${p.name}（${p.id}）` : p.id);
    for (const p of plugins) {
        if (p.state === 'ready') byState.ready.push(p);
        else if (p.state === 'disabled') byState.disabled.push(p);
        else byState.bad.push(p);
    }

    const rows = [];
    rows.push(`${IND}共 ${plugins.length} 个：`
        + `可用 ${byState.ready.length}`
        + (byState.disabled.length ? ` · 未启用 ${byState.disabled.length}` : '')
        + (byState.bad.length ? ` · 有问题 ${byState.bad.length}` : ''));

    if (byState.ready.length) {
        rows.push(`${SUB}${MARK.ok} 可用：${byState.ready.map(label).join('、')}`);
        // ★ 目录名与 id 不同时要**如实说明**，即使是正常工作的插件。
        //   为什么：用户手动改过目录名很常见，而排查"路径为什么不对"时
        //   必须知道它实际装在哪个目录。只报 id 会让人以为目录也叫这个名。
        for (const p of byState.ready) {
            if (p.dir && p.dir !== p.id) {
                rows.push(`${SUB}   · ${p.name || p.id} 实际装在目录 ${p.dir}/（它的 id 是 ${p.id}）`);
            }
        }
    }
    if (byState.disabled.length) {
        rows.push(`${SUB}${MARK.note} 未启用（正常的，插件默认关闭）：${byState.disabled.map(label).join('、')}`);
        rows.push(`${SUB}  需要用就到「设置 → 插件」打开开关，然后刷新页面。`);
    }
    for (const p of byState.bad) {
        const dirNote = p.dir && p.dir !== p.id ? `（装在 ${p.dir}/）` : '';
        rows.push(`${SUB}${MARK.bad} ${label(p)}${dirNote}：${MOD_STATE_LABEL[p.state] || p.state}`);
        if (p.error) rows.push(`${SUB}   ${p.error}`);
        problems.push(`${MARK.bad} 插件「${label(p)}」${MOD_STATE_LABEL[p.state] || p.state}`);
    }
    return { text: rows.join('\n'), problems };
}
