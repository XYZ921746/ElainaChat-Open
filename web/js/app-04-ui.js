/* ========================================================================
 * 界面：收藏 / 语笺 / 弹窗 / 会话 / 侧边栏 / 消息渲染
 *
 * 本文件由 web/index.html 的主脚本按分区拆分而来（保持原始加载顺序）。
 * 拆分前提：主脚本是全局作用域，拆分后各文件共享同一全局词法环境，
 * 因此顶层 function / const / let 互相可见，调用点无需修改。
 *
 * 包含分区：
 *   · 收藏（语笺）
 *   · 语笺页面
 *   · 自定义Modal
 *   · 会话管理
 *   · 侧边栏渲染
 *   · 管理分类弹窗
 *   · 消息渲染
 * ======================================================================== */

// ==================== 收藏（语笺） ====================

function isMessageFavorited(conversationId, messageId) {
    return state.favorites.some(f =>
        f.type === 'message' &&
        f.conversationId === conversationId &&
        f.messageId === messageId
    );
}

function toggleMessageFavorite(message) {
    const convId = state.currentConversationId;
    if (!convId) return false;
    const idx = state.favorites.findIndex(f =>
        f.type === 'message' &&
        f.conversationId === convId &&
        f.messageId === message.id
    );
    if (idx >= 0) {
        state.favorites.splice(idx, 1);
    } else {
        state.favorites.push({
            id: generateId(),
            type: 'message',
            createdAt: new Date().toISOString(),
            conversationId: convId,
            messageId: message.id,
            text: message.text,
            role: message.role,
            timestamp: message.timestamp,
            voiceJp: message.voiceJp || ''
        });
    }
    saveFavorites();
    updateNotesBadge();
    return idx < 0;
}

function handleMessageFavoriteClick(messageId) {
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    if (!conv) return;
    const msg = conv.messages.find(m => String(m.id) === String(messageId));
    if (!msg) return;
    toggleMessageFavorite(msg);
    const msgEl = document.getElementById(`msg-${safeAttrId(messageId)}`);
    if (msgEl) {
        const fresh = renderMessage(msg);
        msgEl.replaceWith(fresh);
    }
}

function updateNotesBadge() {
    const count = state.favorites.length;
    if (count > 0) {
        elements.notesBadge.textContent = count > 99 ? '99+' : count;
        elements.notesBadge.classList.remove('hidden');
    } else {
        elements.notesBadge.classList.add('hidden');
    }
}

function getNotesData() {
    if (state.notesTab === 'quote') {
        return state.favorites
            .filter(f => f.type === 'quote')
            .map(f => ({ ...f, role: 'quote', timestamp: '' }));
    }
    return state.favorites
        .filter(f => f.type === 'message')
        .map(f => ({ ...f }));
}

function renderNotesPage(searchText = '') {
    const scroller = elements.notesPage.querySelector('.overflow-y-auto');
    const prevScroll = scroller ? scroller.scrollTop : 0;
    const data = getNotesData();
    const kw = (searchText || '').trim().toLowerCase();
    const filtered = kw ? data.filter(f => (f.text || '').toLowerCase().includes(kw)) : data;

    elements.notesCount.textContent = `共 ${filtered.length} 条`;
    elements.notesEmpty.classList.toggle('hidden', filtered.length > 0);
    elements.notesGrid.innerHTML = '';

    filtered.forEach(fav => {
        const card = document.createElement('div');
        card.className = 'group note-card cursor-pointer animate-fade-in-up';
        card.onclick = () => openFavoriteDetail(fav.id);
        const roleClass = fav.role === 'user' ? 'note-role-user' : fav.role === 'ai' ? 'note-role-ai' : 'note-role-quote';
        const roleLabel = fav.role === 'user' ? 'You' : fav.role === 'ai' ? '伊蕾娜' : '金句';
        card.innerHTML = `
            <div class="flex items-center gap-2 mb-2">
                <span class="note-role-badge ${roleClass}">${roleLabel}</span>
                ${fav.type === 'quote' ? '<span class="note-card-meta">' + escapeHtml(fav.source || '') + '</span>' : '<span class="note-card-meta">' + escapeHtml(fav.timestamp || '') + '</span>'}
            </div>
            <p class="note-card-text line-clamp-3">${escapeHtml(fav.text)}</p>
            <div class="flex items-center gap-1 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onclick="event.stopPropagation(); removeFavoriteWithConfirm('${safeAttrId(fav.id)}')" class="note-remove-btn ml-auto p-1.5" title="取消收藏">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
            </div>
        `;
        elements.notesGrid.appendChild(card);
    });
    if (scroller) {
        requestAnimationFrame(() => {
            scroller.scrollTop = prevScroll;
        });
    }
}

function openFavoriteDetail(favId) {
    const fav = state.favorites.find(f => f.id === favId);
    if (!fav) return;
    state.selectedFavoriteId = favId;

    elements.detailTypeBadge.textContent = fav.type === 'quote' ? '每日金句' : (fav.role === 'user' ? 'You 的消息' : '伊蕾娜的回复');
    elements.detailRole.textContent = fav.type === 'quote' ? (fav.source || '') : (fav.role === 'user' ? '你' : '伊蕾娜');
    elements.detailTimestamp.textContent = fav.timestamp || '';
    elements.detailText.textContent = fav.text;

    const conv = state.conversations.find(c => c.id === fav.conversationId);
    const hasContext = fav.type === 'message' && conv;
    elements.detailContextSection.classList.toggle('hidden', !hasContext);
    if (hasContext) {
        elements.detailConvTitle.textContent = conv.title || '未命名对话';
    }
    elements.detailJumpBtn.classList.toggle('hidden', fav.type === 'quote');

    elements.notesOverlay.classList.remove('hidden');
    elements.notesOverlay.classList.add('flex');
    elements.favoriteDetail.classList.remove('hidden');
    elements.favoriteDetailCard.classList.add('animate-modal-pop');
}

function collapseFavorite() {
    state.selectedFavoriteId = null;
    elements.favoriteDetail.classList.add('hidden');
    elements.notesOverlay.classList.add('hidden');
    elements.notesOverlay.classList.remove('flex');
}

async function removeFavoriteWithConfirm(favId) {
    const confirmed = await showCustomConfirm('确认取消收藏？');
    if (!confirmed) return;
    state.favorites = state.favorites.filter(f => f.id !== favId);
    saveFavorites();
    updateNotesBadge();
    updateQuoteButtons();
    renderNotesPage(elements.notesSearch.value);
    if (state.selectedFavoriteId === favId) {
        collapseFavorite();
    }
}

function jumpToOriginal(fav) {
    if (!fav || fav.type === 'quote') return;
    const conv = state.conversations.find(c => c.id === fav.conversationId);
    if (!conv) return;

    state.selectedFavoriteId = null;
    elements.favoriteDetail.classList.add('hidden');
    elements.notesOverlay.classList.add('hidden');
    elements.notesOverlay.classList.remove('flex');

    exitNotesMode();
    switchConversation(fav.conversationId);

    setTimeout(() => {
        const msgEl = document.getElementById(`msg-${safeAttrId(fav.messageId)}`);
        if (msgEl) {
            msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            msgEl.classList.add('highlight-pulse');
            setTimeout(() => msgEl.classList.remove('highlight-pulse'), 2200);
        }
    }, 100);
}


// ==================== 语笺页面 ====================

function enterNotesMode() {
    state.notesMode = true;
    state.diaryMode = false;
    if (window.matchMedia('(max-width: 860px)').matches) {
        state.notesTab = 'message';
        document.querySelectorAll('.notes-tab').forEach(btn => {
            const active = btn.dataset.tab === 'message';
            btn.classList.toggle('tab-active', active);
            btn.classList.toggle('text-indigo-500', !active);
            btn.classList.toggle('bg-white/40', !active);
            btn.classList.toggle('border', !active);
            btn.classList.toggle('border-white/55', !active);
        });
    }
    elements.initialState.classList.add('hidden');
    elements.conversationHistory.classList.add('hidden');
    elements.inputBar.classList.add('hidden');
    elements.floatingMic.classList.add('hidden');
    elements.diaryPage.classList.add('hidden');
    elements.notesPage.classList.remove('hidden');
    elements.currentConversationTitle.textContent = '我的语笺';
    renderNotesPage(elements.notesSearch.value);
    setRailActive('notes');
}

function exitNotesMode() {
    state.notesMode = false;
    elements.notesPage.classList.add('hidden');
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    if (conv) {
        updateCurrentConversationTitle();
        elements.conversationHistory.classList.remove('hidden');
        elements.inputBar.classList.remove('hidden');
    } else {
        showInitialState();
    }
    syncRailActive();
}

function setRailActive(action) {
    if (action !== 'categories' && !elements.categoriesModalOverlay.classList.contains('hidden')) {
        elements.categoriesModalOverlay.classList.add('hidden');
        elements.categoriesModalOverlay.classList.remove('flex');
    }
    document.querySelectorAll('.sidebar-rail-btn[data-rail-action]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.railAction === action);
    });
    const memoryUnavailable = state.notesMode || state.diaryMode;
    elements.memoryBtn.classList.toggle('page-mode-hidden', memoryUnavailable);
    elements.memoryBtn.setAttribute('aria-hidden', memoryUnavailable ? 'true' : 'false');
    elements.memoryBtn.tabIndex = memoryUnavailable ? -1 : 0;
    syncMainHeaderVisibility();
}

