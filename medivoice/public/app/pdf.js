// pdf.js — قالب الملزمة: يبني صفحة HTML مستقلة تُحوَّل إلى PDF (A4) بمتصفح Chrome على الخادم،
// أو تُطبع مباشرة من جهاز المستخدم. كل نص يأتي من المستخدم أو من النماذج يُهرَّب قبل إدراجه.
//
// الهوية من اللوكو: تدرّج بنفسجي → أرجواني، مربعات بزوايا مدوّرة، أعمدة الصوت، وخط El Messiri للعناوين.
// الملزمة بلغتين: جزء بلغة المحاضرة ثم جزء مترجم (doc.alt)، وبعدهما الأسئلة والقاموس والمصادر.

import { splitInline, splitLatin, blockText, stripMarkup, isNotes, MODE_LABEL } from './text.js';
import { creditLine } from './images.js';
import { pagedRuntime } from './paged.js';
import { markHtml, MARK_CSS } from '../brand.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cssStr = (s) => String(s ?? '').replace(/[\\"\n\r]/g, ' ').replace(/\s+/g, ' ').trim();

const MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
export function fmtDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
}
export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h) return `${h} س ${m} د`;
  if (m) return `${m} دقيقة`;
  return `${sec} ثانية`;
}

const arabicRatio = (s) => {
  const ar = (s.match(/[؀-ۿ]/g) || []).length, la = (s.match(/[A-Za-z]/g) || []).length;
  return ar + la ? ar / (ar + la) : 1;
};
/** اتجاه نص: المصطلحات بين [[ ]] لا تُحسب. */
export const dirOf = (text) => (arabicRatio(String(text).replace(/\[\[[^\]]*\]\]/g, '')) >= 0.3 ? 'rtl' : 'ltr');

/**
 * نص بترميز المصطلحات إلى HTML. في النص العربي تُعزل المقاطع الإنجليزية (مثل «(Introduction to Chest X-ray)»)
 * حتى لا تنقلب أقواسها وشرطاتها عند التفاف السطر؛ والقصيرة منها لا تنكسر بين سطرين.
 */
export function inlineHtml(text) {
  const rtl = dirOf(text) === 'rtl';
  const plain = (t) => (rtl
    ? splitLatin(t).map((q) => (q.latin ? `<span class="lt${q.text.length <= 36 ? ' nw' : ''}">${esc(q.text)}</span>` : esc(q.text))).join('')
    : esc(t));
  return splitInline(text).map((p) => (p.term ? `<span class="t${p.text.length <= 30 ? ' nw' : ''}">${esc(p.text)}</span>` : plain(p.text))).join('');
}

/** أعمدة صوت (زخرفة من اللوكو): ارتفاعات متناظرة تشبه الموجة الصوتية */
function soundBars(n = 41, max = 18) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1; // -1 .. 1
    const env = Math.exp(-x * x * 2.2);
    const wave = 0.55 + 0.45 * Math.abs(Math.sin(i * 1.7) * 0.7 + Math.cos(i * 0.9) * 0.3);
    const hgt = Math.max(2.2, max * env * wave);
    const op = (0.35 + 0.65 * env).toFixed(2);
    out.push(`<i style="height:${hgt.toFixed(1)}mm;opacity:${op}"></i>`);
  }
  return out.join('');
}

const GRAD = 'linear-gradient(135deg, #4a2fe0 0%, #8521d5 55%, #c923c1 100%)';

