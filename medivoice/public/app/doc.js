// doc.js — عرض الملزمة وتعديلها: نص، جداول، مصطلحات، صور، قاموس، النص المفرّغ الأصلي، وتصدير PDF.

import { h, icon, clear, sheet, confirm, fmtSize, countOf } from './ui.js';
import { splitInline, inlineRuns, blockText, stripMarkup, countWords, uid, fmtTime, isNotes, MODE_LABEL, qualityGate } from './text.js';
import { NOTE_TYPES } from './run.js';
import { buildPdfHtml, buildPdfParts, fmtDate, fmtDuration, dirOf } from './pdf.js';
import { pagedRuntime } from './paged.js';
import { brandAssets } from '../brand.js';
import { findCandidates, creditLine } from './images.js';
import * as db from './db.js';

/** مصغّرات نافذة تبديل الصورة: في الذاكرة فقط، فلا تُحفظ داخل الملزمة فتثقلها */
const thumbs = new WeakMap();
const thumbOf = (c) => thumbs.get(c) || c.tiny || '';

function fill(el, text) {
  clear(el);
  // في النص العربي تُعزل المقاطع الإنجليزية حتى لا تنقلب أقواسها عند التفاف السطر،
  // والمربوطة منها (AP/PA، [[CT]]/[[MRI]]) تبقى معاً باتجاه إنجليزي
  const rtl = dirOf(text) === 'rtl';
  const piece = (r) => (r.term ? h('span', { class: 't' }, r.text) : r.latin ? h('span', { class: r.text.length <= 36 ? 'lt nw' : 'lt' }, r.text) : r.text);
  for (const r of inlineRuns(text, rtl)) {
    if (r.group) el.append(h('span', { class: r.text.length <= 36 ? 'lt nw' : 'lt' }, r.group.map((x) => (x.term ? h('span', { class: 't' }, x.text) : x.text))));
    else el.append(piece(r));
  }
  return el;
}

function editable(el) {
  el.contentEditable = 'plaintext-only';
  if (el.contentEditable !== 'plaintext-only') {
    el.contentEditable = 'true';
    el.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain')); });
  }
  el.spellcheck = false;
  return el;
}

