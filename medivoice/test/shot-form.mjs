// لقطات سريعة لنموذج المحاضرة الجديدة (بدون تحويل): BASE=... ADMIN_PW=... node test/shot-form.mjs <audio> <out-dir>
import { launch, BASE } from './browser.mjs';
import path from 'node:path';
const [audio, out] = process.argv.slice(2);
const J = { 'x-mv': '1', 'content-type': 'application/json' };
const login = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password: process.env.ADMIN_PW }) });
const adm = (login.headers.get('set-cookie') || '').split(';')[0];
const { created } = await (await fetch(`${BASE}/api/admin/codes`, { method: 'POST', headers: { ...J, cookie: adm }, body: JSON.stringify({ label: 'لقطات' }) })).json();
const { browser, context, page } = await launch({ mobile: true });
const act = await fetch(`${BASE}/api/activate`, { method: 'POST', headers: { ...J, 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile Safari/537.36' }, body: JSON.stringify({ code: created[0], fp: { os: 'Android', scr: '390x844@2' } }) });
const cookie = (act.headers.get('set-cookie') || '').split(';')[0];
const u = new URL(BASE);
await context.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=')[1], domain: u.hostname, path: '/' }]);
// مفاتيح وهمية غير مطلوبة: الصفحة الرئيسية تعرض شريط «اربط مفاتيحك»
await page.goto(BASE + '/');
await page.waitForSelector('.view', { timeout: 20000 });
await page.waitForTimeout(1500);
await page.locator('input[type=file][accept*="audio"]').setInputFiles(audio).catch(() => {});
await page.waitForSelector('.types', { timeout: 10000 });
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(out, 'form-top.png') });
await page.locator('.types .type').nth(2).click();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, 'form-integrated.png') });
await page.screenshot({ path: path.join(out, 'form-full.png'), fullPage: true });
await browser.close();
await fetch(`${BASE}/api/admin/codes/${created[0]}`, { method: 'DELETE', headers: { ...J, cookie: adm } });
console.log('ok');