function syncMainHeaderVisibility() {
    const settingsOpen = !elements.settingsOverlay.classList.contains('hidden');
    const headerUnavailable = state.notesMode || state.diaryMode || settingsOpen;
    elements.chatHeader.classList.toggle('hidden', headerUnavailable);
    elements.chatHeader.setAttribute('aria-hidden', headerUnavailable ? 'true' : 'false');
}

function syncRailActive() {
    if (state.diaryMode) setRailActive('diary');
    else if (state.notesMode) setRailActive('notes');
    else setRailActive('chat');
}

function diaryTimestamp(entry) {
    const parsed = Date.parse(entry && entry.timestamp);
    return Number.isFinite(parsed) ? parsed : parseDiaryDate(entry && entry.date);
}

function diaryDisplayDate(entry) {
    const base = entry?.date || '未标注日期';
    const parsed = Date.parse(entry?.timestamp);
    if (!Number.isFinite(parsed)) return base;
    return `${base} · ${new Date(parsed).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

function renderDiaryPage() {
    const diary = Array.isArray(state.memoryCore?.diary) ? [...state.memoryCore.diary] : [];
    diary.sort((a, b) => diaryTimestamp(b) - diaryTimestamp(a));
    elements.diaryCount.textContent = `${diary.length} 条记录`;
    elements.diaryEmpty.classList.toggle('hidden', diary.length > 0);
    elements.diaryGrid.innerHTML = '';
    diary.forEach(entry => {
        const sourceConv = entry.conversationId ? state.conversations.find(c => c.id === entry.conversationId) : null;
        const card = document.createElement('article');
        card.className = 'diary-card animate-fade-in-up';
        if (sourceConv) {
            card.title = '打开来源对话';
            card.tabIndex = 0;
            card.addEventListener('click', () => {
                exitDiaryMode();
                switchConversation(sourceConv.id);
            });
            card.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    exitDiaryMode();
                    switchConversation(sourceConv.id);
                }
            });
        }
        const title = entry.conversationTitle || (sourceConv && sourceConv.title) || '旅途片段';
        const essences = Array.isArray(entry.essences) ? entry.essences.filter(Boolean).slice(0, 6) : [];
        card.innerHTML = `
            <div class="diary-card-date">${escapeHtml(diaryDisplayDate(entry))}</div>
            <div class="diary-card-title">${escapeHtml(title)}</div>
            <div class="diary-card-text">${escapeHtml(entry.content || '')}</div>
            ${essences.length ? `<div class="diary-essences">${essences.map(tag => `<span class="diary-essence">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
        `;
        elements.diaryGrid.appendChild(card);
    });
}

function enterDiaryMode() {
    state.diaryMode = true;
    state.notesMode = false;
    elements.initialState.classList.add('hidden');
    elements.conversationHistory.classList.add('hidden');
    elements.inputBar.classList.add('hidden');
    elements.notesPage.classList.add('hidden');
    elements.floatingMic.classList.add('hidden');
    elements.diaryPage.classList.remove('hidden');
    elements.currentConversationTitle.textContent = '旅行日记';
    renderDiaryPage();
    setRailActive('diary');
}

function exitDiaryMode() {
    state.diaryMode = false;
    elements.diaryPage.classList.add('hidden');
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    if (conv) {
        updateCurrentConversationTitle();
        elements.conversationHistory.classList.remove('hidden');
        elements.inputBar.classList.remove('hidden');
    } else {
        showInitialState();
    }
    syncRailActive();
}

function showInitialState() {
    state.notesMode = false;
    state.diaryMode = false;
    elements.settingsOverlay.classList.add('hidden');
    elements.settingsOverlay.classList.remove('flex');
    elements.chatHeader.classList.remove('hidden');
    elements.chatHeader.setAttribute('aria-hidden', 'false');
    elements.initialState.classList.remove('hidden');
    elements.conversationHistory.classList.add('hidden');
    elements.inputBar.classList.add('hidden');
    elements.notesPage.classList.add('hidden');
    elements.diaryPage.classList.add('hidden');
    elements.floatingMic.classList.add('hidden');
    const greetingEl = document.getElementById('greetingText');
    if (greetingEl) greetingEl.textContent = '';
    updateCurrentConversationTitle();
    greetingTyping = false;
    startGreetingTyping();
    syncRailActive();
    syncMainHeaderVisibility();
}


// ==================== 自定义Modal ====================

function showCustomModal(opts) {
    return new Promise(resolve => {
        const { title = '提示', message = '', input = false, defaultValue = '', placeholder = '', confirmText = '确定', cancelText = '取消', showCancel = true } = opts;
        elements.customModalTitle.textContent = title;
        elements.customModalMessage.textContent = message;
        elements.customModalMessage.classList.toggle('hidden', !message);
        elements.customModalInput.classList.toggle('hidden', !input);
        if (input) {
            elements.customModalInput.value = defaultValue;
            elements.customModalInput.placeholder = placeholder;
        }
        elements.customModalCancelBtn.textContent = cancelText;
        elements.customModalConfirmBtn.textContent = confirmText;
        elements.customModalCancelBtn.classList.toggle('hidden', !showCancel);

        elements.customModal.classList.remove('hidden');
        elements.customModal.classList.add('flex');
        // 层级不在这里设：.modal-overlay 上的 z-index !important 会让内联值完全失效，
        // 写了也只是看着像生效（曾经写过一个 panelOpen ? '100003' : '100001' 的分支，
        // 实际上永远走不到 100001）。真正的分层写在样式表的
        // 「弹窗之间的层叠顺序必须写死」那段 —— #customModal 是 100003，永远在最上面。

        let settled = false;
        const done = (value) => {
            if (settled) return;
            settled = true;
            elements.customModal.classList.add('hidden');
            elements.customModal.classList.remove('flex');
            elements.customModalCancelBtn.onclick = null;
            elements.customModalConfirmBtn.onclick = null;
            elements.customModalInput.onkeydown = null;
            resolve(value);
        };

        elements.customModalCancelBtn.onclick = () => done(input ? null : false);
        elements.customModalConfirmBtn.onclick = () => {
            if (input) {
                const val = elements.customModalInput.value;
                done(val === null || val === undefined ? null : val);
            } else {
                done(true);
            }
        };
        if (input) {
            elements.customModalInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    const val = elements.customModalInput.value;
                    done(val);
                }
                if (e.key === 'Escape') done(null);
            };
            setTimeout(() => {
                elements.customModalInput.focus();
                elements.customModalInput.select();
            }, 50);
        }
    });
}

let conversationMoveTargetId = null;

function closeConversationMoveDialog() {
    conversationMoveTargetId = null;
    if (!elements.conversationMoveOverlay) return;
    elements.conversationMoveOverlay.classList.add('hidden');
    elements.conversationMoveOverlay.classList.remove('flex');
}

function openConversationMoveDialog(convId) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv || !elements.conversationMoveOverlay) return;
    closeConversationContextMenu();
    conversationMoveTargetId = convId;
    elements.conversationMoveList.innerHTML = '';
    const options = [{ id: '', name: '未分类' }, ...state.categories.filter(c => !c.isUnfiled).slice().sort((a, b) => a.order - b.order)];
    options.forEach(option => {
        const categoryId = option.id;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `conversation-move-option${(conv.categoryId || '') === categoryId ? ' is-current' : ''}`;
        button.innerHTML = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3.5 7.5h6l1.8 2H20.5v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg><span>${escapeHtml(option.name)}</span>`;
        button.addEventListener('click', () => {
            moveConversationToCategory(convId, categoryId || null);
            closeConversationMoveDialog();
        });
        elements.conversationMoveList.appendChild(button);
    });
    elements.conversationMoveOverlay.classList.remove('hidden');
    elements.conversationMoveOverlay.classList.add('flex');
}

function showCustomAlert(message, title = '提示') {
    return showCustomModal({ title, message, showCancel: false });
}

function showCustomConfirm(message, title = '确认') {
    return showCustomModal({ title, message });
}

function showCustomPrompt(message, defaultValue = '', placeholder = '') {
    return showCustomModal({ title: '输入', message, input: true, defaultValue, placeholder });
}


// ==================== 会话管理 ====================

function createConversation(categoryId) {
    const conv = {
        id: generateId(),
        title: '新对话',
        categoryId: categoryId !== undefined ? categoryId : state.activeCategoryId,
        isPinned: false,
        isStarred: false,
        worldSetting: '',
        characterPrompt: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: []
    };
    state.conversations.unshift(conv);
    state.currentConversationId = conv.id;
    localStorage.setItem('elaina_open_current_conv', conv.id);
    saveConversations();
    renderFolderList();
    updateCurrentConversationTitle();
    showInitialState();
    return conv;
}

function autoNameConversation(messages) {
    const first = messages.find(m => m.role === 'user');
    if (!first) return '新对话';
    const text = (first.text || '').trim();
    if (!text) return first.imageDataUrl ? '图片对话' : '新对话';
    return text.length > 12 ? text.substring(0, 12) + '...' : text;
}

