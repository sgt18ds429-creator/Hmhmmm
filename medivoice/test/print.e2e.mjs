// الطباعة من الجهاز: يفتح ملزمة محفوظة (JSON) ويطبعها، ويتحقق أن الصفحات قُسّمت كما في ملف الخادم.
//   BASE=... ADMIN_PW=... node test/print.e2e.mjs doc.json [shot.png]
import { readFile } from 'node:fs/promises';
import { launch, BASE } from './browser.mjs';
const [file, shot] = process.argv.slice(2);
const doc = JSON.parse(await readFile(file, 'utf8'));
const J = { 'x-mv': '1', 'content-type': 'application/json' };
const login = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password: process.env.ADMIN_PW }) });
const adm = (login.headers.get('set-cookie') || '').split(';')[0];
const { created } = await (await fetch(`${BASE}/api/admin/codes`, { method: 'POST', headers: { ...J, cookie: adm }, body: JSON.stringify({ label: 'print' }) })).json();
const act = await fetch(`${BASE}/api/activate`, { method: 'POST', headers: { ...J, 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/141 Mobile' }, body: JSON.stringify({ code: created[0], fp: { os: 'Android', scr: '390x844@2' } }) });
const cookie = (act.headers.get('set-cookie') || '').split(';')[0];
// الصفحة الرئيسية تطلب ربط مفتاح قبل عرض المحاضرات
if (process.env.GEMINI_KEY) await fetch(`${BASE}/api/keys`, { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ key: process.env.GEMINI_KEY }) });
const { browser, context, page } = await launch({ mobile: true });
await context.addInitScript(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
await context.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=')[1], domain: new URL(BASE).hostname, path: '/' }]);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('requestfailed', (r) => console.log('[requestfailed]', r.url().slice(0, 100), r.failure()?.errorText));
await page.goto(BASE + '/');
await page.waitForSelector('.view', { timeout: 20000 });
await page.evaluate(async (d) => { const db = await import('/app/db.js'); d.id = 'print-1'; d.createdAt = Date.now(); await db.saveLecture(d); }, doc);
await page.goto(BASE + '/');
await page.waitForSelector('.lec', { timeout: 20000 });
await page.locator('.lec').first().click();
await page.waitForSelector('.paper', { timeout: 20000 });
await page.locator('.docbar-actions .icon-btn').click();
await page.locator('.menu button', { hasText: 'طباعة' }).click();
// ملزمة بلغتين: يسأل أي ملف قبل الطباعة
if (await page.waitForSelector('.sheet.open .pdf-langs', { timeout: 4000 }).catch(() => null)) {
  await page.locator('.sheet .pdf-lang:not(.ghost)').click();
  await page.waitForSelector('.pdf-langs', { state: 'detached', timeout: 5000 }).catch(() => {});
}
const t0 = Date.now();
// الصفحات تُرتّب ثم يظهر زر يفتح نافذة الطباعة (iPhone يمنع فتحها تلقائياً بعد انتظار)
await page.locator('.sheet.open button', { hasText: 'فتح نافذة الطباعة' }).click({ timeout: 90_000 });
let res = null;
while (Date.now() - t0 < 90_000) {
  await page.waitForTimeout(500);
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const r = await f.evaluate(() => ({ printed: window.__printed || 0, pages: document.querySelectorAll('.pg').length, ready: document.documentElement.classList.contains('mv-ready'), err: document.documentElement.dataset.pagedError || '' })).catch(() => null);
    if (r?.printed) { res = r; break; }
  }
  if (res) break;
}
console.log('print:', JSON.stringify(res), `${Math.round((Date.now() - t0) / 1000)}s`);
if (shot && res) {
  const f = page.frames().find((x) => x !== page.mainFrame());
  const png = await f.evaluate(() => document.querySelectorAll('.pg').length);
  console.log('pages in frame', png);
}
await browser.close();
await fetch(`${BASE}/api/admin/codes/${created[0]}`, { method: 'DELETE', headers: { ...J, cookie: adm } });
if (!res || !res.pages) process.exit(1);
