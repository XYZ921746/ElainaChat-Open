// ============================================================================
//  流式输出：SSE 增量解析 + 各协议增量合成
// ============================================================================
//
//  为什么需要这个文件
//  ----------------
//  在它之前，整条链路是"攒包"的：服务端其实早就把 SSE 一块块转发过来了
//  （serve.mjs 的 /api/relay 是 `for await (const chunk of upstream.body) response.write(chunk)`，
//  逐块透传、且强制 `accept-encoding: identity` 关掉了压缩），但前端最后一步
//  是 `await response.text()` —— 把整条流读完拼成一个字符串再返回。
//  于是"流式"在服务端做对了、在客户端被丢掉了：用户盯着"伊蕾娜正在想…"等几十秒，
//  然后一大段字**一次性**蹦出来。
//
//  对普通聊天这只是观感问题；对 agent 自主操作则是**可用性问题**：
//  一次自主操作可能跑十几步、几十秒，全程黑箱，用户既不知道它在干什么，
//  也没法在它跑偏时及时喊停。所以流式是 agent 能力的前置条件，不是锦上添花。
//
//  三种协议的增量事件形状完全不同，全部收在这里
//  ------------------------------------------
//    openai-compatible   data: {"choices":[{"delta":{"content":"…","reasoning_content":"…"}}]}
//    anthropic           event: content_block_delta / data: {"delta":{"type":"text_delta"|"thinking_delta",…}}
//    openai-responses    event: response.output_text.delta / response.reasoning_summary_text.delta
//
//  设计要点：**只做增量解析，不做协议实现**
//  本文件把流"翻译"成统一的 chunk 流，最后合成为一个**和原来非流式响应同构的 payload**，
//  交回给 chat-providers.js 里那三个函数已有的解析代码。
//  这样协议实现仍然只有一处（chat-providers.js），本文件只负责"把流拆开"，
//  两边不会各维护一份字段映射 —— 那种重复迟早会有一边忘了改。
//
//  ★ 降级：拿不到流就退回非流式
//  ---------------------------
//  APK 走原生 ByokHttpPlugin.post，它一次性返回整个 body，没有流通道；
//  有些中转站也不支持 stream。所以本模块是**可选加速**：
//  调用方先试流式，失败（抛错/不支持）就退回原来的非流式请求。绝不能因为
//  "想流式"而让本来能用的对话变得不能用。