const CSS = `
@page { size: A4; margin: 22mm 17mm 20mm; }
@page :first { margin: 0; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: 'IBM Plex Sans Arabic', 'El Messiri', 'IBM Plex Sans', 'Noto Sans Arabic', sans-serif; font-size: 11.2pt; line-height: 1.95; color: #1d1434; background: #fff; }
.t { font-family: 'IBM Plex Sans', 'IBM Plex Sans Arabic', sans-serif; font-weight: 600; color: #5b21b6; direction: ltr; unicode-bidi: isolate; }
.ltr { direction: ltr; unicode-bidi: isolate; }
.lt { direction: ltr; unicode-bidi: isolate; }
.nw { white-space: nowrap; }
.en { font-family: 'IBM Plex Sans', 'IBM Plex Sans Arabic', sans-serif; line-height: 1.75; }
.en .t { color: #5b21b6; }
${MARK_CSS}

/* ── الغلاف ── */
.cover { position: relative; width: 210mm; height: 297mm; overflow: hidden; color: #fff; background: ${GRAD}; break-after: page; page-break-after: always; }
.cover .glow { position: absolute; inset: 0; background:
  radial-gradient(60% 45% at 85% 12%, rgba(255,255,255,.18), transparent 70%),
  radial-gradient(70% 50% at 10% 95%, rgba(255,140,240,.28), transparent 70%),
  radial-gradient(45% 35% at 50% 55%, rgba(255,255,255,.07), transparent 70%); }
.cover .ghost { position: absolute; width: 165mm; inset-inline-end: -46mm; bottom: -30mm; opacity: 1; }
.cover .brand { position: absolute; top: 18mm; inset-inline-start: 18mm; display: flex; align-items: center; gap: 4mm; }
.cover .brand .tile { width: 15mm; height: 15mm; border-radius: 3.4mm; box-shadow: 0 5mm 12mm -3mm rgba(0,0,0,.5); }
.cover .brand .tile img { display: block; width: 100%; height: 100%; border-radius: inherit; }
.cover .brand b { display: block; font-family: 'El Messiri', 'IBM Plex Sans Arabic', sans-serif; font-weight: 700; font-size: 19pt; line-height: 1; }
.cover .brand span { display: block; font-family: 'IBM Plex Sans', sans-serif; font-size: 7.6pt; letter-spacing: .22em; opacity: .8; margin-top: 1.6mm; }
.cover .kind { position: absolute; top: 21mm; inset-inline-end: 18mm; font: 600 9.4pt/1 'IBM Plex Sans', sans-serif; letter-spacing: .04em; padding: 2.6mm 5mm; border-radius: 99mm; background: rgba(255,255,255,.16); border: .3mm solid rgba(255,255,255,.35); }
.cover .head { position: absolute; inset-inline: 18mm; top: 78mm; }
.cover .subject { font-family: 'El Messiri', sans-serif; font-size: 13pt; font-weight: 600; color: #efe6ff; margin-bottom: 4mm; display: flex; align-items: center; gap: 3mm; }
.cover .subject::before { content: ''; width: 9mm; height: 1.1mm; border-radius: 1mm; background: #fff; opacity: .85; }
.cover h1 { margin: 0; font-family: 'El Messiri', 'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif; font-weight: 700; line-height: 1.45; text-shadow: 0 2mm 8mm rgba(0,0,0,.18); }
.cover h1 .t { color: #fff; font-weight: 700; }
.cover .alt-title { margin-top: 5mm; font-family: 'IBM Plex Sans', 'IBM Plex Sans Arabic', sans-serif; font-size: 14pt; font-weight: 500; line-height: 1.5; color: #f1e9ff; opacity: .92; }
.cover .alt-title .t { color: #fff; }
.cover .bars { position: absolute; inset-inline: 18mm; top: 182mm; height: 22mm; display: flex; align-items: center; justify-content: space-between; gap: 1mm; }
.cover .bars i { display: block; width: 2.1mm; border-radius: 2mm; background: #fff; }
.cover .meta { position: absolute; inset-inline: 18mm; bottom: 40mm; display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
.cover .meta div { padding: 3.4mm 4.4mm 3mm; border-radius: 3.4mm; background: rgba(255,255,255,.13); border: .3mm solid rgba(255,255,255,.28); }
.cover .meta small { display: block; font-size: 8pt; color: #e6dbff; margin-bottom: .6mm; }
.cover .meta b { display: block; font-size: 12pt; font-weight: 600; line-height: 1.4; }
.cover .audit { position: absolute; inset-inline-start: 18mm; bottom: 27mm; display: inline-flex; align-items: center; gap: 2mm; font-size: 8.6pt; color: #fff; padding: 1.4mm 4mm; background: rgba(0,0,0,.18); border-radius: 99mm; }
.cover .audit i { width: 2.6mm; height: 2.6mm; border-radius: 50%; background: #7af0c0; box-shadow: 0 0 3mm #7af0c0; }
.cover .foot { position: absolute; inset-inline: 18mm; bottom: 15mm; font-size: 8pt; color: #e6dbff; opacity: .9; }

/* ── فاصل اللغة ── */
.part { break-before: page; page-break-before: always; display: flex; align-items: center; justify-content: space-between; gap: 6mm; margin: 0 0 8mm; padding: 6mm 7mm; border-radius: 4.2mm; background: ${GRAD}; color: #fff; break-inside: avoid; page-break-inside: avoid; }
.part b { display: block; font-family: 'El Messiri', 'IBM Plex Sans', sans-serif; font-size: 17pt; font-weight: 700; line-height: 1.3; }
.part span { display: block; font-size: 9.6pt; opacity: .9; margin-top: 1mm; }
.part .t { color: #fff; font-weight: 600; }
.part .pbars { display: flex; align-items: center; gap: 1.1mm; flex: none; }
.part .pbars i { display: block; width: 1.7mm; border-radius: 2mm; background: #fff; opacity: .9; }

/* ── المتن ── */
main { padding: 0; }
h2 { font-family: 'El Messiri', 'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif; font-weight: 700; font-size: 16pt; line-height: 1.45; color: #2a1a4d; margin: 9mm 0 3.5mm; padding-bottom: 2.2mm; border-bottom: .3mm solid #e9e2fb; break-after: avoid; page-break-after: avoid; display: flex; align-items: flex-start; gap: 3.4mm; }
h2 .num { flex: none; width: 8.6mm; height: 8.6mm; border-radius: 2.4mm; background: ${GRAD}; color: #fff; font: 700 10.5pt/8.6mm 'El Messiri', 'IBM Plex Sans', sans-serif; text-align: center; margin-top: 1mm; box-shadow: 0 1.5mm 4mm -1.5mm rgba(74,47,224,.6); }
h2 .hx { flex: 1; min-width: 0; }
h2 .t { color: inherit; }
h2.plain::before { content: ''; flex: none; width: 4.6mm; height: 4.2mm; margin-top: 2.6mm; background: ${GRAD}; clip-path: polygon(0 0, 50% 55%, 100% 0, 100% 45%, 50% 100%, 0 45%); }
main > h2:first-child, .pg-body > h2:first-child { margin-top: 0; }
h3 { font-family: 'El Messiri', 'IBM Plex Sans Arabic', sans-serif; font-size: 13pt; font-weight: 700; color: #5b21b6; margin: 6mm 0 2mm; break-after: avoid; page-break-after: avoid; display: flex; align-items: flex-start; gap: 2.4mm; }
h3::before { content: ''; flex: none; width: 3.2mm; height: 2.9mm; margin-top: 2.9mm; background: ${GRAD}; clip-path: polygon(0 0, 50% 55%, 100% 0, 100% 45%, 50% 100%, 0 45%); }
h3 .hx { flex: 1; min-width: 0; }
p { margin: 0 0 3.6mm; orphans: 2; widows: 2; }
ul, ol { margin: 0 0 3.6mm; padding: 0; list-style: none; }
li { position: relative; padding-inline-start: 6.6mm; margin-bottom: 1.5mm; break-inside: avoid; }
ul > li::before { content: ''; position: absolute; inset-inline-start: 1mm; top: 3.3mm; width: 2.7mm; height: 2.4mm; background: ${GRAD}; clip-path: polygon(0 0, 50% 55%, 100% 0, 100% 45%, 50% 100%, 0 45%); }
ol { counter-reset: n; }
ol > li { counter-increment: n; }
ol > li::before { content: counter(n); position: absolute; inset-inline-start: 0; top: 1.3mm; width: 4.9mm; height: 4.9mm; border-radius: 50%; background: ${GRAD}; color: #fff; font: 600 7.8pt/4.9mm 'IBM Plex Sans', sans-serif; text-align: center; }
.note { margin: 4.4mm 0 5mm; padding: 3mm 4.6mm 3mm 4.4mm; background: #f5f0ff; border-inline-start: 1.3mm solid #c923c1; border-start-end-radius: 3mm; border-end-end-radius: 3mm; break-inside: avoid; }
.note b.tag { display: inline-block; margin-inline-end: 2.4mm; font-size: 8.4pt; font-weight: 700; color: #fff; background: ${GRAD}; padding: 0 2.8mm; line-height: 1.8; border-radius: 99mm; vertical-align: .3mm; }
figure { margin: 6mm 0 7mm; break-inside: avoid; page-break-inside: avoid; text-align: center; }
figure .frame { display: inline-block; max-width: 100%; padding: 2.4mm; border: .3mm solid #e3dbf7; border-radius: 3.2mm; background: #fff; box-shadow: 0 2.5mm 7mm -2mm rgba(74,47,224,.18); }
figure img { display: block; max-width: 100%; max-height: 98mm; height: auto; margin: 0 auto; border-radius: 1.6mm; }
figcaption { margin-top: 2.8mm; font-size: 9.6pt; line-height: 1.7; color: #2f2550; }
figcaption b { display: inline-block; color: #fff; background: ${GRAD}; font: 700 8pt/1.9 'El Messiri', 'IBM Plex Sans', sans-serif; padding: 0 2.8mm; border-radius: 99mm; margin-inline-end: 2mm; vertical-align: .4mm; }
figcaption small { display: block; font-size: 7.4pt; color: #8a7cab; margin-top: .8mm; }

ul.box { margin: 2mm 0 5mm; padding: 4mm 5mm 2.4mm; border-radius: 3.4mm; border: .5mm solid transparent; background: linear-gradient(#f8f5ff, #f8f5ff) padding-box, ${GRAD} border-box; }
.mcq { margin: 0 0 4.4mm; padding: 3.4mm 4.4mm 2.6mm; border: .3mm solid #e3dbf7; border-radius: 3.2mm; break-inside: avoid; page-break-inside: avoid; }
.mcq .q { font-weight: 600; color: #2a1a4d; margin-bottom: 1.8mm; display: flex; gap: 2.4mm; align-items: flex-start; }
.mcq .q b { flex: none; min-width: 6.6mm; height: 6.6mm; line-height: 6.6mm; text-align: center; border-radius: 2mm; background: ${GRAD}; color: #fff; font: 600 8.5pt/6.6mm 'IBM Plex Sans', sans-serif; margin-top: 1mm; }
.mcq ol { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: .9mm 5mm; counter-reset: none; }
.mcq ol li { padding-inline-start: 7.2mm; margin: 0; font-size: 10.2pt; counter-increment: none; }
.mcq ol li::before { content: attr(data-l); position: absolute; inset-inline-start: 0; top: .3mm; width: 5.3mm; height: 5.3mm; border-radius: 50%; border: .35mm solid #b9aadb; color: #5b21b6; background: #fff; font: 600 8pt/4.8mm 'IBM Plex Sans', sans-serif; text-align: center; }
table.tbl, table.answers, table.gloss { width: 100%; border-collapse: separate; border-spacing: 0; border: .3mm solid #e3dbf7; border-radius: 3mm; overflow: hidden; margin: 2mm 0 5mm; }
.tbl { font-size: 10pt; line-height: 1.7; }
.tbl th, .answers th, .gloss th { text-align: start; font-weight: 700; color: #fff; background: ${GRAD}; padding: 2mm 2.8mm; vertical-align: bottom; font-size: 9.6pt; }
.tbl td { padding: 1.8mm 2.8mm; vertical-align: top; border-bottom: .25mm solid #ebe5fa; overflow-wrap: anywhere; }
.tbl tr, .answers tr, .gloss tr { break-inside: avoid; page-break-inside: avoid; }
.tbl tbody tr:nth-child(even) td, .gloss tbody tr:nth-child(even) td, .answers tbody tr:nth-child(even) td { background: #faf7ff; }
.tbl tbody tr:last-child td, .gloss tbody tr:last-child td, .answers tbody tr:last-child td { border-bottom: 0; }
.answers { font-size: 9.6pt; line-height: 1.65; }
.answers td { padding: 1.7mm 2.6mm; vertical-align: top; border-bottom: .25mm solid #ebe5fa; }
.answers td.n { width: 10mm; font: 600 9.5pt 'IBM Plex Sans', sans-serif; color: #5b21b6; }
.answers td.a { width: 11mm; font: 700 10pt 'IBM Plex Sans', sans-serif; color: #2a1a4d; text-align: center; }
.gloss { table-layout: fixed; font-size: 9.7pt; line-height: 1.7; }
.gloss th.en { width: 30%; }
.gloss th.ar { width: 24%; }
.gloss td { padding: 2mm 2.6mm; vertical-align: top; border-bottom: .25mm solid #ebe5fa; overflow-wrap: anywhere; }
.gloss td.ar { font-weight: 600; color: #2a1a4d; }
.sources { font-size: 8.4pt; line-height: 1.7; color: #4a4067; }
.sources li { padding-inline-start: 0; margin-bottom: 2.2mm; }
.sources li::before { display: none; }
.sources a { display: block; color: #5b21b6; text-decoration: none; word-break: break-all; }
.endnote { margin-top: 9mm; padding-top: 3mm; border-top: .25mm solid #e3dbf7; font-size: 8pt; color: #8a7cab; line-height: 1.7; }
.section-break { break-before: page; page-break-before: always; }

/* ── صفحات ثابتة: تُبنى بسكربت paged.js عند التوليد على الخادم ── */
.pg { position: relative; width: 210mm; height: 296mm; overflow: hidden; display: grid; grid-template-rows: 22mm minmax(0, 1fr) 19mm; padding: 0 17mm; background: #fff; break-after: page; page-break-after: always; break-inside: avoid; page-break-inside: avoid; }
.pg:last-of-type { break-after: auto; page-break-after: auto; }
.pg-head { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 10mm; padding: 8mm 0 0; font-size: 8.2pt; line-height: 1.5; white-space: nowrap; }
.pg-head::after { content: ''; position: absolute; inset-inline: 0; bottom: 3.6mm; height: .45mm; border-radius: 1mm; background: ${GRAD}; opacity: .85; }
.pg-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: #7c6ca3; font-weight: 500; }
.pg-brand { flex: none; display: flex; align-items: center; gap: 2mm; color: #5b21b6; font-family: 'El Messiri', sans-serif; font-weight: 700; font-size: 9.4pt; }
.pg-brand img { width: 5.6mm; height: 5.6mm; border-radius: 1.3mm; }
.pg-body { min-height: 0; padding-top: 1mm; }
.pg-body > :first-child { margin-top: 0 !important; }
.pg-body > .section-break, .pg-body > .part { break-before: auto; page-break-before: auto; }
.pg-foot { display: flex; align-items: flex-start; justify-content: center; gap: 1.6mm; padding-top: 5.2mm; font: 600 8.6pt/1 'IBM Plex Sans', sans-serif; color: #5b21b6; direction: ltr; }
.pg-foot b { display: inline-block; min-width: 9mm; padding: 1.3mm 2.6mm; border-radius: 99mm; background: ${GRAD}; color: #fff; text-align: center; }
.pg-foot i { font-style: normal; font-weight: 500; color: #a99bc9; line-height: 1; padding-top: 1.4mm; }
li.cont::before { display: none !important; }
ol > li.cont { counter-increment: none; }
`;

