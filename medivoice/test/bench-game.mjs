// قياس كلفة رسم اللعبة على هاتف بطيء (إبطاء المعالج 6×): BASE=... ADMIN_PW=... node test/bench-game.mjs [gameUrl]
// يقيس زمن المعالج لكل إطار رسم ونسبة الإطارات الطويلة (> 50ms) خلال 6 ثوانٍ من اللعب.
import { launch, BASE } from './browser.mjs';
const gameUrl = process.argv[2] || '/app/game.js';
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
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
await page.evaluate(async (url) => { const m = await import(url); window.__g = m.openGame({}); }, gameUrl);
await page.waitForSelector('.game-canvas');
await page.waitForTimeout(800);
const box = await page.locator('.game-canvas').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.evaluate(() => {
  window.__frames = [];
  let last = performance.now();
  const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 100000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__long = 0;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long += e.duration; }).observe({ type: 'longtask', buffered: false }); } catch {}
});
for (let i = 0; i < 20; i++) { await page.keyboard.press(i % 3 === 0 ? 'ArrowLeft' : 'ArrowRight'); await page.waitForTimeout(300); }
const r = await page.evaluate(() => {
  const f = window.__frames.slice(5);
  const sorted = [...f].sort((a, b) => a - b);
  return { frames: f.length, p50: sorted[Math.floor(f.length * 0.5)], p95: sorted[Math.floor(f.length * 0.95)], max: sorted[f.length - 1], over50: f.filter((x) => x > 50).length, longTaskMs: Math.round(window.__long) };
});
console.log(gameUrl, JSON.stringify(r));
await browser.close();
await fetch(`${BASE}/api/admin/codes/${created[0]}`, { method: 'DELETE', headers: { ...J, cookie: adm } });
