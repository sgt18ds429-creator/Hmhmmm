// text.js — أدوات النص: التطبيع، ترميز التنسيق الخفيف، تنظيف ناتج Whisper، ولصق المقاطع.

const DIACRITICS = /[ً-ٰٟۖ-ۭـ]/g;

/** تطبيع للمقارنة فقط (لا يُستخدم للعرض). */
export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/گ/g, 'ك')
    .replace(/چ/g, 'ج')
    .replace(/پ/g, 'ب')
    .replace(/ڤ/g, 'ف');
}

export const stripMarkup = (s) => String(s || '').replace(/\[\[|\]\]/g, '').replace(/^\s*(#{1,4}|[-*•>])\s+/gm, '');

/** كلمات مطبّعة (حروف وأرقام فقط). */
export function tokens(s) {
  return normalize(stripMarkup(s)).match(/[\p{L}\p{N}]+/gu) || [];
}
export const countWords = (s) => tokens(s).length;

export const uid = () => Math.random().toString(36).slice(2, 10);

// ───────────── ترميز التنسيق ─────────────
//  ## عنوان      ### عنوان فرعي
//  - عنصر قائمة   1. عنصر مرقّم
//  > ملاحظة مهمة
//  | عمود | عمود |   (جدول: أول صف للعناوين)
//  @fig: النوع | بحث | بحث أعم | ما تُظهره الصورة | تعليق   (طلب صورة توضيحية في هذا الموضع)
//  @slide: رقم الصفحة | تعليق   (صورة من سلايدات المحاضرة المرفوعة)
//  ?? سؤال اختيار من متعدد    ثم خياراته a) b) c) d)    ثم  = حرف الجواب | التعليل
//  [[medical term]]

// أنواع الملزمة المشروحة (ما عدا 'transcript': نص مفرّغ فقط)
export const NOTE_MODES = ['highyield', 'notes', 'integrated'];
export const isNotes = (mode) => NOTE_MODES.includes(mode);
export const MODE_LABEL = { highyield: 'High-Yield', notes: 'Comprehensive', integrated: 'Integrated', transcript: 'نص مفرّغ' };

const FIG_KINDS = ['radiograph', 'diagram', 'photo', 'micrograph'];
const MCQ_LETTERS = 'abcd';

/** سطر طلب صورة: «النوع | بحث | بحث أعم | ما يجب أن تُظهره | تعليق». يرجع null إذا كان ناقصاً. */
function parseFigLine(rest) {
  const parts = String(rest || '').split('|').map((s) => s.replace(/[`*]+/g, '').trim());
  if (!FIG_KINDS.includes(parts[0]?.toLowerCase())) parts.unshift('diagram');
  const [kind, query = '', alt = '', show = '', caption = ''] = parts;
  if (!/[A-Za-z]{3}/.test(query)) return null;
  return {
    t: 'figreq', kind: kind.toLowerCase(), query: query.slice(0, 90),
    alt: /[A-Za-z]{3}/.test(alt) ? alt.slice(0, 90) : '', show: show.slice(0, 300), caption: fixInline(caption).slice(0, 240),
  };
}

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isRuleRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s+/g, '')));

/** يوحّد عدد أعمدة الجدول، ويحوّل جدولاً بلا صفوف إلى فقرة. */
function closeTable(b) {
  const cols = b.head.length;
  b.rows = b.rows.map((r) => (r.length > cols ? [...r.slice(0, cols - 1), r.slice(cols - 1).join(' ')] : [...r, ...Array(cols - r.length).fill('')]));
  if (!b.rows.length) return { t: 'p', text: b.head.filter(Boolean).join(' — ') };
  return b;
}

const fixInline = (s) => s
  .replace(/\*\*(.+?)\*\*/g, '$1')
  .replace(/`+/g, '')
  .replace(/\[\[\s*/g, '[[').replace(/\s*\]\]/g, ']]')
  .replace(/\[\[([^\[\]]*)\[\[/g, '[[$1')        // أقواس متداخلة بالخطأ
  .replace(/\]\]\]+/g, ']]').replace(/\[+\[\[/g, '[[')
  .replace(/\s+/g, ' ')
  .trim();

export function parseMarkup(raw) {
  const text = String(raw || '').replace(/\r/g, '').replace(/^```[a-z]*\n?|```$/gim, '');
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) { blocks.push({ t: 'p', text: fixInline(para.join(' ')) }); para = []; }
  };
  const openMcq = () => { const last = blocks[blocks.length - 1]; return last?.t === 'mcq' && last._open ? last : null; };
  for (const lineRaw of text.split('\n')) {
    const line = lineRaw.trim();
    if (!line || /^[-=_*]{3,}$/.test(line)) {
      flush();
      for (const b of blocks) if (b.t === 'note' || b.t === 'table' || b.t === 'mcq') delete b._open; // سطر فارغ ينهي الملاحظة والجدول والسؤال
      continue;
    }
    let m;
    const mcq = openMcq();
    if ((m = line.replace(/^[`*_\s]+/, '').match(/^(?:[-•]\s*)?@fig\b[`*_]*\s*:?\s*(.*)$/i))) {
      flush();
      const fig = parseFigLine(m[1]);
      if (fig) blocks.push(fig);
    } else if ((m = line.replace(/^[`*_\s]+/, '').match(/^(?:[-•]\s*)?@slide\b[`*_]*\s*:?\s*(\d{1,3})\s*(?:\|\s*(.*))?$/i))) {
      flush();
      blocks.push({ t: 'slidereq', page: parseInt(m[1], 10), caption: fixInline(m[2] || '').slice(0, 240) });
    } else if ((m = line.match(/^\?\?\s*(.+)$/))) {
      flush();
      blocks.push({ t: 'mcq', q: fixInline(m[1]), opts: [], ans: -1, why: '', _open: true });
      continue;
    } else if (mcq && (m = line.match(/^(?:[-*•]\s*)?\(?([a-dA-D])[).]\s*(.+)$/))) {
      const i = MCQ_LETTERS.indexOf(m[1].toLowerCase());
      if (i === mcq.opts.length) mcq.opts.push(fixInline(m[2]));
      continue;
    } else if (mcq && (m = line.match(/^=\s*\(?([a-dA-D])\)?\s*(?:\|\s*(.*))?$/))) {
      mcq.ans = MCQ_LETTERS.indexOf(m[1].toLowerCase());
      mcq.why = fixInline(m[2] || '');
      delete mcq._open;
      continue;
    } else if (/^\|.+\|/.test(line)) {
      flush();
      const cells = splitRow(line);
      const last = blocks[blocks.length - 1];
      if (isRuleRow(cells)) continue; // سطر الفاصل تحت العناوين
      if (last?.t === 'table' && last._open) last.rows.push(cells.map(fixInline));
      else blocks.push({ t: 'table', head: cells.map(fixInline), rows: [], _open: true });
      continue;
    } else if ((m = line.match(/^(#{1,4})\s+(.+)$/))) {
      flush();
      const title = fixInline(m[2]).replace(/[:：.]+$/, '');
      if (title) blocks.push({ t: 'h', level: m[1].length >= 3 ? 3 : 2, text: title });
    } else if ((m = line.match(/^>\s*(.+)$/))) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.t === 'note' && last._open) last.text += ' ' + fixInline(m[1]);
      else blocks.push({ t: 'note', text: fixInline(m[1]), _open: true });
      continue;
    } else if ((m = line.match(/^(?:[-*•]|\d{1,2}[.)]|[٠-٩]{1,2}[.)])\s+(.+)$/))) {
      flush();
      const ordered = /^[\d٠-٩]/.test(line);
      const last = blocks[blocks.length - 1];
      const kind = ordered ? 'ol' : 'ul';
      if (last?.t === kind && last._open) last.items.push(fixInline(m[1]));
      else blocks.push({ t: kind, items: [fixInline(m[1])], _open: true });
      continue;
    } else {
      para.push(line);
    }
    for (const b of blocks) delete b._open;
  }
  flush();
  for (const b of blocks) delete b._open;
  return blocks
    .map((b) => (b.t === 'table' ? closeTable(b) : b))
    .filter((b) => (b.items ? b.items.length : b.rows ? b.rows.length : b.t === 'mcq' ? b.opts.length >= 2 : b.t === 'figreq' || b.t === 'slidereq' || b.text));
}

export function blocksToMarkup(blocks) {
  const out = [];
  const row = (cells) => `| ${cells.map((c) => String(c).replace(/\|/g, '/')).join(' | ')} |`;
  for (const b of blocks) {
    if (b.t === 'h') out.push(`${b.level === 3 ? '###' : '##'} ${b.text}`);
    else if (b.t === 'p') out.push(b.text);
    else if (b.t === 'note') out.push(`> ${b.text}`);
    else if (b.t === 'ul') out.push(b.items.map((i) => `- ${i}`).join('\n'));
    else if (b.t === 'ol') out.push(b.items.map((i, n) => `${n + 1}. ${i}`).join('\n'));
    else if (b.t === 'table') out.push([row(b.head), row(b.head.map(() => '---')), ...b.rows.map(row)].join('\n'));
    else if (b.t === 'figreq') out.push(`@fig: ${b.kind} | ${b.query} | ${b.alt || ''} | ${b.show || ''} | ${b.caption || ''}`);
    else if (b.t === 'slidereq') out.push(`@slide: ${b.page} | ${b.caption || ''}`);
    else if (b.t === 'mcq') out.push([`?? ${b.q}`, ...b.opts.map((o, i) => `${MCQ_LETTERS[i]}) ${o}`), b.ans >= 0 ? `= ${MCQ_LETTERS[b.ans]}${b.why ? ` | ${b.why}` : ''}` : ''].filter(Boolean).join('\n'));
  }
  return out.join('\n\n');
}

/** يقسم نصاً إلى مقاطع عادية ومصطلحات: [{ term:boolean, text }] */
export function splitInline(text) {
  const out = [];
  const re = /\[\[([^\[\]]+)\]\]/g;
  let last = 0, m;
  const s = String(text || '');
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ term: false, text: s.slice(last, m.index) });
    out.push({ term: true, text: m[1].trim() });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ term: false, text: s.slice(last).replace(/\[\[|\]\]/g, '') });
  return out;
}

export const blockText = (b) => (b.items ? b.items.join(' ') : b.rows ? [...b.head, ...b.rows.flat()].join(' ') : b.t === 'mcq' ? [b.q, ...b.opts, b.why].join(' ') : b.t === 'figreq' || b.t === 'slidereq' ? '' : b.text || '');

/** لغة النص الغالبة ('ar' أو 'en'). المصطلحات بين [[ ]] لا تُحسب. */
export function langOf(text) {
  const s = String(text || '').replace(/\[\[[^\]]*\]\]/g, '');
  const ar = (s.match(/[؀-ۿ]/g) || []).length, la = (s.match(/[A-Za-z]/g) || []).length;
  return ar + la && ar / (ar + la) < 0.3 ? 'en' : 'ar';
}

/** مفتاح مقارنة لمصطلح: أحرف صغيرة بلا رموز ولا جمع بسيط. */
export const termKey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/(?<=[a-z]{3})(es|s)$/, '');

