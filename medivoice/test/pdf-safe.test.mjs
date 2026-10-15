// ملف الـ PDF «آمن» لكل عارض: عارض PDF في iPhone يرسم الطبقات ذات قناع الشفافية (SMask) مربعات داكنة
// فوق النص (ظلال مموّهة، text-shadow، filter، أقنعة CSS، تدرّجات بألوان شفافة). هذا الاختبار يمنع رجوعها:
// فحص نصي لكل تنسيقات الملزمة، ثم ملف PDF حقيقي من Chromium يُفحص بناؤه.
// ويتحقق من تنزيل كل لغة وحدها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { buildPdfHtml, buildPdfParts, pdfLangs } from '../public/app/pdf.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const BRAND = { logo: PNG, logoSmall: PNG, mark: PNG, cover: PNG, head: PNG };
let seq = 0;
const id = () => `b${++seq}`;

function sampleDoc(mode = 'notes', { alt = true } = {}) {
  const fig = { id: 'f1', t: 'fig', img: { dataUrl: PNG }, caption: 'صورة شعاعية للصدر بالمسقط [[PA view]]', pick: { source: 'commons', title: 'Chest X-ray', author: 'X', license: 'CC BY-SA 4.0', page: 'https://commons.wikimedia.org/wiki/File:x.jpg' } };
  const blocks = [
    { id: id(), t: 'h', level: 2, text: 'مقدمة عن [[chest X-ray]]' },
    { id: id(), t: 'p', text: 'يُعد تصوير الصدر بالأشعة السينية [[chest X-ray]] الفحص الأكثر طلباً داخل المستشفيات.' },
    { id: id(), t: 'h', level: 3, text: 'أنواع المساقط' },
    { id: id(), t: 'ul', items: ['المسقط الخلفي الأمامي [[PA view]]', 'المسقط الأمامي الخلفي [[AP view]]'] },
    { id: id(), t: 'ol', items: ['الخطوة الأولى', 'الخطوة الثانية'] },
    { id: id(), t: 'note', text: 'القلب يبدو أكبر في المسقط الأمامي الخلفي.' },
    { id: id(), t: 'table', head: ['المسقط', 'الوصف'], rows: [['[[PA]]', 'خلفي أمامي'], ['[[AP]]', 'أمامي خلفي']] },
    fig,
    { id: id(), t: 'h', level: 2, text: 'أهم النقاط للمراجعة' },
    { id: id(), t: 'ul', box: true, items: ['المسقط الخلفي الأمامي هو المعيار.'] },
  ];
  if (mode === 'highyield') {
    blocks.push({ id: id(), t: 'h', level: 2, text: 'أسئلة اختيار من متعدد للمراجعة' });
    blocks.push({ id: id(), t: 'mcq', q: 'Which projection magnifies the heart?', opts: ['PA', 'AP', 'Lateral', 'Oblique'], ans: 1, why: 'The heart is farther from the detector in AP.' });
  }
  const altBlocks = [
    { id: id(), t: 'h', level: 2, text: 'Introduction to chest X-ray' },
    { id: id(), t: 'p', text: 'The [[chest X-ray]] is the most requested examination in hospitals.' },
    { id: id(), t: 'fig', ref: 'f1', caption: 'Chest radiograph in the [[PA view]]' },
    { id: id(), t: 'h', level: 2, text: 'Key points for review' },
    { id: id(), t: 'ul', box: true, items: ['PA is the standard projection.'] },
  ];
  return {
    id: 'd1',
    meta: { title: 'أساسيات قراءة [[Chest X-ray]] والمساقط', subject: 'التصوير الشعاعي', lecturer: 'د. مثال', date: '2026-10-15', mode },
    lang: 'ar', duration: 2700, blocks,
    alt: alt ? { lang: 'en', title: 'Fundamentals of Chest X-ray Reading', blocks: altBlocks } : undefined,
    terms: [{ en: 'pleural effusion', ar: 'انصباب جنبي', def: 'تجمع سائل في الحيز الجنبي.' }],
    stats: { words: 911, audit: { fixes: 1, added: 0 }, gate: { repeats: 0 } },
  };
}

/** كل CSS الملف: كتل <style>، وسمات style، وما يضيفه مقسّم الصفحات */
function cssOf(html, pagedCfg) {
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const inline = [...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]);
  return [...styles, ...inline, pagedCfg?.pagedCss || ''].join('\n');
}

