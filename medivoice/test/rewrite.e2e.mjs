// إعادة كتابة ملزمة محفوظة بنوع آخر من واجهة الموقع: BASE=... ADMIN_PW=... GEMINI_KEY=... node test/rewrite.e2e.mjs doc.json [highyield]
import { readFile } from 'node:fs/promises';
import { launch, BASE } from './browser.mjs';
const [file, mode = 'highyield'] = process.argv.slice(2);
const doc = JSON.parse(await readFile(file, 'utf8'));
const J = { 'x-mv': '1', 'content-type': 'application/json' };
const login = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password: process.env.ADMIN_PW }) });
const adm = (login.headers.get('set-cookie') || '').split(';')[0];
const { created } = await (await fetch(`${BASE}/api/admin/codes`, { method: 'POST', headers: { ...J, cookie: adm }, body: JSON.stringify({ label: 'rewrite' }) })).json();
const act = await fetch(`${BASE}/api/activate`, { method: 'POST', headers: { ...J, 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/141 Mobile' }, body: JSON.stringify({ code: created[0], fp: { os: 'Android', scr: '390x844@2' } }) });
const cookie = (act.headers.get('set-cookie') || '').split(';')[0];
await fetch(`${BASE}/api/keys`, { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ key: process.env.GEMINI_KEY }) });
const { browser, context, page } = await launch({ mobile: true });
await context.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=')[1], domain: new URL(BASE).hostname, path: '/' }]);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(BASE + '/');
await page.waitForSelector('.view', { timeout: 20000 });
await page.evaluate(async (d) => { const db = await import('/app/db.js'); d.id = 'rw-1'; d.createdAt = Date.now() - 1000; await db.saveLecture(d); }, doc);
await page.goto(BASE + '/');
await page.waitForSelector('.lec', { timeout: 20000 });
await page.locator('.lec').first().click();
await page.waitForSelector('.paper', { timeout: 20000 });
await page.locator('.docbar-actions .icon-btn').click();
await page.locator('.menu button', { hasText: 'اكتبها من جديد' }).click();
await page.locator('.sheet .type', { hasText: mode === 'highyield' ? 'High-Yield' : mode === 'integrated' ? 'Integrated' : 'Comprehensive' }).click();
const t0 = Date.now();
await page.waitForSelector('.run', { timeout: 20000 });
await page.waitForSelector('.paper', { timeout: 600000 });
await page.waitForTimeout(1500);
const r = await page.evaluate(() => ({
  badges: document.querySelector('.doc-badges')?.innerText.replace(/\n/g, ' | '),
  mcq: document.querySelectorAll('.blk.mcq').length,
  toggle: document.querySelectorAll('.lang-seg button').length,
  blocks: document.querySelectorAll('.paper .blk').length,
}));
console.log('rewrite:', JSON.stringify(r), `${Math.round((Date.now() - t0) / 1000)}s`);
await browser.close();
await fetch(`${BASE}/api/admin/codes/${created[0]}`, { method: 'DELETE', headers: { ...J, cookie: adm } });
