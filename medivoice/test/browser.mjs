// أدوات مشتركة لاختبارات المتصفح (Playwright + Chromium المثبت مسبقاً).
// ENGINE=webkit: نفس الاختبار بمحرك سفاري (WebKit) وبهيئة آيفون. يحتاج WebKit مثبتاً بمجلد منفصل:
//   PLAYWRIGHT_BROWSERS_PATH=<dir> node node_modules/playwright/cli.js install webkit
import { chromium, webkit } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const BASE = process.env.BASE || 'http://127.0.0.1:8787';
export const ENGINE = process.env.ENGINE === 'webkit' ? 'webkit' : 'chromium';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

function watch(page) {
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text().slice(0, 300)); });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
  page.on('requestfailed', (r) => { if (!/fonts\.g/.test(r.url())) console.log('[requestfailed]', r.url().slice(0, 120), r.failure()?.errorText); });
}

export async function launch({ mobile = true, width, height } = {}) {
  const view = mobile
    ? { viewport: { width: width || 390, height: height || 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ar-IQ' }
    : { viewport: { width: width || 1360, height: height || 850 }, deviceScaleFactor: 1, locale: 'ar-IQ' };
  if (ENGINE === 'webkit') {
    // سياق دائم (ملف تعريف على القرص) مثل سفاري العادي: السياق المؤقت بـ WebKit لا يحفظ Blob في IndexedDB
    const context = await webkit.launchPersistentContext(mkdtempSync(join(tmpdir(), 'mv-wk-')), {
      ...view, ...(mobile ? { userAgent: IPHONE_UA } : {}),
      proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
    });
    const page = context.pages()[0] || await context.newPage();
    watch(page);
    return { browser: context, context, page };
  }
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext(mobile ? { ...view, userAgent: ANDROID_UA } : view);
  const page = await context.newPage();
  watch(page);
  return { browser, context, page };
}