(function () {
    'use strict';

    /**
     * 把一条 SSE 数据行解析成对象。解析不了就返回 null ——
     * 上游偶尔会插入心跳注释行（`: keep-alive`）或 `[DONE]`，那些不是 JSON。
     */
    function parseSseData(data) {
        const text = String(data || '').trim();
        if (!text || text === '[DONE]') return null;
        try { return JSON.parse(text); } catch { return null; }
    }

    /**
     * 通用 SSE 逐行读取器。
     *
     * @param {ReadableStreamDefaultReader} reader
     * @param {(event: {event: string|null, data: string}) => void} onEvent
     *        每凑齐一个 SSE 事件就回调一次。data 可能跨多行（SSE 规范允许），
     *        这里按规范用 \n 拼接。
     * @returns {Promise<void>}
     */
    async function readSse(reader, onEvent) {
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        // SSE 事件之间用空行分隔；一个事件里可以有 event: / data: / id: 等字段
        let eventName = null;
        let dataLines = [];

        const flush = () => {
            if (dataLines.length) onEvent({ event: eventName, data: dataLines.join('\n') });
            eventName = null;
            dataLines = [];
        };

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            // stream: true 让多字节 UTF-8 字符跨块时不会被截断成乱码 ——
            // 中文一个字 3 字节，正好卡在网络分块边界上是很常见的
            // （踩过：不加这个参数时回复里偶尔冒出 ""）。
            buffer += decoder.decode(value, { stream: true });

            let idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                let line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (line.endsWith('\r')) line = line.slice(0, -1);

                if (line === '') { flush(); continue; }        // 空行 = 事件结束
                if (line.startsWith(':')) continue;             // 注释/心跳，忽略
                if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
                if (line.startsWith('data:')) { dataLines.push(line.slice(5).replace(/^ /, '')); continue; }
                // 其余字段（id: / retry:）对流式回复没意义，忽略
            }
        }
        // 收尾：最后一行可能没有换行符结尾，别把已经收到的内容丢掉
        if (buffer.trim()) {
            const line = buffer.replace(/\r$/, '');
            if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        flush();
    }

    // ========================================================================
    //  各协议的增量提取
    // ========================================================================
    //
    //  每个 extractor 接收一个解析后的 SSE 事件，返回若干 chunk：
    //    { kind: 'text',      text }        正文增量
    //    { kind: 'reasoning', text }        思维链增量
    //    { kind: 'done' }                   流结束
    //  返回空数组表示"这个事件对回复内容没贡献"（例如 usage 统计、心跳）。

    /** openai-compatible：choices[0].delta 里的 content / reasoning_content */
    function extractOpenAICompatible(event) {
        const payload = parseSseData(event.data);
        if (!payload) return [];
        const choice = payload.choices?.[0];
        if (!choice) return [];
        const delta = choice.delta || {};
        const out = [];
        // reasoning_content 是 DeepSeek 系的字段名；reasoning 是部分兼容实现用的
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) out.push({ kind: 'reasoning', text: String(reasoning) });
        if (delta.content) out.push({ kind: 'text', text: String(delta.content) });
        if (choice.finish_reason) out.push({ kind: 'done' });
        return out;
    }

    /** anthropic：content_block_delta 里的 text_delta / thinking_delta */
    function extractAnthropic(event) {
        const payload = parseSseData(event.data);
        if (!payload) return [];
        const type = payload.type || event.event;
        if (type === 'content_block_delta') {
            const delta = payload.delta || {};
            if (delta.type === 'thinking_delta' && delta.thinking) {
                return [{ kind: 'reasoning', text: String(delta.thinking) }];
            }
            if (delta.type === 'text_delta' && delta.text) {
                return [{ kind: 'text', text: String(delta.text) }];
            }
            // input_json_delta（工具调用参数）暂不参与正文，忽略
            return [];
        }
        if (type === 'message_stop') return [{ kind: 'done' }];
        return [];
    }

    /** openai-responses：response.output_text.delta / reasoning 摘要增量 */
    function extractOpenAIResponses(event) {
        const payload = parseSseData(event.data);
        if (!payload) return [];
        const type = payload.type || event.event;
        if (type === 'response.output_text.delta' && payload.delta) {
            return [{ kind: 'text', text: String(payload.delta) }];
        }
        // 思维链在 Responses 里叫 reasoning summary（官方不返回原始 CoT，只给摘要）
        if ((type === 'response.reasoning_summary_text.delta'
            || type === 'response.reasoning_text.delta') && payload.delta) {
            return [{ kind: 'reasoning', text: String(payload.delta) }];
        }
        if (type === 'response.completed' || type === 'response.failed') return [{ kind: 'done' }];
        return [];
    }

    const EXTRACTORS = Object.freeze({
        'openai-compatible': extractOpenAICompatible,
        'anthropic': extractAnthropic,
        'openai-responses': extractOpenAIResponses,
    });

    // ========================================================================
    //  合成：把增量拼回"和非流式响应同构"的 payload
    // ========================================================================
    //
    //  这一步是本文件存在的关键理由。合成的形状必须和**非流式**响应完全一致，
    //  这样 chat-providers.js 里那三个解析函数一个字都不用改 ——
    //  流式与非流式走同一段解析代码，就不可能出现"流式能显示、非流式显示不了"
    //  这种只在某一条路上出现的 bug。
    function composeOpenAICompatible(acc) {
        const message = { role: 'assistant', content: acc.text };
        if (acc.reasoning) message.reasoning_content = acc.reasoning;
        return { choices: [{ message, finish_reason: 'stop' }] };
    }

    function composeAnthropic(acc) {
        const content = [];
        // 顺序和 Anthropic 真实响应一致：thinking block 在前，text block 在后
        if (acc.reasoning) content.push({ type: 'thinking', thinking: acc.reasoning });
        content.push({ type: 'text', text: acc.text });
        return { content };
    }

    function composeOpenAIResponses(acc) {
        const output = [];
        if (acc.reasoning) output.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: acc.reasoning }] });
        output.push({
            type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: acc.text }],
        });
        return { output };
    }

    const COMPOSERS = Object.freeze({
        'openai-compatible': composeOpenAICompatible,
        'anthropic': composeAnthropic,
        'openai-responses': composeOpenAIResponses,
    });

    /**
     * 消费一条流式响应，边解析边回调，最后返回合成的完整 payload。
     *
     * @param {Response} response fetch 返回的流式响应
     * @param {string} format 对话格式
     * @param {(chunk: {kind: string, text?: string}) => void} [onDelta]
     *        每个增量回调一次。**回调里抛错会中断整条流**，所以调用方要自己 try 住。
     * @returns {Promise<{payload: object, text: string, reasoning: string}>}
     */
    async function consumeStream(response, format, onDelta) {
        const extractor = EXTRACTORS[format] || extractOpenAICompatible;
        const acc = { text: '', reasoning: '' };
        if (!response.body || typeof response.body.getReader !== 'function') {
            throw new Error('响应没有可读流（该环境不支持流式）');
        }
        const reader = response.body.getReader();
        try {
            await readSse(reader, (event) => {
                for (const chunk of extractor(event)) {
                    if (chunk.kind === 'text') acc.text += chunk.text;
                    else if (chunk.kind === 'reasoning') acc.reasoning += chunk.text;
                    else continue;                       // done 只用于判断结束，不回调
                    if (onDelta) onDelta(chunk);
                }
            });
        } finally {
            // 提前 return/抛错时也要放掉 reader，否则连接会挂在那里
            try { reader.releaseLock(); } catch { /* 已经释放过就算了 */ }
        }
        const compose = COMPOSERS[format] || composeOpenAICompatible;
        return { payload: compose(acc), text: acc.text, reasoning: acc.reasoning };
    }

    /**
     * 给请求体加上 stream 开关。
     *
     * Anthropic 与 OpenAI 系都认 `stream: true`，但**流式事件的形状不同**，
     * 由 EXTRACTORS 表负责。Responses 格式用 `stream: true` 后事件名带 response. 前缀。
     */
    function withStreamFlag(body, format, enabled) {
        if (!enabled) return body;
        // Anthropic 还需要在请求头带 anthropic-beta 之类时才认某些事件，
        // 但基础的 text_delta 不需要，所以这里只加字段。
        return { ...body, stream: true };
    }

    window.ChatStream = {
        consumeStream,
        withStreamFlag,
        readSse,
        // 单独导出，方便检查脚本直接测增量解析而不必造一个真 ReadableStream
        extractors: EXTRACTORS,
        composers: COMPOSERS,
        _internal: { parseSseData, extractOpenAICompatible, extractAnthropic, extractOpenAIResponses },
    };
})();