// يُضاف بعد اكتمال بناء الصفحات: الورقة بلا هوامش لأن كل صفحة تحمل هوامشها
const PAGED_CSS = `
@page { size: A4; margin: 0; }
@page { @top-left { content: none; } @top-right { content: none; } @bottom-center { content: none; } }
html, body { background: #fff; }
`;

const PAGED_FONTS = [400, 500, 600, 700].map((w) => `${w} 15px "IBM Plex Sans Arabic"`)
  .concat([400, 500, 600, 700].map((w) => `${w} 15px "IBM Plex Sans"`), ['600 15px "El Messiri"', '700 15px "El Messiri"']);

// JSON آمن داخل <script>
const scriptJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const KEYPOINT_HEADINGS = new Set(['أهم النقاط للمراجعة', 'Key points for review']);
const MCQ_HEADINGS = new Set(['أسئلة اختيار من متعدد للمراجعة', 'Self-assessment MCQs']);
const L = ['a', 'b', 'c', 'd'];

/**
 * @param doc المستند (meta, blocks, alt, terms, duration, stats)
 * @param opts.paged  true عند التوليد على الخادم: يُضاف سكربت يبني صفحات ثابتة بترويسة وأرقام
 * @param opts.images خريطة (معرّف الصورة ← dataUrl) لصور مصغّرة بدل الأصلية
 * @param opts.brand  { logo, mark, mic } روابط (data:) لأصول الهوية
 * @param opts.screen true لمعاينة الشاشة
 */
