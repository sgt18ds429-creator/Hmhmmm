// اختبار التسجيل المباشر بالمتصفح (ليس من اختبارات node --test): المايكروفون يُغذّى بملف WAV، يُسجَّل، يتحوّل لملزمة.
//   BASE=... ADMIN_PW=... GEMINI_KEY=... GROQ_KEY=... node test/record.e2e.mjs <mic.wav> <shots-dir> [ثواني التسجيل]
import { chromium } from 'playwright';
import path from 'node:path';
import { BASE } from './browser.mjs';
const [wav, shots, secs = '45'] = process.argv.slice(2);
const J = { 'x-mv': '1', 'content-type': 'application/json' };
const login = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password: process.env.ADMIN_PW }) });
const adm = (login.headers.get('set-cookie') || '').split(';')[0];
const { created } = await (await fetch(`${BASE}/api/admin/codes`, { method: 'POST', headers: { ...J, cookie: adm }, body: JSON.stringify({ label: 'اختبار التسجيل' }) })).json();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve(wav)}%noloop`, '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ar-IQ', permissions: ['microphone'],
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
const shot = (n) => page.screenshot({ path: path.join(shots, `${n}.png`) }).catch(() => {});
try {
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#lock.in', { timeout: 30000 });
  await page.locator('#code').focus();
  await page.keyboard.type(created[0].replace(/^MV-/, '').replace('-', ''));
  await page.locator('#lock-btn').click();
  await page.waitForSelector('.prov', { timeout: 30000 });
  for (const [nth, key] of [[0, process.env.GEMINI_KEY], [1, process.env.GROQ_KEY]]) {
    if (!key) continue;
    const input = page.locator('.prov').nth(nth).locator('input.input').first();
    await input.fill(key); await input.press('Enter');
    await page.waitForSelector('.toast.ok', { timeout: 40000 }); await page.waitForTimeout(3500);
  }
  await page.locator('.view button.btn.wide', { hasText: 'تم' }).click();
  await page.locator('button', { hasText: 'تسجيل مباشر' }).click();
  await page.locator('.sheet.open .rec .btn', { hasText: 'ابدأ التسجيل' }).click();
  await page.waitForSelector('.rec-dot', { timeout: 10000 });
  console.log(`recording ${secs}s…`);
  await page.waitForTimeout(Number(secs) * 1000);
  await shot('r1-recording');
  await page.locator('.sheet.open .rec .btn', { hasText: 'إنهاء وتحويل' }).click();
  await page.waitForSelector('.filecard', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.view .btn.wide') && !document.querySelector('.view .btn.wide').disabled, null, { timeout: 30000 });
  console.log('file:', (await page.locator('.filecard').first().innerText()).replace(/\n/g, ' | '));
  await page.locator('.types .type').filter({ hasText: 'High-Yield' }).click();
  await page.locator('.view button.btn.wide', { hasText: 'ابدأ التحويل' }).click();
  const t0 = Date.now();
  while (Date.now() - t0 < 600_000) {
    await page.waitForTimeout(5000);
    if (await page.locator('.paper').count()) break;
    if (await page.locator('.result').count()) { console.log('FAILED:', await page.locator('.result').innerText()); break; }
    console.log('  ', `${Math.round((Date.now() - t0) / 1000)}s`, (await page.locator('.run-pct').innerText().catch(() => '')).replace(/\s+/g, ''), '|', await page.locator('.run-status').innerText().catch(() => ''));
  }
  if (await page.locator('.paper').count()) {
    await page.waitForTimeout(1200); await shot('r2-doc');
    console.log('doc:', await page.locator('.doc-title').innerText(), '| blocks', await page.locator('.blk').count());
  }
} finally {
  await browser.close();
  const del = await fetch(`${BASE}/api/admin/codes/${created[0].replace(/^MV-/, '').replace('-', '')}`, { method: 'DELETE', headers: { ...J, cookie: adm } });
  console.log('test code deleted:', del.status);
}
