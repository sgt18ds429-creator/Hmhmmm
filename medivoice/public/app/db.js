// db.js — التخزين المحلي على جهاز المستخدم (IndexedDB): المحاضرات المحفوظة ونقاط الاستئناف.
// الخادم لا يخزّن أي محتوى للمحاضرات.

const NAME = 'medivoice';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('lectures')) db.createObjectStore('lectures', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('index')) db.createObjectStore('index', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('parts')) db.createObjectStore('parts');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => {
      const db = req.result;
      // iPhone يغلق الاتصال أحياناً بعد الخلفية أو ضغط الذاكرة: نفتحه من جديد عند الطلب التالي
      db.onclose = () => { if (dbp === mine) dbp = null; };
      db.onversionchange = () => { db.close(); if (dbp === mine) dbp = null; };
      resolve(db);
    };
    req.onerror = () => { if (dbp === mine) dbp = null; reject(req.error); };
    req.onblocked = () => { if (dbp === mine) dbp = null; reject(new Error('blocked')); };
  });
  const mine = dbp;
  navigator.storage?.persist?.().catch(() => {});
  return dbp;
}

/** يعيد العملية مرة بعد فتح اتصال جديد إذا كان الاتصال القديم مغلقاً (InvalidStateError) أو تعطّل. */
async function withDb(fn) {
  try {
    return await fn(await open());
  } catch (e) {
    if (!/InvalidState|UnknownError|closing|closed|blocked/i.test(`${e?.name} ${e?.message}`)) throw e;
    dbp = null;
    return fn(await open());
  }
}

function tx(stores, mode, fn) {
  return withDb((db) => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
    out = fn(t);
  }));
}
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const read = (store, fn) => withDb((db) => req(fn(db.transaction(store).objectStore(store))));

function summary(doc) {
  return {
    id: doc.id, createdAt: doc.createdAt, updatedAt: Date.now(),
    title: doc.meta.title || '', subject: doc.meta.subject || '', lecturer: doc.meta.lecturer || '',
    duration: doc.duration || 0, words: doc.stats?.words || 0,
    figures: doc.blocks.filter((b) => b.t === 'fig').length, terms: doc.terms?.length || 0,
    mode: ['highyield', 'notes', 'integrated'].includes(doc.meta.mode) ? doc.meta.mode : 'transcript',
  };
}

export async function saveLecture(doc) {
  await tx(['lectures', 'index'], 'readwrite', (t) => {
    t.objectStore('lectures').put(doc);
    t.objectStore('index').put(summary(doc));
  });
}
export async function listLectures() {
  const all = await read('index', (st) => st.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
export async function getLecture(id) {
  return read('lectures', (st) => st.get(id));
}
export async function deleteLecture(id) {
  await tx(['lectures', 'index'], 'readwrite', (t) => { t.objectStore('lectures').delete(id); t.objectStore('index').delete(id); });
}

// نقاط الاستئناف: مقاطع مكتملة لمهمة لم تنتهِ
export async function getPart(job, index) {
  return (await read('parts', (st) => st.get(`${job}:${index}`))) || null;
}
export async function setPart(job, index, part) {
  await tx(['parts'], 'readwrite', (t) => { t.objectStore('parts').put({ ...part, _job: job, _at: Date.now() }, `${job}:${index}`); });
}
export async function clearParts(job) {
  const keys = await read('parts', (st) => st.getAllKeys());
  await tx(['parts'], 'readwrite', (t) => { for (const k of keys) if (String(k).startsWith(`${job}:`)) t.objectStore('parts').delete(k); });
}
export async function countParts(job) {
  const keys = await read('parts', (st) => st.getAllKeys());
  // مقاطع الصوت فقط (مفاتيحها أرقام)؛ خطة الشرح وأقسامه محفوظة بمفاتيح n:…
  return keys.filter((k) => String(k).startsWith(`${job}:`) && /^\d+$/.test(String(k).slice(job.length + 1))).length;
}
/** يحذف نقاط استئناف أقدم من أسبوع. */
export async function prune() {
  const db = await open();
  const store = db.transaction('parts', 'readwrite').objectStore('parts');
  const cutoff = Date.now() - 7 * 86400_000;
  const cur = store.openCursor();
  // التسجيلات المباشرة (rec:…) لا تُحذف تلقائياً: يحذفها الطالب أو تُحذف بعد تحويلها
  cur.onsuccess = () => { const c = cur.result; if (!c) return; if (!String(c.key).startsWith('rec:') && (c.value?._at || 0) < cutoff) c.delete(); c.continue(); };
}

export async function getPref(key, fallback = null) {
  try {
    const v = await read('kv', (st) => st.get(key));
    return v === undefined ? fallback : v;
  } catch { return fallback; }
}
export async function setPref(key, value) {
  try { await tx(['kv'], 'readwrite', (t) => { t.objectStore('kv').put(value, key); }); } catch { /* تخزين غير متاح */ }
}

// ───────────── التسجيل المباشر: كل 5 ثوانٍ تُحفظ قطعة، فلا يضيع التسجيل إذا أُغلقت الصفحة أو تعطلت ─────────────
export async function addRecPiece(rec, n, blob, meta) {
  await tx(['parts', 'kv'], 'readwrite', (t) => {
    t.objectStore('parts').put({ blob, _at: Date.now() }, `rec:${rec}:${String(n).padStart(6, '0')}`);
    t.objectStore('kv').put({ ...meta, id: rec, pieces: n + 1, updatedAt: Date.now() }, `rec:${rec}`);
  });
}
/** التسجيلات المحفوظة غير المحوّلة: [{ id, type, startedAt, pieces, seconds }] */
export async function listRecordings() {
  const keys = await read('kv', (st) => st.getAllKeys());
  const out = [];
  for (const k of keys) {
    if (!String(k).startsWith('rec:')) continue;
    const m = await read('kv', (st) => st.get(k)).catch(() => null);
    if (m?.pieces) out.push(m);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}
export async function getRecording(rec) {
  const meta = await read('kv', (st) => st.get(`rec:${rec}`));
  if (!meta) return null;
  const pieces = await read('parts', (st) => st.getAll(IDBKeyRange.bound(`rec:${rec}:`, `rec:${rec}:~`)));
  const blobs = pieces.map((p) => p.blob).filter(Boolean);
  if (!blobs.length) return null;
  return new File(blobs, meta.name, { type: meta.type || blobs[0].type, lastModified: meta.startedAt });
}
export async function deleteRecording(rec) {
  const keys = await read('parts', (st) => st.getAllKeys(IDBKeyRange.bound(`rec:${rec}:`, `rec:${rec}:~`)));
  await tx(['parts', 'kv'], 'readwrite', (t) => {
    for (const k of keys) t.objectStore('parts').delete(k);
    t.objectStore('kv').delete(`rec:${rec}`);
  });
}
