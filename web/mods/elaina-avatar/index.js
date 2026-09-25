/* ============================================================================
 * 伊蕾娜立绘与情绪（公共依赖插件）
 *
 * 为什么把它单独做成一个插件，而不是让 Galgame 和桌宠各自实现：
 *   上游 v1.3.1 里两者**共用同一套立绘与情绪词表**，但代码是各写一份
 *   （galgame.js 的 avatarSrc/emotionFrom 与 pet.js 的 setEmotion/emotionFromText
 *    逻辑重复）。上游作者自己在注释里写了"统一走 ElainaEmotion，避免词表分叉"，
 *    说明这个重复是已知痛点。
 *
 *   更严重的是**资源重复**：上游 web/img/elaina/ 下有 3 套立绘
 *   （p_*.png / 中心对齐 / 躯干对齐），共 30.8MB。经逐字节校验：
 *     · p_*.png 与「中心对齐」9/9 完全相同（sha256 一致）—— 纯重复 10.3MB
 *     · 「躯干对齐」9/9 不同，但全仓库**零代码引用** —— 死资源 10.3MB
 *   也就是说 30.8MB 里只有 10.3MB 是真正在用的。
 *
 *   本插件只提供**一套**立绘 + 一套情绪词表，Galgame 与桌宠都从这里取，
 *   既避免代码分叉，也避免资源重复。
 *
 * ── 对外接口（挂到 window.ElainaAvatar）────────────────────────────────────
 *   EMOTIONS            情绪键数组（9 个）
 *   LABELS              键 → 中文名
 *   fromText(text)      从文本识别情绪键，识别不到返回 null
 *   src(key)            情绪键 → 立绘 URL（未知键回落到 calm）
 *   url(key)            同上（别名，语义更清楚）
 *   isReady()           立绘资源是否可用
 * ========================================================================== */
(function () {
    'use strict';

    const MOD_ID = 'elaina-avatar';

    /* 资源基址：★不写死目录名。
       声明的 id 与实际安装目录可能不一致（历史版本曾把带版本号的 zip 名
       当目录名，装出 elaina-avatar-1.0.0/ —— 写死 '/mods/elaina-avatar/img/'
       的 URL 全部 404，表现为"桌宠/Galgame 显示不出人物"）。
       优先用宿主注入的 assetBase（清单归一化后的真实位置）；
       宿主太老没有该 API 时回落到约定路径（正常安装下二者一致）。 */
    let BASE = '/mods/' + MOD_ID + '/img/';

    /* 情绪键固定为 9 个 —— 与立绘文件名一一对应。
       顺序无关紧要，但**键名不能随意改**：它就是图片文件名。 */
    const EMOTIONS = ['smirk', 'shy', 'calm', 'surprised', 'resigned', 'speechless', 'angry', 'confused', 'happy'];

    const LABELS = {
        smirk: '坏笑', shy: '害羞', calm: '平静', surprised: '惊讶', resigned: '无奈',
        speechless: '无语', angry: '生气', confused: '疑惑', happy: '高兴',
    };

    /* 情绪词表。上游把这份表在 galgame.js 与 pet.js 里各写了一份，
       这里只保留一份 —— 改词表只需要改这一个地方，两个界面同时生效。 */
    const RULES = [
        ['happy', /微笑|开心|高兴|嘿嘿|哈哈|愉快|喜悦|太好了|棒/],
        ['angry', /生气|气死|哼|愤怒|恼火|讨厌/],
        ['confused', /疑惑|奇怪|嗯？|不懂|迷茫|\?\s*$/],
        ['shy', /害羞|脸红|唔|呜|别、?别/],
        ['surprised', /惊讶|吃惊|诶|哎|居然|竟然|！/],
        ['resigned', /无奈|叹气|唉|算了/],
        ['speechless', /无语|真是的|服了|…{2,}/],
        ['smirk', /坏笑|狡黠|得意|偷笑/],
    ];

    /** 从文本识别情绪；识别不到返回 null（调用方自己决定回落成什么） */
    function fromText(text) {
        const t = String(text == null ? '' : text);
        for (const [key, re] of RULES) {
            if (re.test(t)) return key;
        }
        return null;
    }

    /** 情绪键 → 立绘 URL；未知键回落到 calm（保证永远有一张能显示） */
    function src(key) {
        const k = EMOTIONS.indexOf(key) >= 0 ? key : 'calm';
        return BASE + 'p_' + k + '.png';
    }

    /* 立绘可用性探测：图片不存在时给出明确日志，而不是让界面显示裂图。
       只探一次，结果缓存 —— 两个界面都会问它，不该重复发请求。 */
    let ready = null;
    function isReady() {
        if (ready !== null) return ready;
        ready = false;
        try {
            const img = new Image();
            img.onload = () => { ready = true; };
            img.onerror = () => {
                ready = false;
                console.warn('[Mod:' + MOD_ID + '] 立绘资源缺失：' + src('calm') +
                    '（Galgame 与桌宠会显示不出人物）');
            };
            img.src = src('calm');
        } catch (e) { ready = false; }
        return ready;
    }

    window.ElainaAvatar = {
        EMOTIONS,
        LABELS,
        fromText,
        src,
        url: src,
        isReady,
        base: BASE,
    };

    /* 注册为插件：本插件不提供界面，只暴露上面的接口。
       autoInit: false 的插件不会被调用 factory，所以这里直接返回一个空对象，
       让加载器把它标记为 ready（供其他插件检查依赖是否就绪）。 */
    if (window.ElainaMods && typeof window.ElainaMods.register === 'function') {
        window.ElainaMods.register(MOD_ID, function (host) {
            // ★ 用宿主给的真实安装位置覆盖约定路径。
            //   这是"接口在、图却 404"的正面修法：id 与目录名不一致时
            //   （历史上装成过 elaina-avatar-1.0.0/），约定路径是错的，
            //   而 host.assetBase() 来自清单归一化后的 id，永远指向真实位置。
            if (host && typeof host.assetBase === 'function') {
                BASE = host.assetBase() + 'img/';
                window.ElainaAvatar.base = BASE;
            }
            host.log('立绘与情绪接口就绪（' + EMOTIONS.length + ' 种表情，资源基址 ' + BASE + '）');
            return {
                EMOTIONS, LABELS, fromText, src, isReady, base: () => BASE,
            };
        });
    }
})();
