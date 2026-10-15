// قياس سرعة الفتح على هاتف متوسط (شبكة 4G ومعالج أبطأ 4 مرات): BASE=... node test/perf.mjs <out-dir> [--warm]
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'https://medivoice.nukhba-uni.workers.dev';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
// 4G-ish: 9 Mbps down, 150ms RTT; CPU 4x slower
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 9e6 / 8, uploadThroughput: 3e6 / 8 });
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
const res = [];
page.on('response', async (r) => { try { const h = r.headers(); res.push({ url: r.url().replace(BASE, ''), status: r.status(), type: (h['content-type'] || '').split(';')[0], len: Number(h['content-length'] || 0), enc: h['content-encoding'] || '', cache: h['cache-control'] || '' }); } catch {} });
if (process.argv.includes('--warm')) { await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(4000); res.length = 0; }
await page.goto(BASE + '/', { waitUntil: 'load' });
const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const fp = performance.getEntriesByType('paint'); return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), ttfb: Math.round(n.responseStart), fcp: Math.round(fp.find((p) => p.name === 'first-contentful-paint')?.startTime || 0) }; });
await page.waitForTimeout(2500);
const lcp = await page.evaluate(() => new Promise((r) => { let v = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) v = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); setTimeout(() => r(Math.round(v)), 100); }));
const longTasks = await page.evaluate(() => new Promise((r) => { const out = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) out.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); setTimeout(() => r(out), 100); }));
console.log('nav', nav, 'lcp', lcp, 'longTasks', longTasks);
const total = res.reduce((n, r) => n + r.len, 0);
console.log('requests', res.length, 'bytes(content-length)', total);
for (const r of res) console.log(' ', r.status, r.type.padEnd(24), String(r.len).padStart(8), r.enc.padEnd(4), r.url.slice(0, 70), '|', r.cache);
await page.screenshot({ path: process.argv[2] + '/first.png' });
await browser.close();
