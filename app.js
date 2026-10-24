import { Backend } from './backend.js';

(() => {
  // =====================================================================
  //  Yordamchilar
  // =====================================================================
  const $ = (s) => document.querySelector(s);
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  };

  // Faqat o'zimizning statik SVG'lar uchun `html` ishlatiladi; foydalanuvchi matni hech qachon innerHTML'ga tushmaydi.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (ts) => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  function fmtDay(ts) {
    const t = Date.now();
    if (sameDay(ts, t)) return 'Bugun';
    if (sameDay(ts, t - 86400e3)) return 'Kecha';
    const d = new Date(ts);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }
  function fmtListTime(ts) {
    if (sameDay(ts, Date.now())) return fmtTime(ts);
    const d = new Date(ts);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  }
  const fmtDur = (s) => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + pad(s % 60); };
  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  const hashId = (id) => { let h = 0; for (const ch of String(id == null ? '' : id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
  const COLORS = ['#e17076', '#e8914f', '#9b84e0', '#5fb84a', '#3fb7bb', '#4f9ad6', '#e56aa5'];
  const initials = (name) =>
    (String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => Array.from(w)[0] || '').join('').toUpperCase()) || '?';
  function paintAvatar(el, name, id, online) {
    el.style.background = COLORS[hashId(id) % COLORS.length];
    el.replaceChildren(initials(name));
    if (online) el.append(h('span', { class: 'dot' }));
  }
  function avatarEl(name, id, online, extra) {
    const el = h('div', { class: 'avatar' + (extra ? ' ' + extra : '') });
    paintAvatar(el, name, id, online);
    return el;
  }

  let toastTimer;
  function toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  const canMedia = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  function mediaUnavailableMsg() {
    return window.isSecureContext
      ? 'Brauzeringiz kamera/mikrofonni qo‘llamaydi'
      : 'Kamera va mikrofon faqat HTTPS (yoki localhost) orqali ishlaydi';
  }

  // =====================================================================
  //  Holat va API
  // =====================================================================
  const S = {
    me: null,
    chats: [],
    active: null,
    msgState: new Map(), // chatId -> { list, hasMore, loaded, pending }
    config: Backend.config,
    typing: {},
    searchMode: false,
    lastMsgTime: null,
    drafts: {},
  };
  const chatById = (id) => S.chats.find((c) => c.id === id);
  const avatarId = (c) => (c.type === 'direct' ? c.otherUserId : c.id);

  // =====================================================================
  //  Kirish / ro'yxatdan o'tish
  // =====================================================================
  let authMode = 'login';
  function setAuthMode(mode) {
    authMode = mode;
    $('#tabLogin').classList.toggle('active', mode === 'login');
    $('#tabRegister').classList.toggle('active', mode === 'register');
    $('#nameField').classList.toggle('hidden', mode !== 'register');
    $('#authSubmit').textContent = mode === 'login' ? 'Kirish' : 'Ro‘yxatdan o‘tish';
    $('#authPass').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    $('#authError').textContent = '';
  }
  $('#tabLogin').addEventListener('click', () => setAuthMode('login'));
  $('#tabRegister').addEventListener('click', () => setAuthMode('register'));

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#authSubmit');
    $('#authError').textContent = '';
    btn.disabled = true;
    try {
      const u = $('#authUser').value.trim();
      const pw = $('#authPass').value;
      S.me = authMode === 'login'
        ? await Backend.login(u, pw)
        : await Backend.register(u, pw, $('#authName').value.trim());
      $('#authPass').value = '';
      await startApp();
    } catch (err) {
      $('#authError').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function showAuth() {
    $('#app').classList.add('hidden');
    $('#auth').classList.remove('hidden');
    document.body.classList.remove('chat-open');
  }

  function logout(silent) {
    Backend.logout().catch(() => {});
    S.me = null; S.chats = []; S.active = null; S.msgState.clear(); S.drafts = {};
    endCall();
    closeVN();
    cancelVoice();
    $('#uploads').replaceChildren();
    $('#chat').classList.add('hidden');
    $('#empty').classList.remove('hidden');
    showAuth();
  }
  $('#btnLogout').addEventListener('click', () => logout(false));

  async function startApp() {
    $('#auth').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#meName').textContent = S.me.displayName;
    $('#meUser').textContent = '@' + S.me.username;
    paintAvatar($('#meAvatar'), S.me.displayName, S.me.id);
    Backend.start(onWS);
    await loadChats().catch((e) => toast(e.message));
  }

  // =====================================================================
  //  Real vaqt hodisalari (Firestore)
  // =====================================================================
  function onWS(m) {
    switch (m.type) {
      case 'message': onIncomingMessage(m.message); break;
      case 'chat': loadChats().catch(() => {}); break;
      case 'presence':
        for (const c of S.chats) if (c.otherUserId === m.userId) c.online = m.online;
        renderChatList();
        if (S.active) renderChatHeader();
        break;
      case 'typing':
        S.typing[m.chatId] = Date.now();
        if (S.active === m.chatId) { renderChatHeader(); setTimeout(renderChatHeader, 3100); }
        break;
      case 'call':
        onCallSignal(m.from, m.data || {}).catch((e) => console.error('call error', e));
        break;
      case 'error': toast(m.message); break;
      default: break;
    }
  }

  // =====================================================================
  //  Chatlar ro'yxati
  // =====================================================================
  async function loadChats() {
    S.chats = await Backend.loadChats();
    sortChats();
    renderChatList();
    updateTitle();
    if (S.active) renderChatHeader();
  }
  function sortChats() {
    S.chats.sort((a, b) => (b.lastMessage ? b.lastMessage.id : 0) - (a.lastMessage ? a.lastMessage.id : 0) || String(b.id).localeCompare(String(a.id)));
  }
  function upsertChat(chat) {
    const i = S.chats.findIndex((c) => c.id === chat.id);
    if (i >= 0) S.chats[i] = chat; else S.chats.push(chat);
    sortChats();
    renderChatList();
  }
  function updateTitle() {
    const n = S.chats.reduce((s, c) => s + (c.unread || 0), 0);
    document.title = n ? `(${n}) MeeT` : 'MeeT';
  }
  function kindLabel(m) {
    switch (m.kind) {
      case 'voice': return '🎤 Ovozli xabar';
      case 'video_note': return '⭕ Video xabar';
      case 'image': return '🖼 Rasm';
      case 'video': return '🎬 Video';
      case 'audio': return '🎵 ' + (m.fileName || 'Audio');
      case 'file': return '📎 ' + (m.fileName || 'Fayl');
      default: return m.text || '';
    }
  }
  function previewText(c) {
    const m = c.lastMessage;
    if (!m) return 'Xabarlar yo‘q';
    let prefix = '';
    if (m.senderId === S.me.id) prefix = 'Siz: ';
    else if (c.type === 'group') prefix = (m.senderName || '').split(' ')[0] + ': ';
    return prefix + kindLabel(m);
  }
  function chatItem(c) {
    return h('div', { class: 'item' + (c.id === S.active ? ' active' : ''), onclick: () => openChat(c.id) },
      avatarEl(c.title, avatarId(c), c.type === 'direct' && c.online),
      h('div', { class: 'item-body' },
        h('div', { class: 'item-top' },
          h('div', { class: 'name', text: c.title }),
          h('div', { class: 'item-time', text: c.lastMessage ? fmtListTime(c.lastMessage.createdAt) : '' })),
        h('div', { class: 'item-bottom' },
          h('div', { class: 'item-last', text: previewText(c) }),
          c.unread ? h('div', { class: 'badge', text: c.unread > 99 ? '99+' : c.unread }) : null)));
  }
  function renderChatList() {
    if (S.searchMode) return;
    const list = $('#chatList');
    list.replaceChildren();
    if (!S.chats.length) {
      list.append(h('div', { class: 'list-empty', text: 'Hali chatlar yo‘q. Yuqoridagi qidiruv orqali foydalanuvchini toping.' }));
      return;
    }
    for (const c of S.chats) list.append(chatItem(c));
  }

  // ---- qidiruv
  let searchTimer;
  function clearSearch() {
    $('#searchInput').value = '';
    S.searchMode = false;
    renderChatList();
  }
  $('#searchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    const v = $('#searchInput').value.trim();
    if (v.length < 2) { S.searchMode = false; renderChatList(); return; }
    searchTimer = setTimeout(() => doSearch(v), 250);
  });
  async function doSearch(v) {
    try {
      const users = await Backend.searchUsers(v);
      if ($('#searchInput').value.trim() !== v) return;
      S.searchMode = true;
      const list = $('#chatList');
      list.replaceChildren(h('div', { class: 'list-title', text: 'Foydalanuvchilar' }));
      if (!users.length) list.append(h('div', { class: 'list-empty', text: 'Hech kim topilmadi' }));
      for (const u of users) {
        list.append(h('div', { class: 'item', onclick: () => openDirect(u.id) },
          avatarEl(u.displayName, u.id),
          h('div', { class: 'item-body' },
            h('div', { class: 'name', text: u.displayName }),
            h('div', { class: 'sub', text: '@' + u.username }))));
      }
    } catch (e) { toast(e.message); }
  }
  async function openDirect(userId) {
    try {
      const chat = await Backend.openDirect(userId);
      upsertChat(chat);
      clearSearch();
      openChat(chat.id);
    } catch (e) { toast(e.message); }
  }

  // =====================================================================
  //  Chat oynasi
  // =====================================================================
  async function openChat(id) {
    if (S.active !== null && S.active !== id) S.drafts[S.active] = $('#msgInput').value;
    S.active = id;
    document.body.classList.add('chat-open');
    if (!history.state || !history.state.chat) history.pushState({ chat: id }, '');
    $('#empty').classList.add('hidden');
    $('#chat').classList.remove('hidden');
    renderChatHeader();
    renderChatList();
    $('#msgInput').value = S.drafts[id] || '';
    autoGrow();
    updateSendBtn();
    filterUploads();
    $('#messages').replaceChildren();
    try {
      await loadMessages(id);
    } catch (e) { toast(e.message); }
    if (S.active === id) {
      markRead(id);
      if (matchMedia('(pointer: fine)').matches) $('#msgInput').focus();
    }
  }
  function closeChat(fromPop) {
    if (S.active === null) return;
    S.drafts[S.active] = $('#msgInput').value;
    S.active = null;
    document.body.classList.remove('chat-open');
    $('#chat').classList.add('hidden');
    $('#empty').classList.remove('hidden');
    renderChatList();
    if (!fromPop && history.state && history.state.chat) history.back();
  }
  $('#btnBack').addEventListener('click', () => closeChat(false));
  window.addEventListener('popstate', () => closeChat(true));

  function renderChatHeader() {
    const c = chatById(S.active);
    if (!c) return;
    $('#chatName').textContent = c.title;
    paintAvatar($('#chatAvatar'), c.title, avatarId(c), c.type === 'direct' && c.online);
    let status;
    if (S.typing[c.id] && Date.now() - S.typing[c.id] < 3000) status = 'yozmoqda…';
    else if (c.type === 'direct') status = c.online ? 'onlayn' : 'oflayn';
    else status = c.memberCount + ' a’zo';
    $('#chatStatus').textContent = status;
    $('#callButtons').classList.toggle('hidden', c.type !== 'direct');
  }

  async function loadMessages(chatId) {
    let st = S.msgState.get(chatId);
    if (!st) { st = { list: [], hasMore: false, loaded: false, pending: [] }; S.msgState.set(chatId, st); }
    if (!st.loaded) {
      const d = await Backend.loadMessages(chatId);
      st.list = d.messages;
      st.hasMore = d.hasMore;
      st.loaded = true;
      const have = new Set(st.list.map((m) => m.id));
      for (const m of st.pending) if (!have.has(m.id)) st.list.push(m);
      st.pending = [];
      st.list.sort((a, b) => a.id - b.id);
    }
    if (S.active === chatId) renderMessages(true);
  }

  function renderMessages(toBottom) {
    const box = $('#messages');
    const chat = chatById(S.active);
    const st = S.msgState.get(S.active);
    if (!chat || !st) return;
    box.replaceChildren();
    S.lastMsgTime = null;
    if (st.hasMore) box.append(h('button', { class: 'day', onclick: loadOlder, text: 'Oldingi xabarlarni yuklash' }));
    for (const m of st.list) appendMsgNode(m, chat);
    if (toBottom) box.scrollTop = box.scrollHeight;
  }
  function appendMsgNode(m, chat) {
    const box = $('#messages');
    if (S.lastMsgTime === null || !sameDay(S.lastMsgTime, m.createdAt)) {
      box.append(h('div', { class: 'day', text: fmtDay(m.createdAt) }));
    }
    S.lastMsgTime = m.createdAt;
    box.append(msgNode(m, chat));
  }
  async function loadOlder() {
    const id = S.active;
    const st = S.msgState.get(id);
    if (!st || !st.list.length) return;
    try {
      const d = await Backend.loadMessages(id, st.list[0].id);
      if (S.active !== id) return;
      const box = $('#messages');
      const prevH = box.scrollHeight;
      st.list = d.messages.concat(st.list);
      st.hasMore = d.hasMore;
      renderMessages(false);
      box.scrollTop = box.scrollHeight - prevH;
    } catch (e) { toast(e.message); }
  }

  function addMessage(m) {
    const st = S.msgState.get(m.chatId);
    if (!st) return; // chat hali ochilmagan: ochilganda serverdan yuklanadi
    if (!st.loaded) { st.pending.push(m); return; }
    if (st.list.some((x) => x.id === m.id)) return;
    st.list.push(m);
    if (S.active === m.chatId) {
      const box = $('#messages');
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140 || m.senderId === S.me.id;
      appendMsgNode(m, chatById(m.chatId));
      if (nearBottom) box.scrollTop = box.scrollHeight;
    }
  }

  function onIncomingMessage(m) {
    const chat = chatById(m.chatId);
    if (!chat) { loadChats().catch(() => {}); return; }
    const already = chat.lastMessage && chat.lastMessage.id >= m.id;
    if (!already) chat.lastMessage = m;
    const mine = m.senderId === S.me.id;
    const viewing = S.active === m.chatId && document.visibilityState === 'visible';
    if (!mine && !viewing && !already) chat.unread = (chat.unread || 0) + 1;
    sortChats();
    renderChatList();
    updateTitle();
    addMessage(m);
    if (!mine && viewing) markRead(m.chatId);
    if (!mine && !viewing && !already) notify(chat, m);
  }

  const readTimers = {};
  function markRead(chatId) {
    const chat = chatById(chatId);
    if (chat && chat.unread) { chat.unread = 0; renderChatList(); updateTitle(); }
    clearTimeout(readTimers[chatId]);
    readTimers[chatId] = setTimeout(() => Backend.markRead(chatId), 300);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.active) markRead(S.active);
  });

  function notify(chat, m) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
      const n = new Notification(chat.title, { body: kindLabel(m), tag: 'chat' + chat.id });
      n.onclick = () => { window.focus(); openChat(chat.id); n.close(); };
    } catch { /* ignore */ }
  }
  document.addEventListener('click', () => {
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
  }, { once: true });

  // =====================================================================
  //  Xabar ko'rinishlari
  // =====================================================================
  function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /(https?:\/\/[^\s<]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      frag.append(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer nofollow', text: m[0] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  let currentMedia = null;
  function claimPlayback(el) {
    if (currentMedia && currentMedia !== el) { try { currentMedia.pause(); } catch { /* ignore */ } }
    currentMedia = el;
  }

  function setFileSrc(el, m, suffix = '') {
    Backend.getFileUrl(m).then((u) => { el.src = u + suffix; }).catch(() => { el.classList.add('broken'); });
  }
  async function downloadFile(m) {
    try {
      const u = await Backend.getFileUrl(m);
      const a = document.createElement('a');
      a.href = u; a.download = m.fileName || 'fayl';
      document.body.append(a); a.click(); a.remove();
    } catch (e) { toast(e.message || 'Faylni yuklab bo‘lmadi'); }
  }

  function voiceNode(m) {
    const audio = h('audio', { preload: 'none' });
    setFileSrc(audio, m);
    const btn = h('button', { class: 'vp-btn', html: ICON.play, 'aria-label': 'Ijro etish' });
    const fill = h('i');
    const bar = h('div', { class: 'vp-bar' }, fill);
    const time = h('div', { class: 'vp-time', text: fmtDur(m.duration) });
    const total = () => (m.duration || (isFinite(audio.duration) ? audio.duration : 0) || 1);
    btn.addEventListener('click', () => {
      if (audio.paused) { claimPlayback(audio); audio.play().catch(() => toast('Ovozni ijro etib bo‘lmadi')); } else audio.pause();
    });
    audio.addEventListener('play', () => { btn.innerHTML = ICON.pause; });
    audio.addEventListener('pause', () => { btn.innerHTML = ICON.play; });
    audio.addEventListener('timeupdate', () => {
      fill.style.width = Math.min(100, (audio.currentTime / total()) * 100) + '%';
      time.textContent = fmtDur(audio.currentTime);
    });
    audio.addEventListener('ended', () => { fill.style.width = '0'; time.textContent = fmtDur(m.duration); btn.innerHTML = ICON.play; });
    bar.addEventListener('click', (e) => {
      const rect = bar.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      if (isFinite(audio.duration) && audio.duration > 0) audio.currentTime = ratio * audio.duration;
      else if (m.duration) { try { audio.currentTime = ratio * m.duration; } catch { /* ignore */ } }
    });
    return h('div', { class: 'voice' }, btn, h('div', { class: 'vp-main' }, bar, time), audio);
  }

  function videoNoteNode(m) {
    const v = h('video', { playsinline: true, preload: 'metadata' });
    setFileSrc(v, m, '#t=0.1');
    const badge = h('span', { class: 'vn-badge', text: fmtDur(m.duration) });
    const box = h('div', { class: 'vnote' }, v, h('div', { class: 'vn-play', html: ICON.play }), badge);
    box.addEventListener('click', () => {
      if (v.paused) { claimPlayback(v); v.play().catch(() => toast('Videoni ijro etib bo‘lmadi')); } else v.pause();
    });
    v.addEventListener('play', () => box.classList.add('playing'));
    v.addEventListener('pause', () => box.classList.remove('playing'));
    v.addEventListener('timeupdate', () => { badge.textContent = fmtDur((m.duration || 0) - v.currentTime); });
    v.addEventListener('ended', () => { box.classList.remove('playing'); v.currentTime = 0.1; badge.textContent = fmtDur(m.duration); });
    return box;
  }

  function fileNode(m) {
    const ext = ((m.fileName || '').match(/\.([a-z0-9]{1,5})$/i) || [, 'FILE'])[1];
    return h('a', { class: 'file', href: '#', onclick: (e) => { e.preventDefault(); downloadFile(m); } },
      h('div', { class: 'file-ico' + (ext.toLowerCase() === 'apk' ? ' apk' : ''), text: ext }),
      h('div', { class: 'file-body' },
        h('div', { class: 'file-name', text: m.fileName || 'Fayl' }),
        h('div', { class: 'file-size', text: fmtSize(m.fileSize || 0) })));
  }

  function msgNode(m, chat) {
    const mine = m.senderId === S.me.id;
    const bubble = h('div', { class: `bubble k-${m.kind}` });
    if (!mine && chat && chat.type === 'group') bubble.append(h('div', { class: 'sender', text: m.senderName }));
    switch (m.kind) {
      case 'voice': bubble.append(voiceNode(m)); break;
      case 'video_note': bubble.append(videoNoteNode(m)); break;
      case 'image':
        const img = h('img', {
          class: 'media-img', alt: m.fileName || 'rasm',
          onclick: () => { $('#lightboxImg').src = img.src; $('#lightbox').classList.remove('hidden'); },
        });
        setFileSrc(img, m);
        bubble.append(img);
        break;
      case 'video':
        const vid = h('video', { class: 'media-video', controls: true, playsinline: true, preload: 'metadata' });
        setFileSrc(vid, m);
        bubble.append(vid);
        break;
      case 'audio':
        bubble.append(h('div', { class: 'file-name', text: m.fileName || 'Audio' }));
        const au = h('audio', { class: 'audio-el', controls: true, preload: 'none' });
        setFileSrc(au, m);
        bubble.append(au);
        break;
      case 'file': bubble.append(fileNode(m)); break;
      default: bubble.append(h('div', { class: 'text' }, linkify(m.text || '')));
    }
    if (m.kind !== 'text' && m.text) bubble.append(h('div', { class: 'caption' }, linkify(m.text)));
    bubble.append(h('div', { class: 'meta', text: fmtTime(m.createdAt) }));
    return h('div', { class: 'row ' + (mine ? 'mine' : 'theirs'), dataset: { id: m.id } }, bubble);
  }

  $('#lightbox').addEventListener('click', () => { $('#lightbox').classList.add('hidden'); $('#lightboxImg').removeAttribute('src'); });

  // =====================================================================
  //  Yozish paneli: matn, fayl
  // =====================================================================
  const input = $('#msgInput');
  const isTouch = matchMedia('(pointer: coarse)').matches;
  let lastTypingSent = 0;

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  function updateSendBtn() {
    const has = input.value.trim().length > 0;
    $('#btnSend').classList.toggle('hidden', !has);
    $('#btnMic').classList.toggle('hidden', has);
    $('#btnVideoNote').classList.toggle('hidden', has);
  }
  input.addEventListener('input', () => {
    autoGrow();
    updateSendBtn();
    if (S.active && Date.now() - lastTypingSent > 2500) {
      lastTypingSent = Date.now();
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.isComposing) { e.preventDefault(); sendText(); }
  });
  input.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (files.length && S.active) {
      e.preventDefault();
      for (const f of files) uploadFile(S.active, f, { name: f.name || 'rasm.png' });
    }
  });
  $('#btnSend').addEventListener('click', sendText);

  async function sendText() {
    const text = input.value.trim();
    if (!text || S.active === null) return;
    const chatId = S.active;
    input.value = '';
    delete S.drafts[chatId];
    autoGrow();
    updateSendBtn();
    try {
      const msg = await Backend.sendText(chatId, text);
      onIncomingMessage(msg);
    } catch (e) {
      if (S.active === chatId && !input.value) { input.value = text; autoGrow(); updateSendBtn(); }
      toast(e.message);
    }
  }

  $('#btnAttach').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (S.active === null) return;
    for (const f of files) uploadFile(S.active, f, { name: f.name });
  });
  const chatEl = $('#chat');
  chatEl.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  chatEl.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length || S.active === null) return;
    e.preventDefault();
    for (const f of e.dataTransfer.files) uploadFile(S.active, f, { name: f.name });
  });

  // ---- yuklash (oqim bilan, foiz ko'rsatiladi)
  function filterUploads() {
    for (const el of $('#uploads').children) el.classList.toggle('hidden', el.dataset.chat !== String(S.active));
  }
  function uploadFile(chatId, blob, { name, kind, duration }) {
    const maxBytes = S.config.maxFileMb * 1024 * 1024;
    if (blob.size > maxBytes) { toast(`Fayl juda katta (hozircha maksimum ${S.config.maxFileMb} MB)`); return Promise.resolve(null); }
    const fill = h('i');
    const pct = h('span', { class: 'up-pct', text: '0%' });
    const ctrl = new AbortController();
    const item = h('div', { class: 'up-item', dataset: { chat: chatId } },
      h('span', { class: 'up-name', text: name }),
      h('span', { class: 'up-bar' }, fill), pct,
      h('button', { class: 'up-x', text: '✕', title: 'Bekor qilish', onclick: () => ctrl.abort() }));
    $('#uploads').append(item);
    filterUploads();
    return Backend.uploadFile(chatId, blob, { name, kind, duration }, (p) => {
      const v = Math.round(p * 100);
      fill.style.width = v + '%';
      pct.textContent = v + '%';
    }, ctrl.signal).then((msg) => {
      item.remove();
      onIncomingMessage(msg);
      return msg;
    }).catch((e) => {
      item.remove();
      if (!ctrl.signal.aborted) toast(e.message || 'Yuklashda xatolik');
      return null;
    });
  }

  // =====================================================================
  //  Yozib olish (ovozli xabar, dumaloq video)
  // =====================================================================
  const AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  const VIDEO_MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  function pickMime(list) {
    if (!window.MediaRecorder) return '';
    return list.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }
  function extFor(type, video) {
    if (/webm/.test(type)) return '.webm';
    if (/mp4/.test(type)) return video ? '.mp4' : '.m4a';
    if (/ogg/.test(type)) return '.ogg';
    return video ? '.webm' : '.webm';
  }
  function makeRecorder(stream, mimes, extra) {
    const mime = pickMime(mimes);
    const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), ...(extra || {}) });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start(250);
    const type = (rec.mimeType || mime || '').split(';')[0];
    return {
      stop: () => new Promise((resolve) => {
        const done = () => { stream.getTracks().forEach((t) => t.stop()); resolve(new Blob(chunks, { type })); };
        if (rec.state === 'inactive') return done();
        rec.onstop = done;
        rec.stop();
      }),
      cancel: () => {
        rec.onstop = null; rec.ondataavailable = null;
        try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  }

  // ---- ovozli xabar
  const Voice = { cur: null };
  function showRecBar(on) {
    $('#composeNormal').classList.toggle('hidden', on);
    $('#composeRec').classList.toggle('hidden', !on);
    $('#recTime').textContent = '0:00';
  }
  async function startVoice() {
    if (Voice.cur || S.active === null) return;
    if (!canMedia() || !window.MediaRecorder) return toast(mediaUnavailableMsg());
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { return toast('Mikrofonga ruxsat berilmadi'); }
    const cur = { rec: makeRecorder(stream, AUDIO_MIMES), chatId: S.active, t0: Date.now(), timer: null };
    cur.timer = setInterval(() => {
      const s = (Date.now() - cur.t0) / 1000;
      $('#recTime').textContent = fmtDur(s);
      if (s >= 300) finishVoice(true); // 5 daqiqa chegarasi
    }, 250);
    Voice.cur = cur;
    showRecBar(true);
  }
  async function finishVoice(send) {
    const cur = Voice.cur;
    if (!cur) return;
    Voice.cur = null;
    clearInterval(cur.timer);
    showRecBar(false);
    if (!send) { cur.rec.cancel(); return; }
    const dur = Math.round((Date.now() - cur.t0) / 1000);
    const blob = await cur.rec.stop();
    if (dur < 1 || blob.size < 400) { toast('Xabar juda qisqa'); return; }
    uploadFile(cur.chatId, blob, { name: 'voice' + extFor(blob.type, false), kind: 'voice', duration: dur });
  }
  function cancelVoice() { if (Voice.cur) finishVoice(false); }
  $('#btnMic').addEventListener('click', startVoice);
  $('#recCancel').addEventListener('click', () => finishVoice(false));
  $('#recSend').addEventListener('click', () => finishVoice(true));

  // ---- dumaloq video xabar
  const VN = { stream: null, rec: null, t0: 0, timer: null, facing: 'user', state: 'idle', chatId: null };
  async function startVNStream() {
    stopVNStream();
    try {
      VN.stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: VN.facing, width: { ideal: 480 }, height: { ideal: 480 } },
      });
    } catch {
      toast('Kamera yoki mikrofonga ruxsat berilmadi');
      return false;
    }
    const v = $('#vnPreview');
    v.srcObject = VN.stream;
    v.style.transform = VN.facing === 'user' ? 'scaleX(-1)' : 'none';
    return true;
  }
  function stopVNStream() {
    if (VN.stream) { VN.stream.getTracks().forEach((t) => t.stop()); VN.stream = null; }
    $('#vnPreview').srcObject = null;
  }
  async function openVideoNote() {
    if (S.active === null || VN.state !== 'idle') return;
    if (!canMedia() || !window.MediaRecorder) return toast(mediaUnavailableMsg());
    VN.chatId = S.active;
    VN.state = 'preview';
    $('#vnOverlay').classList.remove('hidden');
    resetVNUi();
    if (!(await startVNStream())) closeVN();
  }
  function resetVNUi() {
    $('#vnRing').classList.remove('recording');
    $('#vnRecord').classList.remove('recording');
    $('#vnTime').textContent = '0:00';
    $('#vnHint').textContent = 'Yozishni boshlash uchun qizil tugmani bosing';
    $('#vnFlip').classList.remove('hidden');
  }
  function startVNRec() {
    if (!VN.stream) return;
    VN.rec = makeRecorder(VN.stream, VIDEO_MIMES, { videoBitsPerSecond: 600000, audioBitsPerSecond: 32000 });
    VN.state = 'recording';
    VN.t0 = Date.now();
    $('#vnRing').classList.add('recording');
    $('#vnRecord').classList.add('recording');
    $('#vnFlip').classList.add('hidden');
    $('#vnHint').textContent = 'Yuborish uchun tugmani yana bosing (maksimum 1 daqiqa)';
    VN.timer = setInterval(() => {
      const s = (Date.now() - VN.t0) / 1000;
      $('#vnTime').textContent = fmtDur(s);
      if (s >= 60) finishVN(true);
    }, 250);
  }
  async function finishVN(send) {
    if (VN.state !== 'recording') return;
    const chatId = VN.chatId;
    const dur = Math.round((Date.now() - VN.t0) / 1000);
    clearInterval(VN.timer);
    const rec = VN.rec;
    VN.rec = null;
    VN.stream = null; // makeRecorder.stop() oqim treklarini o'zi to'xtatadi
    VN.state = 'idle';
    $('#vnOverlay').classList.add('hidden');
    $('#vnPreview').srcObject = null;
    if (!send) { rec.cancel(); return; }
    const blob = await rec.stop();
    if (dur < 1 || blob.size < 1000) { toast('Video juda qisqa'); return; }
    uploadFile(chatId, blob, { name: 'video-xabar' + extFor(blob.type, true), kind: 'video_note', duration: dur });
  }
  function closeVN() {
    if (VN.state === 'recording' && VN.rec) { clearInterval(VN.timer); VN.rec.cancel(); VN.rec = null; VN.stream = null; }
    stopVNStream();
    VN.state = 'idle';
    $('#vnOverlay').classList.add('hidden');
  }
  $('#btnVideoNote').addEventListener('click', openVideoNote);
  $('#vnCancel').addEventListener('click', closeVN);
  $('#vnRecord').addEventListener('click', () => { if (VN.state === 'preview') startVNRec(); else finishVN(true); });
  $('#vnFlip').addEventListener('click', async () => {
    if (VN.state !== 'preview') return;
    VN.facing = VN.facing === 'user' ? 'environment' : 'user';
    if (!(await startVNStream())) closeVN();
  });

  // =====================================================================
  //  Video / ovozli qo'ng'iroq (WebRTC)
  // =====================================================================
  const Call = { cur: null, incoming: null };
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const wsCall = (to, data) => Backend.sendSignal(to, data);

  const Ring = {
    ctx: null, iv: null,
    start() {
      this.stop();
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = this.ctx || new AC();
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const beep = () => {
          const o = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          o.type = 'sine'; o.frequency.value = 480; g.gain.value = 0.07;
          o.connect(g); g.connect(this.ctx.destination);
          o.start(); o.stop(this.ctx.currentTime + 0.45);
        };
        beep();
        this.iv = setInterval(beep, 1600);
      } catch { /* ovoz bo'lmasa ham ishlayveradi */ }
    },
    stop() { if (this.iv) { clearInterval(this.iv); this.iv = null; } },
  };

  function setCallStatus(t) { $('#callStatus').textContent = t; }

  function setupPC(c) {
    const pc = new RTCPeerConnection({ iceServers: S.config.iceServers });
    c.pc = pc;
    c.stream.getTracks().forEach((t) => pc.addTrack(t, c.stream));
    pc.onicecandidate = (e) => {
      if (e.candidate) wsCall(c.peerId, { kind: 'ice', callId: c.id, candidate: e.candidate });
    };
    pc.ontrack = (e) => {
      const rv = $('#remoteVideo');
      if (rv.srcObject !== e.streams[0]) rv.srcObject = e.streams[0];
      rv.play().catch(() => {});
      if (e.track.kind === 'video') $('#callOverlay').classList.remove('no-remote-video');
    };
    pc.onconnectionstatechange = () => {
      if (Call.cur !== c) return;
      const st = pc.connectionState;
      if (st === 'connected') onConnected(c);
      else if (st === 'disconnected') setCallStatus('Aloqa yomon…');
      else if (st === 'failed') { wsCall(c.peerId, { kind: 'end', callId: c.id }); endCall('Ulanish uzildi. Ikki tomon orasida to‘g‘ridan-to‘g‘ri aloqa o‘rnatilmadi (TURN server kerak bo‘lishi mumkin)'); }
    };
  }
  function onConnected(c) {
    if (c.startedAt) return;
    c.startedAt = Date.now();
    clearTimeout(c.timeout);
    const tick = () => setCallStatus(fmtDur((Date.now() - c.startedAt) / 1000));
    tick();
    c.timer = setInterval(tick, 1000);
  }
  async function flushIce(c) {
    const list = c.pendingIce;
    c.pendingIce = [];
    for (const cand of list) { try { await c.pc.addIceCandidate(cand); } catch { /* ignore */ } }
  }

  function showCallUI(c) {
    const ov = $('#callOverlay');
    ov.classList.remove('hidden', 'cam-off');
    ov.classList.toggle('audio-only', !c.video);
    ov.classList.toggle('no-remote-video', !!c.video);
    $('#callName').textContent = c.peerName;
    paintAvatar($('#callAvatar'), c.peerName, c.peerId);
    $('#localVideo').srcObject = c.stream;
    $('#callMic').classList.remove('off');
    $('#callCam').classList.remove('off');
    $('#callCam').classList.toggle('hidden', !c.video);
    setCallStatus(c.role === 'caller' ? 'Qo‘ng‘iroq qilinmoqda…' : 'Ulanmoqda…');
  }

  async function getCallStream(video) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
  }

  async function startCall(video) {
    const chat = chatById(S.active);
    if (!chat || chat.type !== 'direct') return;
    if (Call.cur || Call.incoming) return toast('Siz allaqachon qo‘ng‘iroqdasiz');
    if (!canMedia() || !window.RTCPeerConnection) return toast(mediaUnavailableMsg());
    if (!navigator.onLine) return toast('Internetga ulanilmagan');
    let stream;
    try { stream = await getCallStream(video); }
    catch { return toast(video ? 'Kamera yoki mikrofonga ruxsat berilmadi' : 'Mikrofonga ruxsat berilmadi'); }
    const c = {
      id: rid(), peerId: chat.otherUserId, peerName: chat.title, chatId: chat.id, video, role: 'caller',
      stream, pc: null, pendingIce: [], startedAt: 0, timeout: null, timer: null,
    };
    Call.cur = c;
    setupPC(c);
    showCallUI(c);
    try {
      const offer = await c.pc.createOffer();
      await c.pc.setLocalDescription(offer);
      wsCall(c.peerId, { kind: 'offer', callId: c.id, sdp: c.pc.localDescription, video, callerName: S.me.displayName });
    } catch (e) {
      console.error(e);
      return endCall('Qo‘ng‘iroqni boshlab bo‘lmadi');
    }
    c.timeout = setTimeout(() => {
      if (Call.cur === c && !c.startedAt) { wsCall(c.peerId, { kind: 'end', callId: c.id }); endCall('Javob berilmadi'); }
    }, 45000);
  }

  function hideIncoming() {
    const inc = Call.incoming;
    Call.incoming = null;
    if (inc) clearTimeout(inc.timeout);
    $('#incoming').classList.add('hidden');
    Ring.stop();
  }

  function onOffer(from, d) {
    if (Call.cur || Call.incoming) { wsCall(from, { kind: 'busy', callId: d.callId }); return; }
    const chat = S.chats.find((c) => c.otherUserId === from);
    const name = (chat && chat.title) || String(d.callerName || 'Foydalanuvchi').slice(0, 40);
    const inc = { from, callId: d.callId, sdp: d.sdp, video: !!d.video, name, pendingIce: [], timeout: null };
    inc.timeout = setTimeout(() => { if (Call.incoming === inc) hideIncoming(); }, 50000);
    Call.incoming = inc;
    paintAvatar($('#incAvatar'), name, from);
    $('#incName').textContent = name;
    $('#incKind').textContent = inc.video ? 'Video qo‘ng‘iroq' : 'Ovozli qo‘ng‘iroq';
    $('#incoming').classList.remove('hidden');
    Ring.start();
    try { if (navigator.vibrate) navigator.vibrate([300, 200, 300]); } catch { /* ignore */ }
    if (document.visibilityState !== 'visible') notify({ id: 'call' + from, title: name }, { kind: 'text', text: inc.kind === 'video' ? 'Video qo‘ng‘iroq' : 'Qo‘ng‘iroq' });
  }

  async function acceptCall() {
    const inc = Call.incoming;
    if (!inc) return;
    hideIncoming();
    if (!canMedia() || !window.RTCPeerConnection) {
      wsCall(inc.from, { kind: 'reject', callId: inc.callId });
      return toast(mediaUnavailableMsg());
    }
    let stream;
    try { stream = await getCallStream(inc.video); }
    catch {
      wsCall(inc.from, { kind: 'reject', callId: inc.callId });
      return toast('Kamera yoki mikrofonga ruxsat berilmadi');
    }
    const c = {
      id: inc.callId, peerId: inc.from, peerName: inc.name, video: inc.video, role: 'callee',
      stream, pc: null, pendingIce: inc.pendingIce, startedAt: 0, timeout: null, timer: null,
    };
    Call.cur = c;
    setupPC(c);
    showCallUI(c);
    try {
      await c.pc.setRemoteDescription(inc.sdp);
      await flushIce(c);
      const answer = await c.pc.createAnswer();
      await c.pc.setLocalDescription(answer);
      wsCall(c.peerId, { kind: 'answer', callId: c.id, sdp: c.pc.localDescription });
    } catch (e) {
      console.error(e);
      wsCall(c.peerId, { kind: 'end', callId: c.id });
      endCall('Qo‘ng‘iroqni qabul qilib bo‘lmadi');
    }
  }
  function declineCall() {
    const inc = Call.incoming;
    if (!inc) return;
    wsCall(inc.from, { kind: 'reject', callId: inc.callId });
    hideIncoming();
  }

  async function onCallSignal(from, d) {
    const c = Call.cur;
    switch (d.kind) {
      case 'offer': onOffer(from, d); break;
      case 'answer':
        if (!c || c.id !== d.callId || c.peerId !== from || c.role !== 'caller') return;
        setCallStatus('Ulanmoqda…');
        await c.pc.setRemoteDescription(d.sdp);
        await flushIce(c);
        break;
      case 'ice': {
        if (!d.candidate) return;
        if (Call.incoming && Call.incoming.callId === d.callId) { Call.incoming.pendingIce.push(d.candidate); return; }
        if (!c || c.id !== d.callId) return;
        if (c.pc.remoteDescription) { try { await c.pc.addIceCandidate(d.candidate); } catch { /* ignore */ } }
        else c.pendingIce.push(d.candidate);
        break;
      }
      case 'end':
      case 'reject':
      case 'busy':
      case 'unavailable': {
        if (Call.incoming && Call.incoming.callId === d.callId) { hideIncoming(); toast('Qo‘ng‘iroq bekor qilindi'); return; }
        if (!c || c.id !== d.callId) return;
        const msg = { end: 'Qo‘ng‘iroq tugadi', reject: 'Qo‘ng‘iroq rad etildi', busy: 'Foydalanuvchi band', unavailable: 'Foydalanuvchi hozir tarmoqda emas' }[d.kind];
        endCall(msg);
        break;
      }
      case 'handled':
        if (Call.incoming && Call.incoming.callId === d.callId) hideIncoming();
        break;
      default: break;
    }
  }

  function endCall(reason) {
    const c = Call.cur;
    Call.cur = null;
    if (c) {
      clearTimeout(c.timeout);
      clearInterval(c.timer);
      try { c.pc.close(); } catch { /* ignore */ }
      c.stream.getTracks().forEach((t) => t.stop());
    }
    hideIncoming();
    $('#callOverlay').classList.add('hidden');
    $('#remoteVideo').srcObject = null;
    $('#localVideo').srcObject = null;
    if (reason) toast(reason);
  }

  $('#btnVoiceCall').addEventListener('click', () => startCall(false));
  $('#btnVideoCall').addEventListener('click', () => startCall(true));
  $('#incAccept').addEventListener('click', acceptCall);
  $('#incDecline').addEventListener('click', declineCall);
  $('#callHang').addEventListener('click', () => {
    const c = Call.cur;
    if (!c) return;
    wsCall(c.peerId, { kind: 'end', callId: c.id });
    endCall();
  });
  $('#callMic').addEventListener('click', () => {
    const c = Call.cur;
    if (!c) return;
    const tracks = c.stream.getAudioTracks();
    const on = !(tracks[0] && tracks[0].enabled);
    tracks.forEach((t) => { t.enabled = on; });
    $('#callMic').classList.toggle('off', !on);
  });
  $('#callCam').addEventListener('click', () => {
    const c = Call.cur;
    if (!c || !c.video) return;
    const tracks = c.stream.getVideoTracks();
    const on = !(tracks[0] && tracks[0].enabled);
    tracks.forEach((t) => { t.enabled = on; });
    $('#callCam').classList.toggle('off', !on);
    $('#callOverlay').classList.toggle('cam-off', !on);
  });

  // =====================================================================
  //  Yangi guruh
  // =====================================================================
  const G = { members: new Map(), timer: null };
  function renderChips() {
    const box = $('#groupChips');
    box.replaceChildren();
    for (const [id, u] of G.members) {
      box.append(h('span', { class: 'chip' }, u.displayName,
        h('button', { text: '✕', 'aria-label': 'Olib tashlash', onclick: () => { G.members.delete(id); renderChips(); } })));
    }
  }
  function openGroupDialog() {
    G.members.clear();
    $('#groupTitle').value = '';
    $('#groupSearch').value = '';
    $('#groupResults').replaceChildren();
    $('#groupError').textContent = '';
    renderChips();
    $('#groupDialog').classList.remove('hidden');
    $('#groupTitle').focus();
  }
  const closeGroupDialog = () => $('#groupDialog').classList.add('hidden');
  $('#btnGroup').addEventListener('click', openGroupDialog);
  $('#groupCancel').addEventListener('click', closeGroupDialog);
  $('#groupSearch').addEventListener('input', () => {
    clearTimeout(G.timer);
    const v = $('#groupSearch').value.trim();
    if (v.length < 2) { $('#groupResults').replaceChildren(); return; }
    G.timer = setTimeout(async () => {
      try {
        const users = await Backend.searchUsers(v);
        const box = $('#groupResults');
        box.replaceChildren();
        for (const u of users.filter((x) => !G.members.has(x.id))) {
          box.append(h('div', { class: 'item', onclick: () => { G.members.set(u.id, u); renderChips(); box.replaceChildren(); $('#groupSearch').value = ''; } },
            avatarEl(u.displayName, u.id),
            h('div', { class: 'item-body' },
              h('div', { class: 'name', text: u.displayName }),
              h('div', { class: 'sub', text: '@' + u.username }))));
        }
      } catch (e) { $('#groupError').textContent = e.message; }
    }, 250);
  });
  $('#groupCreate').addEventListener('click', async () => {
    $('#groupError').textContent = '';
    try {
      const chat = await Backend.createGroup($('#groupTitle').value.trim(), [...G.members.keys()]);
      closeGroupDialog();
      upsertChat(chat);
      openChat(chat.id);
    } catch (e) { $('#groupError').textContent = e.message; }
  });

  // =====================================================================
  //  Klaviatura
  // =====================================================================
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').classList.contains('hidden')) $('#lightbox').click();
    else if (!$('#groupDialog').classList.contains('hidden')) closeGroupDialog();
    else if (VN.state !== 'idle') closeVN();
    else if (Voice.cur) finishVoice(false);
  });

  // =====================================================================
  //  Ishga tushirish
  // =====================================================================
  (async function boot() {
    try {
      const u = await Backend.init();
      if (u) { S.me = u; await startApp(); return; }
    } catch (e) { console.error(e); }
    showAuth();
  })();
})();
