// لقطات للعبة: BASE=... ADMIN_PW=... node test/shot-game.mjs <out-dir>
import { launch, BASE } from './browser.mjs';
import path from 'node:path';
const [out] = process.argv.slice(2);
const J = { 'x-mv': '1', 'content-type': 'application/json' };
const login = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password: process.env.ADMIN_PW }) });
const adm = (login.headers.get('set-cookie') || '').split(';')[0];
const { created } = await (await fetch(`${BASE}/api/admin/codes`, { method: 'POST', headers: { ...J, cookie: adm }, body: JSON.stringify({ label: 'لعبة' }) })).json();
const { browser, context, page } = await launch({ mobile: true });
const act = await fetch(`${BASE}/api/activate`, { method: 'POST', headers: { ...J, 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile Safari/537.36' }, body: JSON.stringify({ code: created[0], fp: { os: 'Android', scr: '390x844@2' } }) });
const cookie = (act.headers.get('set-cookie') || '').split(';')[0];
await context.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=')[1], domain: new URL(BASE).hostname, path: '/' }]);
await page.goto(BASE + '/');
await page.waitForSelector('.view', { timeout: 20000 });
await page.evaluate(async () => { const m = await import('/app/game.js'); window.__g = m.openGame({ build: window.MV?.session?.build || '' }); });
await page.waitForSelector('.race canvas');
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(out, 'game-ready.png') });
const box = await page.locator('.race').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); // ابدأ
await page.waitForTimeout(1200);
await page.evaluate(() => window.__g.update(31, 'أكتب الشرح المفصل: جاهز 2 من 6'));
for (let i = 0; i < 14; i++) { await page.keyboard.press(i % 3 === 0 ? 'ArrowLeft' : 'ArrowRight'); await page.waitForTimeout(260); }
await page.screenshot({ path: path.join(out, 'game-run.png') });
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(out, 'game-run2.png') });
const info = await page.evaluate(() => window.__g.stats());
console.log('game ok', JSON.stringify(info));
await browser.close();
await fetch(`${BASE}/api/admin/codes/${created[0]}`, { method: 'DELETE', headers: { ...J, cookie: adm } });
