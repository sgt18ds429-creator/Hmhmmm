// move.js — نقل الزائر من رابط ثاني للموقع (workers.dev، رابط Pages، دومين قديم) إلى الرابط الرئيسي.
// المتصفح يفصل تخزين كل رابط عن غيره: تسجيل الدخول والمحاضرات والتسجيلات المحفوظة على رابط لا تظهر على رابط ثاني،
// فيطلب الكود من جديد وتبدو المحاضرات محذوفة. هنا تُنقل كلها مرة واحدة عبر الخادم:
//   الرابط القديم: leave() يجمع ما حفظه المتصفح (قاعدة medivoice كاملة + تفضيلات mv-) ويرفعه قطعاً برمز لمرة واحدة،
//                  ثم يفتح الرابط الرئيسي ومعه #mv-move=الرمز
//   الرابط الرئيسي: arrive() يستلم الرمز (والخادم يدخله بنفس التفعيل إذا ما عنده تفعيل)، ينزّل القطع ويضيف الناقص
//                  فقط (الموجود هنا لا يُستبدل)، ثم يمسحها من الخادم.
// لا يعتمد على ملفات التطبيق المحمية (/app/)، فيشتغل حتى لو انتهى تفعيل الرابط القديم.

const NAME = 'medivoice'; // نفس قاعدة public/app/db.js ومخازنها
const STORES = ['lectures', 'index', 'parts', 'kv'];
const MAGIC = 'MVMOVE1\n';
const CHUNK = 1024 * 1024; // = MOVE_CHUNK في الخادم
const MAX = 600 * 1024 * 1024; // = MOVE_MAX في الخادم
const FLAG = 'mv-moved'; // على الرابط القديم: آخر نقلة (حتى لا تُرفع نفس البيانات كل مرة يُفتح)
const SKIP_LS = new Set([FLAG, 'mv-intro-at']);
const T = '\u0001mv'; // علامة نوع داخل الكائنات المحزومة
const VIEWS = new Set(['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView']);

// ───────────── التحزيم: كائنات + ملفات (Blob/File) في ملف واحد ─────────────

/** يحزم أي بيانات قابلة للحفظ في IndexedDB (مع Blob وFile وArrayBuffer وDate) في Blob واحد */
export function pack(data) {
  const blobs = [];
  const add = (b) => blobs.push(b) - 1;
  const enc = (v) => {
    if (typeof Blob !== 'undefined' && v instanceof Blob) {
      const file = typeof File !== 'undefined' && v instanceof File;
      return { [T]: 'b', i: add(v), type: v.type, ...(file ? { name: v.name, lm: v.lastModified } : {}) };
    }
    if (v instanceof ArrayBuffer) return { [T]: 'ab', i: add(new Blob([v])) };
    if (ArrayBuffer.isView(v)) return { [T]: 'ta', i: add(new Blob([new Uint8Array(v.buffer, v.byteOffset, v.byteLength)])), k: v.constructor.name };
    if (v instanceof Date) return { [T]: 'd', t: v.getTime() };
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = enc(v[k]);
      return o;
    }
    return v;
  };
  const head = { v: 1, data: enc(data) };
  head.sizes = blobs.map((b) => b.size);
  const json = new TextEncoder().encode(JSON.stringify(head));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.length);
  return new Blob([MAGIC, len, json, ...blobs]);
}

/** عكس pack. يرفض الملف الناقص (قطعة ما وصلت) بدل ما يرجّع بيانات مبتورة */
export async function unpack(blob) {
  const m = MAGIC.length;
  const pre = new Uint8Array(await blob.slice(0, m + 4).arrayBuffer());
  if (pre.length < m + 4 || new TextDecoder().decode(pre.subarray(0, m)) !== MAGIC) throw new Error('bad_package');
  const n = new DataView(pre.buffer, pre.byteOffset, pre.byteLength).getUint32(m);
  const head = JSON.parse(await blob.slice(m + 4, m + 4 + n).text());
  const sizes = Array.isArray(head.sizes) ? head.sizes : [];
  let off = m + 4 + n;
  if (blob.size !== off + sizes.reduce((a, b) => a + b, 0)) throw new Error('incomplete');
  const parts = sizes.map((size) => { const b = blob.slice(off, off + size); off += size; return b; });
  // ArrayBuffer والمصفوفات تحتاج قراءة (غير متزامنة) قبل البناء
  const buffers = new Map();
  const need = (v) => {
    if (Array.isArray(v)) v.forEach(need);
    else if (v && typeof v === 'object') {
      if (v[T] === 'ab' || v[T] === 'ta') buffers.set(v.i, null);
      else Object.values(v).forEach(need);
    }
  };
  need(head.data);
  for (const i of buffers.keys()) buffers.set(i, await parts[i].arrayBuffer());
  const dec = (v) => {
    if (Array.isArray(v)) return v.map(dec);
    if (!v || typeof v !== 'object') return v;
    switch (v[T]) {
      case 'b': {
        const b = parts[v.i].slice(0, parts[v.i].size, v.type || '');
        return v.name !== undefined && typeof File !== 'undefined' ? new File([b], v.name, { type: v.type || '', lastModified: v.lm }) : b;
      }
      case 'ab': return buffers.get(v.i);
      case 'ta': {
        const buf = buffers.get(v.i);
        return VIEWS.has(v.k) && typeof globalThis[v.k] === 'function' ? new globalThis[v.k](buf) : new Uint8Array(buf);
      }
      case 'd': return new Date(v.t);
      default: {
        const o = {};
        for (const k of Object.keys(v)) o[k] = dec(v[k]);
        return o;
      }
    }
  };
  return dec(head.data);
}