async function renameConversation(convId) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    const newName = await showCustomPrompt('重命名对话：', conv.title);
    if (newName && newName.trim()) {
        conv.title = newName.trim();
        saveConversations();
        renderFolderList();
        updateCurrentConversationTitle();
    }
}

async function deleteConversation(convId) {
    const confirmed = await showCustomConfirm('确认删除这个对话？');
    if (!confirmed) return;
    const idx = state.conversations.findIndex(c => c.id === convId);
    if (idx < 0) return;
    state.conversations.splice(idx, 1);
    state.favorites = state.favorites.filter(f => f.conversationId !== convId);
    saveConversations();
    saveFavorites();
    updateNotesBadge();
    if (state.currentConversationId === convId) {
        state.currentConversationId = null;
        localStorage.removeItem('elaina_open_current_conv');
        elements.conversationHistory.classList.add('hidden');
        elements.inputBar.classList.add('hidden');
        elements.initialState.classList.remove('hidden');
        elements.currentConversationTitle.textContent = '伊蕾娜';
    }
    renderFolderList();
}

function togglePin(convId) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    conv.isPinned = !conv.isPinned;
    saveConversations();
    renderFolderList();
}

function toggleStar(convId) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    conv.isStarred = !conv.isStarred;
    saveConversations();
    renderFolderList();
}

let conversationContextMenu = null;
let conversationContextTarget = null;
let suppressConversationClickUntil = 0;

function isMobileConversationLayout() {
    return window.matchMedia('(max-width: 860px)').matches;
}

function closeConversationContextMenu() {
    if (conversationContextTarget) {
        conversationContextTarget.classList.remove('is-context-target');
        conversationContextTarget = null;
    }
    if (!conversationContextMenu) return;
    const menu = conversationContextMenu;
    conversationContextMenu = null;
    menu.classList.remove('is-open');
    window.setTimeout(() => menu.remove(), 170);
}

function openConversationContextMenu(convId, anchor) {
    if (!isMobileConversationLayout()) return;
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    closeConversationContextMenu();

    const menu = document.createElement('div');
    menu.className = 'conversation-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `${conv.title}的会话操作`);
    menu.innerHTML = `
        <button type="button" role="menuitem" data-conversation-action="pin">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
            <span>${conv.isPinned ? '取消置顶' : '置顶对话'}</span>
        </button>
        <button type="button" role="menuitem" data-conversation-action="rename">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.4-9.4a2 2 0 112.8 2.8L11.8 15H9v-2.8l8.6-8.6z"/></svg>
            <span>重命名</span>
        </button>
        <button type="button" role="menuitem" data-conversation-action="move">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h6l2 2h8v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path stroke-linecap="round" d="M12 12v5m-2.5-2.5L12 17l2.5-2.5"/></svg>
            <span>移动至</span>
        </button>
        <button type="button" role="menuitem" data-conversation-action="delete" class="danger">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.9"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.9 12.1A2 2 0 0116.1 21H7.9a2 2 0 01-2-1.9L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            <span>删除对话</span>
        </button>
    `;
    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    menu.addEventListener('contextmenu', (event) => event.preventDefault());
    menu.addEventListener('click', (event) => {
        const button = event.target.closest('[data-conversation-action]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const action = button.dataset.conversationAction;
        closeConversationContextMenu();
        if (action === 'pin') togglePin(convId);
        if (action === 'rename') renameConversation(convId);
        if (action === 'move') openConversationMoveDialog(convId);
        if (action === 'delete') deleteConversation(convId);
    });

    document.body.appendChild(menu);
    conversationContextMenu = menu;
    conversationContextTarget = anchor;
    anchor.classList.add('is-context-target');

    const rect = anchor.getBoundingClientRect();
    const menuWidth = menu.offsetWidth || 166;
    const menuHeight = menu.offsetHeight || 126;
    const edge = 10;
    const left = Math.min(Math.max(edge, rect.right - menuWidth), window.innerWidth - menuWidth - edge);
    const below = rect.bottom + 6;
    const top = below + menuHeight <= window.innerHeight - edge
        ? below
        : Math.max(edge, rect.top - menuHeight - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    requestAnimationFrame(() => menu.classList.add('is-open'));
}

async function createCategory(name) {
    const cat = {
        id: generateId(),
        name,
        order: state.categories.length,
        isUnfiled: false
    };
    state.categories.push(cat);
    saveCategories();
    renderFolderList();
    return cat;
}

async function promptCreateCategory() {
    const name = await showCustomPrompt('输入文件夹名称：');
    if (name && name.trim()) {
        await createCategory(name.trim());
    }
}

async function renameCategoryPrompt(categoryId) {
    const cat = state.categories.find(c => c.id === categoryId);
    if (!cat) return;
    const newName = await showCustomPrompt('重命名文件夹：', cat.name);
    if (newName && newName.trim()) {
        cat.name = newName.trim();
        saveCategories();
        renderFolderList();
        renderCategoriesModalList();
    }
}

async function deleteCategory(categoryId) {
    const cat = state.categories.find(c => c.id === categoryId);
    if (!cat || cat.isUnfiled) return;
    const confirmed = await showCustomConfirm(`确认删除文件夹「${cat.name}」？其中的对话将移到未分类。`);
    if (!confirmed) return;
    state.conversations.forEach(conv => {
        if (conv.categoryId === categoryId) conv.categoryId = null;
    });
    state.categories = state.categories.filter(c => c.id !== categoryId);
    saveConversations();
    saveCategories();
    renderFolderList();
    renderCategoriesModalList();
}

function moveConversationToCategory(convId, categoryId) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    conv.categoryId = categoryId;
    saveConversations();
    renderFolderList();
}

function switchConversation(convId) {
    state.currentConversationId = convId;
    localStorage.setItem('elaina_open_current_conv', convId);
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    loadConversation(convId);
}

function updateCurrentConversationTitle() {
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    elements.currentConversationTitle.textContent = conv ? conv.title : '伊蕾娜';
    elements.currentConversationTitle.title = conv ? conv.title : '';
}

function currentConversationHasMessages() {
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    return Boolean(conv && conv.messages.length > 0);
}

function loadConversation(conversationId) {
    const conv = state.conversations.find(c => c.id === conversationId);
    if (!conv) return;

    state.currentConversationId = conversationId;
    updateCurrentConversationTitle();
    if (state.notesMode) {
        state.notesMode = false;
        elements.notesPage.classList.add('hidden');
    }
    if (state.diaryMode) {
        state.diaryMode = false;
        elements.diaryPage.classList.add('hidden');
    }
    elements.initialState.classList.add('hidden');
    elements.conversationHistory.classList.remove('hidden');
    elements.inputBar.classList.remove('hidden');
    elements.notesPage.classList.add('hidden');
    elements.diaryPage.classList.add('hidden');

    elements.conversationHistory.innerHTML = '';
    conv.messages.forEach(message => {
        renderMessage(message);
    });
    renderFolderList();
    syncRailActive();
    if (elements.conversationHistory) {
        elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
    }
}


// ==================== 侧边栏渲染====================

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/`/g, '&#96;');
}

// 内联 onclick 里嵌 id 用的消毒：只保留字母数字和 - _
// （注意：不能靠 escapeHtml 把 ' 转成 &#39; —— HTML 解析器会先把属性值里的实体解码，
//   再交给 JS 解析，' 依然会闭合字符串。所以这里做的是白名单剔除。）
function safeAttrId(id) {
    return String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * 把 AI 回复的文本渲染成 HTML：Markdown + LaTeX（离线，无网络依赖）。
 *
 * 为什么需要它（从上游 v1.3.1 合并过来的能力）：
 *   · 模型很爱输出 `**加粗**`、`- 列表`、```代码块```、表格与数学公式。
 *     以前一律按纯文本 `whitespace-pre-wrap` 显示，这些标记会原样露出，
 *     读起来很吵。Markdown 渲染是上游界面的重要体验改进。
 *   · Galgame mod 也依赖它（对话框要渲染富文本），所以它属于**宿主能力**，
 *     不能放进某个 mod 里 —— 那样别的 mod 用不到，且 mod 停用就没了。
 *
 * 安全（这是关键，不能为了好看牺牲它）：
 *   ① 先 escapeHtml，**再**交给 marked —— 顺序反了就是 XSS。
 *   ② 数学公式在转义后用占位符换出，避免 $...$ 里的内容被 Markdown 误解析，
 *      也避免 KaTeX 拿到已被转义的源码。
 *   ③ marked / katex 任一不可用（vendor 没加载、离线失败）就**静默回落**到
 *      纯文本转义 —— 宁可少个样式，也不能白屏或抛错。
 *   ④ 代码块先挖出来占位再处理，避免把 ``` 里的示例标记当成真指令删掉
 *      （上游踩过这个坑，注释里写了 OCR 二轮 C）。
 *
 * @param {string} text 原始文本
 * @returns {string} 可安全插入 innerHTML 的 HTML
 */
function renderMessageText(text) {
    const raw0 = String(text == null ? '' : text);

    // ① 先把三反引号围栏整体挖出来占位，避免后续正则误伤代码块里的内容
    const FENCE = String.fromCharCode(96, 96, 96);
    const PH0 = String.fromCharCode(0xE100), PH1 = String.fromCharCode(0xE101);
    const fences = [];
    let raw = raw0.replace(new RegExp(FENCE + '[\\s\\S]*?' + FENCE, 'g'), (m) => {
        fences.push(m);
        return PH0 + (fences.length - 1) + PH1;
    });

    // ② 剥掉独占一行的场景标记（Galgame 的内部指令，不该显示给用户）
    raw = raw.replace(/^[ \t]*<scene>[^<\n]{0,64}<\/scene>[ \t]*$/gim, '').trim();

    // ③ 把围栏放回来
    raw = raw.replace(new RegExp(PH0 + '(\\d+)' + PH1, 'g'), (m, i) => fences[Number(i)] || '');

    // ④ 没有 Markdown 特征就直接纯文本 —— 省掉一次 marked 调用（长回复里它不便宜）
    //
    //    注意表格这一项：`| a | b |` + `| --- |` 是 GFM 表格语法，
    //    但上面的行首特征（#/-/>/```/---）都匹配不到它，会整段被当纯文本。
    //    上游那份正则就漏了表格，导致"模型输出的表格原样露出管道符"。
    //    这里补一条：行首以 `|` 开头、且后面出现过分隔行（|---|）。
    const hasMd = /(^|\n)\s*(#{1,6}\s|[-*+]\s|>\s|\u0060\u0060\u0060|---|\d+\.\s)|(\*\*[^*]+\*\*|\u0060[^\u0060]+\u0060|\[[^\]]+\]\([^)]+\))|(\$\$|(?:^|[^\\])\$[^$\n]{1,200}\$)|(^|\n)\s*\|[^\n]*\|/.test(raw);
    const mdObj = window.marked;
    const mdParse = (typeof mdObj === 'function') ? mdObj : (mdObj && typeof mdObj.parse === 'function') ? mdObj.parse.bind(mdObj) : null;
    if (!hasMd || !mdParse) return escapeHtml(raw);

    // ⑤ 先转义，再用占位符保护数学公式。
    //
    //    ⚠️ 这里有个关键细节：escapeHtml 会把反引号转成 &#96;，
    //    而 marked 认不出 &#96; —— 于是「行内代码」和「代码块」会失效
    //    （表现为反引号原样显示）。所以先把反引号换成**私有区占位符**
    //    （U+E200/U+E201，正常文本里不会出现），等 marked 渲染完再换回来。
    const BT0 = '\uE200', BT1 = '\uE201';
    const mathStore = [];
    let safe = escapeHtml(raw);
    // 三反引号（围栏）与单反引号（行内）分别占位
    safe = safe.replace(/&#96;&#96;&#96;/g, BT0 + BT0 + BT0);
    safe = safe.replace(/&#96;/g, BT1);
    safe = safe.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => {
        mathStore.push({ tex, d: true });
        return '\uE000' + (mathStore.length - 1) + '\uE001';
    });
    safe = safe.replace(/(^|[^\\])\$([^$\n]{1,200})\$/g, (m, pre, tex) => {
        mathStore.push({ tex, d: false });
        return pre + '\uE000' + (mathStore.length - 1) + '\uE001';
    });
    // 把围栏反引号还原成真反引号（交给 marked），行内反引号同理
    safe = safe.split(BT0).join('`').split(BT1).join('`');

    // ⑥ Markdown 渲染。失败就回落纯文本 —— 样式不该有能力弄挂消息显示
    let html;
    try { html = mdParse(safe, { breaks: true, gfm: true }); }
    catch (e) { return escapeHtml(raw); }

    // ⑦ ★ 安全清洗：marked 会照单全收 `[x](javascript:...)`，生成可点击的
    //    `href="javascript:..."`。那等于把"点一下就执行任意代码"送给模型输出
    //    （模型输出受提示词影响，而提示词可以被对话内容影响）。
    //    这里把所有危险协议的链接/图片降级成纯文本。
    html = html.replace(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
        return /^\s*(javascript|data|vbscript|file)\s*:/i.test(href) ? text : m;
    });
    html = html.replace(/<img\b[^>]*src\s*=\s*"([^"]*)"[^>]*>/gi, (m, src) => {
        return /^\s*(javascript|data|vbscript|file)\s*:/i.test(src) ? '' : m;
    });

    // ⑧ 公式换回 KaTeX。katex 不可用时保留占位符原文（至少不丢内容）
    if (mathStore.length && window.katex && typeof window.katex.renderToString === 'function') {
        html = html.replace(/\uE000(\d+)\uE001/g, (m, i) => {
            const it = mathStore[Number(i)];
            if (!it) return m;
            try {
                return window.katex.renderToString(it.tex, { displayMode: !!it.d, throwOnError: false });
            } catch (e) { return escapeHtml(it.tex); }
        });
    }
    return html;
}

