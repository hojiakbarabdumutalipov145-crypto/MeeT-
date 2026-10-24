// MeeT — Firebase (Auth + Firestore) bilan ishlash qatlami.
// Serverga ehtiyoj yo'q: hamma narsa Firebase'da.
import { firebaseConfig, iceServers, maxFileMb, SDK_VERSION } from './config.js';

const base = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;
const [appMod, authMod, fsMod] = await Promise.all([
  import(`${base}/firebase-app.js`),
  import(`${base}/firebase-auth.js`),
  import(`${base}/firebase-firestore.js`),
]);
const { initializeApp } = appMod;
const { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } = authMod;
const {
  initializeFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc, addDoc,
  query, where, orderBy, limit, startAfter, onSnapshot, writeBatch, Bytes,
} = fsMod;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Cheklangan tarmoqlarda (korporativ, ba'zi davlatlar) ulanish uchun avtomatik long-polling
const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

const EMAIL_DOMAIN = '@meet.user';
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const CHUNK = 700 * 1024;
const ONLINE_MS = 100 * 1000;

const BackendError = class extends Error {};

// ------------------------------------------------------------------ yordamchilar
const msgNum = (ts, id) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000;
  return ts * 1000 + h;
};
function msgFromData(chatId, docId, d) {
  return {
    id: msgNum(d.ts, docId), docId, chatId,
    senderId: d.senderId, senderName: d.senderName || '',
    kind: d.kind, text: d.text || null,
    fileName: d.fileName || null, fileSize: d.fileSize || 0, mime: d.mime || null,
    duration: d.duration || null, createdAt: d.ts, chunks: d.chunks || 0,
  };
}
const publicUser = (uid, d) => ({ id: uid, username: d.username, displayName: d.displayName });

function authMessage(e) {
  const c = (e && e.code) || '';
  if (c === 'auth/email-already-in-use') return 'Bu foydalanuvchi nomi band';
  if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' || c === 'auth/user-not-found' || c === 'auth/invalid-login-credentials')
    return 'Foydalanuvchi nomi yoki parol noto‘g‘ri';
  if (c === 'auth/weak-password') return 'Parol kamida 6 ta belgidan iborat bo‘lsin';
  if (c === 'auth/too-many-requests') return 'Juda ko‘p urinish. Birozdan so‘ng qayta urinib ko‘ring';
  if (c === 'auth/network-request-failed') return 'Internetga ulanib bo‘lmadi';
  if (c === 'auth/operation-not-allowed') return 'Firebase’da Email/Password kirish yoqilmagan (Authentication → Sign-in method)';
  if (c === 'auth/api-key-not-valid.-please-pass-a-valid-api-key.' || c === 'auth/invalid-api-key')
    return 'config.js dagi apiKey noto‘g‘ri. Firebase konsolidan qayta nusxalang';
  if (c === 'permission-denied') return 'Ruxsat yo‘q. Firestore qoidalari (rules) joylanganini tekshiring';
  return (e && e.message) || 'Xatolik yuz berdi';
}
const wrap = async (fn) => {
  try { return await fn(); }
  catch (e) { if (e instanceof BackendError) throw e; console.error(e); throw new BackendError(authMessage(e)); }
};

// ------------------------------------------------------------------ holat
let me = null; // { id, username, displayName }
let emit = () => {};
let unsubs = [];
let chatsCache = new Map(); // chatId -> chat doc data (xom)
let chatsReady = null;
let activeWatch = null; // { chatId, unsub, first: Promise }
const peerUnsubs = new Map(); // peerId -> unsub
const peerSeen = new Map(); // peerId -> lastSeen
const fileCache = new Map(); // docId -> Promise<blobUrl>
let heartbeatTimer = null;
let signalSeq = 0;

const readKey = () => 'meet_read_' + (me ? me.id : '');
function readMap() { try { return JSON.parse(localStorage.getItem(readKey()) || '{}'); } catch { return {}; } }

