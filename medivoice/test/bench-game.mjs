// قياس سلاسة اللعبة على هاتف بطيء (إبطاء المعالج 4×) والصفحة مشغولة كأنها تحوّل محاضرة
// (مهام ثقيلة 120ms كل 300ms): BASE=... ADMIN_PW=... node test/bench-game.mjs [--page]
//   --page: يجبر المحرك على العمل في الصفحة (للمقارنة مع العامل الخلفي)
import { launch, BASE } from './browser.mjs';
const forcePage = process.argv.includes('--page');
const J = { 'x-mv': '1', 'content-type': 'application/json' };
const login = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password: process.env.ADMIN_PW }) });
const adm = (login.headers.get('set-cookie') || '').split(';')[0];
const { created } = await (await fetch(`${BASE}/api/admin/codes`, { method: 'POST', headers: { ...J, cookie: adm }, body: JSON.stringify({ label: 'bench' }) })).json();
const { browser, context, page } = await launch({ mobile: true });
const act = await fetch(`${BASE}/api/activate`, { method: 'POST', headers: { ...J, 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile Safari/537.36' }, body: JSON.stringify({ code: created[0], fp: { os: 'Android', scr: '390x844@2' } }) });
const cookie = (act.headers.get('set-cookie') || '').split(';')[0];
await context.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=')[1], domain: new URL(BASE).hostname, path: '/' }]);
await page.goto(BASE + '/');
await page.waitForSelector('.view', { timeout: 20000 });
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.evaluate(async (forcePage) => {
  if (forcePage) delete HTMLCanvasElement.prototype.transferControlToOffscreen;
  const m = await import('/app/game.js');
  window.__g = m.openGame({ build: window.MV?.session?.build || '' });
}, forcePage);
await page.waitForSelector('.race canvas');
await page.waitForTimeout(1500);
const box = await page.locator('.race').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
// الصفحة مشغولة: مهمة ثقيلة متكررة
await page.evaluate(() => { window.__busy = setInterval(() => { const t = performance.now(); while (performance.now() - t < 120) { /* حمل */ } }, 300); });
for (let i = 0; i < 20; i++) { await page.keyboard.press(i % 3 === 0 ? 'ArrowLeft' : 'ArrowRight'); await page.waitForTimeout(300); }
const r = await page.evaluate(() => window.__g.stats());
await page.evaluate(() => clearInterval(window.__busy));
console.log(forcePage ? 'page   ' : 'default', JSON.stringify(r));
await browser.close();
await fetch(`${BASE}/api/admin/codes/${created[0]}`, { method: 'DELETE', headers: { ...J, cookie: adm } });
