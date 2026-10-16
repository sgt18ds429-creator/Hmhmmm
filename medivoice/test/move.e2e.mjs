// اختبار بالمتصفح للنقل بين الروابط (ليس من اختبارات node --test). يحتاج wrangler dev بـ wrangler.dev.jsonc، حيث
// الرابط الرئيسي http://127.0.0.1:8787 و http://localhost:8787 رابط قديم لنفس الموقع:
//   ADMIN_PW=... node test/move.e2e.mjs [shots-dir]
// 1) الطالب يفتح الرابط الرئيسي فقط: يمر تلقائياً على القديم ويرجع مفعّلاً بلا كود، ومحاضرته وتسجيله وتفضيله وصلت.
// 2) فتح الرئيسي مرة ثانية لا يمر على القديم، وفتح القديم بنفسه يتحول للرئيسي بلا إعادة رفع.
// 3) زبون جديد ما عنده شي: يمر مرة وحدة بلا تحميل صفحة على القديم، ويوصل لشاشة الكود.
// 4) اسم ملف طويل بلا مسافات (تحويل متوقف) ما يوسّع الصفحة.
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

/** على رابط ما: تفعيل بالكود (اختياري) وبيانات محفوظة كأنها من التطبيق */
async function seed(page, origin, { activate = true, longName = '' } = {}) {
  await page.goto(`${origin}/robots.txt`);
  if (activate) {
    const st = await page.evaluate(async (c) => {
      const r = await fetch('/api/activate', { method: 'POST', headers: { 'x-mv': '1', 'content-type': 'application/json' }, body: JSON.stringify({ code: c, fp: { os: 'Android', scr: '412x915' } }) });
      await r.text();
      return r.status;
    }, code);
    assert.equal(st, 200, `تفعيل على ${origin}`);
  }
  await page.evaluate(async (longName) => {
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
    if (longName) {
      // تحويل توقف قبل ما يكمل، باسم ملف طويل بلا مسافات (مثل لقطة الزبون)
      t.objectStore('kv').put({ job: 'job-long', name: longName }, 'active-run');
      t.objectStore('parts').put({ text: 'جزء', _at: now }, 'job-long:0');
    }
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    db.close();
    localStorage.setItem('mv-game', 'xo');
  }, longName);
}

/** ما وصل للرابط الرئيسي من بيانات */
const arrived = (page) => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('medivoice'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const get = (store, key) => new Promise((res) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); });
  const rec = await get('parts', 'rec:r-move:000000');
  let ok = false;
  if (rec?.blob) {
    const bytes = new Uint8Array(await rec.blob.arrayBuffer());
    ok = bytes.length === 1.5 * 1024 * 1024;
    for (let i = 0; ok && i < bytes.length; i += 997) ok = bytes[i] === ((i * 7) & 255);
  }
  const meta = await get('kv', 'rec:r-move');
  const lec = await get('lectures', 'L-move');
  db.close();
  return { ok, type: rec?.blob?.type, meta: meta?.name, title: lec?.meta?.title, game: localStorage.getItem('mv-game') };
});
const WANT = { ok: true, type: 'audio/webm', meta: 'تسجيل.webm', title: 'محاضرة النقل', game: 'xo' };

async function scenario(name, fn) {
  step(name);
  const { browser, page } = await launch();
  const seen = { puts: 0, old: [] };
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/api/move/part')) seen.puts++;
    if (r.isNavigationRequest() && r.url().startsWith(OLD)) seen.old.push(r.url());
  });
  try { await fn(page, seen); } finally { await browser.close(); }
}
const shot = (page, name) => (shots ? page.screenshot({ path: path.join(shots, `${name}.png`) }) : null);
const clean = (page) => { const u = new URL(page.url()); return u.origin === BASE && !u.search && !u.hash; };

