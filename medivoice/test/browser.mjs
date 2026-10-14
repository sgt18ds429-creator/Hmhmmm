// أدوات مشتركة لاختبارات المتصفح (Playwright + Chromium المثبت مسبقاً).
import { chromium } from 'playwright';
export const BASE = process.env.BASE || 'http://127.0.0.1:8787';
export async function launch({ mobile = true, width, height } = {}) {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext(mobile
    ? { viewport: { width: width || 390, height: height || 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ar-IQ',
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' }
    : { viewport: { width: width || 1360, height: height || 850 }, deviceScaleFactor: 1, locale: 'ar-IQ' });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text().slice(0, 300)); });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
  page.on('requestfailed', (r) => { if (!/fonts\.g/.test(r.url())) console.log('[requestfailed]', r.url().slice(0, 120), r.failure()?.errorText); });
  return { browser, context, page };
}