function createConversationItem(conv) {
    const div = document.createElement('div');
    const isActive = conv.id === state.currentConversationId;
    div.className = `conversation-item group flex items-center gap-2 px-2.5 py-2 rounded-xl cursor-pointer transition-all text-sm ${isActive ? 'sidebar-item-active' : 'hover:bg-white/50'}`;
    div.draggable = !isMobileConversationLayout();
    div.dataset.convId = conv.id;
    div.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        if (isMobileConversationLayout() && Date.now() < suppressConversationClickUntil) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        closeConversationContextMenu();
        switchConversation(conv.id);
    });
    div.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', conv.id);
        e.dataTransfer.effectAllowed = 'move';
        div.classList.add('opacity-50');
    });
    div.addEventListener('dragend', () => {
        div.classList.remove('opacity-50');
    });

    let longPressTimer = null;
    let longPressStartX = 0;
    let longPressStartY = 0;
    let longPressOpened = false;
    const cancelLongPress = () => {
        if (longPressTimer) window.clearTimeout(longPressTimer);
        longPressTimer = null;
    };
    div.addEventListener('pointerdown', (event) => {
        if (!isMobileConversationLayout() || !event.isPrimary || event.target.closest('button')) return;
        cancelLongPress();
        longPressOpened = false;
        longPressStartX = event.clientX;
        longPressStartY = event.clientY;
        longPressTimer = window.setTimeout(() => {
            longPressTimer = null;
            longPressOpened = true;
            suppressConversationClickUntil = Date.now() + 800;
            openConversationContextMenu(conv.id, div);
        }, 520);
    });
    div.addEventListener('pointermove', (event) => {
        if (!longPressTimer) return;
        if (Math.hypot(event.clientX - longPressStartX, event.clientY - longPressStartY) > 9) {
            cancelLongPress();
        }
    });
    div.addEventListener('pointerup', () => {
        if (longPressOpened) suppressConversationClickUntil = Date.now() + 800;
        longPressOpened = false;
        cancelLongPress();
    });
    div.addEventListener('pointercancel', () => {
        longPressOpened = false;
        cancelLongPress();
    });
    div.addEventListener('pointerleave', cancelLongPress);
    div.addEventListener('contextmenu', (event) => {
        if (!isMobileConversationLayout() || event.target.closest('button')) return;
        event.preventDefault();
        cancelLongPress();
        longPressOpened = true;
        suppressConversationClickUntil = Date.now() + 800;
        if (conversationContextMenu && conversationContextTarget === div) return;
        openConversationContextMenu(conv.id, div);
    });

    div.innerHTML = `
        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1">
                <span class="text-sm font-medium truncate text-indigo-900">${escapeHtml(conv.title)}</span>
            </div>
            <div class="flex items-center gap-1.5 mt-0.5">
                ${conv.isPinned ? '<svg class="conversation-pin-icon w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-label="置顶"><path stroke-linecap="round" stroke-linejoin="round" d="M8 3h8l-.7 5.2 3.7 3.3v1.1H5v-1.1l3.7-3.3L8 3zM12 12.6V21"/></svg>' : ''}
                ${conv.isStarred ? '<span class="text-[10px] text-amber-500">⭐</span>' : ''}
                <span class="text-[11px] text-indigo-300">${new Date(conv.updatedAt).toLocaleDateString()}</span>
            </div>
        </div>
        <div class="conversation-inline-actions flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onclick="event.stopPropagation(); toggleStar('${safeAttrId(conv.id)}')" class="conversation-favorite-btn p-1 hover:bg-white/70 rounded-lg" title="${conv.isStarred ? '取消收藏' : '收藏'}" aria-label="${conv.isStarred ? '取消收藏' : '收藏'}">
                <svg class="w-3.5 h-3.5 ${conv.isStarred ? 'text-amber-500 fill-current' : 'text-indigo-300'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>
            </button>
            <div class="conversation-secondary-actions flex items-center gap-0.5">
                <button onclick="event.stopPropagation(); togglePin('${safeAttrId(conv.id)}')" class="p-1 hover:bg-white/70 rounded-lg" title="${conv.isPinned ? '取消置顶' : '置顶'}">
                    <svg class="w-3.5 h-3.5 ${conv.isPinned ? 'text-pink-500' : 'text-indigo-300'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
                </button>
                <button onclick="event.stopPropagation(); renameConversation('${safeAttrId(conv.id)}')" class="p-1 hover:bg-white/70 rounded-lg" title="重命名">
                    <svg class="w-3.5 h-3.5 text-indigo-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                </button>
                <button onclick="event.stopPropagation(); deleteConversation('${safeAttrId(conv.id)}')" class="p-1 hover:bg-white/70 rounded-lg" title="删除">
                    <svg class="w-3.5 h-3.5 text-red-300 hover:text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
            </div>
        </div>
    `;
    return div;
}

