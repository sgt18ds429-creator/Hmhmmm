// اختبار بالمتصفح لـ «مشاركة ← ميدي فويز» بالأندرويد (ليس من اختبارات node --test). يحتاج wrangler dev بـ wrangler.dev.jsonc:
//   ADMIN_PW=... node test/share.e2e.mjs [shots-dir]
// تفعيل ← شريط «ثبّت» بالرئيسية ← عامل الخدمة يشتغل ← تسجيل يوصل بطلب POST /share مثل ما يرسله الأندرويد ←
// الموقع يفتح شاشة التحويل بنفس الملف (الاسم والحجم)، وما يبقى بالجهاز. ومشاركة بلا ملف تطلع رسالة.
import { launch, BASE } from './browser.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';

const shots = process.argv[2] || '';
const J = { 'x-mv': '1', 'content-type': 'application/json' };
const login = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password: process.env.ADMIN_PW }) });
assert.equal(login.status, 200, 'دخول لوحة التحكم');
const adm = (login.headers.get('set-cookie') || '').split(';')[0];
const code = (await (await fetch(`${BASE}/api/admin/codes`, { method: 'POST', headers: { ...J, cookie: adm }, body: JSON.stringify({ label: 'اختبار المشاركة' }) })).json()).created[0];

// ملف WAV صغير (ثانيتين صمت) باسم عربي مثل تسجيلات المسجل
function wav(sec = 2, rate = 8000) {
  const n = sec * rate, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
const audio = { name: 'محاضرة التشريح.wav', mimeType: 'audio/wav', buffer: wav() };

const { browser, page } = await launch();
const shot = (name) => (shots ? page.screenshot({ path: path.join(shots, `${name}.png`) }) : null);
// كود بلا مفاتيح يفتح على «ربط المفاتيح»: الجلسة تُعرض كأن المفتاح مربوط حتى تظهر الرئيسية
await page.route(/\/api\/(session|activate)/, async (route) => {
  const res = await route.fetch();
  const j = await res.json().catch(() => null);
  if (j?.keys) j.keys.gemini = { linked: true, hint: 'AIza…test', count: 1 };
  await route.fulfill(j ? { response: res, json: j } : { response: res });
});
// نفس الطلب اللي يرسله الأندرويد عند «مشاركة ← ميدي فويز» (form POST multipart بحقل audio حسب manifest)
const share = async (withFile = true) => {
  await page.evaluate(() => {
    const f = Object.assign(document.createElement('form'), { method: 'post', action: '/share', enctype: 'multipart/form-data' });
    f.innerHTML = '<input type="file" name="audio" id="mv-test-share"><input name="title" value="تسجيل">';
    document.body.append(f);
  });
  if (withFile) await page.setInputFiles('#mv-test-share', audio);
  await page.evaluate(() => document.querySelector('#mv-test-share').form.submit());
};
try {
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#lock.in', { timeout: 30000 });
  await page.locator('#code').focus();
  await page.keyboard.type(code.replace(/^MV-/, '').replace('-', ''));
  await page.locator('#lock-btn').click();
  await page.waitForSelector('#app .view', { timeout: 30000 });

  // الرئيسية بالأندرويد: شريط التثبيت
  const tip = page.locator('.banner', { hasText: 'ثبّت ميدي فويز' });
  await tip.waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await shot('share-tip');
  await tip.locator('button', { hasText: 'تثبيت' }).click();
  await page.locator('.sheet', { hasText: 'إضافة إلى الشاشة الرئيسية' }).waitFor({ timeout: 5000 });
  await shot('share-install-steps');
  await page.locator('.sheet button[aria-label="إغلاق"]').click();
  await page.waitForTimeout(400);

  // عامل الخدمة جاهز ويتحكم بالصفحة
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
    await page.waitForSelector('#app .view', { timeout: 30000 });
  }
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'عامل الخدمة يتحكم بالصفحة');

  // مشاركة تسجيل: يفتح شاشة التحويل بنفس الملف
  await share(true);
  await page.waitForSelector('.filecard', { timeout: 30000 });
  const card = await page.locator('.filecard b').first().textContent();
  assert.equal(card, audio.name, 'اسم التسجيل المشارك');
  assert.equal(new URL(page.url()).hash, '', 'الرابط بلا #mv-share');
  assert.equal(await page.evaluate(async () => !!(await (await caches.open('mv-shared')).match('/__mv-shared'))), false, 'التسجيل ما يبقى بالجهاز بعد ما ينفتح');
  await page.waitForTimeout(600);
  await shot('share-arrived');
  console.log('✔ التسجيل المشارك فتح شاشة التحويل:', card);

  // مشاركة بلا ملف: رسالة واضحة والرئيسية
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#app .view', { timeout: 30000 });
  await share(false);
  await page.locator('.toast', { hasText: 'ما وصل ملف صوت' }).waitFor({ timeout: 30000 });
  console.log('✔ مشاركة بلا ملف تطلع رسالة');

  // بلا عامل خدمة (أول مرة قبل ما يشتغل): الخادم يرجّع للموقع برسالة بدل صفحة خطأ
  const r = await fetch(`${BASE}/share`, { method: 'POST', body: new FormData(), redirect: 'manual' });
  assert.ok([302, 303].includes(r.status) && /#mv-share-fail$/.test(r.headers.get('location') || ''), `الخادم: ${r.status} ${r.headers.get('location')}`);
  console.log('✔ الخادم يرجّع /share للموقع');
} finally {
  await browser.close();
  await fetch(`${BASE}/api/admin/codes/${encodeURIComponent(code.replace(/^MV-/, '').replace('-', ''))}`, { method: 'DELETE', headers: { ...J, cookie: adm } }).catch(() => {});
}
