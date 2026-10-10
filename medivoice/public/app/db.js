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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  navigator.storage?.persist?.().catch(() => {});
  return dbp;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    out = fn(t);
  });
}
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

function summary(doc) {
  return {
    id: doc.id, createdAt: doc.createdAt, updatedAt: Date.now(),
    title: doc.meta.title || '', subject: doc.meta.subject || '', lecturer: doc.meta.lecturer || '',
    duration: doc.duration || 0, words: doc.stats?.words || 0,
    figures: doc.blocks.filter((b) => b.t === 'fig').length, terms: doc.terms?.length || 0,
  };
}

export async function saveLecture(doc) {
  await tx(['lectures', 'index'], 'readwrite', (t) => {
    t.objectStore('lectures').put(doc);
    t.objectStore('index').put(summary(doc));
  });
}
export async function listLectures() {
  const db = await open();
  const all = await req(db.transaction('index').objectStore('index').getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
export async function getLecture(id) {
  const db = await open();
  return req(db.transaction('lectures').objectStore('lectures').get(id));
}
export async function deleteLecture(id) {
  await tx(['lectures', 'index'], 'readwrite', (t) => { t.objectStore('lectures').delete(id); t.objectStore('index').delete(id); });
}

// نقاط الاستئناف: مقاطع مكتملة لمهمة لم تنتهِ
export async function getPart(job, index) {
  const db = await open();
  return (await req(db.transaction('parts').objectStore('parts').get(`${job}:${index}`))) || null;
}
export async function setPart(job, index, part) {
  await tx(['parts'], 'readwrite', (t) => { t.objectStore('parts').put({ ...part, _job: job, _at: Date.now() }, `${job}:${index}`); });
}
export async function clearParts(job) {
  const db = await open();
  const keys = await req(db.transaction('parts').objectStore('parts').getAllKeys());
  await tx(['parts'], 'readwrite', (t) => { for (const k of keys) if (String(k).startsWith(`${job}:`)) t.objectStore('parts').delete(k); });
}
export async function countParts(job) {
  const db = await open();
  const keys = await req(db.transaction('parts').objectStore('parts').getAllKeys());
  return keys.filter((k) => String(k).startsWith(`${job}:`)).length;
}
/** يحذف نقاط استئناف أقدم من أسبوع. */
export async function prune() {
  const db = await open();
  const store = db.transaction('parts', 'readwrite').objectStore('parts');
  const cutoff = Date.now() - 7 * 86400_000;
  const cur = store.openCursor();
  cur.onsuccess = () => { const c = cur.result; if (!c) return; if ((c.value?._at || 0) < cutoff) c.delete(); c.continue(); };
}

export async function getPref(key, fallback = null) {
  try {
    const db = await open();
    const v = await req(db.transaction('kv').objectStore('kv').get(key));
    return v === undefined ? fallback : v;
  } catch { return fallback; }
}
export async function setPref(key, value) {
  try { await tx(['kv'], 'readwrite', (t) => { t.objectStore('kv').put(value, key); }); } catch { /* تخزين غير متاح */ }
}