try {
  await scenario('1) يفتح الرابط الرئيسي فقط: يسحب من القديم تلقائياً ويدخل بلا كود', async (page, seen) => {
    await seed(page, OLD);
    seen.old.length = 0;
    await page.goto(`${BASE}/`);
    await page.waitForSelector('#app .view', { timeout: 30000 });
    assert.equal(await page.locator('#lock').isHidden(), true, 'لا يطلب الكود');
    assert.ok(seen.old.length >= 1, 'مر على الرابط القديم');
    assert.equal(seen.puts, 2, `قطعتين رُفعت (${seen.puts})`);
    assert.ok(clean(page), `الرابط نظيف: ${page.url()}`);
    await page.waitForSelector('.toast', { timeout: 8000 });
    assert.match(await page.locator('.toast').first().textContent(), /وصلت محاضراتك/);
    assert.deepEqual(await arrived(page), WANT);
    await page.waitForTimeout(500);
    await shot(page, 'pull-arrived');

    step('2) فتح الرئيسي مرة ثانية: لا يمر على القديم. وفتح القديم بنفسه: يتحول بلا إعادة رفع');
    seen.old.length = 0; seen.puts = 0;
    await page.goto(`${BASE}/`);
    await page.waitForSelector('#app .view', { timeout: 30000 });
    assert.equal(seen.old.length, 0, 'ما رجع للقديم');
    await page.goto(`${OLD}/`);
    await page.waitForURL((u) => u.origin === BASE, { timeout: 30000 });
    await page.waitForSelector('#app .view', { timeout: 30000 });
    assert.equal(seen.puts, 0, 'نفس البيانات ما تنرفع مرة ثانية');
    assert.ok(clean(page), `الرابط نظيف: ${page.url()}`);
    await page.goto(`${OLD}/admin`);
    assert.equal(new URL(page.url()).origin, BASE, 'لوحة التحكم تتحول للرئيسي');
  });

  await scenario('3) زبون جديد بلا بيانات: مرور سريع واحد ثم شاشة الكود', async (page, seen) => {
    const t0 = Date.now();
    await page.goto(`${BASE}/`);
    await page.waitForSelector('#lock.in', { timeout: 30000 });
    assert.deepEqual(seen.old.map((u) => new URL(u).pathname), ['/'], 'مر على القديم مرة وحدة');
    assert.ok(clean(page), `الرابط نظيف: ${page.url()}`);
    console.log(`   وصل لشاشة الكود خلال ${Date.now() - t0}ms`);
    seen.old.length = 0;
    await page.goto(`${BASE}/`);
    await page.waitForSelector('#lock.in', { timeout: 30000 });
    assert.equal(seen.old.length, 0, 'المرة الثانية ما يمر');
  });

  await scenario('4) اسم ملف طويل بلا مسافات ما يوسّع الصفحة', async (page) => {
    await seed(page, BASE, { longName: 'د.لمياء_هستري_اكزامنيشن_كروث_جارث_المحاضرة_الثالثة_كاملة.m4a' });
    // كود بلا مفاتيح يفتح على «ربط المفاتيح»: الجلسة تُعرض كأن المفتاح مربوط حتى تظهر الرئيسية
    await page.route('**/api/session*', async (route) => {
      const res = await route.fetch();
      const j = await res.json();
      if (j.keys) j.keys.gemini = { linked: true, hint: 'AIza…test', count: 1 };
      await route.fulfill({ response: res, json: j });
    });
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.banner.info', { timeout: 30000 });
    await page.waitForTimeout(900);
    const m = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, width: innerWidth,
      wide: [...document.querySelectorAll('#app *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).map((el) => el.className || el.tagName).slice(0, 5),
    }));
    await shot(page, 'long-name');
    assert.ok(m.scroll <= m.width + 1, `عرض الصفحة ${m.scroll} > ${m.width}`);
    assert.deepEqual(m.wide, [], 'عناصر طالعة برا الشاشة');
  });
  console.log('✔ النقل بين الروابط والتخطيط سليمين');
} finally {
  // الكود التجريبي يُحذف
  await fetch(`${BASE}/api/admin/codes/${encodeURIComponent(code.replace(/^MV-/, '').replace('-', ''))}`, { method: 'DELETE', headers: { ...J, cookie: adm } }).catch(() => {});
}