function renderFolderList() {
    const kw = (elements.sidebarSearchInput.value || '').trim().toLowerCase();
    closeConversationContextMenu();
    elements.folderList.innerHTML = '';

    if (state.conversations.length === 0 && state.categories.length === 0) {
        elements.folderList.innerHTML = `
            <div class="text-center py-16">
                <p class="text-base font-semibold text-indigo-700 leading-relaxed">还没有对话</p>
                <p class="text-xs text-indigo-300 leading-relaxed mt-1.5">和伊蕾娜开启一段旅途吧</p>
            </div>
        `;
        return;
    }

    const matchesSearch = (conv) => {
        if (!kw) return true;
        return (conv.title || '').toLowerCase().includes(kw);
    };

    const pinned = state.conversations.filter(c => c.isPinned && matchesSearch(c));
    const regular = state.conversations.filter(c => !c.isPinned && matchesSearch(c));
    const pinnedIds = new Set(pinned.map(c => c.id));
    const inCategory = new Set(regular.filter(c => c.categoryId).map(c => c.id));
    const unfiled = regular.filter(c => !c.categoryId);

    const renderConversationList = (list) => {
        const wrap = document.createElement('div');
        wrap.className = 'space-y-0.5';
        list.forEach(conv => {
            wrap.appendChild(createConversationItem(conv));
        });
        return wrap;
    };

    const renderFolderHeader = (cat) => {
        const header = document.createElement('div');
        const count = state.conversations.filter(c => c.categoryId === cat.id).length;
        header.className = 'group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg cursor-pointer text-xs font-semibold text-indigo-700 hover:bg-white/50 transition-colors select-none';
        header.dataset.folderId = cat.id;
        header.draggable = cat.isUnfiled ? false : true;
        header.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            header.classList.add('bg-white/60');
        });
        header.addEventListener('dragleave', () => {
            header.classList.remove('bg-white/60');
        });
        header.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            header.classList.remove('bg-white/60');
            const convId = e.dataTransfer.getData('text/plain');
            if (convId) moveConversationToCategory(convId, cat.isUnfiled ? null : cat.id);
        });
        header.innerHTML = `
            <svg class="folder-header-icon ${cat.isUnfiled ? 'folder-header-unfiled' : ''} w-3.5 h-3.5 text-violet-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
            <span class="truncate">${escapeHtml(cat.name)}</span>
            <span class="text-[10px] text-indigo-300 ml-auto">${count}</span>
            ${cat.isUnfiled ? '' : `
            <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onclick="event.stopPropagation(); renameCategoryPrompt('${safeAttrId(cat.id)}')" class="p-0.5 hover:bg-white/70 rounded" title="重命名">
                    <svg class="w-3 h-3 text-indigo-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                </button>
                <button onclick="event.stopPropagation(); deleteCategory('${safeAttrId(cat.id)}')" class="p-0.5 hover:bg-white/70 rounded" title="删除">
                    <svg class="w-3 h-3 text-red-300 hover:text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
            </div>`}
        `;
        return header;
    };

    if (pinned.length > 0) {
        const section = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'conversation-pinned-label flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold';
        label.innerHTML = '<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M8 3h8l-.7 5.2 3.7 3.3v1.1H5v-1.1l3.7-3.3L8 3zM12 12.6V21"/></svg><span>置顶</span>';
        section.appendChild(label);
        section.appendChild(renderConversationList(pinned));
        elements.folderList.appendChild(section);
    }

    const unfiledCat = { id: '__unfiled__', name: '未分类', isUnfiled: true };
    const cats = [unfiledCat, ...state.categories.slice().sort((a, b) => a.order - b.order)];
    const unfiledList = unfiled.filter(c => !pinnedIds.has(c.id));
    if (unfiledList.length > 0) {
        const section = document.createElement('div');
        section.appendChild(renderFolderHeader(unfiledCat));
        section.appendChild(renderConversationList(unfiledList));
        elements.folderList.appendChild(section);
    }

    cats.forEach(cat => {
        if (cat.isUnfiled) return;
        const list = regular.filter(c => c.categoryId === cat.id);
        if (list.length === 0 && kw) return;
        const section = document.createElement('div');
        section.appendChild(renderFolderHeader(cat));
        if (list.length > 0) {
            section.appendChild(renderConversationList(list));
        }
        elements.folderList.appendChild(section);
    });
}


// ==================== 管理分类弹窗 ====================

let catSelected = new Set();

function openCategoriesModal() {
    catSelected = new Set();
    renderCategoriesModalList();
    elements.categoriesModalOverlay.classList.remove('hidden');
    elements.categoriesModalOverlay.classList.add('flex');
    renderCatBatchBar();
    setRailActive('categories');
}

function closeCategoriesModal() {
    elements.categoriesModalOverlay.classList.add('hidden');
    elements.categoriesModalOverlay.classList.remove('flex');
    syncRailActive();
}

function renderCategoriesModalList() {
    elements.categoriesModalList.innerHTML = '';
    const cats = [null, ...state.categories.slice().sort((a, b) => a.order - b.order).map(c => c.id)];
    cats.forEach(catId => {
        const cat = catId ? state.categories.find(c => c.id === catId) : null;
        const name = cat ? cat.name : '未分类';
        const convs = state.conversations.filter(c => c.categoryId === catId);
        if (convs.length === 0) return;

        const section = document.createElement('div');
        section.className = 'glass-panel rounded-xl overflow-hidden';
        const expanded = state.catModalExpanded[catId || '__unfiled__'] !== false;

        const header = document.createElement('div');
        header.className = 'flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-white/40 transition-colors';
        header.innerHTML = `
            <svg class="w-3.5 h-3.5 text-violet-400 transition-transform ${expanded ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            <span class="text-xs font-semibold text-indigo-800">${escapeHtml(name)}</span>
            <span class="text-[11px] text-indigo-300 ml-auto">${convs.length} 条对话</span>
        `;
        header.onclick = () => {
            state.catModalExpanded[catId || '__unfiled__'] = !expanded;
            renderCategoriesModalList();
        };
        section.appendChild(header);

        if (expanded) {
            const list = document.createElement('div');
            list.className = 'px-3 pb-3 space-y-1 max-h-56 overflow-y-auto scroll-soft';
            convs.forEach(conv => {
                const row = document.createElement('label');
                const checked = catSelected.has(conv.id);
                row.className = `flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer transition-colors text-xs ${checked ? 'bg-pink-50' : 'hover:bg-white/50'}`;
                row.innerHTML = `
                    <input type="checkbox" class="accent-pink-500 cat-checkbox" data-conv-id="${safeAttrId(conv.id)}" ${checked ? 'checked' : ''}>
                    <span class="truncate text-indigo-800">${escapeHtml(conv.title)}</span>
                    <span class="ml-auto text-[10px] text-indigo-300">${new Date(conv.updatedAt).toLocaleDateString()}</span>
                `;
                const checkbox = row.querySelector('.cat-checkbox');
                checkbox.onchange = () => {
                    if (checkbox.checked) catSelected.add(conv.id);
                    else catSelected.delete(conv.id);
                    row.classList.toggle('bg-pink-50', checkbox.checked);
                    renderCatBatchBar();
                };
                list.appendChild(row);
            });
            section.appendChild(list);
        }
        elements.categoriesModalList.appendChild(section);
    });

    const catOptions = state.categories.filter(c => !c.isUnfiled);
    elements.catMoveSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '移动到...';
    elements.catMoveSelect.appendChild(defaultOpt);
    catOptions.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = cat.name;
        elements.catMoveSelect.appendChild(opt);
    });
}

function renderCatBatchBar() {
    const count = catSelected.size;
    elements.catSelectedCount.textContent = `已选 ${count} 个`;
    elements.categoriesBatchBar.classList.toggle('hidden', count === 0);
    elements.categoriesBatchBar.classList.toggle('flex', count > 0);
}

function catMoveSelected() {
    const target = elements.catMoveSelect.value;
    if (!target) return;
    catSelected.forEach(convId => moveConversationToCategory(convId, target));
    catSelected = new Set();
    renderCategoriesModalList();
    renderCatBatchBar();
    elements.catMoveSelect.value = '';
}

async function catDeleteSelected() {
    if (catSelected.size === 0) return;
    const confirmed = await showCustomConfirm(`确认删除选中的 ${catSelected.size} 个对话？`);
    if (!confirmed) return;
    state.conversations = state.conversations.filter(c => !catSelected.has(c.id));
    state.favorites = state.favorites.filter(f => !catSelected.has(f.conversationId));
    saveConversations();
    saveFavorites();
    updateNotesBadge();
    if (catSelected.has(state.currentConversationId)) {
        state.currentConversationId = null;
        localStorage.removeItem('elaina_open_current_conv');
        elements.conversationHistory.classList.add('hidden');
        elements.inputBar.classList.add('hidden');
        elements.initialState.classList.remove('hidden');
        elements.currentConversationTitle.textContent = '伊蕾娜';
    }
    catSelected = new Set();
    renderCategoriesModalList();
    renderCatBatchBar();
    renderFolderList();
}


