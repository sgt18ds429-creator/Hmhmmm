// اختبار شامل بالمتصفح (ليس من اختبارات node --test): تفعيل → ربط المفاتيح → رفع تسجيل → تحويل → ملزمة → PDF.
//   BASE=http://127.0.0.1:8787 ADMIN_PW=... GROQ_KEY=... GEMINI_KEY=... node test/e2e.mjs <audio> <shots-dir> [--type=highyield|notes|integrated] [--pdf=file.pdf] [--cleanup]
import { launch, BASE } from './browser.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
const args = process.argv.slice(2);
const [audio, shots] = args.filter((a) => !a.startsWith('--'));
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');
const type = opt('type', 'highyield');
const pdfFile = opt('pdf', '');
const step = (m) => console.log(`\n▶ ${m}`);
const J = { 'x-mv': '1', 'content-type': 'application/json' };

// كود جديد من لوحة التحكم
const login = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password: process.env.ADMIN_PW }) });
const adm = (login.headers.get('set-cookie') || '').split(';')[0];
const created = await (await fetch(`${BASE}/api/admin/codes`, { method: 'POST', headers: { ...J, cookie: adm }, body: JSON.stringify({ label: 'اختبار المتصفح' }) })).json();
const code = created.created[0];
console.log('code', code);

const { browser, page } = await launch({ mobile: process.env.DESKTOP !== '1' });
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

step('intro → lock → activate');
await page.goto(BASE + '/');
await page.waitForTimeout(1300); await shot('00-intro');
await page.waitForSelector('#lock.in', { timeout: 15000 });
await page.waitForTimeout(900); await shot('01-lock');
await page.locator('#code').focus();
await page.keyboard.type(code.replace(/^MV-/, '').replace('-', ''));
await page.waitForTimeout(300); await shot('01b-lock-filled');
await page.locator('#lock-btn').click();
await page.waitForSelector('.view', { timeout: 15000 });
await page.waitForTimeout(1200); await shot('02-link');

step('link keys');
for (const [name, key] of [['Gemini', process.env.GEMINI_KEY], ['Groq', process.env.GROQ_KEY]]) {
  if (!key) continue;
  const input = page.locator('.prov', { has: page.locator('h3', { hasText: name }) }).locator('input.input').first();
  await input.fill(key);
  await input.press('Enter');
  await page.waitForSelector('.toast.ok', { timeout: 30000 });
  await page.waitForTimeout(3600);
}
await shot('03-linked');
await page.locator('.view button.btn.wide', { hasText: 'تم' }).click();
await page.waitForSelector('.slab'); await page.waitForTimeout(900); await shot('04-home');