export async function viewDoc(ctx, el, { id, fresh, mem = null }) {
  // mem: ملزمة جديدة تعذّر حفظها على الجهاز (مساحة ممتلئة): تُعرض من الذاكرة حتى تُنزَّل ولا تضيع
  let readFailed = false;
  const doc = mem || await db.getLecture(id).catch(() => { readFailed = true; return null; });
  if (!doc) {
    if (readFailed) {
      el.append(h('div', { class: 'result' }, icon('warn', 'icon big'), h('h2', { class: 'h-section' }, 'تعذّر فتح الملزمة الآن'), h('p', { class: 'muted' }, 'التخزين على الجهاز ما استجاب. حدّث الصفحة وحاول مرة ثانية.'),
        h('div', { class: 'row', style: { justifyContent: 'center' } }, h('button', { class: 'btn', onclick: () => location.reload() }, 'تحديث'))));
      return;
    }
    ctx.toast('ما لقيت هذي المحاضرة على الجهاز.', 'err'); ctx.go('home'); return;
  }
  // ملازم قديمة (قبل بوابة الجودة) قد تحمل تكراراً من خلل التفريغ: تُنظّف مرة واحدة عند فتحها وتُحفظ
  if (!doc.stats?.gate) {
    try {
      doc.stats = doc.stats || {};
      const g = qualityGate(doc);
      doc.stats.gate = { ...g, onOpen: true };
      if (g.repeats || g.duplicates || g.cycles || g.empty) {
        await db.saveLecture(doc).catch(() => {});
        if (g.duplicates + g.cycles >= 3) setTimeout(() => ctx.toast('نظّفت الملزمة من التكرار الناتج عن خلل التفريغ.', 'ok'), 400);
      }
    } catch { /* تبقى كما هي */ }
  }
  ctx.ribbon.set({ alpha: 0, energy: 0.2 });

  let saveTimer = null;
  let unsaved = !!mem;
  let unsavedNote = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      doc.stats.words = doc.blocks.reduce((n, b) => n + (b.t === 'fig' ? 0 : countWords(blockText(b))), 0);
      db.saveLecture(doc).then(() => {
        if (unsaved) { unsaved = false; unsavedNote?.remove(); ctx.toast('انحفظت الملزمة على الجهاز.', 'ok'); }
      }).catch(() => ctx.toast('تعذّر الحفظ: مساحة الجهاز ممتلئة؟', 'err'));
    }, 500);
  };
  /** يحفظ فقط إذا تغيّر النص فعلاً (لمسة على فقرة للقراءة لا تعيد حفظ الملزمة كلها) */
  const saveIf = (changed) => { if (changed) save(); };

  const pdfBtn = h('button', { class: 'btn small', onclick: () => exportPdf() }, icon('download'), 'PDF');
  ctx.setBar('sub', { title: doc.meta.title || 'محاضرة', actions: [h('div', { class: 'docbar-actions' }, pdfBtn, h('button', { class: 'icon-btn', 'aria-label': 'خيارات', onclick: openMenu }, icon('dots')))] });

  const paper = h('article', { class: 'paper' });
  const list = h('div');
  const gloss = h('section', { class: 'gloss-list' });
  const hint = h('p', { class: 'edit-hint' }, 'اضغط على أي فقرة لتعديلها. المصطلحات تُكتب بين قوسين مزدوجين: [[term]]');

  // ── رأس المستند ──
  const titleEl = editable(h('h1', { class: 'doc-title', dir: 'auto' }, stripMarkup(doc.meta.title || '')));
  titleEl.addEventListener('blur', () => {
    const t = titleEl.textContent.replace(/\s+/g, ' ').trim();
    if (view === 'alt') { const changed = doc.alt.title !== t; doc.alt.title = t; titleEl.textContent = t; saveIf(changed); return; }
    const before = doc.meta.title;
    doc.meta.title = t || 'محاضرة';
    titleEl.textContent = doc.meta.title;
    ctx.root.querySelector('.bar .title').textContent = doc.meta.title;
    saveIf(before !== doc.meta.title);
  });
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } });
  const metaLine = h('div', { class: 'doc-meta' });
  const paintMeta = () => {
    clear(metaLine);
    for (const v of [doc.meta.lecturer, fmtDate(doc.meta.date), doc.duration ? fmtDuration(doc.duration) : '', `${(doc.stats.words || 0).toLocaleString('en-US')} كلمة`, doc.stats.sections ? countOf(doc.stats.sections, ['قسم واحد', 'قسمان', 'أقسام', 'قسماً']) : '', doc.terms?.length ? `${doc.terms.length} مصطلح` : '']) if (v) metaLine.append(h('span', null, v));
  };
  paintMeta();
  if (doc.meta.subject) paper.append(h('div', { class: 'doc-kicker' }, doc.meta.subject));
  paper.append(titleEl, metaLine);
  if (mem) {
    unsavedNote = h('div', { class: 'blk note' }, h('span', { class: 'tag' }, 'غير محفوظة'),
      'ما كدرت أحفظ هذي الملزمة على الجهاز (غالباً المساحة ممتلئة). نزّلها PDF هسه حتى لا تضيع، أو فرّغ مساحة ثم اضغط حفظ.',
      h('div', null, h('button', { class: 'mini', onclick: () => save() }, icon('check'), 'حفظ على الجهاز')));
    paper.append(unsavedNote);
  }

  if (doc.stats.review?.length) {
    paper.append(h('div', { class: 'blk note' }, h('span', { class: 'tag' }, 'للمراجعة'),
      `مقاطع قد ينقصها كلام بسبب ضعف الصوت: ${doc.stats.review.map((r) => `${fmtTime(r.start)} إلى ${fmtTime(r.end)}`).join('، ')}`));
  }
  const notes = isNotes(doc.meta.mode);
  // النسخة الثانية (الترجمة): عرض بلغة واحدة في كل مرة، والـ PDF يحوي اللغتين
  const hasAlt = !!doc.alt?.blocks?.length;
  let view = 'main';
  const langName = (l) => (l === 'en' ? 'English' : 'العربية');
  const mainLang = doc.lang || 'ar';
  if (notes) {
    const a = doc.stats.audit;
    paper.append(h('div', { class: 'doc-badges' },
      h('span', { class: 'badge mode ltr' }, MODE_LABEL[doc.meta.mode] || 'Notes'),
      a ? h('span', { class: 'badge ok', title: a.verdict || '' }, icon('check'), a.fixes || a.added ? `روجعت: ${[a.fixes ? countOf(a.fixes, ['تصحيح', 'تصحيحان', 'تصحيحات', 'تصحيحاً']) : '', a.added ? countOf(a.added, ['إضافة', 'إضافتان', 'إضافات', 'إضافة']) : ''].filter(Boolean).join('، ')}` : 'روجعت مقابل التسجيل') : null,
      doc.slides?.pages?.length ? h('span', { class: 'badge' }, icon('book'), `${doc.slides.pages.length} سلايد`) : null,
      hasAlt ? h('span', { class: 'badge' }, icon('text'), 'عربي + English') : null,
      doc.stats.gate && !doc.stats.gate.onOpen ? h('span', { class: 'badge ok', title: 'فحص آلي لكل الصفحات قبل التسليم: تكرار، فقرات مكررة، كتل فارغة' }, icon('check'), 'فُحصت كل الصفحات') : null));
    if (hasAlt) {
      const seg = h('div', { class: 'seg lang-seg', role: 'group' });
      const paintSeg = () => [...seg.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === view)));
      for (const [v, label] of [['main', langName(mainLang)], ['alt', langName(doc.alt.lang)]]) {
        seg.append(h('button', { type: 'button', dataset: { v }, onclick: () => { if (view === v) return; view = v; paintSeg(); renderAll(); titleEl.textContent = stripMarkup(view === 'alt' && doc.alt.title ? doc.alt.title : doc.meta.title || ''); } }, label));
      }
      paintSeg();
      paper.append(seg);
    }
  }
  if (notes && doc.stats.fallback) {
    paper.append(h('div', { class: 'blk note' }, h('span', { class: 'tag' }, 'للمراجعة'),
      `${countOf(doc.stats.fallback, ['جزء واحد', 'جزآن', 'أجزاء', 'جزءاً'])} من الملزمة ${doc.stats.fallback === 1 ? 'بقي' : 'بقيت'} نصاً مفرّغاً لأن كتابة شرحه ما اكتملت (غالباً خلصت حصة المحرك اليومية). تقدر تعيد كتابة الشرح بعدين من خيارات الملزمة.`));
  }
  if (!notes && doc.blocks.length) {
    paper.append(h('div', { class: 'blk note convert' }, h('span', { class: 'tag' }, 'جديد'),
      'هذي الملزمة نص مفرّغ كما قيل. تكدر تحوّلها لشرح مفصّل ومرتب بعناوين ونقاط وجداول وصور مطابقة، بدون ما تعيد رفع التسجيل.',
      h('div', null, h('button', { class: 'mini', onclick: () => rewrite() }, icon('book'), 'حوّلها لشرح مفصّل'))));
  }
  if (doc.stats.engines && !doc.stats.engines.gemini && (doc.stats.engines.groq || doc.stats.engines.raw)) {
    paper.append(h('div', { class: 'blk note' }, h('span', { class: 'tag' }, 'دقة أقل'), ctx.session?.keys?.gemini?.linked
      ? 'Gemini ما كدر يسمع هذا التسجيل هسه (خلصت حصته اليومية أو كان مشغول)، فالنص من المحرك السريع وحده ودقته أقل. أعد تحويله بعدين حتى يطلع أدق.'
      : 'هذي المحاضرة تحوّلت بدون Gemini، فراجع المصطلحات. اربطه من «حسابي» للمحاضرات الجاية.'));
  }

  // ── الفقرات ──
  function textNode(block, key, cls) {
    // عند التركيز يظهر النص الخام مع [[ ]]، وعند الخروج يُعاد رسمه
    const get = () => (key === null ? block.text : block.items[key]);
    const node = editable(h('span', { class: cls || 'txt', dir: dirOf(get()) }));
    fill(node, get());
    node.addEventListener('focus', () => { node.textContent = get(); });
    node.addEventListener('blur', () => {
      const raw = node.textContent.replace(/\u00a0/g, ' ').trim();
      if (raw === String(get() || '').trim()) { fill(node, get()); return; } // لم يتغيّر شيء: لا حفظ
      const lines = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) {
        if (key === null) removeBlock(block); else { block.items.splice(key, 1); if (!block.items.length) removeBlock(block); else rerender(block); }
        save(); return;
      }
      if (key === null) {
        block.text = lines[0];
        // أسطر إضافية تصير فقرات جديدة بعدها
        if (lines.length > 1 && block.t === 'p') {
          const arr = listOf(block);
          const at = arr.indexOf(block);
          arr.splice(at + 1, 0, ...lines.slice(1).map((t) => ({ id: uid(), t: 'p', text: t })));
          renderAll();
        } else { node.dir = dirOf(block.text); fill(node, block.text); }
      } else {
        block.items.splice(key, 1, ...lines);
        rerender(block);
      }
      save();
    });
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' && block.t !== 'p' && key === null) { e.preventDefault(); node.blur(); } });
    return node;
  }

  // خلية جدول قابلة للتعديل (r = -1 لصف العناوين)
  function cellNode(b, r, c) {
    const get = () => (r < 0 ? b.head[c] : b.rows[r][c]) || '';
    const node = editable(h('span', { class: 'txt', dir: dirOf(get()) }));
    fill(node, get());
    node.addEventListener('focus', () => { node.textContent = get(); });
    node.addEventListener('blur', () => {
      const v = node.textContent.replace(/\s+/g, ' ').trim();
      const changed = v !== get();
      if (r < 0) b.head[c] = v; else b.rows[r][c] = v;
      node.dir = dirOf(v);
      fill(node, v);
      saveIf(changed);
    });
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); node.blur(); } });
    return node;
  }

  /** الكتل المعروضة الآن: الأصل، أو الترجمة ومعها أسئلة الاختيار (بالإنجليزية) من الأصل */
  function currentBlocks() {
    if (view !== 'alt') return doc.blocks;
    const mcqAt = doc.blocks.findIndex((b) => b.t === 'mcq');
    const mcqPart = mcqAt > 0 && doc.blocks[mcqAt - 1].t === 'h' ? doc.blocks.slice(mcqAt - 1) : doc.blocks.filter((b) => b.t === 'mcq');
    return [...doc.alt.blocks, ...mcqPart];
  }
  const listOf = (b) => (doc.alt?.blocks?.includes(b) ? doc.alt.blocks : doc.blocks);
  /** صورة في الترجمة تشير إلى صورة الأصل (ref) */
  const figOf = (b) => (b.ref ? doc.blocks.find((x) => x.id === b.ref && x.t === 'fig') : b);

  function blockEl(b) {
    const grip = h('button', { class: 'grip', 'aria-label': 'خيارات الفقرة', onclick: () => blockMenu(b) }, icon('dots'));
    let node;
    if (b.t === 'h') node = h('div', { class: `blk ${b.level === 3 ? 'h3' : 'h2'}` }, grip, textNode(b, null));
    else if (b.t === 'p') node = h('div', { class: 'blk p' }, grip, textNode(b, null));
    else if (b.t === 'note') node = h('div', { class: 'blk note' }, grip, h('span', { class: 'tag' }, 'مهم'), textNode(b, null));
    else if (b.t === 'ul' || b.t === 'ol') node = h('div', { class: b.box ? 'blk box' : 'blk' }, grip, h(b.t, { dir: dirOf(b.items.join(' ')), style: b.t === 'ol' && b.start > 1 ? { counterReset: `n ${b.start - 1}` } : null }, b.items.map((_, i) => h('li', null, textNode(b, i)))));
    else if (b.t === 'table') {
      node = h('div', { class: 'blk tbl-wrap' }, grip, h('div', { class: 'tbl-scroll' }, h('table', { class: 'tbl', dir: dirOf(blockText(b)) },
        h('thead', null, h('tr', null, b.head.map((_, c) => h('th', null, cellNode(b, -1, c))))),
        h('tbody', null, b.rows.map((row, r) => h('tr', null, row.map((_, c) => h('td', null, cellNode(b, r, c)))))))));
    } else if (b.t === 'fig') node = figEl(b, grip);
    else if (b.t === 'h' && b.untranslated) node = h('div', { class: 'blk h2' }, grip, textNode(b, null));
    else if (b.t === 'mcq') node = mcqEl(b, grip);
    else node = h('div', { class: 'blk' }); // نوع غير معروف: لا يُعرض
    node.dataset.id = b.id;
    return node;
  }

  // سؤال اختيار من متعدد: اضغط خياراً يظهر الصحيح والتعليل
  function mcqEl(b, grip) {
    const letters = ['a', 'b', 'c', 'd'];
    const dir = dirOf(b.q);
    const en = dir === 'ltr';
    const why = h('p', { class: 'mcq-why', hidden: true, dir: dirOf(b.why || b.q) });
    const opts = b.opts.map((o, i) => h('button', { type: 'button', class: 'mcq-opt', onclick: () => reveal(i) }, h('b', null, letters[i]), fill(h('span', { dir: dirOf(o) }), o)));
    function reveal(i) {
      opts.forEach((el, k) => { el.classList.toggle('right', k === b.ans); el.classList.toggle('wrong', k === i && i !== b.ans); el.disabled = true; });
      const verdict = i === b.ans ? (en ? 'Correct. ' : 'صح. ') : (en ? `Correct answer: ${letters[b.ans]}. ` : `الجواب الصحيح: ${letters[b.ans]}. `);
      clear(why).append(h('b', null, verdict), ...splitInline(b.why || '').map((p) => (p.term ? h('span', { class: 't' }, p.text) : p.text)));
      why.hidden = false;
    }
    const n = doc.blocks.filter((x) => x.t === 'mcq').indexOf(b) + 1;
    return h('div', { class: 'blk mcq', dir }, grip, h('div', { class: 'mcq-q', dir }, h('span', { class: 'mcq-n' }, `${n}`), fill(h('span'), b.q)), h('div', { class: 'mcq-opts' }, opts), why);
  }

  function figEl(b, grip) {
    const src = figOf(b); // في الترجمة: الصورة نفسها من الأصل والتعليق مترجم
    if (!src) return h('div', { class: 'blk' });
    const cap = editable(h('div', { class: 'cap', dir: 'auto' }));
    fill(cap, b.caption || '');
    cap.addEventListener('focus', () => { cap.textContent = b.caption || ''; });
    cap.addEventListener('blur', () => { const v = cap.textContent.replace(/\s+/g, ' ').trim(); const changed = v !== (b.caption || ''); b.caption = v; fill(cap, b.caption); saveIf(changed); });
    cap.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cap.blur(); } });
    return h('figure', { class: 'blk fig' }, grip,
      src.img?.dataUrl ? h('img', { src: src.img.dataUrl, alt: b.caption || '', loading: 'lazy' }) : null,
      cap,
      src.pick ? h('div', { class: 'credit' }, creditLine(src.pick)) : null,
      h('div', { class: 'fig-actions' },
        b.ref ? null : h('button', { class: 'mini', onclick: () => pickImage(b) }, icon('swap'), 'تبديل الصورة'),
        h('button', { class: 'mini red', onclick: () => { removeBlock(b); save(); } }, icon('trash'), 'حذف')));
  }

  function rerender(b) {
    const old = list.querySelector(`[data-id="${b.id}"]`);
    if (old) old.replaceWith(blockEl(b));
  }
  function removeBlock(b) {
    const arr = listOf(b);
    const i = arr.indexOf(b);
    if (i >= 0) arr.splice(i, 1);
    if (b.t === 'fig' && !b.ref && doc.alt?.blocks) { // حذف صورة الأصل يحذف نظيرتها في الترجمة
      const k = doc.alt.blocks.findIndex((x) => x.ref === b.id);
      if (k >= 0) doc.alt.blocks.splice(k, 1);
    }
    list.querySelector(`[data-id="${b.id}"]`)?.remove();
  }
  function renderAll() {
    clear(list);
    list.dir = view === 'alt' ? (doc.alt.lang === 'en' ? 'ltr' : 'rtl') : (mainLang === 'en' ? 'ltr' : 'rtl');
    for (const b of currentBlocks()) { if (!b.id) b.id = uid(); list.append(blockEl(b)); }
  }
  renderAll();

  function blockMenu(b) {
    const opts = [];
    const act = (label, ic, fn, cls) => opts.push(h('button', { class: cls, onclick: () => { s.close(); fn(); } }, icon(ic), label));
    if (b.t === 'p') { act('تحويل إلى عنوان', 'heading', () => { b.t = 'h'; b.level = 2; b.text = stripMarkup(b.text); rerender(b); save(); }); act('تحويل إلى ملاحظة مهمة', 'warn', () => { b.t = 'note'; rerender(b); save(); }); }
    if (b.t === 'h' || b.t === 'note') act('تحويل إلى فقرة عادية', 'text', () => { b.t = 'p'; delete b.level; rerender(b); save(); });
    const arr = listOf(b);
    if (b.t !== 'fig') act('إضافة فقرة بعدها', 'plus', () => {
      const nb = { id: uid(), t: 'p', text: arr === doc.blocks && mainLang !== 'en' || arr !== doc.blocks && doc.alt?.lang !== 'en' ? 'نص جديد' : 'New text' };
      arr.splice(arr.indexOf(b) + 1, 0, nb);
      list.querySelector(`[data-id="${b.id}"]`).after(blockEl(nb));
      list.querySelector(`[data-id="${nb.id}"] .txt`)?.focus();
      save();
    });
    if (arr === doc.blocks) act('إضافة صورة بعدها', 'image', () => {
      const nb = { id: uid(), t: 'fig', caption: '', query: '', kind: 'diagram', pick: null, candidates: [], img: null };
      pickImage(nb, () => { doc.blocks.splice(doc.blocks.indexOf(b) + 1, 0, nb); list.querySelector(`[data-id="${b.id}"]`).after(blockEl(nb)); });
    });
    act('حذف', 'trash', () => { removeBlock(b); save(); }, 'red');
    const s = sheet({ title: 'خيارات', body: h('div', { class: 'menu' }, opts) });
  }

  // ── اختيار/تبديل صورة ──
  function pickImage(b, onFirstPick) {
    const grid = h('div', { class: 'pick-grid' });
    const state = h('p', { class: 'dim' });
    const q = h('input', { class: 'input', type: 'text', dir: 'ltr', placeholder: 'pneumothorax chest x-ray', value: b.query || '', 'aria-label': 'بحث عن صورة بالإنجليزية' });
    const go = h('button', { class: 'btn small', onclick: search }, icon('search'), 'بحث');
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    let inserted = !onFirstPick;

    function paint(cands) {
      clear(grid);
      for (const c of cands) {
        const btn = h('button', { class: 'pick', 'aria-pressed': String(b.pick?.id === c.id), onclick: () => choose(c, btn) },
          h('img', { src: thumbOf(c) || c.small, alt: c.title || '', loading: 'lazy', referrerPolicy: 'no-referrer' }),
          h('small', null, `${c.title || ''} · ${c.license || ''}`));
        grid.append(btn);
      }
      state.textContent = cands.length ? '' : 'ماكو نتائج. جرّب كلمات إنجليزية أبسط.';
    }
    async function choose(c, btn) {
      btn.classList.add('busy');
      try {
        const img = await ctx.io.loadImage(c, 'large');
        b.pick = c; b.img = { dataUrl: img.dataUrl, w: img.w, h: img.h };
        if (!b.caption) b.caption = c.title || '';
        b.query = q.value.trim() || b.query;
        if (!inserted) { onFirstPick(); inserted = true; } else rerender(b);
        save();
        s.close();
      } catch {
        btn.classList.remove('busy');
        ctx.toast('تعذّر تحميل هذي الصورة. اختر غيرها.', 'err');
      }
    }
    async function search() {
      const query = q.value.trim();
      if (query.length < 2) return;
      go.disabled = true;
      state.textContent = 'أبحث في Wikimedia Commons و NIH Open-i…';
      clear(grid);
      try {
        const kind = /x-?ray|radiograph|ct\b|mri|ultrasound|scan/i.test(query) ? 'radiograph' : /histolog|microscop|stain|micrograph/i.test(query) ? 'micrograph' : 'diagram';
        const cands = await findCandidates({ query, alt: '', kind }, ctx.io.net, 8);
        // مصغّرات محمّلة مسبقاً حتى تظهر حتى لو منع المصدر العرض المباشر
        await Promise.all(cands.map(async (c) => { try { thumbs.set(c, (await ctx.io.loadImage(c, 'small')).dataUrl); } catch { /* بلا مصغّرة */ } }));
        b.candidates = cands.filter((c) => thumbOf(c));
        paint(b.candidates);
      } catch {
        state.textContent = 'تعذّر البحث الآن. تأكد من الإنترنت.';
      }
      go.disabled = false;
    }
    const s = sheet({ title: 'اختيار صورة', wide: true, body: h('div', { class: 'stack' },
      h('div', { class: 'paste-row' }, q, go),
      h('p', { class: 'dim' }, 'الصور من مصادر مفتوحة ويُذكر مصدرها وترخيصها تحت الصورة.'), state, grid) });
    if (b.candidates?.length) {
      paint(b.candidates);
      // المصغّرات لا تُحفظ مع الملزمة (تثقلها): تُحمَّل عند فتح النافذة
      const missing = b.candidates.filter((c) => !thumbOf(c));
      if (missing.length) {
        state.textContent = 'أحمّل الصور البديلة…';
        Promise.all(missing.map(async (c) => { try { thumbs.set(c, (await ctx.io.loadImage(c, 'small')).dataUrl); } catch { /* بلا مصغّرة */ } }))
          .then(() => { if (s.panel.isConnected) paint(b.candidates.filter((c) => thumbOf(c))); });
      }
    } else if (b.query) search();
  }

  // ── القاموس ──
  function paintGloss() {
    clear(gloss);
    if (!doc.terms?.length) return;
    gloss.append(h('h2', null, 'قاموس المصطلحات'));
    for (const t of doc.terms) {
      gloss.append(h('div', { class: 'gloss-row' },
        h('div', null, h('span', { class: 't' }, t.en), '  ', h('b', null, t.ar)),
        h('button', { 'aria-label': `حذف ${t.en}`, onclick: () => { doc.terms.splice(doc.terms.indexOf(t), 1); paintGloss(); paintMeta(); save(); } }, icon('close')),
        h('p', null, t.def)));
    }
  }
  paintGloss();

  paper.append(list, hint, gloss);
  el.append(paper,
    h('div', { class: 'fab' }, h('button', { class: 'btn', onclick: () => exportPdf() }, icon('download'), 'تحميل الملزمة PDF')));
  if (fresh) ctx.toast('الملزمة جاهزة. راجعها ثم حمّلها PDF.', 'ok');

  // ── التصدير ──
  const fileName = () => `${stripMarkup(doc.meta.title || 'محاضرة').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || 'محاضرة'}.pdf`;

  // صور الملزمة تُرسل داخل المستند، فنصغّر الكبير منها حتى يبقى الطلب خفيفاً على الخادم
  async function pdfImages(budget = 2_300_000) {
    const figs = doc.blocks.filter((b) => b.t === 'fig' && b.img?.dataUrl);
    if (figs.reduce((n, b) => n + b.img.dataUrl.length, 0) <= budget) return {};
    const per = budget / figs.length;
    const out = {};
    for (const b of figs) {
      if (b.img.dataUrl.length <= per) continue;
      try {
        const im = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = b.img.dataUrl; });
        for (const [side, q] of [[1100, 0.8], [940, 0.76], [800, 0.72], [680, 0.68], [560, 0.62]]) {
          const k = Math.min(1, side / Math.max(im.naturalWidth, im.naturalHeight));
          const c = h('canvas', { width: Math.max(1, Math.round(im.naturalWidth * k)), height: Math.max(1, Math.round(im.naturalHeight * k)) });
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          g.imageSmoothingQuality = 'high';
          g.drawImage(im, 0, 0, c.width, c.height);
          out[b.id] = c.toDataURL('image/jpeg', q);
          if (out[b.id].length <= per) break;
        }
      } catch { /* تبقى الصورة الأصلية */ }
    }
    return out;
  }

  let exporting = false;
  async function exportPdf() {
    if (exporting) return; // ضغطتان متتاليتان كانتا ترسلان ملفين وتحجزان دورين في طابور الخادم
    exporting = true;
    try { await exportPdfOnce(); } finally { exporting = false; }
  }
  async function exportPdfOnce() {
    document.activeElement?.blur?.();
    // النافذة تظهر فوراً (تجهيز الصور قد يأخذ ثواني على الهاتف)
    const stateText = h('p', { class: 'muted' }, 'أجهّز الصفحات وأرتّب الخطوط والصور…');
    const box = h('div', { class: 'stack' }, stateText, h('div', { class: 'progress-line' }, h('i')));
    let cancelled = false;
    const controller = new AbortController();
    const s = sheet({ title: 'تجهيز PDF', body: box, onClose: () => { cancelled = true; controller.abort(); } });
    clearTimeout(saveTimer);
    if (!unsaved) await db.saveLecture(doc).catch(() => {});
    const [images, brand] = await Promise.all([pdfImages(), brandAssets()]);
    if (cancelled) return;
    const html = buildPdfHtml(doc, { paged: true, images, brand });
    let blob = null, error = '', timedOut = false;
    for (let attempt = 0; attempt < 3 && !blob && !cancelled; attempt++) {
      // مهلة دقيقتين ونصف للطلب كله (مع تنزيل الملف): إذا علق خادم التحويل نعرض الطباعة من الجهاز
      const slow = setTimeout(() => { timedOut = true; controller.abort(); }, 150_000);
      try {
        const res = await fetch('/api/pdf', { method: 'POST', headers: { 'x-mv': '1', 'x-mv-paged': '1', 'content-type': 'text/html; charset=utf-8' }, body: html, credentials: 'same-origin', signal: controller.signal });
        if (res.ok && (res.headers.get('content-type') || '').includes('pdf')) { blob = await res.blob(); clearTimeout(slow); break; }
        const data = await res.json().catch(() => ({}));
        clearTimeout(slow);
        error = data.error || `http_${res.status}`;
        if (error !== 'pdf_busy') break;
        stateText.textContent = 'الخادم مشغول بطلب آخر، أعيد المحاولة بعد ثوانٍ…';
        await new Promise((r) => setTimeout(r, 11000));
      } catch (e) {
        clearTimeout(slow);
        if (e?.name === 'AbortError' && !timedOut) return;
        error = timedOut ? 'timeout' : 'network';
        if (timedOut) break;
      }
    }
    if (cancelled) return;
    if (blob) {
      const name = fileName();
      const url = URL.createObjectURL(blob);
      const file = new File([blob], name, { type: 'application/pdf' });
      const canShare = !!navigator.canShare?.({ files: [file] });
      const dl = h('a', { class: 'btn wide', href: url, download: name }, icon('download'), 'تنزيل الملف');
      clear(box).append(h('p', { class: 'muted' }, `الملزمة جاهزة (${fmtSize(blob.size)}).`), dl);
      if (canShare) box.append(h('button', { class: 'btn ghost wide', onclick: () => navigator.share({ files: [file], title: name }).catch(() => {}) }, icon('share'), 'مشاركة أو حفظ في الملفات'));
      s.panel.querySelector('h2').textContent = 'PDF جاهز';
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
      ctx.refreshSession().catch(() => {});
      return;
    }
    const why = error === 'pdf_limit' ? 'وصلت الحد اليومي لملفات PDF.'
      : error === 'pdf_quota' ? 'خلصت حصة الخادم اليومية لتوليد PDF، وتتجدد الساعة 3 الفجر.'
      : error === 'pdf_busy' ? 'خادم التحويل مشغول الآن.'
      : error === 'too_large' ? 'الملزمة كبيرة على الخادم (صور كثيرة).'
      : error === 'network' ? 'انقطع الاتصال.' : error === 'timeout' ? 'خادم التحويل تأخر كثيراً.' : 'تعذّر تجهيز الملف على الخادم.';
    clear(box).append(
      h('p', { class: 'muted' }, `${why} تقدر تحفظها من نافذة الطباعة: اختر «حفظ كـ PDF».`),
      h('button', { class: 'btn wide', onclick: () => { s.close(); printDoc(); } }, icon('print'), 'فتح نافذة الطباعة'),
      h('button', { class: 'btn ghost wide', onclick: () => { s.close(); exportPdf(); } }, icon('refresh'), 'حاول مرة ثانية'));
  }

  /**
   * الطباعة من الجهاز (مجانية وبلا حد): نفس صفحات ملف الخادم بترويستها وأرقامها. المستند يُبنى في إطار
   * مخفي بحجم حقيقي، وتقسيم الصفحات يشغّله هذا السكربت على الإطار (سياسة الأمان تمنع السكربتات داخله)،
   * ثم تُفتح نافذة الطباعة فيختار الطالب «حفظ كـ PDF».
   */
  let preparingPrint = false;
  async function printDoc() {
    if (preparingPrint) return;
    preparingPrint = true;
    const wait = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'أرتّب الصفحات للطباعة…'), h('div', { class: 'progress-line' }, h('i')));
    let frame = null, printed = false;
    const s = sheet({ title: 'تجهيز الطباعة', body: wait, onClose: () => { preparingPrint = false; if (frame && !printed) frame.remove(); } });
    const [images, brand] = await Promise.all([pdfImages(), brandAssets()]);
    if (!s.panel.isConnected) return;
    const { html, pagedCfg } = buildPdfParts(doc, { paged: 'external', images, brand });
    frame = h('iframe', { title: 'طباعة', 'aria-hidden': 'true', style: { position: 'fixed', left: '-12000px', top: '0', width: '860px', height: '1200px', border: '0', opacity: '0', pointerEvents: 'none' } });
    frame.onload = async () => {
      const w = frame.contentWindow, d = frame.contentDocument;
      try {
        pagedRuntime(pagedCfg, w);
        const t0 = Date.now();
        while (!d.documentElement.classList.contains('mv-ready') && Date.now() - t0 < 45_000) await new Promise((r) => setTimeout(r, 150));
      } catch { /* نطبع كما هو: قواعد ‎@page‎ تكفي */ }
      if (!frame.isConnected) return; // أغلق الطالب النافذة
      // الطباعة تُفتح بلمسة من الطالب: iPhone يمنع فتحها تلقائياً بعد انتظار
      const goPrint = h('button', { class: 'btn wide', onclick: () => {
        printed = true;
        try { w.focus(); w.print(); } catch { ctx.toast('تعذّر فتح نافذة الطباعة على هذا المتصفح.', 'err'); }
        s.close();
        setTimeout(() => frame.remove(), 60_000);
      } }, icon('print'), 'فتح نافذة الطباعة');
      clear(wait).append(h('p', { class: 'muted' }, 'الصفحات جاهزة. من نافذة الطباعة اختر «حفظ كـ PDF» أو الطابعة.'), goPrint);
    };
    frame.srcdoc = html;
    document.body.append(frame);
  }

  function plainText(blocks = doc.blocks, title = doc.meta.title) {
    const out = [title, ''];
    for (const b of blocks) {
      if (b.t === 'fig' || b.t === 'figreq') continue;
      if (b.items) out.push(b.items.map((i) => `• ${stripMarkup(i)}`).join('\n'));
      else if (b.rows) out.push([b.head, ...b.rows].map((r) => r.map(stripMarkup).join(' | ')).join('\n'));
      else if (b.t === 'mcq') out.push([stripMarkup(b.q), ...b.opts.map((o, i) => `${'abcd'[i]}) ${stripMarkup(o)}`), `الجواب: ${'abcd'[b.ans] || '?'}${b.why ? ` — ${stripMarkup(b.why)}` : ''}`].join('\n'));
      else if (b.t === 'slidereq') continue;
      else out.push(stripMarkup(b.text));
      out.push('');
    }
    return out.join('\n');
  }

  // ── النص المفرّغ الأصلي (للمراجعة مقابل الشرح) ──
  function openTranscript() {
    const list = h('div', { class: 'transcript' });
    for (const b of doc.transcript) {
      if (b.t === 'fig') continue;
      if (b.t === 'h') list.append(fill(h('h3', { dir: dirOf(b.text) }), b.text));
      else if (b.items) { const ul = h('ul', { dir: dirOf(b.items.join(' ')) }); for (const it of b.items) ul.append(fill(h('li'), it)); list.append(ul); }
      else list.append(fill(h(b.t === 'note' ? 'blockquote' : 'p', { dir: dirOf(blockText(b)) }), blockText(b)));
    }
    sheet({ title: 'النص المفرّغ من التسجيل', wide: true, body: h('div', { class: 'stack' },
      h('p', { class: 'dim' }, 'هذا كلام المحاضر كما سُمع من التسجيل، ومنه كُتب الشرح.'),
      h('div', { class: 'row' }, h('button', { class: 'btn small ghost', onclick: async () => { try { await navigator.clipboard.writeText(plainText(doc.transcript)); ctx.toast('انتسخ النص المفرّغ.', 'ok'); } catch { ctx.toast('تعذّر النسخ.', 'err'); } } }, icon('copy'), 'نسخ النص المفرّغ')),
      list) });
  }

  async function rewrite() {
    document.activeElement?.blur?.();
    clearTimeout(saveTimer);
    await db.saveLecture(doc).catch(() => {});
    if (!ctx.session?.keys?.gemini?.linked && !ctx.session?.keys?.groq?.linked) { ctx.go('link'); return; }
    // اختيار نوع الملزمة الجديدة (النوع المتكامل فقط إذا كانت السلايدات محفوظة مع المحاضرة)
    const types = NOTE_TYPES.filter((t) => t.id !== 'integrated' || doc.slides?.pages?.length);
    const s = sheet({ title: 'اكتبها من جديد كـ…', body: h('div', { class: 'stack' },
      h('p', { class: 'dim' }, 'تُكتب ملزمة جديدة من نفس التسجيل بدون إعادة رفعه، وتبقى هذي كما هي.'),
      h('div', { class: 'types' }, types.map((t) => h('button', { type: 'button', class: 'type', onclick: () => { s.close(); ctx.go('rewrite', { id: doc.id, mode: t.id }); } },
        h('span', { class: 'type-letter' }, t.letter), h('span', { class: 'type-body' }, h('b', { class: 'ltr' }, t.name), h('span', null, t.title)), h('span', { class: 'type-check' }, icon('check')))))) });
  }

  function openMenu() {
    const s = sheet({ title: 'خيارات المحاضرة', body: h('div', { class: 'menu' },
      h('button', { onclick: () => { s.close(); exportPdf(); } }, icon('download'), 'تحميل PDF'),
      h('button', { onclick: () => { s.close(); printDoc(); } }, icon('print'), 'طباعة'),
      h('button', { onclick: async () => { s.close(); try { await navigator.clipboard.writeText(plainText()); ctx.toast('انتسخ النص.', 'ok'); } catch { ctx.toast('تعذّر النسخ.', 'err'); } } }, icon('copy'), 'نسخ النص'),
      doc.transcript?.length ? h('button', { onclick: () => { s.close(); openTranscript(); } }, icon('text'), 'النص المفرّغ من التسجيل') : null,
      h('button', { onclick: () => { s.close(); rewrite(); } }, icon('book'), notes ? 'اكتبها من جديد بنوع آخر' : 'حوّلها لملزمة مشروحة'),
      h('button', { class: 'red', onclick: async () => {
        s.close();
        if (!(await confirm({ title: 'حذف المحاضرة؟', message: 'تنحذف من هذا الجهاز نهائياً.', ok: 'حذف', danger: true }))) return;
        await db.deleteLecture(doc.id).catch(() => {});
        ctx.toast('انحذفت المحاضرة.');
        history.back();
      } }, icon('trash'), 'حذف المحاضرة')) });
  }
}