/** المصطلحات الواردة بين [[ ]] في نص (مفاتيح فريدة مع أول صيغة ظهرت). */
export function termsIn(text) {
  const out = new Map();
  for (const m of String(text || '').matchAll(/\[\[([^\[\]]{2,60})\]\]/g)) {
    const k = termKey(m[1]);
    if (k.length > 1 && !out.has(k)) out.set(k, m[1].trim());
  }
  return out;
}

/** بصمة قصيرة لنص (لمعرفة إن تغيّر بين محاولة وأخرى). */
export function textHash(str) {
  let a = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { a ^= s.charCodeAt(i); a = Math.imul(a, 16777619); }
  return (a >>> 0).toString(36) + s.length.toString(36);
}

/** كل المصطلحات مع عدد مرات ورودها، مرتبة بالأكثر تكراراً. */
export function collectTerms(blocks) {
  const map = new Map();
  for (const b of blocks) {
    if (b.t === 'fig') continue;
    for (const part of splitInline(blockText(b))) {
      if (!part.term) continue;
      const clean = part.text.replace(/\s+/g, ' ').trim();
      if (clean.length < 2 || clean.length > 60 || !/[A-Za-z]/.test(clean)) continue;
      const key = clean.toLowerCase().replace(/s$/, '');
      const cur = map.get(key);
      if (cur) cur.count++;
      else map.set(key, { term: clean, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

// ───────────── تنظيف ناتج Whisper ─────────────

const HALLUCINATIONS = [
  'اشتركوا في القناه', 'اشترك في القناه', 'لا تنسوا الاشتراك', 'شكرا للمشاهده', 'شكرا علي المشاهده', 'شكرا لكم علي المشاهده',
  'ترجمه نانسي قنقر', 'نانسي قنقر', 'ترجمه', 'تابعونا', 'المترجم', 'موسيقي',
  'thanks for watching', 'thank you for watching', 'subscribe to the channel', 'subtitles by', 'amara org', 'music',
].map((p) => tokens(p).join(' '));

/**
 * يحوّل استجابة Whisper (verbose_json) إلى كلمات نظيفة بتوقيت محلي.
 * يعتمد قائمة words لأنها أكمل من حقل text، ويحذف: الهلوسات المعروفة،
 * ترديد نص الـ prompt، والكلمات المتلاصقة زمنياً بشكل غير طبيعي.
 * @returns {{w:string,s:number,e:number}[]}
 */
export function cleanWhisper(data, prompt = '') {
  let words = (data.words || []).map((x) => ({ w: String(x.word || '').trim(), s: +x.start, e: +x.end })).filter((x) => x.w);
  if (!words.length && data.segments?.length) {
    // احتياط: لا توجد توقيتات كلمات
    for (const seg of data.segments) {
      const parts = String(seg.text || '').trim().split(/\s+/).filter(Boolean);
      const step = (seg.end - seg.start) / Math.max(parts.length, 1);
      parts.forEach((w, i) => words.push({ w, s: seg.start + i * step, e: seg.start + (i + 1) * step }));
    }
  }
  if (!words.length) return [];
  const drop = new Uint8Array(words.length);

  // 1) مقاطع صامتة أو هلوسات معروفة
  for (const seg of data.segments || []) {
    const t = tokens(seg.text).join(' ');
    const silent = seg.no_speech_prob > 0.8 && seg.avg_logprob < -0.7;
    const known = t && HALLUCINATIONS.includes(t);
    const repetitive = seg.compression_ratio > 2.8;
    if (silent || known || repetitive) {
      words.forEach((x, i) => { if (x.s >= seg.start - 0.01 && x.s < seg.end) drop[i] = 1; });
    }
  }
  // 2) كلمات متراصّة: 4 كلمات أو أكثر في أقل من خُمس ثانية (علامة هلوسة)
  for (let i = 0; i + 3 < words.length; i++) {
    if (words[i + 3].e - words[i].s < 0.2) for (let k = i; k <= i + 3; k++) drop[k] = 1;
  }
  // 3) ترديد الـ prompt: 5 كلمات متتالية أو أكثر مطابقة له
  const pt = tokens(prompt);
  if (pt.length >= 5) {
    const grams = new Set();
    for (let i = 0; i + 5 <= pt.length; i++) grams.add(pt.slice(i, i + 5).join(' '));
    const flat = [], owner = [];
    words.forEach((x, i) => { for (const t of tokens(x.w)) { flat.push(t); owner.push(i); } });
    for (let i = 0; i + 5 <= flat.length; i++) {
      if (grams.has(flat.slice(i, i + 5).join(' '))) for (let k = i; k < i + 5; k++) drop[owner[k]] = 1;
    }
  }
  // 4) هلوسة معروفة في نهاية الكلام حتى لو لم تُعزل في مقطع
  words = words.filter((_, i) => !drop[i]);
  const tailText = tokens(words.slice(-6).map((x) => x.w).join(' ')).join(' ');
  for (const h of HALLUCINATIONS) {
    if (h.split(' ').length >= 2 && tailText.endsWith(h)) { words = words.slice(0, words.length - h.split(' ').length); break; }
  }
  return words;
}

/**
 * يختار نقطة قطع عند أطول سكتة قرب الحد الاسمي (حتى لا تُقطع كلمة بالنص).
 * @param words كلمات بتوقيت عام (ثوانٍ من بداية الملف)
 */
export function pickCut(words, boundary, overlap) {
  const zone = Math.max(overlap - 0.4, 0.2);
  let best = boundary, bestScore = -1;
  for (let i = 0; i + 1 < words.length; i++) {
    const gap = words[i + 1].s - words[i].e;
    const mid = (words[i].e + words[i + 1].s) / 2;
    if (mid < boundary - zone || mid > boundary + zone) continue;
    // نفضّل نهاية جملة، ثم أطول سكتة
    const score = Math.max(gap, 0) + (/[.؟?!]$/.test(words[i].w) ? 0.8 : /[،,:؛]$/.test(words[i].w) ? 0.25 : 0);
    if (score > bestScore) { bestScore = score; best = mid; }
  }
  return best;
}

export const wordsBetween = (words, from, to) => words.filter((x) => { const m = (x.s + x.e) / 2; return m >= from && m < to; });
export const wordsToText = (words) => words.map((x) => x.w).join(' ').replace(/\s+([،,.؟?!:؛])/g, '$1');

/** يقسم نصاً طويلاً إلى أجزاء لا تتجاوز maxWords، ويقطع عند نهايات الجمل ما أمكن. */
export function splitByWords(text, maxWords) {
  const sentences = String(text).split(/(?<=[.؟?!…])\s+|\n+/).filter((s) => s.trim());
  const parts = [];
  let cur = [], n = 0;
  const push = () => { if (cur.length) { parts.push(cur.join(' ')); cur = []; n = 0; } };
  for (const s of sentences) {
    const w = s.split(/\s+/);
    if (w.length > maxWords) {
      push();
      for (let i = 0; i < w.length; i += maxWords) parts.push(w.slice(i, i + maxWords).join(' '));
      continue;
    }
    if (n + w.length > maxWords) push();
    cur.push(s); n += w.length;
  }
  push();
  return parts;
}

// ───────────── لصق المقاطع ─────────────

function firstTextBlock(blocks) { return blocks.find((b) => b.t !== 'h' && b.t !== 'fig'); }
function lastTextBlock(blocks) { for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].t !== 'h' && blocks[i].t !== 'fig') return blocks[i]; return null; }

function dropLeadingWords(block, n) {
  const strip = (text) => {
    // نحذف أول n كلمة مع الحفاظ على باقي النص كما هو
    let count = 0, i = 0;
    const re = /[\p{L}\p{N}]+/gu;
    let m;
    while (count < n && (m = re.exec(text))) { count++; i = re.lastIndex; }
    return text.slice(i).replace(/^[\s\]\[،,.؟?!:؛-]+/, (lead) => (lead.includes('[[') ? '[[' : ''));
  };
  if (block.items) block.items[0] = strip(block.items[0]);
  else block.text = strip(block.text);
}

/**
 * يلصق مقاطع متتالية ويحذف الكلمات المكررة عند الحدود (تداخل الصوت بين مقطعين).
 * @param {Array<Array>} chunks مصفوفة من مصفوفات blocks
 */
export function joinChunks(chunks) {
  const out = [];
  for (const blocks of chunks) {
    if (!blocks?.length) continue;
    const next = blocks.map((b) => ({ ...b, items: b.items ? [...b.items] : undefined }));
    const prev = lastTextBlock(out);
    const head = firstTextBlock(next);
    if (prev && head) {
      const a = tokens(blockText(prev)).slice(-14);
      const b = tokens(blockText(head)).slice(0, 14);
      let k = Math.min(a.length, b.length, 12);
      for (; k >= 2; k--) {
        if (a.slice(-k).join(' ') === b.slice(0, k).join(' ')) break;
      }
      if (k >= 2) dropLeadingWords(head, k);
    }
    // جملة انقطعت عند حد المقطع: نكملها في نفس الفقرة بدل فقرة جديدة
    if (prev && head && head === next[0] && head.t === 'p') {
      const prevText = prev.items ? prev.items[prev.items.length - 1] : prev.text;
      if (prevText && !/[.؟?!…:]\s*(\]\])?\s*$/.test(prevText) && prev.t !== 'note') {
        if (prev.items) prev.items[prev.items.length - 1] = `${prevText} ${head.text}`.trim();
        else prev.text = `${prevText} ${head.text}`.trim();
        next.shift();
      }
    }
    // عنوان مكرر في بداية المقطع التالي
    const lastHeading = [...out].reverse().find((b) => b.t === 'h');
    if (lastHeading && next[0]?.t === 'h' && normalize(next[0].text) === normalize(lastHeading.text)) next.shift();
    for (const b of next) {
      if (b.items) { b.items = b.items.filter((x) => x.trim()); if (!b.items.length) continue; }
      else if (!b.text?.trim()) continue;
      out.push({ id: uid(), ...b });
    }
  }
  return out;
}

export const fmtTime = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
};

/** استخراج JSON من رد نموذج حتى لو أحاطه بنص أو أسوار كود. */
export function parseJsonLoose(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}
