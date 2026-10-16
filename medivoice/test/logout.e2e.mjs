// اختبار بالمتصفح لتسجيل خروج الزبون (ليس من اختبارات node --test). يحتاج wrangler dev بـ wrangler.dev.jsonc:
//   ADMIN_PW=... node test/logout.e2e.mjs [shots-dir]
// تفعيل ← حسابي ← تسجيل خروج ← تأكيد ← صفحة الكود، وفتح الموقع بعدها يبقى على صفحة الكود، والرجوع بنفس الكود يدخل.
import { launch, BASE } from './browser.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';

const shots = process.argv[2] || '';
const J = { 'x-mv': '1', 'content-type': 'application/json' };
const login = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password: process.env.ADMIN_PW }) });
assert.equal(login.status, 200, 'دخول لوحة التحكم');
const adm = (login.headers.get('set-cookie') || '').split(';')[0];
const code = (await (await fetch(`${BASE}/api/admin/codes`, { method: 'POST', headers: { ...J, cookie: adm }, body: JSON.stringify({ label: 'اختبار الخروج' }) })).json()).created[0];

const { browser, page } = await launch();
const shot = (name) => (shots ? page.screenshot({ path: path.join(shots, `${name}.png`) }) : null);
// كود بلا مفاتيح يفتح على «ربط المفاتيح»: الجلسة تُعرض كأن المفتاح مربوط حتى تظهر الرئيسية وزر القائمة
await page.route(/\/api\/(session|activate)/, async (route) => {
  const res = await route.fetch();
  const j = await res.json().catch(() => null);
  if (j?.keys) j.keys.gemini = { linked: true, hint: 'AIza…test', count: 1 };
  await route.fulfill(j ? { response: res, json: j } : { response: res });
});
const enter = async () => {
  await page.waitForSelector('#lock.in', { timeout: 30000 });
  await page.locator('#code').focus();
  await page.keyboard.type(code.replace(/^MV-/, '').replace('-', ''));
  await page.locator('#lock-btn').click();
  await page.waitForSelector('#app .view', { timeout: 30000 });
};
try {
  await page.goto(`${BASE}/`);
  await enter();
  await page.locator('button[aria-label="القائمة"]').click();
  await page.locator('.sheet button', { hasText: 'تسجيل خروج' }).click();
  await page.waitForTimeout(500);
  await shot('logout-confirm');
  await page.locator('.sheet button', { hasText: /^خروج$/ }).click();
  await page.waitForSelector('#lock.in', { timeout: 30000 });
  await page.waitForTimeout(600);
  await shot('logout-lock');
  assert.equal(await page.locator('#app').isHidden(), true, 'التطبيق مخفي');
  // فتح الموقع من جديد: يبقى على صفحة الكود
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#lock.in', { timeout: 30000 });
  // يرجع بنفس الكود على نفس الهاتف: يدخل
  await enter();
  await page.waitForSelector('#lock', { state: 'hidden', timeout: 10000 });
  console.log('✔ تسجيل الخروج والرجوع سليمين');
} finally {
  await browser.close();
  await fetch(`${BASE}/api/admin/codes/${encodeURIComponent(code.replace(/^MV-/, '').replace('-', ''))}`, { method: 'DELETE', headers: { ...J, cookie: adm } }).catch(() => {});
}
