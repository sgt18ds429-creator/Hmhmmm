// يبني ملزمة PDF من مستند محفوظ (JSON) بنفس محرك Chrome، لمعاينة القالب بدون الخادم.
//   node tools/pdf-preview.mjs doc.json out.pdf
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { buildPdfHtml } from '../public/app/pdf.js';
const [src, out] = process.argv.slice(2);
const doc = JSON.parse(await readFile(src, 'utf8'));
const dataUrl = async (f) => `data:image/png;base64,${(await readFile(new URL(`../public/${f}`, import.meta.url))).toString('base64')}`;
const brand = { logo: await dataUrl('logo.png'), mark: await dataUrl('mark.png'), mic: await dataUrl('mark-mic.png') };
const html = buildPdfHtml(doc, { paged: true, brand });
await writeFile(out.replace(/\.pdf$/, '.html'), html);
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
const browser = await chromium.launch(exe ? { executablePath: exe, proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined } : {});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.setContent(html, { waitUntil: 'load' });
await page.waitForSelector('html.mv-ready', { timeout: 40000 });
const info = await page.evaluate(() => ({ ...document.documentElement.dataset }));
const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
await writeFile(out, pdf);
console.log('paged:', JSON.stringify(info), '| html', (html.length / 1024).toFixed(0) + 'KB → pdf', (pdf.length / 1024).toFixed(0) + 'KB');
await browser.close();
