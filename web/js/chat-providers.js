// ============================================================================
//  对话 API 格式适配器（从 index.html 拆分而来）
// ============================================================================
//
//  这里放"同一件事、三种协议"的实现：
//    openai-compatible  POST /v1/chat/completions   （DeepSeek / 硅基流动 / OneAPI / Ollama…）
//    anthropic          POST /v1/messages           （Claude 官方）
//    openai-responses   POST /v1/responses          （OpenAI 官方，协议和上面两个都不同）
//
//  为什么要拆出来：
//    · 这三套协议加起来 300+ 行，占了 index.html 相当一块，而它们与界面毫无关系；
//    · 新增一种格式时，只该动这个文件 + 往下面的 PROVIDERS 表加一行，
//      不该再去改 index.html 里的分发逻辑（改漏一处就是"某格式静默失效"）。
//
//  ★ 依赖注入而不是 import
//  ----------------------
//  这是普通 <script>（不是 ES module），文件之间作用域独立 —— 拆出去后直接调用
//  index.html 里的 getChatBaseUrl() 会拿到 undefined。
//  所以依赖统一从 window.ChatDeps 取（由 index.html 在加载本文件之前挂上）。
//  这样做的好处：**调用方一行都不用改**，风险只在"依赖有没有挂全"。
//
//  加载顺序（index.html 里必须保证）：
//    1. <script src="/js/chat-providers.js"></script>   ← 先加载（只定义，不执行依赖）
//    2. 主脚本挂 window.ChatDeps
//    3. 主脚本调 window.ChatProviders.forFormat(...)
//  因为依赖是**调用时**才取（每次进函数都 d() 一次），所以 1 和 2 的先后其实不敏感，
//  但保持"先加载本文件"更符合直觉。