export function buildPdfHtml(doc, opts = {}) {
  return buildPdfParts(doc, opts).html;
}

/**
 * مثل buildPdfHtml لكن يرجع أيضاً إعدادات تقسيم الصفحات، لمن يشغّل pagedRuntime بنفسه
 * (الطباعة من جهاز المستخدم: opts.paged = 'external' فلا يُضمَّن السكربت).
 * @returns {{ html: string, pagedCfg: object }}
 */
export function buildPdfParts(doc, opts = {}) {
  const meta = doc.meta || {};
  const title = String(meta.title || 'محاضرة');
  const notes = isNotes(meta.mode);
  const mainLang = doc.lang || (dirOf(doc.blocks.filter((b) => b.t !== 'fig').map(blockText).join(' ')) === 'ltr' ? 'en' : 'ar');
  const dir = mainLang === 'en' ? 'ltr' : 'rtl';
  const plainTitle = stripMarkup(title);
  const titleSize = plainTitle.length <= 28 ? 36 : plainTitle.length <= 56 ? 29 : plainTitle.length <= 90 ? 24 : 20;
  const brand = opts.brand || {};
  const logoUrl = brand.logo || '/logo.png';
  const figById = new Map(doc.blocks.filter((b) => b.t === 'fig').map((b) => [b.id, b]));

  const sources = [];
  const seenSources = new Set();
  const answers = [];
  const mcqParts = [];
  let qNo = 0;

  /** يحوّل كتل جزء واحد (لغة واحدة) إلى HTML. الأسئلة تُجمع لتُعرض مرة واحدة في آخر الملزمة. */
  function renderPart(blocks, lang) {
    const en = lang === 'en';
    const cls = en ? ' class="en"' : '';
    const parts = [];
    let figNo = 0, secNo = 0;
    for (const b of blocks) {
      if (b.t === 'h') {
        const d = dirOf(b.text);
        if (b.level === 3) parts.push(`<h3${cls} dir="${d}"><span class="hx">${inlineHtml(b.text)}</span></h3>`);
        else if (KEYPOINT_HEADINGS.has(stripMarkup(b.text).trim()) || MCQ_HEADINGS.has(stripMarkup(b.text).trim())) {
          if (MCQ_HEADINGS.has(stripMarkup(b.text).trim())) continue; // عنوان الأسئلة يُبنى مع الأسئلة
          parts.push(`<h2 class="plain${en ? ' en' : ''}" dir="${d}"><span class="hx">${inlineHtml(b.text)}</span></h2>`);
        } else parts.push(`<h2${cls} dir="${d}"><span class="num">${++secNo}</span><span class="hx">${inlineHtml(b.text)}</span></h2>`);
      } else if (b.t === 'p') {
        parts.push(`<p${cls} dir="${dirOf(b.text)}">${inlineHtml(b.text)}</p>`);
      } else if (b.t === 'ul' || b.t === 'ol') {
        parts.push(`<${b.t}${b.box ? ` class="box${en ? ' en' : ''}"` : cls} dir="${dirOf(b.items.join(' '))}">${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</${b.t}>`);
      } else if (b.t === 'table' && b.rows?.length) {
        const cols = b.head.length;
        const row = (cells, tag) => `<tr>${Array.from({ length: cols }, (_, c) => `<${tag} dir="${dirOf(cells[c] || '')}">${inlineHtml(cells[c] || '')}</${tag}>`).join('')}</tr>`;
        parts.push(`<table class="tbl${en ? ' en' : ''}" dir="${dirOf(blockText(b))}"><thead>${row(b.head, 'th')}</thead><tbody>${b.rows.map((r) => row(r, 'td')).join('')}</tbody></table>`);
      } else if (b.t === 'mcq') {
        qNo++;
        answers.push({ n: qNo, a: L[b.ans] || '?', why: b.why || '' });
        mcqParts.push(`<div class="mcq en" dir="${dirOf(b.q)}"><div class="q"><b>${qNo}</b><span>${inlineHtml(b.q)}</span></div><ol>${b.opts.map((o, i) => `<li data-l="${L[i]}" style="position:relative" dir="${dirOf(o)}">${inlineHtml(o)}</li>`).join('')}</ol></div>`);
      } else if (b.t === 'note') {
        const d = dirOf(b.text);
        parts.push(`<div class="note${en ? ' en' : ''}" dir="${d}"><b class="tag">${d === 'rtl' ? 'مهم' : 'Important'}</b>${inlineHtml(b.text)}</div>`);
      } else if (b.t === 'fig') {
        const src = b.ref ? figById.get(b.ref) : b;
        if (!src?.img?.dataUrl) continue;
        figNo++;
        const d = en ? 'ltr' : dirOf(b.caption || plainTitle);
        const label = d === 'rtl' ? `شكل ${figNo}` : `Figure ${figNo}`;
        if (src.pick && src.pick.source !== 'slides' && !seenSources.has(src.id)) { seenSources.add(src.id); sources.push({ n: figNo, label, ...src.pick }); }
        const srcUrl = opts.images?.[src.id] || src.img.dataUrl;
        parts.push(`<figure${cls}><div class="frame"><img src="${esc(srcUrl)}" alt=""></div><figcaption dir="${d}"><b>${label}</b>${inlineHtml(b.caption || '')}${src.pick ? `<small dir="ltr">${esc(creditLine(src.pick))}</small>` : ''}</figcaption></figure>`);
      }
    }
    return parts;
  }

  const partBanner = (lang, subtitle) => {
    const en = lang === 'en';
    const bars = Array.from({ length: 9 }, (_, i) => `<i style="height:${[3, 6, 9, 12, 14, 12, 9, 6, 3][i]}mm"></i>`).join('');
    return `<div class="part${en ? ' en' : ''}" dir="${en ? 'ltr' : 'rtl'}" data-dir="${en ? 'ltr' : 'rtl'}"><div><b>${en ? 'English edition' : 'النسخة العربية'}</b>${subtitle ? `<span dir="${dirOf(subtitle)}">${inlineHtml(subtitle)}</span>` : ''}</div><div class="pbars">${bars}</div></div>`;
  };

  const alt = notes && doc.alt?.blocks?.length ? doc.alt : null;
  const mainParts = renderPart(doc.blocks, mainLang);
  const altParts = alt ? renderPart(alt.blocks, alt.lang) : [];
  const body = alt
    ? [partBanner(mainLang, ''), ...mainParts, partBanner(alt.lang, alt.title || ''), ...altParts]
    : mainParts;

  const mcqHtml = mcqParts.length ? `
<h2 class="plain en section-break" dir="ltr" data-dir="ltr"><span class="hx">Self-assessment MCQs</span></h2>
${mcqParts.join('\n')}
<h2 class="plain en section-break" dir="ltr"><span class="hx">Answer key</span></h2>
<table class="answers en" dir="ltr">
  <thead><tr><th>Q</th><th>Answer</th><th>Explanation</th></tr></thead>
  <tbody>${answers.map((a) => `<tr><td class="n">${a.n}</td><td class="a">${esc(a.a)}</td><td dir="${dirOf(a.why)}">${inlineHtml(a.why)}</td></tr>`).join('')}</tbody>
</table>` : '';

  const terms = doc.terms || [];
  const gloss = terms.length ? `
<h2 class="plain section-break" dir="rtl" data-dir="rtl"><span class="hx">قاموس المصطلحات</span></h2>
<table class="gloss" dir="rtl">
  <thead><tr><th class="en">المصطلح</th><th class="ar">بالعربية</th><th>التعريف</th></tr></thead>
  <tbody>${terms.map((t) => `<tr><td class="en"><span class="t">${esc(t.en)}</span></td><td class="ar">${esc(t.ar)}</td><td>${esc(t.def)}</td></tr>`).join('')}</tbody>
</table>` : '';

  const src = sources.length ? `
<h2 class="plain" dir="rtl" data-dir="rtl"><span class="hx">مصادر الصور</span></h2>
<ul class="sources" dir="rtl">${sources.map((s) => `<li><b>${esc(s.label)}:</b> <span dir="ltr" class="ltr">${esc(s.title || '')}</span> — <span dir="ltr" class="ltr">${esc(creditLine(s))}</span>${/^https:\/\//.test(s.page || '') ? `<a dir="ltr" href="${esc(s.page)}">${esc(s.page)}</a>` : ''}</li>`).join('')}</ul>` : '';

  const metaItems = [
    ['المادة', meta.subject], ['التدريسي', meta.lecturer], ['التاريخ', fmtDate(meta.date)],
    ['مدة التسجيل', doc.duration ? fmtDuration(doc.duration) : ''], ['عدد الكلمات', doc.stats?.words ? doc.stats.words.toLocaleString('en-US') : ''],
    ['المصطلحات', terms.length ? String(terms.length) : ''],
  ].filter(([, v]) => v);

  const header = cssStr(plainTitle).slice(0, 70);
  // الترويسة تتكرر في كل صفحة: نسخة صغيرة من اللوكو حتى لا يتضخم الملف
  const pageHead = `<header class="pg-head"><span class="pg-title" dir="${dirOf(title)}">${esc(plainTitle)}</span><span class="pg-brand" dir="rtl"><img src="${esc(brand.logoSmall || logoUrl)}" alt="">ميدي فويز</span></header><div class="pg-body"></div><footer class="pg-foot"><b class="pg-num"></b><i class="pg-total"></i></footer>`;
  const pagedCfg = { dir, firstPage: 2, fonts: PAGED_FONTS, pagedCss: PAGED_CSS, pageHtml: pageHead };
  const paged = opts.paged === true ? `<script>(${pagedRuntime.toString()})(${scriptJson(pagedCfg)});</script>` : '';
  const kindLabel = notes ? `${MODE_LABEL[meta.mode] || 'Notes'}${alt ? ' · AR + EN' : ''}` : 'ملزمة محاضرة';

  const html = `<!doctype html>
<html lang="${mainLang === 'en' ? 'en' : 'ar'}" dir="${dir}">
<head>
<meta charset="utf-8">
<title>${esc(plainTitle)} — ميدي فويز</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=El+Messiri:wght@600;700&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}
@page {
  @top-${dir === 'rtl' ? 'right' : 'left'} { content: "${header}"; font: 500 8.2pt 'IBM Plex Sans Arabic', sans-serif; color: #7c6ca3; vertical-align: bottom; padding-bottom: 5mm; }
  @top-${dir === 'rtl' ? 'left' : 'right'} { content: "ميدي فويز · MediVoice"; font: 600 8.2pt 'IBM Plex Sans Arabic', sans-serif; color: #5b21b6; vertical-align: bottom; padding-bottom: 5mm; }
  @bottom-center { content: counter(page); font: 600 9pt 'IBM Plex Sans', sans-serif; color: #5b21b6; vertical-align: top; padding-top: 6mm; }
}
@page :first { @top-left { content: none; } @top-right { content: none; } @bottom-center { content: none; } }
${opts.screen ? '@media screen { body { background: #2a1a4d; } .cover, main { margin: 12px auto; box-shadow: 0 10px 40px rgba(0,0,0,.4); } main { width: 210mm; background: #fff; padding: 23mm 17mm; } }' : ''}
</style>
</head>
<body>
<section class="cover" dir="rtl">
  <div class="glow"></div>
  ${markHtml({ color: 'rgba(255,255,255,.07)', cls: 'ghost', urls: brand })}
  <div class="brand"><span class="tile"><img src="${esc(logoUrl)}" alt=""></span><div><b>ميدي فويز</b><span dir="ltr">MediVoice</span></div></div>
  <div class="kind"><span dir="ltr">${esc(kindLabel)}</span></div>
  <div class="head" dir="${dirOf(title)}">
    ${meta.subject ? `<div class="subject" dir="${dirOf(meta.subject)}">${esc(meta.subject)}</div>` : ''}
    <h1 style="font-size:${titleSize}pt">${inlineHtml(title)}</h1>
    ${alt?.title ? `<div class="alt-title" dir="${dirOf(alt.title)}">${inlineHtml(alt.title)}</div>` : ''}
  </div>
  <div class="bars" aria-hidden="true">${soundBars()}</div>
  <div class="meta">${metaItems.map(([k, v]) => `<div><small>${esc(k)}</small><b dir="auto">${esc(v)}</b></div>`).join('')}</div>
  ${doc.stats?.audit || (doc.stats?.gate && !doc.stats.gate.onOpen) ? `<div class="audit"><i></i>${doc.stats?.audit ? 'روجعت كاملة مقابل التسجيل' : ''}${doc.stats?.audit && doc.stats?.gate ? ' وفُحصت كل صفحاتها' : doc.stats?.gate ? 'فُحصت كل صفحاتها' : ''} قبل التسليم</div>` : ''}
  <div class="foot">${notes ? 'شرح مكتوب آلياً من تسجيل المحاضرة. راجعه مع المحاضرة الأصلية قبل الاعتماد عليه.' : 'نص مفرّغ آلياً من تسجيل صوتي. راجعه مع المحاضرة الأصلية قبل الاعتماد عليه.'}</div>
</section>
<main id="flow">
${body.join('\n')}
${mcqHtml}
${gloss}
${src}
<div class="endnote" dir="rtl" data-dir="rtl">أُعدّت هذه الملزمة بواسطة ميدي فويز من تسجيل صوتي للمحاضرة. ${notes ? 'كتابة الشرح والترجمة' : 'التفريغ'} والقاموس واختيار الصور تمت آلياً وقد تحتوي أخطاء؛ المرجع النهائي هو المحاضر والمصادر المعتمدة.</div>
</main>
${paged}
</body>
</html>`;
  return { html, pagedCfg };
}