// ───────────── قاعدة المتصفح ─────────────

function openDb() {
  return new Promise((resolve, reject) => {
    // بلا رقم إصدار: تُفتح بإصدارها الحالي مهما صار، وإذا ما موجودة تُنشأ بنفس مخازن db.js
    const req = indexedDB.open(NAME);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('lectures')) db.createObjectStore('lectures', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('index')) db.createObjectStore('index', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('parts')) db.createObjectStore('parts');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}

async function hasDb() {
  try {
    if (indexedDB.databases) return (await indexedDB.databases()).some((d) => d.name === NAME);
  } catch { /* غير مدعوم: نفتحها */ }
  return true;
}

function done(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}

/** كل ما حفظه المتصفح على هذا الرابط: { stores: { اسم: [[مفتاح، قيمة]...] }, ls: { مفتاح: نص } } */
async function collect() {
  const stores = {};
  if (await hasDb()) {
    const db = await openDb();
    try {
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) { stores[name] = []; continue; }
        const t = db.transaction(name);
        const st = t.objectStore(name);
        const keys = st.getAllKeys(), vals = st.getAll();
        await done(t);
        stores[name] = keys.result.map((k, i) => [k, vals.result[i]]);
      }
    } finally { db.close(); }
  }
  const ls = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('mv-') && !SKIP_LS.has(k)) ls[k] = localStorage.getItem(k);
    }
  } catch { /* تخزين ممنوع */ }
  return { stores, ls };
}

/** يضيف الناقص فقط: ما هو موجود على هذا الرابط يبقى (قد يكون أحدث). يرجّع عدد المحاضرات المضافة */
async function store(data) {
  let lectures = 0;
  const db = await openDb();
  try {
    for (const name of STORES) {
      const rows = data?.stores?.[name] || [];
      if (!rows.length || !db.objectStoreNames.contains(name)) continue;
      const t = db.transaction(name, 'readwrite');
      const st = t.objectStore(name);
      for (const [key, value] of rows) {
        const probe = st.count(key);
        probe.onsuccess = () => {
          if (probe.result) return;
          if (st.keyPath) st.put(value); else st.put(value, key);
          if (name === 'lectures') lectures++;
        };
      }
      await done(t);
    }
  } finally { db.close(); }
  try {
    for (const [k, v] of Object.entries(data?.ls || {})) {
      if (k.startsWith('mv-') && !SKIP_LS.has(k) && localStorage.getItem(k) === null && typeof v === 'string') localStorage.setItem(k, v);
    }
  } catch { /* تخزين ممنوع */ }
  return lectures;
}

// ───────────── الشبكة ─────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** يعيد المحاولة على أخطاء الشبكة والخادم (لا على رفض نهائي 4xx) */
async function retry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.status || 0;
      const final = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (final || i >= tries - 1) throw e;
      await sleep(Math.min(8000, 800 * 2 ** i));
    }
  }
}

async function call(url, init = {}) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { 'x-mv': '1', ...(init.headers || {}) } });
  if (!r.ok) throw Object.assign(new Error(`http_${r.status}`), { status: r.status });
  return r;
}
const callJson = (url, init) => retry(async () => (await call(url, init)).json());

/** n مهمة بثلاث في نفس الوقت */
async function pool(n, width, task) {
  let next = 0;
  const worker = async () => { while (next < n) { const i = next++; await task(i); } };
  await Promise.all(Array.from({ length: Math.min(width, n) }, worker));
}

// ───────────── الرابط القديم: ارفع وانتقل ─────────────

const readFlag = () => { try { return JSON.parse(localStorage.getItem(FLAG) || 'null'); } catch { return null; } };
const writeFlag = (v) => { try { localStorage.setItem(FLAG, JSON.stringify(v)); } catch { /* تخزين ممنوع */ } };

/**
 * ui: { show(text), progress(0..1), fail(text, actions) } — شريط صغير تحت الشعار (shell.js)
 */