function chatView(id, d) {
  const last = d.lastMessage ? msgFromData(id, d.lastMessage.docId, d.lastMessage) : null;
  const readTs = readMap()[id] || 0;
  const out = {
    id, type: d.type, title: d.title, createdAt: d.createdAt || 0, lastMessage: last,
    unread: last && last.senderId !== me.id && last.createdAt > readTs ? 1 : 0,
  };
  if (d.type === 'direct') {
    const otherId = d.members.find((u) => u !== me.id);
    const info = (d.memberInfo && d.memberInfo[otherId]) || {};
    out.title = info.n || 'Foydalanuvchi';
    out.username = info.u || '';
    out.otherUserId = otherId;
    out.online = isOnline(otherId);
  } else {
    out.memberCount = d.members.length;
  }
  return out;
}
const isOnline = (uid) => { const t = peerSeen.get(uid); return !!t && Date.now() - t < ONLINE_MS; };

function watchPeer(peerId) {
  if (peerUnsubs.has(peerId)) return;
  const un = onSnapshot(doc(db, 'users', peerId), (s) => {
    const d = s.data();
    if (!d) return;
    const was = isOnline(peerId);
    peerSeen.set(peerId, d.lastSeen || 0);
    if (was !== isOnline(peerId)) emit({ type: 'presence', userId: peerId, online: isOnline(peerId) });
  }, () => {});
  peerUnsubs.set(peerId, un);
}

function lastIdOf(d) { return d && d.lastMessage ? msgNum(d.lastMessage.ts, d.lastMessage.docId) : 0; }

