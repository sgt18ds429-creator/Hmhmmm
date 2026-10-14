// pdf.js — قالب الملزمة: يبني صفحة HTML مستقلة تُحوَّل إلى PDF (A4) بمتصفح Chrome على الخادم،
// أو تُطبع مباشرة من جهاز المستخدم. كل نص يأتي من المستخدم أو من النماذج يُهرَّب قبل إدراجه.

import { splitInline, blockText, stripMarkup, isNotes, MODE_LABEL } from './text.js';
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

export function inlineHtml(text) {
  return splitInline(text).map((p) => (p.term ? `<span class="t">${esc(p.text)}</span>` : esc(p.text))).join('');
}

// خط متعرج بزوايا 30° (هوية ميدي فويز) كمسار SVG
function zigzag(width, mid, amps) {
  const TAN = 0.57735;
  let x = 0, up = true, d = `M0 ${mid}`;
  let i = 0;
  while (x < width) {
    const a = amps[i++ % amps.length];
    const dx = a / TAN;
    x += dx; d += ` L${x.toFixed(1)} ${(mid + (up ? -a : a)).toFixed(1)}`;
    x += dx; up = !up;
  }
  return d + ` L${x.toFixed(1)} ${mid}`;
}

const CSS = `
@page { size: A4; margin: 23mm 17mm 21mm; }
@page :first { margin: 0; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: 'IBM Plex Sans Arabic', 'El Messiri', 'IBM Plex Sans', 'Noto Sans Arabic', sans-serif; font-size: 11.4pt; line-height: 1.95; color: #1f1736; background: #fff; }
.t { font-family: 'IBM Plex Sans', 'IBM Plex Sans Arabic', sans-serif; font-weight: 600; color: #5a1fd1; direction: ltr; unicode-bidi: isolate; }
.ltr { direction: ltr; unicode-bidi: isolate; }

/* ── الغلاف ── */
.cover { position: relative; width: 210mm; height: 297mm; overflow: hidden; color: #fff; background: linear-gradient(135deg, #4d1ace 0%, #7a19c4 52%, #9a18b8 100%); break-after: page; page-break-after: always; }
.cover .grid { position: absolute; inset: 0; background: repeating-linear-gradient(30deg, rgba(255,255,255,.055) 0 .3mm, transparent .3mm 13mm), repeating-linear-gradient(-30deg, rgba(255,255,255,.055) 0 .3mm, transparent .3mm 13mm); }
${MARK_CSS}
.cover .ghost { position: absolute; width: 150mm; inset-inline-end: -40mm; bottom: -24mm; }
.cover .brand { position: absolute; top: 19mm; inset-inline-start: 19mm; display: flex; align-items: center; gap: 3.6mm; }
.cover .brand .tile { width: 13mm; height: 13mm; border-radius: 3mm; box-shadow: 0 4mm 10mm -3mm rgba(0,0,0,.45); }
.cover .brand .tile img { display: block; width: 100%; height: 100%; border-radius: inherit; }
.cover .brand b { font-family: 'El Messiri', 'IBM Plex Sans Arabic', sans-serif; font-weight: 700; font-size: 18pt; line-height: 1; }
.cover .brand span { display: block; font-family: 'IBM Plex Sans', sans-serif; font-size: 7.5pt; letter-spacing: .2em; opacity: .75; margin-top: 1.2mm; }
.cover .kind { position: absolute; top: 22mm; inset-inline-end: 19mm; font-size: 9.5pt; padding: 1.2mm 4.4mm; background: rgba(255,255,255,.14); clip-path: polygon(3mm 0, 100% 0, 100% calc(100% - 1.7mm), calc(100% - 3mm) 100%, 0 100%, 0 1.7mm); }
.cover .head { position: absolute; inset-inline: 19mm; top: 84mm; }
.cover .subject { font-size: 13pt; font-weight: 500; color: #e7dcff; margin-bottom: 5mm; }
.cover h1 { margin: 0; font-family: 'El Messiri', 'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif; font-weight: 700; line-height: 1.5; }
.cover h1 .t { color: #fff; font-weight: 700; }
.cover .wave { position: absolute; inset-inline: 0; top: 186mm; width: 210mm; height: 19mm; }
.cover .meta { position: absolute; inset-inline: 19mm; bottom: 30mm; display: grid; grid-template-columns: repeat(3, 1fr); gap: 7mm 6mm; }
.cover .meta div { border-top: .35mm solid rgba(255,255,255,.4); padding-top: 2.4mm; }
.cover .meta small { display: block; font-size: 8.4pt; color: #dccbff; }
.cover .meta b { font-size: 12pt; font-weight: 600; }
.cover .foot { position: absolute; inset-inline: 19mm; bottom: 15mm; font-size: 8pt; color: #d6c4ff; }

/* ── المتن ── */
main { padding: 0; }
h2 { font-family: 'El Messiri', 'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif; font-weight: 700; font-size: 16pt; line-height: 1.5; color: #4d1ace; margin: 9mm 0 3mm; break-after: avoid; page-break-after: avoid; display: flex; align-items: flex-start; gap: 3mm; }
h2::before { content: ''; flex: none; width: 4.4mm; height: 4mm; margin-top: 2.2mm; background: linear-gradient(135deg, #5433ec, #c923c1); clip-path: polygon(0 0, 50% 55%, 100% 0, 100% 45%, 50% 100%, 0 45%); }
h2 .hx { flex: 1; min-width: 0; }
h2 .t { color: inherit; }
main > h2:first-child { margin-top: 0; }
h3 { font-family: 'El Messiri', 'IBM Plex Sans Arabic', sans-serif; font-size: 13pt; font-weight: 700; color: #2a1a4d; margin: 6mm 0 2mm; break-after: avoid; page-break-after: avoid; }
p { margin: 0 0 3.6mm; orphans: 2; widows: 2; }
ul, ol { margin: 0 0 3.6mm; padding: 0; list-style: none; }
li { position: relative; padding-inline-start: 6.6mm; margin-bottom: 1.6mm; break-inside: avoid; }
ul > li::before { content: ''; position: absolute; inset-inline-start: 1mm; top: 3.2mm; width: 2.6mm; height: 2.3mm; background: #7a19c4; clip-path: polygon(0 0, 50% 55%, 100% 0, 100% 45%, 50% 100%, 0 45%); }
ol { counter-reset: n; }
ol > li { counter-increment: n; }
ol > li::before { content: counter(n); position: absolute; inset-inline-start: 0; top: 1.2mm; width: 4.8mm; height: 4.8mm; border-radius: 50%; background: #f1eaff; color: #4d1ace; font: 600 8pt/4.8mm 'IBM Plex Sans', sans-serif; text-align: center; }
.note { margin: 4.4mm 0 5mm; padding: 3mm 5mm 3mm 4.4mm; background: #fff5dc; border-inline-start: 1.1mm solid #f5a524; break-inside: avoid; }
.note b.tag { display: inline-block; margin-inline-end: 2.2mm; font-size: 8.6pt; font-weight: 700; color: #8a4f00; background: #ffdf9e; padding: 0 2.4mm; line-height: 1.75; }
figure { margin: 6mm 0 7mm; break-inside: avoid; page-break-inside: avoid; text-align: center; }
figure .frame { display: inline-block; max-width: 100%; padding: 2mm; border: .3mm solid #e2d8f8; background: #fff; }
figure img { display: block; max-width: 100%; max-height: 98mm; height: auto; margin: 0 auto; }
figcaption { margin-top: 2.4mm; font-size: 9.6pt; line-height: 1.7; color: #2f2550; }
figcaption b { color: #4d1ace; font-weight: 700; margin-inline-end: 1.4mm; }
figcaption small { display: block; font-size: 7.4pt; color: #8778aa; margin-top: .6mm; }

ul.box { margin: 2mm 0 5mm; padding: 3.4mm 5mm 1.6mm; background: #f6f1ff; border-inline-start: 1.1mm solid #7a19c4; }
.mcq { margin: 0 0 4.4mm; padding: 3mm 4mm 2.4mm; border: .3mm solid #e2d8f8; border-radius: 2mm; break-inside: avoid; page-break-inside: avoid; }
.mcq .q { font-weight: 600; color: #2a1a4d; margin-bottom: 1.6mm; }
.mcq .q b { display: inline-block; min-width: 6.5mm; height: 6.5mm; line-height: 6.5mm; text-align: center; border-radius: 50%; background: #4d1ace; color: #fff; font: 600 8.5pt 'IBM Plex Sans', sans-serif; margin-inline-end: 2mm; }
.mcq ol { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: .8mm 5mm; }
.mcq ol li { padding-inline-start: 7mm; margin: 0; font-size: 10.3pt; }
.mcq ol li::before { content: attr(data-l); position: absolute; inset-inline-start: 0; top: .2mm; width: 5.2mm; height: 5.2mm; border-radius: 50%; border: .3mm solid #b9aadb; color: #4d1ace; font: 600 8pt/5.2mm 'IBM Plex Sans', sans-serif; text-align: center; background: #fff; }
.answers { width: 100%; border-collapse: collapse; font-size: 9.6pt; line-height: 1.65; margin-top: 2mm; }
.answers th { text-align: start; font-size: 8.6pt; color: #6c5c96; padding: 1.4mm 2.4mm; border-bottom: .5mm solid #4d1ace; }
.answers td { padding: 1.6mm 2.4mm; vertical-align: top; border-bottom: .25mm solid #e7dff8; }
.answers td.n { width: 9mm; font: 600 9.5pt 'IBM Plex Sans', sans-serif; color: #4d1ace; }
.answers td.a { width: 10mm; font: 700 10pt 'IBM Plex Sans', sans-serif; color: #2a1a4d; text-align: center; }
.answers tr { break-inside: avoid; page-break-inside: avoid; }
.cover .audit { position: absolute; inset-inline-start: 19mm; bottom: 22mm; display: inline-flex; align-items: center; gap: 2mm; font-size: 8.6pt; color: #fff; padding: 1.2mm 3.6mm; background: rgba(255,255,255,.16); border-radius: 99mm; }
.cover .audit i { width: 2.6mm; height: 2.6mm; border-radius: 50%; background: #6fe3b4; }
.tbl { width: 100%; border-collapse: collapse; font-size: 10pt; line-height: 1.7; margin: 2mm 0 5mm; }
.tbl th { text-align: start; font-weight: 700; color: #4d1ace; background: #f1eaff; padding: 1.8mm 2.6mm; border-bottom: .5mm solid #4d1ace; vertical-align: bottom; }
.tbl td { padding: 1.8mm 2.6mm; vertical-align: top; border-bottom: .25mm solid #e7dff8; overflow-wrap: anywhere; }
.tbl tr { break-inside: avoid; page-break-inside: avoid; }
.tbl tbody tr:nth-child(even) td { background: #faf7ff; }
.gloss { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 9.7pt; line-height: 1.7; margin-top: 2mm; }
.gloss th.en { width: 30%; }
.gloss th.ar { width: 24%; }
.gloss td { overflow-wrap: anywhere; }
.gloss th { text-align: start; font-weight: 600; font-size: 8.6pt; color: #6c5c96; padding: 1.6mm 2.4mm; border-bottom: .5mm solid #4d1ace; }
.gloss td { padding: 1.9mm 2.4mm; vertical-align: top; border-bottom: .25mm solid #e7dff8; }
.gloss tr { break-inside: avoid; page-break-inside: avoid; }
.gloss tbody tr:nth-child(even) td { background: #faf7ff; }
.gloss td.ar { font-weight: 600; color: #2a1a4d; }
.sources { font-size: 8.4pt; line-height: 1.7; color: #4a4067; }
.sources li { padding-inline-start: 0; margin-bottom: 2.2mm; }
.sources li::before { display: none; }
.sources a { display: block; color: #5a1fd1; text-decoration: none; word-break: break-all; }
.endnote { margin-top: 9mm; padding-top: 3mm; border-top: .25mm solid #e2d8f8; font-size: 8pt; color: #8778aa; line-height: 1.7; }
.section-break { break-before: page; page-break-before: always; }

/* ── صفحات ثابتة: تُبنى بسكربت paged.js عند التوليد على الخادم ── */
.pg { position: relative; width: 210mm; height: 296mm; overflow: hidden; display: grid; grid-template-rows: 23mm minmax(0, 1fr) 21mm; padding: 0 17mm; background: #fff; break-after: page; page-break-after: always; break-inside: avoid; page-break-inside: avoid; }
.pg:last-of-type { break-after: auto; page-break-after: auto; }
.pg-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 10mm; padding-bottom: 5mm; font-size: 8.2pt; line-height: 1.5; white-space: nowrap; }
.pg-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: #7c6ca3; font-weight: 500; }
.pg-brand { flex: none; display: flex; align-items: center; gap: 1.7mm; color: #5a1fd1; font-weight: 600; }
.pg-brand .mk { width: 3.2mm; }
.pg-body { min-height: 0; }
.pg-body > :first-child { margin-top: 0 !important; }
.pg-body > .section-break { break-before: auto; page-break-before: auto; }
.pg-foot { display: flex; align-items: flex-start; justify-content: center; gap: 1.3mm; padding-top: 6.5mm; font: 600 9pt/1 'IBM Plex Sans', sans-serif; color: #5a1fd1; direction: ltr; }
.pg-foot i { font-style: normal; font-weight: 400; color: #a99bc9; }
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

/**
 * @param doc المستند (meta, blocks, terms, duration, stats)
 * @param opts.paged  true عند التوليد على الخادم: يُضاف سكربت يبني صفحات ثابتة بترويسة وأرقام
 * @param opts.images خريطة (معرّف الفقرة ← dataUrl) لصور مصغّرة بدل الأصلية
 * @param opts.screen true لمعاينة الشاشة
 */
export function buildPdfHtml(doc, opts = {}) {
  const meta = doc.meta || {};
  const title = String(meta.title || 'محاضرة');
  const body = doc.blocks.filter((b) => b.t !== 'fig').map(blockText).join(' ');
  const notes = isNotes(meta.mode);
  const dir = dirOf(body);
  const plainTitle = stripMarkup(title);
  const titleSize = plainTitle.length <= 28 ? 38 : plainTitle.length <= 56 ? 31 : plainTitle.length <= 90 ? 25 : 21;

  let figNo = 0, qNo = 0;
  const sources = [];
  const parts = [];
  const answers = [];
  const L = ['a', 'b', 'c', 'd'];
  for (const b of doc.blocks) {
    if (b.t === 'h') {
      if (b.level === 3) parts.push(`<h3 dir="${dirOf(b.text)}">${inlineHtml(b.text)}</h3>`);
      else parts.push(`<h2 dir="${dirOf(b.text)}"><span class="hx">${inlineHtml(b.text)}</span></h2>`);
    } else if (b.t === 'p') {
      parts.push(`<p dir="${dirOf(b.text)}">${inlineHtml(b.text)}</p>`);
    } else if (b.t === 'ul' || b.t === 'ol') {
      parts.push(`<${b.t}${b.box ? ' class="box"' : ''} dir="${dirOf(b.items.join(' '))}">${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</${b.t}>`);
    } else if (b.t === 'table' && b.rows?.length) {
      const cols = b.head.length;
      const row = (cells, tag) => `<tr>${Array.from({ length: cols }, (_, c) => `<${tag} dir="${dirOf(cells[c] || '')}">${inlineHtml(cells[c] || '')}</${tag}>`).join('')}</tr>`;
      parts.push(`<table class="tbl" dir="${dirOf(blockText(b))}"><thead>${row(b.head, 'th')}</thead><tbody>${b.rows.map((r) => row(r, 'td')).join('')}</tbody></table>`);
    } else if (b.t === 'mcq') {
      qNo++;
      answers.push({ n: qNo, a: L[b.ans] || '?', why: b.why || '' });
      parts.push(`<div class="mcq" dir="${dirOf(b.q)}"><div class="q"><b>${qNo}</b>${inlineHtml(b.q)}</div><ol>${b.opts.map((o, i) => `<li data-l="${L[i]}" style="position:relative" dir="${dirOf(o)}">${inlineHtml(o)}</li>`).join('')}</ol></div>`);
    } else if (b.t === 'note') {
      const d = dirOf(b.text);
      parts.push(`<div class="note" dir="${d}"><b class="tag">${d === 'rtl' ? 'مهم' : 'Important'}</b>${inlineHtml(b.text)}</div>`);
    } else if (b.t === 'fig' && b.img?.dataUrl) {
      figNo++;
      const d = dirOf(b.caption || body);
      const label = d === 'rtl' ? `شكل ${figNo}` : `Figure ${figNo}`;
      if (b.pick && b.pick.source !== 'slides') sources.push({ n: figNo, label, ...b.pick });
      const srcUrl = opts.images?.[b.id] || b.img.dataUrl;
      parts.push(`<figure><div class="frame"><img src="${esc(srcUrl)}" alt=""></div><figcaption dir="${d}"><b>${label}</b>${inlineHtml(b.caption || '')}${b.pick ? `<small dir="ltr">${esc(creditLine(b.pick))}</small>` : ''}</figcaption></figure>`);
    }
  }

  const answerKey = answers.length ? `
<h2 class="section-break" dir="rtl"><span class="hx">مفتاح الإجابات</span></h2>
<table class="answers" dir="rtl">
  <thead><tr><th>س</th><th>الجواب</th><th>التعليل</th></tr></thead>
  <tbody>${answers.map((a) => `<tr><td class="n">${a.n}</td><td class="a">${esc(a.a)}</td><td dir="${dirOf(a.why)}">${inlineHtml(a.why)}</td></tr>`).join('')}</tbody>
</table>` : '';

  const terms = doc.terms || [];
  const gloss = terms.length ? `
<h2 class="section-break" dir="rtl"><span class="hx">قاموس المصطلحات</span></h2>
<table class="gloss" dir="rtl">
  <thead><tr><th class="en">المصطلح</th><th class="ar">بالعربية</th><th>التعريف</th></tr></thead>
  <tbody>${terms.map((t) => `<tr><td class="en"><span class="t">${esc(t.en)}</span></td><td class="ar">${esc(t.ar)}</td><td>${esc(t.def)}</td></tr>`).join('')}</tbody>
</table>` : '';

  const src = sources.length ? `
<h2 dir="rtl"><span class="hx">مصادر الصور</span></h2>
<ul class="sources" dir="rtl">${sources.map((s) => `<li><b>${esc(s.label)}:</b> <span dir="ltr" class="ltr">${esc(s.title || '')}</span> — <span dir="ltr" class="ltr">${esc(creditLine(s))}</span>${/^https:\/\//.test(s.page || '') ? `<a dir="ltr" href="${esc(s.page)}">${esc(s.page)}</a>` : ''}</li>`).join('')}</ul>` : '';

  const metaItems = [
    ['المادة', meta.subject], ['التدريسي', meta.lecturer], ['التاريخ', fmtDate(meta.date)],
    ['مدة التسجيل', doc.duration ? fmtDuration(doc.duration) : ''], ['عدد الكلمات', doc.stats?.words ? doc.stats.words.toLocaleString('en-US') : ''],
    ['المصطلحات', terms.length ? String(terms.length) : ''],
  ].filter(([, v]) => v);

  const wave = zigzag(1680, 72, [14, 26, 44, 60, 30, 48, 20, 38, 56, 24, 12, 34, 52, 28, 16, 42, 22, 58, 18, 36, 46, 14, 30]);
  const header = cssStr(plainTitle).slice(0, 70);
  const brand = opts.brand || {};
  const logoUrl = brand.logo || '/logo.png';
  const paged = opts.paged ? `<script>(${pagedRuntime.toString()})(${scriptJson({
    dir, firstPage: 2, fonts: PAGED_FONTS, pagedCss: PAGED_CSS,
    pageHtml: `<header class="pg-head"><span class="pg-title" dir="${dirOf(title)}">${esc(plainTitle)}</span><span class="pg-brand" dir="rtl">${markHtml({ color: '#5a1fd1', bars: false, urls: brand })}ميدي فويز</span></header><div class="pg-body"></div><footer class="pg-foot"><b class="pg-num"></b><i class="pg-total"></i></footer>`,
  })});</script>` : '';

  return `<!doctype html>
<html lang="ar" dir="${dir}">
<head>
<meta charset="utf-8">
<title>${esc(plainTitle)} — ميدي فويز</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=El+Messiri:wght@600;700&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}
@page {
  @top-${dir === 'rtl' ? 'right' : 'left'} { content: "${header}"; font: 500 8.2pt 'IBM Plex Sans Arabic', sans-serif; color: #7c6ca3; vertical-align: bottom; padding-bottom: 5mm; }
  @top-${dir === 'rtl' ? 'left' : 'right'} { content: "ميدي فويز · MediVoice"; font: 600 8.2pt 'IBM Plex Sans Arabic', sans-serif; color: #5a1fd1; vertical-align: bottom; padding-bottom: 5mm; }
  @bottom-center { content: counter(page); font: 600 9pt 'IBM Plex Sans', sans-serif; color: #5a1fd1; vertical-align: top; padding-top: 6mm; }
}
@page :first { @top-left { content: none; } @top-right { content: none; } @bottom-center { content: none; } }
${opts.screen ? '@media screen { body { background: #2a1a4d; } .cover, main { margin: 12px auto; box-shadow: 0 10px 40px rgba(0,0,0,.4); } main { width: 210mm; background: #fff; padding: 23mm 17mm; } }' : ''}
</style>
</head>
<body>
<section class="cover" dir="rtl">
  <div class="grid"></div>
  ${markHtml({ color: 'rgba(255,255,255,.08)', cls: 'ghost', urls: brand })}
  <div class="brand"><span class="tile"><img src="${esc(logoUrl)}" alt=""></span><div><b>ميدي فويز</b><span dir="ltr">MediVoice</span></div></div>
  <div class="kind">${notes ? `<span dir="ltr">${esc(MODE_LABEL[meta.mode] || 'Notes')}</span>` : 'ملزمة محاضرة'}</div>
  ${doc.stats?.audit ? '<div class="audit"><i></i>روجعت كاملة مقابل التسجيل قبل التسليم</div>' : ''}
  <div class="head" dir="${dirOf(title)}">
    ${meta.subject ? `<div class="subject">${esc(meta.subject)}</div>` : ''}
    <h1 style="font-size:${titleSize}pt">${inlineHtml(title)}</h1>
  </div>
  <svg class="wave" viewBox="0 0 1680 152" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <path d="${wave}" fill="none" stroke="rgba(255,255,255,.2)" stroke-width="17" stroke-linejoin="miter" transform="translate(0 11)"/>
    <path d="${wave}" fill="none" stroke="#fff" stroke-width="6.5" stroke-linejoin="miter"/>
  </svg>
  <div class="meta">${metaItems.map(([k, v]) => `<div><small>${esc(k)}</small><b>${esc(v)}</b></div>`).join('')}</div>
  <div class="foot">${notes ? 'شرح مكتوب آلياً من تسجيل المحاضرة. راجعه مع المحاضرة الأصلية قبل الاعتماد عليه.' : 'نص مفرّغ آلياً من تسجيل صوتي. راجعه مع المحاضرة الأصلية قبل الاعتماد عليه.'}</div>
</section>
<main id="flow">
${parts.join('\n')}
${answerKey}
${gloss}
${src}
<div class="endnote" dir="rtl">أُعدّت هذه الملزمة بواسطة ميدي فويز من تسجيل صوتي للمحاضرة. ${notes ? 'كتابة الشرح' : 'التفريغ'} والقاموس واختيار الصور تمت آلياً وقد تحتوي أخطاء؛ المرجع النهائي هو المحاضر والمصادر المعتمدة.</div>
</main>
${paged}
</body>
</html>`;
}