(function () {
    'use strict';

    /**
     * 取依赖。每次调用都取一次而不是在模块顶层缓存 ——
     * 顶层缓存会在"本文件先加载、ChatDeps 后挂上"时拿到 undefined，
     * 而且那种失败是**静默的**（函数存在，调用时才炸）。每次取最稳。
     */
    function deps() {
        const d = window.ChatDeps;
        if (!d) {
            throw new Error('ChatDeps 未初始化（chat-providers.js 与主脚本的加载顺序不对）');
        }
        return d;
    }

    // ========================================================================
    //  1. OpenAI 兼容（/v1/chat/completions）
    // ========================================================================

    /**
     * 把已废弃的 DeepSeek 模型名映射到现在的名字。
     *
     * 为什么要留这一层：DeepSeek 官方文档明确写了 `deepseek-chat` 这类老名字
     * **仍然被接受**，但请求其实由 deepseek-flash 服务（按 flash 计费）。
     * 用户设置里存着老名字时，如果我们直接原样发，行为其实是对的；
     * 唯一需要处理的是 `deepseek-reasoner` —— 它是"思考专用模型"时代的产物，
     * 现在思考由 thinking 字段控制，模型名统一了。
     *
     * 所以规则是：
     *   · 老名字 → 换成当前名字（deepseek-flash），让计费和能力都符合预期；
     *   · 已经填了新名字（deepseek-flash / deepseek-v4-pro）→ 一个字都不动，
     *     绝不擅自把用户明确选择的 pro 降成 flash（那是花用户的钱还改他的选择）。
     *
     * @param {string} model 用户填的模型名
     * @param {boolean} thinking 是否开了思考（老 reasoner 名字隐含"要思考"）
     */
    function legacyDeepSeekModel(model, thinking) {
        const name = String(model || '').trim().toLowerCase();
        if (name === 'deepseek-chat' || name === 'deepseek-reasoner' || name === 'deepseek-coder') {
            return 'deepseek-flash';
        }
        return String(model || '').trim() || 'deepseek-flash';
    }

    async function callOpenAICompatibleChat(messages, opts, settings) {
        const { ClientApiError, getChatBaseUrl, isDeepSeekOfficial, requestChatJson, buildThinkingParams, normalizeChatReply, throwProviderResponseError } = deps();
        const { apiKey, model } = settings;
        if (!apiKey) {
            throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写 API Key');
        }
        const baseUrl = getChatBaseUrl(settings);
        const endpoint = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
        // 换模型名这条老路保留，但**只在用户填的就是那个已废弃的名字时**才换：
        // DeepSeek 现在的模型是 deepseek-flash / deepseek-v4-pro，思考由 thinking 字段控制，
        // 不再需要 reasoner 这个模型。可老用户设置里存着 deepseek-chat / deepseek-reasoner，
        // 直接不管会让他们的配置一夜之间失效，所以这里做一次兼容映射。
        const rawModel = String(model || 'deepseek-chat').trim();
        const requestModel = isDeepSeekOfficial(baseUrl)
            ? legacyDeepSeekModel(rawModel, opts.thinking === true)
            : rawModel;
        const result = await requestChatJson(endpoint, {
            model: requestModel,
            messages,
            ...(opts.temperature !== undefined && { temperature: opts.temperature }),
            ...(Number.isFinite(opts.maxTokens) && { max_tokens: Math.max(1, Math.floor(opts.maxTokens)) }),
            // 思考开关与强度：显式发 disabled 很重要 —— DeepSeek 现在**默认开启**思考，
            // 不发这个字段的话，用户明明关了开关，模型照样思考（慢且费 token）。
            ...buildThinkingParams(opts.thinking, opts.thinkingEffort, 'openai-compatible', settings)
        }, { Authorization: 'Bearer ' + apiKey }, {
            signal: opts.signal, onDelta: opts.onDelta, stream: opts.stream,
        }, 'openai-compatible');
        if (!result.ok) await throwProviderResponseError(result, '对话服务请求失败');
        if (!result.payload) throw new ClientApiError('UPSTREAM_UNAVAILABLE', '对话服务返回格式异常');
        const message = result.payload.choices?.[0]?.message || {};
        return normalizeChatReply(message.content, message.reasoning_content || message.reasoning);
    }

    // ========================================================================
    //  2. Anthropic（/v1/messages）
    // ========================================================================
    /** 把 OpenAI 形态的 content 转成 Anthropic 的 content blocks */
    function anthropicContentBlocks(content) {
        const { stripThinkTags, extractTextContent } = deps();
        if (typeof content === 'string') return [{ type: 'text', text: content || ' ' }];
        const blocks = [];
        for (const part of Array.isArray(content) ? content : []) {
            if (part?.type === 'text') {
                blocks.push({ type: 'text', text: String(part.text ?? '') });
            } else if (part?.type === 'image_url') {
                const url = String(part.image_url?.url || '');
                const match = url.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([^]+)$/i);
                if (match) {
                    blocks.push({
                        type: 'image',
                        source: { type: 'base64', media_type: match[1].toLowerCase(), data: match[2] }
                    });
                } else {
                    blocks.push({ type: 'text', text: '[图片]' });
                }
            } else {
                blocks.push({ type: 'text', text: '[附件]' });
            }
        }
        return blocks.length ? blocks : [{ type: 'text', text: ' ' }];
    }

    /** OpenAI messages → Anthropic { system, messages } */
    function convertOpenAIToAnthropicMessages(messages) {
        const { extractTextContent, stripThinkTags } = deps();
        const systemParts = [];
        const converted = [];
        for (const msg of messages || []) {
            const role = msg?.role;
            if (role === 'system') {
                systemParts.push(extractTextContent(msg.content));
            } else if (role === 'user') {
                converted.push({ role: 'user', content: anthropicContentBlocks(msg.content) });
            } else if (role === 'assistant') {
                converted.push({ role: 'assistant', content: [{ type: 'text', text: stripThinkTags(extractTextContent(msg.content)) || ' ' }] });
            }
        }
        // 相邻同角色合并成一条 —— Anthropic 不接受连续的 user 或 assistant
        const merged = [];
        for (const msg of converted) {
            const last = merged[merged.length - 1];
            if (last && last.role === msg.role) {
                const prevBlocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content || ' ') }];
                const nextBlocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || ' ') }];
                last.content = prevBlocks.concat(nextBlocks);
            } else {
                merged.push({ ...msg });
            }
        }
        return { system: systemParts.filter(Boolean).join('\n\n'), messages: merged };
    }

    async function callAnthropicChat(messages, opts, settings) {
        const { ClientApiError, getChatBaseUrl, requestChatJson, buildThinkingParams, normalizeChatReply, throwProviderResponseError, ANTHROPIC_MIN_MAX_TOKENS } = deps();
        const { apiKey, model } = settings;
        if (!apiKey) {
            throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写 Anthropic API Key');
        }
        const baseUrl = getChatBaseUrl(settings).replace(/\/+$/, '');
        const endpoint = /\/messages$/i.test(baseUrl)
            ? baseUrl
            : (/\/v\d+$/i.test(baseUrl) ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`);
        const payload = convertOpenAIToAnthropicMessages(messages);
        const modelName = String(model || '').trim() || 'claude-sonnet-4-20250514';
        // 下限已经由主脚本的 resolveOutputTokenLimit(model, maxTokens, true) 统一算好
        // （那条链路无条件保底 4096，见 ANTHROPIC_MIN_MAX_TOKENS 的说明）。
        // 这里只兜个底，防止有人绕过 callChatAPI 直接调本函数。
        const maxTokens = Number.isFinite(opts.maxTokens)
            ? Math.max(1, Math.floor(opts.maxTokens))
            : ANTHROPIC_MIN_MAX_TOKENS;
        const result = await requestChatJson(endpoint, {
            model: modelName,
            system: payload.system || undefined,
            messages: payload.messages,
            max_tokens: maxTokens,
            // ★ 开了思考就**不能**带 temperature：Anthropic 官方明确禁止
            //   （"temperature may only be set to 1 when thinking is enabled"），
            //   带了会直接 400。宁可让用户少一个采样参数，也不能让请求失败。
            //   DeepSeek 那边同样是"思考模式不支持 temperature"（发了不报错但也不生效）。
            ...(opts.temperature !== undefined && !opts.thinking && { temperature: opts.temperature }),
            // 思考开关：Anthropic 侧走 reasoning.effort（none = 关闭）。
            // ★ 这里**不用** `thinking` 字段：那是 Claude 官方 extended thinking 的
            //   {type, budget_tokens} 结构，和这里的开关同名不同义，发错会 400。
            ...buildThinkingParams(opts.thinking, opts.thinkingEffort, 'anthropic', settings)
        }, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, {
            signal: opts.signal, onDelta: opts.onDelta, stream: opts.stream,
        }, 'anthropic');
        if (!result.ok) await throwProviderResponseError(result, 'Anthropic 请求失败');
        if (!result.payload) throw new ClientApiError('UPSTREAM_UNAVAILABLE', 'Anthropic 返回格式异常');
        const blocks = Array.isArray(result.payload.content) ? result.payload.content : [];
        const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text || '').join('');
        const reasoning = blocks.filter((block) => block?.type === 'thinking').map((block) => block.thinking || '').join('');
        return normalizeChatReply(text, reasoning);
    }

    // ========================================================================
    //  3. OpenAI 官方 Responses（/v1/responses）
    // ========================================================================
    /*  它和 chat/completions 不是同一套协议，必须单独适配，不能靠改个路径蒙混：
     *    · 系统提示走顶层 instructions，不是 messages 里的一条
     *    · 对话内容走 input 数组，每项 { role, content: [{ type:'input_text'|'output_text'|'input_image' }] }
     *    · 输出上限参数叫 max_output_tokens，不叫 max_tokens
     *    · 回复不在 choices[0].message.content，而在 output[] 里 type === 'message' 那些项的 content 块里
     *  这些字段名是官方文档定的，写错会直接 400，而报错往往只说 "unknown parameter"，
     *  排查起来很费劲，所以在这里一次写清楚。 */

    function convertOpenAIToResponsesInput(messages) {
        const { extractTextContent } = deps();
        const instructions = [];
        const input = [];
        for (const msg of messages || []) {
            const role = msg?.role;
            if (role === 'system') {
                instructions.push(extractTextContent(msg.content));
                continue;
            }
            const isAssistant = role === 'assistant';
            const textType = isAssistant ? 'output_text' : 'input_text';
            const parts = [];
            const content = msg.content;
            if (typeof content === 'string') {
                parts.push({ type: textType, text: content || ' ' });
            } else {
                for (const part of Array.isArray(content) ? content : []) {
                    if (part?.type === 'text') {
                        parts.push({ type: textType, text: String(part.text ?? '') });
                    } else if (part?.type === 'image_url') {
                        // Responses 的图片用 input_image.image_url，字符串 URL 或 data URL 都直接收
                        const url = String(part.image_url?.url || '');
                        if (/^(https?:\/\/|data:)/i.test(url)) parts.push({ type: 'input_image', image_url: url });
                        else parts.push({ type: textType, text: '[图片]' });
                    } else {
                        parts.push({ type: textType, text: '[附件]' });
                    }
                }
            }
            if (!parts.length) parts.push({ type: textType, text: ' ' });
            input.push({ role: isAssistant ? 'assistant' : 'user', content: parts });
        }
        return { instructions: instructions.filter(Boolean).join('\n\n'), input };
    }

    async function callOpenAIResponsesChat(messages, opts, settings) {
        const { ClientApiError, getChatBaseUrl, requestChatJson, buildThinkingParams, normalizeChatReply, throwProviderResponseError } = deps();
        const { apiKey, model } = settings;
        if (!apiKey) {
            throw new ClientApiError('APP_KEY_MISSING', '请先在设置中填写 OpenAI API Key');
        }
        const baseUrl = getChatBaseUrl(settings).replace(/\/+$/, '');
        const endpoint = /\/responses$/i.test(baseUrl) ? baseUrl : `${baseUrl}/responses`;
        const payload = convertOpenAIToResponsesInput(messages);
        const result = await requestChatJson(endpoint, {
            model: String(model || '').trim() || 'gpt-4.1-mini',
            ...(payload.instructions ? { instructions: payload.instructions } : {}),
            input: payload.input,
            ...(opts.temperature !== undefined && { temperature: opts.temperature }),
            ...(Number.isFinite(opts.maxTokens) && { max_output_tokens: Math.max(1, Math.floor(opts.maxTokens)) }),
            // Responses 格式只有 reasoning.effort，没有"关闭"这个取值，
            // 所以关思考时这里不发字段（buildThinkingParams 里说明了原因）。
            ...buildThinkingParams(opts.thinking, opts.thinkingEffort, 'openai-responses', settings)
        }, { Authorization: 'Bearer ' + apiKey }, {
            signal: opts.signal, onDelta: opts.onDelta, stream: opts.stream,
        }, 'openai-responses');
        if (!result.ok) await throwProviderResponseError(result, 'OpenAI 请求失败');
        if (!result.payload) throw new ClientApiError('UPSTREAM_UNAVAILABLE', 'OpenAI 返回格式异常');
        // 部分兼容实现会把全文直接放在顶层 output_text，先认这个，省得再遍历一遍
        if (typeof result.payload.output_text === 'string' && result.payload.output_text.trim()) {
            return normalizeChatReply(result.payload.output_text);
        }
        const items = Array.isArray(result.payload.output) ? result.payload.output : [];
        const text = items
            .filter((item) => item?.type === 'message')
            .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
            .filter((block) => block?.type === 'output_text')
            .map((block) => block.text || '')
            .join('');
        const reasoning = items
            .filter((item) => item?.type === 'reasoning')
            .flatMap((item) => (Array.isArray(item.summary) ? item.summary : []))
            .map((part) => part?.text || '')
            .join('');
        return normalizeChatReply(text, reasoning);
    }

    // ========================================================================
    //  分发：格式 → 实现
    // ========================================================================
    /*  用**表**而不是 if 链。
     *  差别不在"好看"，而在"加新格式时的漏改风险"：
     *    if 链要改两处（加分支 + 记得加顺序），表只要加一行；
     *    而且表能直接 for...in 枚举出来，测试可以断言"每个已知格式都有实现"。 */
    const PROVIDERS = Object.freeze({
        'openai-compatible': callOpenAICompatibleChat,
        'anthropic': callAnthropicChat,
        'openai-responses': callOpenAIResponsesChat,
    });

    /** 默认格式：未知格式回落到它（与原 if 链最后那个 return 的行为一致） */
    const DEFAULT_FORMAT = 'openai-compatible';

    window.ChatProviders = {
        PROVIDERS,
        /** 取指定格式的实现；未知格式回落到默认（不抛错，与原行为一致） */
        forFormat(format) {
            return PROVIDERS[format] || PROVIDERS[DEFAULT_FORMAT];
        },
        /** 供测试用：列出所有已知格式 */
        formats() {
            return Object.keys(PROVIDERS);
        },
        // 单独导出，方便测试直接调某一个而不经过分发
        callOpenAICompatibleChat,
        callAnthropicChat,
        callOpenAIResponsesChat,
        // 转换器也导出：它们是最容易写错、也最值得单独测的部分
        convertOpenAIToAnthropicMessages,
        convertOpenAIToResponsesInput,
    };
})();