const FORBIDDEN = [
  [/box-shadow\s*:\s*(?!none\b)/i, 'box-shadow'],
  [/text-shadow\s*:/i, 'text-shadow'],
  [/(^|[;{\s])filter\s*:/i, 'filter'],
  [/backdrop-filter\s*:/i, 'backdrop-filter'],
  [/mix-blend-mode\s*:/i, 'mix-blend-mode'],
  [/(^|[;{\s])(-webkit-)?mask(-image)?\s*:/i, 'CSS mask'],
  [/(?:linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))*?(?:rgba\(|hsla\(|transparent)/i, 'gradient with a transparent stop'],
];

const VARIANTS = [];
for (const mode of ['notes', 'highyield', 'transcript']) for (const lang of ['both', 'ar', 'en']) VARIANTS.push({ mode, lang });

test('تنسيق الملزمة بلا ظلال مموّهة ولا أقنعة ولا تدرّجات شفافة (كل الأنواع واللغات، الخادم والطباعة)', () => {
  for (const { mode, lang } of VARIANTS) {
    for (const paged of [true, 'external']) {
      const { html, pagedCfg } = buildPdfParts(sampleDoc(mode), { paged, brand: BRAND, lang });
      const css = cssOf(html, pagedCfg);
      for (const [re, what] of FORBIDDEN) assert.doesNotMatch(css, re, `${mode}/${lang}: ${what}`);
      assert.doesNotMatch(html, /class="mk\b/, `${mode}/${lang}: علامة بقناع CSS`);
    }
  }
});

test('تنزيل كل لغة وحدها: العربية بمصطلحاتها، والإنجليزية وحدها، والاثنتان', () => {
  const doc = sampleDoc('highyield');
  assert.deepEqual(pdfLangs(doc), ['ar', 'en']);
  assert.deepEqual(pdfLangs(sampleDoc('notes', { alt: false })), ['ar'], 'بلا ترجمة: لغة واحدة');

  const both = buildPdfHtml(doc, { brand: BRAND });
  assert.match(both, /النسخة العربية/);
  assert.match(both, /English edition/);
  assert.match(both, /AR \+ EN/);

  const ar = buildPdfHtml(doc, { brand: BRAND, lang: 'ar' });
  assert.match(ar, /<html lang="ar" dir="rtl">/);
  assert.match(ar, /مقدمة عن/);
  assert.match(ar, /class="t[^"]*">chest X-ray</, 'المصطلحات الإنجليزية داخل النص العربي');
  assert.doesNotMatch(ar, /Introduction to chest X-ray/, 'لا نص من النسخة الإنجليزية');
  assert.doesNotMatch(ar, /class="part/, 'لا فاصل لغات');
  assert.match(ar, /Self-assessment MCQs/, 'الأسئلة (بالإنجليزية) تبقى');
  assert.match(ar, /قاموس المصطلحات/);
  assert.match(ar, /· AR</, 'نوع الملزمة بلا AR + EN');

  const en = buildPdfHtml(doc, { brand: BRAND, lang: 'en' });
  assert.match(en, /<html lang="en" dir="ltr">/);
  assert.match(en, /Fundamentals of Chest X-ray Reading/, 'عنوان الغلاف بالإنجليزية');
  assert.match(en, /Introduction to chest X-ray/);
  assert.doesNotMatch(en, /مقدمة عن/, 'لا نص من النسخة العربية');
  assert.doesNotMatch(en, /class="part/);
  assert.match(en, /Which projection magnifies the heart\?/, 'الأسئلة من الملزمة الأصلية');
  assert.match(en, /Glossary of terms/);
  assert.match(en, />Subject</);
  assert.match(en, /15 October 2026/);
  assert.match(en, /Figure 1/);
  assert.match(en, /· EN</);
  // الأسئلة لا تتكرر في الملف الكامل
  assert.equal((both.match(/Which projection magnifies the heart\?/g) || []).length, 1);
});

/** نص ملف PDF مع محتوى تدفقاته المضغوطة (لفحص القواميس داخل تدفقات الكائنات أيضاً) */
function pdfText(buf) {
  const raw = buf.toString('latin1');
  const out = [raw];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try { out.push(inflateSync(buf.subarray(start, end)).toString('latin1')); } catch { /* تدفق غير مضغوط أو صورة */ }
    re.lastIndex = end;
  }
  return out.join('\n');
}

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
test('ملف PDF مطبوع من Chromium بلا أقنعة شفافية ولا أنماط مزج (ما يشوّه العرض على iPhone)', { skip: !existsSync(CHROME) && 'Chromium غير مثبت', timeout: 120_000 }, async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    for (const [mode, lang] of [['highyield', 'both'], ['notes', 'ar'], ['highyield', 'en']]) {
      const html = buildPdfHtml(sampleDoc(mode), { paged: true, brand: BRAND, lang });
      await page.setContent(html, { waitUntil: 'load' });
      await page.waitForSelector('html.mv-ready', { timeout: 30_000 }).catch(() => {});
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      const text = pdfText(pdf);
      assert.ok(text.includes('/Page'), 'ملف PDF صالح');
      assert.doesNotMatch(text, /\/Type\s*\/Mask\b/, `${mode}/${lang}: قناع شفافية (SMask في حالة الرسم)`);
      assert.doesNotMatch(text, /\/S\s*\/(?:Luminosity|Alpha)\b/, `${mode}/${lang}: قناع شفافية`);
      const blend = [...text.matchAll(/\/BM\s*\/(\w+)/g)].map((x) => x[1]).filter((x) => x !== 'Normal' && x !== 'Compatible');
      assert.deepEqual(blend, [], `${mode}/${lang}: نمط مزج`);
    }
  } finally {
    await browser.close();
  }
});