// ------------------------------------------------------------------ ochiq API
export const Backend = {
  config: { iceServers, maxFileMb },
  Error: BackendError,

  /** Sahifa ochilganda: avval kirgan foydalanuvchi bormi? */
  init() {
    return new Promise((resolve) => {
      let first = true;
      onAuthStateChanged(auth, async (u) => {
        if (!first) return;
        first = false;
        if (!u) return resolve(null);
        try {
          const s = await getDoc(doc(db, 'users', u.uid));
          if (!s.exists()) { await signOut(auth); return resolve(null); }
          me = publicUser(u.uid, s.data());
          resolve(me);
        } catch (e) { console.error(e); resolve(null); }
      });
    });
  },

  register: (username, password, displayName) => wrap(async () => {
    const uname = String(username || '').trim().toLowerCase();
    const name = String(displayName || '').trim().slice(0, 40) || uname;
    if (!USERNAME_RE.test(uname)) throw new BackendError('Foydalanuvchi nomi 3–24 ta belgi: lotin harflari, raqam va _');
    if (typeof password !== 'string' || password.length < 6) throw new BackendError('Parol kamida 6 ta belgidan iborat bo‘lsin');
    const cred = await createUserWithEmailAndPassword(auth, uname + EMAIL_DOMAIN, password);
    const data = { username: uname, displayName: name, lastSeen: Date.now(), createdAt: Date.now() };
    await setDoc(doc(db, 'users', cred.user.uid), data);
    me = publicUser(cred.user.uid, data);
    return me;
  }),

  login: (username, password) => wrap(async () => {
    const uname = String(username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(uname) || !password) throw new BackendError('Foydalanuvchi nomi yoki parol noto‘g‘ri');
    const cred = await signInWithEmailAndPassword(auth, uname + EMAIL_DOMAIN, password);
    const s = await getDoc(doc(db, 'users', cred.user.uid));
    if (!s.exists()) throw new BackendError('Profil topilmadi');
    me = publicUser(cred.user.uid, s.data());
    return me;
  }),

  async logout() {
    this.stop();
    me = null;
    try { await signOut(auth); } catch { /* ignore */ }
  },

  /** Real vaqt tinglovchilarini ishga tushirish. onEvent({type:'message'|'chat'|'presence'|'call', ...}) */
  start(onEvent) {
    this.stop();
    emit = onEvent;
    const uid = me.id;
    let firstChats = true;
    let resolveChats;
    chatsReady = new Promise((r) => { resolveChats = r; });

    unsubs.push(onSnapshot(query(collection(db, 'chats'), where('members', 'array-contains', uid)), (snap) => {
      const events = [];
      for (const ch of snap.docChanges()) {
        const id = ch.doc.id;
        const d = ch.doc.data();
        if (ch.type === 'removed') { chatsCache.delete(id); continue; }
        const before = chatsCache.get(id);
        chatsCache.set(id, d);
        if (d.type === 'direct') watchPeer(d.members.find((u) => u !== uid));
        if (firstChats) continue;
        if (!before) events.push({ type: 'chat', chatId: id });
        if (lastIdOf(d) > lastIdOf(before) && d.lastMessage) {
          events.push({ type: 'message', message: msgFromData(id, d.lastMessage.docId, d.lastMessage) });
        }
      }
      if (firstChats) { firstChats = false; resolveChats(); }
      for (const e of events) emit(e);
    }, (e) => { console.error(e); resolveChats(); emit({ type: 'error', message: authMessage(e) }); }));

    // qo'ng'iroq signallari
    let firstSig = true;
    unsubs.push(onSnapshot(query(collection(db, 'signals'), where('to', '==', uid)), (snap) => {
      if (firstSig) { // eski (qolib ketgan) signallarni tozalaymiz
        firstSig = false;
        snap.docs.forEach((d) => deleteDoc(d.ref).catch(() => {}));
        return;
      }
      const added = snap.docChanges().filter((c) => c.type === 'added').map((c) => c.doc);
      added.sort((a, b) => (a.data().at || 0) - (b.data().at || 0));
      for (const d of added) {
        const s = d.data();
        deleteDoc(d.ref).catch(() => {});
        let data;
        try { data = JSON.parse(s.data); } catch { continue; }
        if (data.kind === 'offer' && s.from !== uid && !this.hasChatWith(s.from)) continue; // begona qo'ng'iroq
        emit({ type: 'call', from: s.from, data });
      }
    }, (e) => console.error('signals', e)));

    // onlayn holat
    const beat = () => { if (document.visibilityState === 'visible') updateDoc(doc(db, 'users', uid), { lastSeen: Date.now() }).catch(() => {}); };
    beat();
    heartbeatTimer = setInterval(() => {
      beat();
      for (const [pid, t] of peerSeen) emit({ type: 'presence', userId: pid, online: Date.now() - t < ONLINE_MS });
    }, 40000);
    this._vis = () => beat();
    document.addEventListener('visibilitychange', this._vis);
  },

  stop() {
    for (const u of unsubs) { try { u(); } catch { /* ignore */ } }
    unsubs = [];
    for (const u of peerUnsubs.values()) { try { u(); } catch { /* ignore */ } }
    peerUnsubs.clear(); peerSeen.clear();
    if (activeWatch) { try { activeWatch.unsub(); } catch { /* ignore */ } activeWatch = null; }
    clearInterval(heartbeatTimer);
    if (this._vis) document.removeEventListener('visibilitychange', this._vis);
    chatsCache = new Map();
    for (const p of fileCache.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
    fileCache.clear();
    emit = () => {};
  },

  hasChatWith(uid) {
    for (const d of chatsCache.values()) if (d.type === 'direct' && d.members.includes(uid)) return true;
    return false;
  },

  // -------------------------------------------------------------- chatlar
  async loadChats() {
    await chatsReady;
    const list = [];
    for (const [id, d] of chatsCache) list.push(chatView(id, d));
    return list;
  },

  searchUsers: (q) => wrap(async () => {
    const s = String(q || '').trim().replace(/^@/, '').toLowerCase();
    if (s.length < 2) return [];
    const snap = await getDocs(query(collection(db, 'users'),
      where('username', '>=', s), where('username', '<=', s + ''), limit(12)));
    return snap.docs.filter((d) => d.id !== me.id).map((d) => publicUser(d.id, d.data()));
  }),

  openDirect: (otherId) => wrap(async () => {
    if (!otherId || otherId === me.id) throw new BackendError('Foydalanuvchi topilmadi');
    const id = [me.id, otherId].sort().join('_');
    const ref = doc(db, 'chats', id);
    let s = await getDoc(ref);
    if (!s.exists()) {
      const o = await getDoc(doc(db, 'users', otherId));
      if (!o.exists()) throw new BackendError('Foydalanuvchi topilmadi');
      const od = o.data();
      const data = {
        type: 'direct', title: null, members: [me.id, otherId], createdAt: Date.now(), lastMessage: null, lastTs: 0,
        memberInfo: {
          [me.id]: { n: me.displayName, u: me.username },
          [otherId]: { n: od.displayName, u: od.username },
        },
      };
      await setDoc(ref, data);
      chatsCache.set(id, data);
      watchPeer(otherId);
      return chatView(id, data);
    }
    const d = s.data();
    chatsCache.set(id, d);
    watchPeer(otherId);
    return chatView(id, d);
  }),

  createGroup: (title, memberIds) => wrap(async () => {
    const t = String(title || '').trim().slice(0, 60);
    if (!t) throw new BackendError('Guruh nomini kiriting');
    const ids = [...new Set((memberIds || []).filter((x) => x && x !== me.id))];
    if (!ids.length) throw new BackendError('Kamida bitta a’zo tanlang');
    if (ids.length > 49) throw new BackendError('Guruhda 50 tadan ortiq a’zo bo‘lmaydi');
    const memberInfo = { [me.id]: { n: me.displayName, u: me.username } };
    for (const uid of ids) {
      const s = await getDoc(doc(db, 'users', uid));
      if (!s.exists()) throw new BackendError('Foydalanuvchi topilmadi');
      memberInfo[uid] = { n: s.data().displayName, u: s.data().username };
    }
    const ref = doc(collection(db, 'chats'));
    const data = { type: 'group', title: t, members: [me.id, ...ids], createdAt: Date.now(), lastMessage: null, lastTs: 0, memberInfo };
    await setDoc(ref, data);
    chatsCache.set(ref.id, data);
    return chatView(ref.id, data);
  }),

  markRead(chatId) {
    const m = readMap();
    m[chatId] = Date.now();
    try { localStorage.setItem(readKey(), JSON.stringify(m)); } catch { /* ignore */ }
  },

  // -------------------------------------------------------------- xabarlar
  /** Chat xabarlarini yuklaydi. before berilsa — eski xabarlar. Faol chatni real vaqtda tinglaydi. */
  loadMessages: (chatId, before) => wrap(async () => {
    const col = collection(db, 'chats', chatId, 'messages');
    const PAGE = 50;
    if (before) {
      const ts = Math.floor(Number(before) / 1000);
      const snap = await getDocs(query(col, orderBy('ts', 'desc'), startAfter(ts), limit(PAGE + 1)));
      const docs = snap.docs.slice(0, PAGE);
      return { messages: docs.map((d) => msgFromData(chatId, d.id, d.data())).reverse(), hasMore: snap.docs.length > PAGE };
    }
    if (activeWatch && activeWatch.chatId !== chatId) { activeWatch.unsub(); activeWatch = null; }
    if (activeWatch) { // allaqachon tinglanmoqda: yangidan olamiz
      const snap = await getDocs(query(col, orderBy('ts', 'desc'), limit(PAGE + 1)));
      const docs = snap.docs.slice(0, PAGE);
      return { messages: docs.map((d) => msgFromData(chatId, d.id, d.data())).reverse(), hasMore: snap.docs.length > PAGE };
    }
    return new Promise((resolve, reject) => {
      let first = true;
      const unsub = onSnapshot(query(col, orderBy('ts', 'desc'), limit(PAGE + 1)), (snap) => {
        if (first) {
          first = false;
          const docs = snap.docs.slice(0, PAGE);
          resolve({ messages: docs.map((d) => msgFromData(chatId, d.id, d.data())).reverse(), hasMore: snap.docs.length > PAGE });
          return;
        }
        for (const ch of snap.docChanges()) {
          if (ch.type === 'added') emit({ type: 'message', message: msgFromData(chatId, ch.doc.id, ch.doc.data()) });
        }
      }, (e) => { if (first) { first = false; reject(e); } else console.error(e); });
      activeWatch = { chatId, unsub };
    });
  }),

  _post: async (chatId, msgRef, payload) => {
    const ts = Date.now();
    const data = { senderId: me.id, senderName: me.displayName, ts, ...payload };
    const summary = { docId: msgRef.id, ...data };
    if (summary.text && summary.text.length > 300) summary.text = summary.text.slice(0, 300);
    const batch = writeBatch(db);
    batch.set(msgRef, data);
    batch.update(doc(db, 'chats', chatId), { lastMessage: summary, lastTs: ts });
    await batch.commit();
    return msgFromData(chatId, msgRef.id, data);
  },

  sendText: (chatId, text) => wrap(async () => {
    const t = String(text || '').trim().slice(0, 4000);
    if (!t) throw new BackendError('Xabar bo‘sh');
    const ref = doc(collection(db, 'chats', chatId, 'messages'));
    return Backend._post(chatId, ref, { kind: 'text', text: t });
  }),

  /** Fayl / rasm / ovozli / dumaloq video: bo'laklarga bo'lib Firestore'ga yoziladi. */
  uploadFile: (chatId, blob, opts, onProgress, signal) => wrap(async () => {
    const { name, kind: wanted, duration, caption } = opts;
    if (blob.size === 0) throw new BackendError('Fayl bo‘sh');
    if (blob.size > maxFileMb * 1024 * 1024) throw new BackendError(`Fayl juda katta (hozircha maksimum ${maxFileMb} MB)`);
    const mime = (blob.type || 'application/octet-stream');
    const ext = (String(name).match(/\.([a-z0-9]{1,5})$/i) || [, ''])[1].toLowerCase();
    let kind = 'file';
    if (wanted === 'voice') kind = 'voice';
    else if (wanted === 'video_note') kind = 'video_note';
    else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) && mime.startsWith('image/')) kind = 'image';
    else if (['mp4', 'webm', 'mov'].includes(ext) && mime.startsWith('video/')) kind = 'video';
    else if (['mp3', 'ogg', 'oga', 'm4a', 'wav', 'opus', 'aac', 'weba'].includes(ext) && mime.startsWith('audio/')) kind = 'audio';

    const ref = doc(collection(db, 'chats', chatId, 'messages'));
    const n = Math.ceil(blob.size / CHUNK);
    for (let i = 0; i < n; i++) {
      if (signal && signal.aborted) throw new BackendError('Bekor qilindi');
      const buf = new Uint8Array(await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
      await setDoc(doc(db, 'chats', chatId, 'messages', ref.id, 'chunks', String(i).padStart(4, '0')), { i, data: Bytes.fromUint8Array(buf) });
      if (onProgress) onProgress((i + 1) / n);
    }
    if (signal && signal.aborted) throw new BackendError('Bekor qilindi');
    const payload = { kind, fileName: String(name).slice(0, 200), fileSize: blob.size, mime, chunks: n };
    if (caption) payload.text = String(caption).slice(0, 4000);
    if (kind === 'voice' || kind === 'video_note') payload.duration = Math.min(3600, Math.max(0, Math.round(duration || 0)));
    return Backend._post(chatId, ref, payload);
  }),

  /** Fayl bo'laklarini yig'ib, blob: URL qaytaradi (xotirada saqlanadi). */
  getFileUrl(m) {
    if (!m.chunks) return Promise.reject(new BackendError('Fayl topilmadi'));
    const key = m.chatId + '/' + m.docId;
    if (!fileCache.has(key)) {
      const p = (async () => {
        const snap = await getDocs(query(collection(db, 'chats', m.chatId, 'messages', m.docId, 'chunks'), orderBy('i')));
        const parts = snap.docs.map((d) => d.data().data.toUint8Array());
        if (parts.length < m.chunks) throw new BackendError('Fayl to‘liq emas');
        return URL.createObjectURL(new Blob(parts, { type: m.mime || 'application/octet-stream' }));
      })();
      p.catch(() => fileCache.delete(key));
      fileCache.set(key, p);
    }
    return fileCache.get(key);
  },

  // -------------------------------------------------------------- qo'ng'iroq signallari
  sendSignal(to, data) {
    const add = (from, toUid, d) => addDoc(collection(db, 'signals'), {
      from, to: toUid, data: JSON.stringify(d), at: Date.now() * 1000 + (signalSeq++ % 1000),
    }).catch((e) => console.error('signal', e));
    add(me.id, to, data);
    if (data.kind === 'answer' || data.kind === 'reject') {
      // foydalanuvchining boshqa qurilmalarida jiringlashni to'xtatish
      add(to, me.id, { kind: 'handled', callId: data.callId });
    }
    return true;
  },
};

export default Backend;