export async function leave(home, ui) {
  // الرجوع للرئيسي: ?mv-pulled يعلّم هذا الرابط «مرّ عليه» (والقائمة التي جاءت مع السحب)، و#mv-move يحمل رموز النقل،
  // ومعها رموز روابط قبله في نفس الدورة
  const pull = new URLSearchParams(location.search).get('mv-pull');
  const before = tokensIn(location.hash);
  const go = (token) => {
    const tokens = token ? [...before, token] : before;
    const path = pull === null ? location.pathname : '/';
    location.replace(`${home}${path}?mv-pulled=${encodeURIComponent(pull || location.host)}${tokens.length ? `#mv-move=${tokens.join(',')}` : ''}`);
  };
  let data = { stores: {}, ls: {} };
  try { data = await collect(); } catch (e) { console.warn('move: collect', e); }
  const rows = STORES.reduce((n, s) => n + (data.stores[s]?.length || 0), 0) + Object.keys(data.ls).length;
  let pkg = rows ? pack(data) : null;
  if (pkg && pkg.size > MAX) {
    // كبير جداً: ملفات تحويلات لم تكتمل (فيديو مثلاً) تُترك، ونقاط استئنافها تنتقل فيكمل الطالب برفع نفس الملف
    data.stores.parts = (data.stores.parts || []).filter(([k]) => !String(k).startsWith('src:'));
    pkg = pack(data);
  }
  const sig = pkg ? `${pkg.size}:${STORES.map((s) => data.stores[s]?.length || 0).join('.')}` : '';
  // نفس البيانات انتقلت قبل ووصلت: ما نرفعها مرة ثانية
  const prev = readFlag();
  if (pkg && prev?.sig === sig && prev.home === home && prev.token) {
    const st = await callJson(`/api/move/status?t=${encodeURIComponent(prev.token)}`).catch(() => null);
    if (st?.done) pkg = null;
  }
  let start = null;
  try {
    start = await callJson('/api/move/start', { method: 'POST' });
  } catch (e) {
    console.warn('move: start', e);
  }
  if (!start?.token) { go(); return; } // ما نكدر ننقل: الرئيسي يفتح ويطلب الكود إذا لازم
  if (!pkg && !start.session) { go(); return; } // ما في شي ينتقل
  if (pkg) {
    ui?.show?.('ننقل محاضراتك للرابط الجديد…');
    const total = Math.ceil(pkg.size / CHUNK);
    let sent = 0;
    try {
      await pool(total, 3, (n) => retry(async () => {
        await call(`/api/move/part?t=${start.token}&n=${n}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: pkg.slice(n * CHUNK, Math.min(pkg.size, (n + 1) * CHUNK)),
        });
        sent++;
        ui?.progress?.(sent / total);
      }));
    } catch (e) {
      console.warn('move: upload', e);
      ui?.fail?.('ما كدرنا ننقل محاضراتك، تأكد من الإنترنت.', [
        { label: 'حاول مرة ثانية', primary: true, run: () => location.reload() },
        { label: 'كمّل بدون محاضراتي', run: () => go(start.session ? start.token : '') },
      ]);
      return;
    }
    writeFlag({ sig, home, token: start.token, at: Date.now() });
  }
  go(start.token);
}

// ───────────── الرابط الرئيسي: استلم ─────────────

/** رموز النقل في #mv-move=رمز,رمز (رابط أو أكثر في نفس الدورة) */
export function tokensIn(hash) {
  const m = /(?:^#|&)mv-move=([\w,-]+)/.exec(String(hash || ''));
  return m ? m[1].split(',').filter((t) => /^[\w-]{20,80}$/.test(t)) : [];
}

/** يرجّع { ok, lectures, session } أو null إذا الرمز منتهي */
export async function arrive(token, ui) {
  let claim;
  try {
    claim = await callJson(`/api/move/claim?t=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch (e) {
    console.warn('move: claim', e);
    return null;
  }
  let lectures = 0, ok = true;
  if (claim.parts > 0) {
    ui?.show?.('نجيب محاضراتك من الرابط القديم…');
    try {
      const got = new Array(claim.parts);
      let n = 0;
      await pool(claim.parts, 3, (i) => retry(async () => {
        got[i] = await (await call(`/api/move/part?t=${encodeURIComponent(token)}&n=${i}`)).blob();
        n++;
        ui?.progress?.(n / claim.parts);
      }));
      lectures = await store(await unpack(new Blob(got)));
    } catch (e) {
      // ما وصلت كاملة: تبقى على الخادم يوم، والرابط القديم يعيد رفعها أول ما يُفتح
      console.warn('move: download', e);
      ok = false;
    }
  }
  if (ok) await callJson(`/api/move/done?t=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
  return { ok, lectures, session: !!claim.session };
}
