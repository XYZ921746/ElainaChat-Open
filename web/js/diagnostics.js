// 前端诊断输出：与 server/diagnostics.mjs 同一套格式，让**两端日志看起来是一回事**。
//
// ── 为什么要单独成文件（而不是各模块自己拼字符串）────────────────────────
//
// 实测教训：插件加载失败时打的是 `elaina-avatar=disabled galgame=ready` ——
// 那是机器视角的键值对。用户把日志贴出来，谁也看不懂：
//   · 不知道 `disabled` 是好是坏
//   · 不知道 elaina-avatar 是什么
//   · 看不出"前置没启用、依赖它的却起来了"这个关键矛盾
//
// 用户的原始要求是："就算不知道是什么软件也可以通过日志知道是哪里有问题、
// 软件在做什么事情"。所以每条输出都要满足：
//
//   ① **自报家门**：说清这是哪个模块在说话、它负责什么
//   ② **三段式**：发生了什么（what）/ 为什么（why）/ 怎么办（how）
//   ③ **怎么办必须能照做**：给出界面上的具体位置（「设置 → 插件」），
//      而不是"请检查配置"
//   ④ **区分正常与故障**：默认关闭、还没配置是**正常状态**，不该报警
//   ⑤ **不用内部标识符当主语**：说「桌宠（pet）」而不是裸 `pet`
//
// ── 与后端的约定 ────────────────────────────────────────────────────────
// 状态图标、状态文案与 server/diagnostics.mjs 保持一致 —— 同一件事在两端
// 必须是同一句话，否则对照着看会以为不是一回事。改动时两边一起改，
// 由 scripts/check-diagnostics.mjs 的"文案一致"断言盯着。
//
// 注意：这是普通脚本（不是 ES module）—— 前端以 <script src> 直接加载，
// 所以挂在 window.ElainaDiag 上，与既有代码风格一致。
(function () {
    'use strict';

    /** 状态图标。与 server/diagnostics.mjs 的 MARK 一一对应。 */
    var MARK = {
        ok: '✔',      // 正常
        note: '○',    // 正常，但用户可能想知道
        warn: '⚠',    // 能跑，但可能不是用户想要的状态
        bad: '✘',     // 坏了，功能不可用
    };

    var IND = '  ';
    var SUB = '      ';

    /**
     * 一个模块的自述标题。
     *
     * 为什么要它：日志里同时有 Live2D、语音、插件、Agent 在说话。
     * 每条输出前面带上"我是谁、我负责什么"，读者才知道该往哪看。
     *
     * @param {string} name 模块名（如「插件系统」）
     * @param {string} duty 一句话职责（写给外行）
     * @returns {string}
     */
    function title(name, duty) {
        return '【' + name + '】' + (duty ? '（' + duty + '）' : '');
    }

    /**
     * 检查清单：逐项给状态与说明。
     * @param {Array<{state:string,label:string,detail?:string,hint?:string}>} items
     * @param {string} [heading]
     */
    function checklist(items, heading) {
        var rows = [heading ? title(heading) : ''];
        for (var i = 0; i < items.length; i++) {
            var it = items[i] || {};
            var mark = MARK[it.state] || MARK.note;
            rows.push(IND + mark + ' ' + it.label + (it.detail ? '   ' + it.detail : ''));
            if (it.hint) rows.push(SUB + it.hint);
        }
        return rows.join('\n');
    }

    /**
     * 三段式问题报告。what / why / how 缺一，用户就得自己猜。
     * @param {{what:string, why?:string, how?:string|string[], where?:string}} p
     */
    function problem(p) {
        var rows = [MARK.bad + ' ' + p.what];
        if (p.where) rows.push(IND + '位置：' + p.where);
        if (p.why) rows.push(IND + '原因：' + p.why);
        var how = Array.isArray(p.how) ? p.how : (p.how ? [p.how] : []);
        if (how.length === 1) rows.push(IND + '怎么办：' + how[0]);
        else if (how.length > 1) {
            rows.push(IND + '怎么办（任选一种）：');
            for (var i = 0; i < how.length; i++) rows.push(SUB + (i + 1) + ') ' + how[i]);
        }
        return rows.join('\n');
    }

    /**
     * 收尾汇总：把"需要处理"的集中列一遍，或明确说"一切正常"。
     *
     * 为什么"一切正常"也必须打一句：日志里"什么都没有"与"一切正常"
     * 在视觉上无法区分 —— 用户会以为日志坏了（这个坑实际发生过）。
     */
    function summary(problems, opts) {
        opts = opts || {};
        var rows = [];
        if (!problems || !problems.length) {
            rows.push(MARK.ok + ' 一切正常。');
            var notes = opts.notes || [];
            for (var i = 0; i < notes.length; i++) rows.push(IND + MARK.note + ' ' + notes[i]);
        } else {
            rows.push(MARK.bad + ' 有 ' + problems.length + ' 项需要处理（逐条见上）：');
            for (var j = 0; j < problems.length; j++) {
                rows.push(IND + (j + 1) + '. ' + String(problems[j]).split('\n')[0]);
            }
            if (opts.after) rows.push(IND + opts.after);
        }
        return rows.join('\n');
    }

    window.ElainaDiag = {
        MARK: MARK,
        title: title,
        checklist: checklist,
        problem: problem,
        summary: summary,
    };
})();
