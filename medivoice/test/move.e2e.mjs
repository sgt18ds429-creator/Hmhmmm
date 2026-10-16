// اختبار بالمتصفح للنقل بين الروابط (ليس من اختبارات node --test). يحتاج wrangler dev بـ wrangler.dev.jsonc، حيث
// الرابط الرئيسي http://127.0.0.1:8787 و http://localhost:8787 رابط ثاني لنفس الموقع:
//   ADMIN_PW=... node test/move.e2e.mjs [shots-dir]
// متصفح مفعّل على الرابط الثاني وعليه محاضرة وتسجيل مباشر وتفضيل ← يفتح الرابط الثاني ← يصل للرئيسي مفعّلاً بلا كود
// ومحاضرته وتسجيله وتفضيله هناك، وفتح الرابط الثاني مرة ثانية لا يعيد رفع نفس البيانات.
import { launch, BASE } from './browser.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';

const OLD = BASE.replace('127.0.0.1', 'localhost');
assert.notEqual(OLD, BASE, 'BASE لازم يكون 127.0.0.1');
const shots = process.argv[2] || '';
const J = { 'x-mv': '1', 'content-type': 'application/json' };
const step = (m) => console.log(`▶ ${m}`);

const login = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password: process.env.ADMIN_PW }) });
assert.equal(login.status, 200, 'دخول لوحة التحكم');
const adm = (login.headers.get('set-cookie') || '').split(';')[0];
const created = await (await fetch(`${BASE}/api/admin/codes`, { method: 'POST', headers: { ...J, cookie: adm }, body: JSON.stringify({ label: 'اختبار النقل' }) })).json();
const code = created.created[0];

const { browser, page } = await launch();
const shot = (name) => (shots ? page.screenshot({ path: path.join(shots, `${name}.png`) }) : null);
const puts = [];
page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/move/part')) puts.push(r.url()); });

try {
  step('الرابط الثاني: تفعيل + محاضرة + تسجيل مباشر + تفضيل');
  await page.goto(`${OLD}/robots.txt`);
  const act = await page.evaluate(async (c) => {
    const r = await fetch('/api/activate', { method: 'POST', headers: { 'x-mv': '1', 'content-type': 'application/json' }, body: JSON.stringify({ code: c, fp: { os: 'Android', scr: '412x915' } }) });
    await r.text();
    return r.status;
  }, code);
  assert.equal(act, 200, 'تفعيل على الرابط الثاني');
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const q = indexedDB.open('medivoice', 1);
      q.onupgradeneeded = () => {
        const d = q.result;
        d.createObjectStore('lectures', { keyPath: 'id' }); d.createObjectStore('index', { keyPath: 'id' });
        d.createObjectStore('parts'); d.createObjectStore('kv');
      };
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
    const now = Date.now();
    const t = db.transaction(['lectures', 'index', 'parts', 'kv'], 'readwrite');
    t.objectStore('lectures').put({ id: 'L-move', createdAt: now - 3600_000, meta: { title: 'محاضرة النقل', subject: 'تشريح' }, blocks: [{ t: 'p', text: 'نص المحاضرة' }], terms: [], stats: { words: 2 }, duration: 3600 });
    t.objectStore('index').put({ id: 'L-move', createdAt: now - 3600_000, updatedAt: now, title: 'محاضرة النقل', subject: 'تشريح', lecturer: '', duration: 3600, words: 2, figures: 0, terms: 0, mode: 'transcript' });
    // تسجيل مباشر غير محوّل: 1.5 ميغا (قطعتين نقل)
    const bytes = new Uint8Array(1.5 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 255;
    t.objectStore('parts').put({ blob: new Blob([bytes], { type: 'audio/webm' }), _at: now }, 'rec:r-move:000000');
    t.objectStore('kv').put({ id: 'r-move', name: 'تسجيل.webm', type: 'audio/webm', pieces: 1, startedAt: now - 60_000, updatedAt: now }, 'rec:r-move');
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    db.close();
    localStorage.setItem('mv-game', 'xo');
  });

  step('فتح الرابط الثاني ← الرئيسي مفعّلاً بلا كود');
  await page.goto(`${OLD}/`);
  await page.waitForURL((u) => u.origin === BASE, { timeout: 30000 });
  await page.waitForSelector('#app .view', { timeout: 30000 });
  assert.equal(new URL(page.url()).hash, '', 'الرمز يُمسح من الرابط');
  assert.equal(await page.locator('#lock').isHidden(), true, 'لا يطلب الكود');
  await page.waitForSelector('.toast', { timeout: 8000 });
  assert.match(await page.locator('.toast').first().textContent(), /وصلت محاضراتك/);
  await page.waitForTimeout(600);
  await shot('move-arrived');
  assert.equal(puts.length, 2, `قطعتين رُفعت (${puts.length})`);
  const got = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('medivoice'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const get = (store, key) => new Promise((res) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); });
    const rec = await get('parts', 'rec:r-move:000000');
    const bytes = new Uint8Array(await rec.blob.arrayBuffer());
    let ok = bytes.length === 1.5 * 1024 * 1024;
    for (let i = 0; ok && i < bytes.length; i += 997) ok = bytes[i] === ((i * 7) & 255);
    const meta = await get('kv', 'rec:r-move');
    const lec = await get('lectures', 'L-move');
    db.close();
    return { ok, type: rec.blob.type, meta: meta?.name, title: lec?.meta?.title, game: localStorage.getItem('mv-game') };
  });
  assert.deepEqual(got, { ok: true, type: 'audio/webm', meta: 'تسجيل.webm', title: 'محاضرة النقل', game: 'xo' });

  step('فتح الرابط الثاني مرة ثانية: يتحول فوراً بلا إعادة رفع');
  puts.length = 0;
  await page.goto(`${OLD}/`);
  await page.waitForURL((u) => u.origin === BASE, { timeout: 30000 });
  await page.waitForSelector('#app .view', { timeout: 30000 });
  assert.equal(puts.length, 0, 'نفس البيانات ما تنرفع مرة ثانية');

  step('لوحة التحكم على الرابط الثاني تتحول للرئيسي');
  await page.goto(`${OLD}/admin`);
  assert.equal(new URL(page.url()).origin, BASE);
  console.log('✔ النقل بين الروابط سليم');
} finally {
  await browser.close();
  // الكود التجريبي يُحذف
  await fetch(`${BASE}/api/admin/codes/${encodeURIComponent(code.replace(/^MV-/, '').replace('-', ''))}`, { method: 'DELETE', headers: { ...J, cookie: adm } }).catch(() => {});
}