// ==================== 消息渲染 ====================

function renderThinkingMessage() {
    if (!elements.conversationHistory) return;
    if (document.getElementById('thinking-bubble')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'thinking-bubble';
    wrapper.className = 'flex gap-3 mb-4 thinking-bubble animate-fade-in-up';
    wrapper.innerHTML = `
        <div class="pixso-chat-avatar" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="2.7"/>
                <circle cx="5.5" cy="12" r="3.2"/>
                <circle cx="18.5" cy="12" r="3.2"/>
                <circle cx="12" cy="5.5" r="3.2"/>
                <circle cx="12" cy="18.5" r="3.2"/>
            </svg>
        </div>
        <div class="flex-1 min-w-0">
            <div class="bubble-ai rounded-2xl px-4 py-3 inline-flex items-center gap-2.5">
                <span class="thinking-dot"></span>
                <span class="thinking-dot"></span>
                <span class="thinking-dot"></span>
                <span class="thinking-label text-sm ml-1">伊蕾娜正在想...</span>
            </div>
        </div>
    `;
    elements.conversationHistory.appendChild(wrapper);
    elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
}

// ========================================================================
//  回合过程渲染：思考行 + 工具调用行 + 每回合总览
// ========================================================================
//
// 为什么要有这一整块，而不是"把 reasoning 拼到气泡里"：
//   ① 角色扮演应用里，模型思考内容经常包含"我不该直接回答这个"这类
//      出戏的元叙述，混进正文会破坏体验 —— 必须分开展示；
//   ② 关掉思考开关时，工具调用记录**仍然要显示**（用户的原话：
//      "思考模式关闭的情况下思维链还是要显示工具调用的"）——
//      因为那是"AI 干了什么"的事实记录，不是思考过程；
//   ③ 需要"每回合总览"：用户想知道这一轮 AI 到底做了什么，
//      而不是逐行读每一条调用。
//
// 折叠策略（参考 DSH）：全部默认折叠，摘要行常驻。
// 理由：这是聊天应用，正文才是主角；思考动辄上千字，默认展开会把对话顶走。

/** 一次回合（= 一条 AI 回复的处理过程）的记录容器 */
function createTurnTrace() {
    return { reasoning: '', tools: [], startedAt: Date.now() };
}

/** 当前正在进行的回合记录。一条 AI 回复对应一个，回复完成后清空。 */
let activeTurnTrace = null;

/** 本轮过程区要插到哪个消息前面（AI 气泡的 id） */
let activeTurnAnchorId = null;

function beginTurnTrace(anchorMessageId) {
    activeTurnTrace = createTurnTrace();
    activeTurnAnchorId = anchorMessageId ? String(anchorMessageId) : null;
    return activeTurnTrace;
}

/**
 * 追加思考增量。思考开关关着时也允许调用 —— 由渲染层决定显不显示，
 * 而不是由收集层决定收不收：万一用户中途打开开关，已经收到的内容不该是空的。
 */
function appendTurnReasoning(delta) {
    if (!activeTurnTrace || !delta) return;
    activeTurnTrace.reasoning += String(delta);
    scheduleTurnProcessRender();
}

/**
 * 记录一次工具/操作调用。
 *
 * @param {object} entry { kind, title, summary, args, result, state }
 *   kind    用于选图标与配色：read/write/search/command/phone/file/others
 *   state   running | ok | error | stopped
 *   args    调用参数（展开后显示）
 *   result  执行结果（展开后显示）
 */
function recordTurnTool(entry) {
    if (!activeTurnTrace) return null;
    const item = {
        kind: String(entry?.kind || 'others'),
        title: String(entry?.title || '操作'),
        summary: String(entry?.summary || ''),
        args: entry?.args === undefined ? '' : String(entry.args),
        result: entry?.result === undefined ? '' : String(entry.result),
        state: String(entry?.state || 'ok'),
        at: Date.now()
    };
    activeTurnTrace.tools.push(item);
    scheduleTurnProcessRender();
    return item;
}

/** 更新最近一条工具记录的状态/结果（执行完成时回填） */
function updateTurnTool(item, patch = {}) {
    if (!item || !activeTurnTrace) return;
    if (patch.state !== undefined) item.state = String(patch.state);
    if (patch.result !== undefined) item.result = String(patch.result);
    if (patch.summary !== undefined) item.summary = String(patch.summary);
    scheduleTurnProcessRender();
}

/**
 * 增量渲染用 requestAnimationFrame 合并。
 *
 * 不合并的话，流式每来一个 token 就重建一次 DOM —— 一次长回复有上千个增量，
 * 每个都重排一次会让页面明显卡顿（而且越到后面越卡，因为内容越长）。
 * 合并到每帧一次，视觉上完全看不出差别，开销却降了两个数量级。
 */
let turnProcessRenderScheduled = false;
function scheduleTurnProcessRender() {
    if (turnProcessRenderScheduled) return;
    turnProcessRenderScheduled = true;
    const run = () => { turnProcessRenderScheduled = false; renderTurnProcess(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
}

/** 工具类型 → 图标 SVG（内联，避免依赖图标库） */
function processIconSvg(kind) {
    const paths = {
        read: '<path stroke-linecap="round" stroke-linejoin="round" d="M4 5.5A2.5 2.5 0 016.5 3H20v15H6.5A2.5 2.5 0 004 20.5z"/><path stroke-linecap="round" d="M4 5.5v15"/>',
        write: '<path stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9a2.1 2.1 0 10-3-3L5 17v3z"/>',
        search: '<circle cx="11" cy="11" r="6"/><path stroke-linecap="round" d="M20 20l-4.3-4.3"/>',
        command: '<rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M7 9l3 3-3 3M13 15h4"/>',
        phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path stroke-linecap="round" d="M10.5 18.5h3"/>',
        file: '<path stroke-linecap="round" stroke-linejoin="round" d="M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V9z"/><path stroke-linecap="round" d="M13 3v6h6"/>',
        think: '<path stroke-linecap="round" stroke-linejoin="round" d="M9.7 17h4.6M12 3a6 6 0 00-3.6 10.8c.7.5 1.1 1.3 1.1 2.2V16h5v-.1c0-.9.4-1.6 1.1-2.2A6 6 0 0012 3z"/>',
        others: '<circle cx="12" cy="12" r="8"/><path stroke-linecap="round" d="M12 8v4.5l2.5 1.5"/>'
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${paths[kind] || paths.others}</svg>`;
}

/** 状态 → 中文文案 */
function processStateLabel(state) {
    if (state === 'running') return '运行中';
    if (state === 'error') return '失败';
    if (state === 'stopped') return '已停止';
    return '完成';
}

/** 生成一条过程行的 HTML（思考行 / 工具行通用） */
function processRowHtml({ kind, title, summary, state, bodyHtml }) {
    return `
        <div class="process-row" data-state="${escapeHtml(state || 'ok')}" data-kind="${escapeHtml(kind)}">
            <button type="button" class="process-row-head" onclick="toggleProcessRow(this)" aria-expanded="false">
                <span class="process-row-icon" aria-hidden="true">${processIconSvg(kind)}</span>
                <span class="process-state" aria-hidden="true"></span>
                <span class="process-row-title">${escapeHtml(title)}</span>
                ${summary ? `<span class="process-row-summary">${escapeHtml(summary)}</span>` : '<span class="process-row-summary"></span>'}
                <span class="process-row-status">${escapeHtml(processStateLabel(state))}</span>
                <span class="process-row-chevron" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>
                </span>
            </button>
            <div class="process-row-body">${bodyHtml || ''}</div>
        </div>`;
}

/** 展开/收起一条过程行（内联 onclick，与项目其它地方一致） */
function toggleProcessRow(button) {
    const row = button?.closest?.('.process-row');
    if (!row) return;
    const open = row.classList.toggle('is-open');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/**
 * 把当前回合的过程渲染到界面上。
 *
 * 渲染目标：`#turn-process-<锚点消息 id>`。锚点就是 AI 气泡的 id，
 * 过程区插在它**前面** —— 这样用户先看到"AI 做了什么/想了什么"，
 * 再看到正文，符合阅读顺序（DSH 也是这个顺序）。
 */
function renderTurnProcess() {
    if (!elements.conversationHistory) return;
    const trace = activeTurnTrace;
    if (!trace) return;

    // 思考开关：只控制**思考行**是否显示。
    // 工具调用行无条件显示 —— 那是"AI 干了什么"的事实记录，
    // 关掉思考不代表用户可以不知道 AI 动了哪些文件。
    const showReasoning = Boolean(state.settings.thinkingMode);
    const hasReasoning = showReasoning && trace.reasoning.trim().length > 0;
    const hasTools = trace.tools.length > 0;
    if (!hasReasoning && !hasTools) return;

    const anchorId = activeTurnAnchorId ? `turn-process-${safeAttrId(activeTurnAnchorId)}` : 'turn-process-active';
    let host = document.getElementById(anchorId);
    if (!host) {
        host = document.createElement('div');
        host.id = anchorId;
        host.className = 'turn-process';
        // 插到 AI 气泡前面；找不到就追加到末尾（例如自动语音那条路径）
        const anchor = activeTurnAnchorId ? document.getElementById(`msg-${safeAttrId(activeTurnAnchorId)}`) : null;
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor);
        else elements.conversationHistory.appendChild(host);
    }

    const parts = [];

    // ---- 每回合总览（放最前面，折叠状态下也能看清这一轮做了什么）----
    const counts = { ok: 0, error: 0, running: 0, stopped: 0 };
    for (const t of trace.tools) counts[t.state] = (counts[t.state] || 0) + 1;
    const summaryBits = [];
    if (hasReasoning) summaryBits.push('已思考');
    if (counts.ok) summaryBits.push(`${counts.ok} 个操作完成`);
    if (counts.error) summaryBits.push(`${counts.error} 个失败`);
    if (counts.running) summaryBits.push(`${counts.running} 个进行中`);
    if (counts.stopped) summaryBits.push(`${counts.stopped} 个已停止`);
    if (summaryBits.length) {
        parts.push(`<div class="turn-summary">${summaryBits
            .map((b) => escapeHtml(b))
            .join('<span class="turn-summary-sep">·</span>')}</div>`);
    }

    // ---- 思考行（只有开关打开时才有）----
    if (hasReasoning) {
        const text = trace.reasoning.trim();
        const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) || '思考中';
        parts.push(processRowHtml({
            kind: 'think',
            title: '思考',
            // 摘要用首行并截断 —— 一行摘要 + 省略号，是折叠态的全部信息量
            summary: firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine,
            state: trace.done ? 'ok' : 'running',
            bodyHtml: `<div class="process-reasoning">${escapeHtml(text)}</div>`
        }));
    }

    // ---- 工具调用行 ----
    for (const t of trace.tools) {
        const body = [];
        if (t.args) body.push(`<span class="process-row-label">参数</span><pre>${escapeHtml(t.args)}</pre>`);
        if (t.result) body.push(`<span class="process-row-label">结果</span><pre>${escapeHtml(t.result)}</pre>`);
        parts.push(processRowHtml({
            kind: t.kind,
            title: t.title,
            summary: t.summary,
            state: t.state,
            bodyHtml: body.join('')
        }));
    }

    host.innerHTML = parts.join('');
    // 自动滚到底：流式输出时用户视线在底部，不滚的话新内容会出现在屏幕外
    elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
}

/** 回合结束：把思考行标成完成，并保留过程区（历史消息回看时还要看得到） */
function finishTurnTrace() {
    if (!activeTurnTrace) return;
    activeTurnTrace.done = true;
    renderTurnProcess();
}

function removeThinkingMessage() {
    const el = document.getElementById('thinking-bubble');
    if (el) {
        el.style.transition = 'opacity 0.2s ease-out, transform 0.2s ease-out';
        el.style.opacity = '0';
        el.style.transform = 'translateY(-4px)';
        setTimeout(() => el.remove(), 200);
    }
    state.thinkingMessageId = null;
}

let activeVoicePlayerId = null;
let activeVoicePlaybackStatus = 'idle';
let voicePlaybackGeneration = 0;
let voicePlaybackStartGeneration = 0;
let activeVoiceSession = null;
const pendingAutomaticVoiceMessageIds = new Set();
const pendingJapaneseVoiceTextTasks = new WeakMap();
const voicePlaybackTasksByMessageId = new Map();

function getJapaneseVoiceText(message) {
    const voiceText = String(message?.voiceJp || '').trim();
    return /[\u3040-\u30ff]/.test(voiceText) ? voiceText : '';
}

function ensureJapaneseVoiceText(message) {
    const existing = getJapaneseVoiceText(message);
    if (existing) return Promise.resolve(existing);
    if (!message || typeof message !== 'object') return Promise.resolve('');
    const pending = pendingJapaneseVoiceTextTasks.get(message);
    if (pending) return pending;
    const dialogueOnly = sanitizeTtsText(message.text || '', false);
    if (!dialogueOnly) return Promise.resolve('');
    const task = translateToJapanese(dialogueOnly).then(result => {
        const japanese = String(result || '').trim();
        if (!/[\u3040-\u30ff]/.test(japanese)) return '';
        message.voiceJp = japanese;
        return japanese;
    });
    pendingJapaneseVoiceTextTasks.set(message, task);
    const clearTask = () => {
        if (pendingJapaneseVoiceTextTasks.get(message) === task) pendingJapaneseVoiceTextTasks.delete(message);
    };
    task.then(clearTask, clearTask);
    return task;
}

function createVoiceCancellationError() {
    const error = new Error('语音播放已取消');
    error.name = 'AbortError';
    error.code = 'VOICE_CANCELLED';
    return error;
}

function isVoiceCancellation(error) {
    return error?.name === 'AbortError' || error?.code === 'VOICE_CANCELLED';
}

function createVoiceSession(messageId = null) {
    const session = {
        generation: ++voicePlaybackGeneration,
        messageId,
        cancelled: false,
        abortController: null,
        webSocket: null,
        audioSources: new Set(),
        browserUtterance: null
    };
    session.cancelPromise = new Promise(resolve => { session.resolveCancel = resolve; });
    activeVoiceSession = session;
    return session;
}

function isVoiceSessionActive(session) {
    return Boolean(session) && activeVoiceSession === session && !session.cancelled && session.generation === voicePlaybackGeneration;
}

function ensureVoiceSessionActive(session) {
    if (!isVoiceSessionActive(session)) throw createVoiceCancellationError();
}

function estimateVoiceDurationSeconds(text) {
    const clean = sanitizeTtsText(text || '', false);
    if (!clean) return 0;
    const cjkCount = (clean.match(/[\u3400-\u9fff\u3040-\u30ff]/g) || []).length;
    const latinWords = clean.replace(/[\u3400-\u9fff\u3040-\u30ff]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    const punctuationPauses = (clean.match(/[，。！？；：,.!?;:]/g) || []).length * 0.16;
    const speed = Math.max(0.5, Number(state.settings.ttsSpeed) || 1);
    return Math.max(2, Math.ceil((cjkCount / 4.5 + latinWords / 2.4 + punctuationPauses) / speed));
}

function formatVoiceDuration(seconds) {
    const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function voiceWaveformMarkup() {
    return Array.from({ length: 15 }, () => '<span class="voice-wave-bar"></span>').join('');
}

function updateVoicePlayerButton(messageId, status) {
    const button = document.getElementById(`voice-player-${safeAttrId(messageId)}`);
    if (!button) return;
    const isPlaying = status === 'playing';
    const isPaused = status === 'paused';
    const isLoading = status === 'loading';
    button.classList.toggle('is-playing', isPlaying);
    button.classList.toggle('is-paused', isPaused);
    button.classList.toggle('is-loading', isLoading);
    button.setAttribute('aria-busy', isLoading ? 'true' : 'false');
    button.setAttribute('aria-label', isLoading ? '伊蕾娜的语音生成中' : isPlaying ? '暂停伊蕾娜的语音' : isPaused ? '继续伊蕾娜的语音' : '播放伊蕾娜的语音');
}

function setVoicePlaybackLoading(messageId) {
    if (activeVoicePlayerId && String(activeVoicePlayerId) !== String(messageId)) {
        updateVoicePlayerButton(activeVoicePlayerId, 'idle');
    }
    activeVoicePlayerId = messageId;
    activeVoicePlaybackStatus = 'loading';
    updateVoicePlayerButton(messageId, 'loading');
}

function setVoicePlaybackState(messageId, playing, durationSeconds = 0) {
    if (activeVoicePlayerId && String(activeVoicePlayerId) !== String(messageId)) {
        updateVoicePlayerButton(activeVoicePlayerId, 'idle');
    }
    if (!playing) {
        updateVoicePlayerButton(messageId, 'idle');
        if (String(activeVoicePlayerId) === String(messageId)) {
            activeVoicePlayerId = null;
            activeVoicePlaybackStatus = 'idle';
        }
        return;
    }
    activeVoicePlayerId = messageId;
    activeVoicePlaybackStatus = 'playing';
    updateVoicePlayerButton(messageId, 'playing');
}

function markVoicePlaybackStarted(messageId, durationSeconds = 0) {
    // 用户可能在音频真正产出前就点了暂停，启动回调不能把它强行切回播放。
    if (String(activeVoicePlayerId) === String(messageId) && activeVoicePlaybackStatus === 'paused') {
        updateVoicePlayerButton(messageId, 'paused');
        if (_audioContext && _audioContext.state === 'running') _audioContext.suspend().catch(() => {});
        if ('speechSynthesis' in window && window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
            window.speechSynthesis.pause();
        }
        return;
    }
    setVoicePlaybackState(messageId, true, durationSeconds);
}

async function toggleVoicePlayback(messageId) {
    if (String(activeVoicePlayerId) !== String(messageId)) return false;
    if (activeVoicePlaybackStatus === 'loading') {
        console.log('[TTS] 语音仍在生成，点击复用当前任务');
        return true;
    }
    if (activeVoicePlaybackStatus === 'playing') {
        activeVoicePlaybackStatus = 'paused';
        updateVoicePlayerButton(messageId, 'paused');
        if (_audioContext && _audioContext.state === 'running') await _audioContext.suspend().catch(() => {});
        if ('speechSynthesis' in window && window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
            window.speechSynthesis.pause();
        }
        return true;
    }
    if (activeVoicePlaybackStatus === 'paused') {
        if (_audioContext && _audioContext.state === 'suspended') await _audioContext.resume().catch(() => {});
        if ('speechSynthesis' in window && window.speechSynthesis.paused) window.speechSynthesis.resume();
        activeVoicePlaybackStatus = 'playing';
        updateVoicePlayerButton(messageId, 'playing');
        return true;
    }
    return false;
}

async function stopActiveVoicePlayback(invalidatePendingStart = true) {
    if (invalidatePendingStart) voicePlaybackStartGeneration += 1;
    const previousId = activeVoicePlayerId;
    const previousSession = activeVoiceSession;
    voicePlaybackGeneration += 1;
    activeVoiceSession = null;
    if (previousSession) {
        previousSession.cancelled = true;
        if (previousSession.resolveCancel) previousSession.resolveCancel({ cancelled: true });
        if (previousSession.abortController) previousSession.abortController.abort();
        if (previousSession.webSocket) {
            try { previousSession.webSocket.close(1000, 'cancelled'); } catch (e) { /* 已关闭的连接无需处理 */ }
        }
        previousSession.audioSources.forEach(source => {
            try { source.stop(); } catch (e) { /* 音频源可能已经结束 */ }
            try { source.disconnect(); } catch (e) { /* 已断开的音频源无需处理 */ }
        });
        previousSession.audioSources.clear();
    }
    activeTtsTasks.clear();
    if (previousId != null) setVoicePlaybackState(previousId, false);
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    const previousContext = _audioContext;
    _audioContext = null;
    if (previousContext && previousContext.state !== 'closed') {
        try { await previousContext.close(); } catch (e) { /* 已结束的上下文无需处理 */ }
    }
}

async function startExclusiveVoicePlayback(messageId, text, onStart, options = {}) {
    const startGeneration = ++voicePlaybackStartGeneration;
    await stopActiveVoicePlayback(false);
    if (startGeneration !== voicePlaybackStartGeneration) return { cancelled: true };
    const session = createVoiceSession(messageId);
    if (startGeneration !== voicePlaybackStartGeneration || !isVoiceSessionActive(session)) return { cancelled: true };
    setVoicePlaybackLoading(messageId);
    return speakText(text, onStart, { ...options, messageId, session });
}

function startVoicePlaybackOnce(messageId, text, onStart, options = {}) {
    const messageKey = String(messageId);
    const existingTask = voicePlaybackTasksByMessageId.get(messageKey);
    if (existingTask) {
        console.log('[TTS] 复用同一消息正在进行的播放任务');
        return existingTask;
    }
    const task = startExclusiveVoicePlayback(messageId, text, onStart, options);
    voicePlaybackTasksByMessageId.set(messageKey, task);
    const clearTask = () => {
        if (voicePlaybackTasksByMessageId.get(messageKey) === task) {
            voicePlaybackTasksByMessageId.delete(messageKey);
        }
    };
    task.then(clearTask, clearTask);
    return task;
}

function renderMessage(message) {
    const div = document.createElement('div');
    div.id = `msg-${safeAttrId(message.id)}`;
    div.className = `message-item ${message.role === 'user' ? 'message-item-user' : 'message-item-ai'} animate-fade-in-up`;

    if (message.role === 'user') {
        const userImageUrl = isSafeComposerImageDataUrl(message.imageDataUrl) ? message.imageDataUrl : '';
        div.innerHTML = `
            <div class="flex gap-3 mb-4 group">
                <div class="flex-1">
                    <div class="bubble-user rounded-2xl p-4">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="text-xs font-medium text-indigo-500">You</span>
                            <span class="text-xs text-indigo-300">${escapeHtml(message.timestamp)}</span>
                            <button onclick="event.stopPropagation(); handleMessageFavoriteClick('${safeAttrId(message.id)}')"
                                    class="message-action-btn ml-auto p-1.5 rounded-lg hover:bg-white/60 transition-all flex items-center gap-1 ${isMessageFavorited(state.currentConversationId, message.id) ? 'text-amber-500' : 'text-indigo-300 hover:text-amber-500'}">
                                <svg class="w-3.5 h-3.5" fill="${isMessageFavorited(state.currentConversationId, message.id) ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
                                </svg>
                                <span class="text-xs font-medium">${isMessageFavorited(state.currentConversationId, message.id) ? '已收藏' : '收藏'}</span>
                            </button>
                        </div>
                        ${userImageUrl ? `<img class="message-image" src="${userImageUrl}" alt="${escapeHtml(message.imageName || '用户发送的图片')}">` : ''}
                        ${message.text ? `<p class="text-indigo-800 text-sm leading-relaxed whitespace-pre-wrap">${renderMessageText(message.text)}</p>` : ''}
                    </div>
                </div>
            </div>
        `;
    } else {
        const faved = isMessageFavorited(state.currentConversationId, message.id);
        const name = state.characterCard.name || '伊蕾娜';
        const voiceDurationSeconds = estimateVoiceDurationSeconds(message.voiceJp || message.text);
        const voiceCard = `
                        <div class="ai-voice-card">
                            <button id="voice-player-${safeAttrId(message.id)}" onclick="event.stopPropagation(); replayAIMessage('${safeAttrId(message.id)}')" class="ai-voice-player" type="button" aria-label="播放伊蕾娜的语音">
                                <span class="voice-play-box" aria-hidden="true">
                                    <svg class="voice-icon-play" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.8v10.4L13 8 4 2.8z"/></svg>
                                    <svg class="voice-icon-pause" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>
                                </span>
                                <span class="voice-duration">${formatVoiceDuration(voiceDurationSeconds)}</span>
                                <span class="voice-waveform" aria-hidden="true">${voiceWaveformMarkup()}</span>
                            </button>
                        </div>`;
        div.innerHTML = `
            <div class="flex gap-3 mb-4 group">
                <div class="flex-1">
                    <div class="bubble-ai rounded-2xl p-4">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="ai-speaker-name">${escapeHtml(name)}</span>
                            <span class="text-xs text-indigo-300">${escapeHtml(message.timestamp)}</span>
                            <button onclick="event.stopPropagation(); handleMessageFavoriteClick('${safeAttrId(message.id)}')"
                                    class="message-action-btn ml-auto p-1.5 rounded-lg hover:bg-white/60 transition-all flex items-center gap-1 ${faved ? 'text-amber-500' : 'text-indigo-300 hover:text-amber-500'}">
                                <svg class="w-3.5 h-3.5" fill="${faved ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
                                </svg>
                                <span class="text-xs font-medium">${faved ? '已收藏' : '收藏'}</span>
                            </button>
                        </div>
                        <p class="text-indigo-950 text-sm leading-relaxed whitespace-pre-wrap">${renderMessageText(message.text)}</p>
                        ${voiceCard}
                    </div>
                </div>
            </div>
        `;
    }
    elements.conversationHistory.appendChild(div);
    elements.conversationHistory.scrollTop = elements.conversationHistory.scrollHeight;
    return div;
}

async function replayAIMessage(messageId) {
    const voiceMessageKey = String(messageId);
    const existingPlaybackTask = voicePlaybackTasksByMessageId.get(voiceMessageKey);
    if (existingPlaybackTask && activeVoicePlaybackStatus === 'loading') {
        console.log('[TTS] 自动语音尚未返回，手动点击复用当前请求');
        return;
    }
    if (await toggleVoicePlayback(messageId)) return;
    if (existingPlaybackTask) {
        console.log('[TTS] 同一消息已有播放任务，忽略重复启动');
        return;
    }
    if (pendingAutomaticVoiceMessageIds.has(voiceMessageKey)) {
        console.log('[TTS] 自动语音仍在准备，忽略重复的手动播放请求');
        return;
    }
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    if (!conv) return;
    const msg = conv.messages.find(m => String(m.id) === String(messageId));
    if (!msg) return;
    const wantsJp = state.settings.ttsLang === 'japanese';
    let textToSpeak = msg.text;
    if (wantsJp) {
        try {
            textToSpeak = await ensureJapaneseVoiceText(msg);
            if (textToSpeak) saveConversations();
        } catch (error) {
            console.error('[TTS] 手动播放的日语朗读稿生成失败:', error);
            setVoicePlaybackState(messageId, false);
            showClientApiError(error);
            return;
        }
        if (!textToSpeak) {
            setVoicePlaybackState(messageId, false);
            showCustomAlert('未能生成日语朗读稿，本次不会回退播放中文。请稍后重试。', '日语语音生成失败');
            return;
        }
    }
    const durationSeconds = estimateVoiceDurationSeconds(textToSpeak);
    startVoicePlaybackOnce(messageId, textToSpeak, () => {
        markVoicePlaybackStarted(messageId, durationSeconds);
    }, {
        cacheKey: buildMessageTtsCacheKey(msg, textToSpeak, conv.id),
        onEnd: () => setVoicePlaybackState(messageId, false)
    }).catch(error => {
        if (isVoiceCancellation(error)) return;
        console.error('[TTS] 缓存语音播放失败:', error);
        setVoicePlaybackState(messageId, false);
        showClientApiError(error);
    });
}