step('choose file + type');
await page.locator('input[type=file][accept*="audio"]').setInputFiles(audio);
await page.waitForSelector('.filecard');
await page.locator('.types .type').filter({ hasText: type === 'highyield' ? 'High-Yield' : type === 'notes' ? 'Comprehensive' : 'Integrated' }).click();
if (type === 'integrated' && pdfFile) await page.locator('input[type=file][accept*="pdf"]').setInputFiles(pdfFile);
await page.waitForFunction(() => document.querySelector('.view .btn.wide') && !document.querySelector('.view .btn.wide').disabled, null, { timeout: 30000 });
await page.locator('input[list=mv-subjects]').fill(process.env.SUBJECT ?? 'التصوير الشعاعي');
if (process.env.LECTURER) await page.locator('label.field', { hasText: 'اسم التدريسي' }).locator('input').fill(process.env.LECTURER).catch(() => {});
await page.locator('textarea').fill(process.env.KEYWORDS ?? 'chest X-ray, pneumothorax, pleural effusion');
await page.waitForTimeout(300); await shot('05-new');
await page.evaluate(() => scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(300); await shot('05b-new-bottom');

step('run');
await page.locator('.view button.btn.wide', { hasText: 'ابدأ التحويل' }).click();
await page.waitForSelector('.run');
let n = 0;
const t0 = Date.now();
const runLimit = (parseInt(process.env.RUN_TIMEOUT || '600', 10)) * 1000; // ثوانٍ؛ محاضرة ساعة تحتاج أكثر من 10 دقائق
while (Date.now() - t0 < runLimit) {
  await page.waitForTimeout(n < 6 ? 2500 : 6000);
  if (await page.locator('.paper').count()) break;
  if (await page.locator('.result').count()) { await shot('06-run-failed'); console.log('FAILED:', await page.locator('.result').innerText()); break; }
  if (n < 12) await shot(`06-run-${n}`);
  console.log('  ', `${Math.round((Date.now() - t0) / 1000)}s`, (await page.locator('.run-pct').innerText().catch(() => '')).replace(/\s+/g, ''), '|', await page.locator('.run-status').innerText().catch(() => ''));
  n++;
}
step('doc');
await page.waitForSelector('.paper', { timeout: 10000 });
await page.waitForTimeout(1500); await shot('07-doc');
await page.screenshot({ path: path.join(shots, '07-doc-full.png'), fullPage: true });
console.log('blocks', await page.locator('.blk').count(), 'figs', await page.locator('.blk.fig').count(), 'mcq', await page.locator('.blk.mcq').count(), 'terms', await page.locator('.gloss-row').count());
console.log('title:', await page.locator('.doc-title').innerText());
console.log('badges:', (await page.locator('.doc-badges').innerText().catch(() => '')).replace(/\n/g, ' | '));
console.log('time:', `${Math.round((Date.now() - t0) / 1000)}s`);
const stats = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('medivoice');
  req.onsuccess = () => { const db = req.result; const all = db.transaction('lectures').objectStore('lectures').getAll(); all.onsuccess = () => { const d = all.result.sort((a, b) => b.createdAt - a.createdAt)[0]; resolve({ stats: d?.stats, slides: d?.slides ? { pages: d.slides.pages.length, figs: d.slides.figs } : null, slidereq: d?.blocks.filter((b) => b.t === 'slidereq').length, transcriptHasSlide: (d?.transcript || []).some((b) => b.t === 'slidereq') }); }; };
  req.onerror = () => resolve(null);
}));
console.log('stats:', JSON.stringify(stats).slice(0, 1400));
// المستند كاملاً (بلا بيانات الصور) لتحليل الناتج لاحقاً
const dump = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('medivoice');
  req.onsuccess = () => { const db = req.result; const all = db.transaction('lectures').objectStore('lectures').getAll(); all.onsuccess = () => {
    const d = all.result.sort((a, b) => b.createdAt - a.createdAt)[0];
    const strip = (v) => (typeof v === 'string' && v.startsWith('data:') ? `data:…(${v.length})` : v);
    resolve(JSON.stringify(d, (k, v) => (k === 'big' || k === 'small' || k === 'tiny' ? undefined : strip(v))));
  }; };
  req.onerror = () => resolve(null);
}));
if (dump) await fs.writeFile(path.join(shots, 'doc.json'), dump);
const figs = page.locator('.blk.fig');
for (let i = 0; i < await figs.count(); i++) {
  await figs.nth(i).scrollIntoViewIfNeeded();
  await figs.nth(i).screenshot({ path: path.join(shots, `07c-fig-${i + 1}.png`) });
  console.log(`fig ${i + 1}:`, (await figs.nth(i).locator('.credit').innerText().catch(() => '')), '|', (await figs.nth(i).locator('.cap').innerText()).slice(0, 90));
}
if (await page.locator('.mcq-opt').count()) { await page.locator('.mcq-opt').first().click(); await page.waitForTimeout(400); await page.locator('.blk.mcq').first().screenshot({ path: path.join(shots, '07b-mcq.png') }); }

step('pdf');
await page.locator('.fab .btn').click();
// ملزمة بلغتين: يسأل أي ملف (العربية، الإنجليزية، أو الاثنين بملف واحد)
const langPick = process.env.PDF_LANG || 'both';
if (await page.waitForSelector('.sheet.open .pdf-langs', { timeout: 4000 }).catch(() => null)) {
  await page.waitForTimeout(500); await shot('08a-pdf-langs');
  await page.locator(langPick === 'both' ? '.sheet .pdf-lang:not(.ghost)' : `.sheet .pdf-lang.ghost >> nth=${langPick === 'ar' ? 0 : 1}`).click();
  await page.waitForSelector('.pdf-langs', { state: 'detached', timeout: 5000 }).catch(() => {});
}
await page.waitForFunction(() => document.querySelector('.sheet a[download]') || document.querySelectorAll('.sheet .btn').length >= 2, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(600); await shot('08-pdf-sheet');
console.log('sheet:', (await page.locator('.sheet-panel').innerText()).replace(/\n+/g, ' | ').slice(0, 200));
if (await page.locator('.sheet a[download]').count()) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.sheet a[download]').click()]);
  await dl.saveAs(path.join(shots, 'out.pdf'));
  console.log('pdf saved');
}
if (args.includes('--cleanup')) {
  const del = await fetch(`${BASE}/api/admin/codes/${code}`, { method: 'DELETE', headers: { ...J, cookie: adm } });
  console.log('test code deleted:', del.status);
}
await browser.close();
