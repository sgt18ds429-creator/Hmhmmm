// run.js — تفاصيل المحاضرة، شاشة التحويل الحية، والتسجيل المباشر.

import { h, icon, clear, sheet, confirm, fmtHM, fmtSize, countOf, svgEl } from './ui.js';
// المحرك (الاستماع والكتابة وقاطع الصوت) ثقيل ولا يلزم إلا عند بدء تحويل: يُحمَّل عند الحاجة حتى تفتح
// الشاشة الرئيسية أسرع، ويُجلب مسبقاً في الخلفية بعد فتحها
let engineJob = null;
export const loadEngine = () => (engineJob ??= Promise.all([import('./pipeline.js'), import('./chunker.js')]).then(([p, c]) => ({ ...p, ...c })));
const isPipelineError = (e) => !!e && e instanceof Error && typeof e.code === 'string' && e.name === 'PipelineError';
import { parseMarkup, splitInline, fmtTime, isNotes } from './text.js';
import { fmtDuration } from './pdf.js';
import * as db from './db.js';
import { openGame, openXO, chooseGame } from './game.js';
import { keepAwake } from './awake.js';
import { toMemory, storable } from './memfile.js';

/** متصفح حديث بما يكفي لقارئ PDF (يحتاج Safari 16.4 أو أحدث): importmap ظهرت مع نفس الجيل */
const modernJs = () => typeof HTMLScriptElement !== 'undefined' && !!HTMLScriptElement.supports?.('importmap');

/** أنواع الملزمة كما تظهر للمستخدم */
export const NOTE_TYPES = [
  { id: 'highyield', letter: 'A', name: 'High-Yield Notes', title: 'النقاط الأساسية والمعلومات المهمة', desc: 'أهم الأفكار والمعلومات الامتحانية من المحاضرة، مختصرة ومنظمة بدون تفاصيل غير ضرورية، ومعها أسئلة MCQ للمراجعة.' },
  { id: 'notes', letter: 'B', name: 'Comprehensive Notes', title: 'ملاحظات دراسية شاملة ومفصلة', desc: 'المحاضرة كاملة كمادة دراسية متكاملة: شرح المفاهيم وترتيب العناوين والتفاصيل والأمثلة، مع صور مطابقة للشرح.' },
  { id: 'integrated', letter: 'C', name: 'Integrated Lecture', title: 'دمج PDF المحاضرة مع التسجيل', desc: 'يدمج سلايدات المحاضرة (PDF) مع شرح التدريسي بالتسجيل في ملزمة واحدة كاملة ومرتبة، وصور السلايدات داخلها.' },
];

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function hash(str) {
  let a = 2166136261;
  for (let i = 0; i < str.length; i++) { a ^= str.charCodeAt(i); a = Math.imul(a, 16777619); }
  return (a >>> 0).toString(36);
}

function segmented(options, value, onChange) {
  const el = h('div', { class: 'seg', role: 'group' });
  const paint = () => [...el.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === value)));
  for (const [v, label] of options) el.append(h('button', { type: 'button', dataset: { v }, onclick: () => { value = v; paint(); onChange(v); } }, label));
  paint();
  return el;
}
function toggle(label, hint, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked, onchange: () => onChange(input.checked) });
  return h('label', { class: 'switch' }, input, h('i'), h('span', null, label, h('small', null, hint)));
}

// ───────────── تفاصيل المحاضرة ─────────────
/** الموبايل سحب وصول الصفحة للملف (NotFoundError بسفاري الآيفون، NotReadableError بغيره) */
const lostFile = (e) => [e, e?.cause].some((x) => /^(NotFoundError|NotReadableError)$/.test(x?.name || '') || /can ?not be found|could not be read|NotReadable/i.test(String(x?.message || '')));

/**
 * نسخة من الملف بذاكرة الصفحة نفسها (MemFile). ملف مختار من «الملفات» أو iCloud بالآيفون، وحتى نسخة Blob منه، تصير
 * غير مقروءة بعد ما الصفحة تروح للخلفية فترة (The object can not be found here)، أما ذاكرة الصفحة فتبقى ما دامت مفتوحة.
 * الاسم والحجم والتاريخ نفسها، فالتحويل يبقى يكمل من مكانه. الملفات الضخمة جداً تبقى كما هي (ذاكرة الهاتف).
 */
const ownCopy = (f) => toMemory(f);
const GONE_MSG = 'ما كدرت أقرأ الملف من مكانه. إذا هو بـ iCloud نزّله للموبايل أول (افتحه مرة بتطبيق الملفات)، بعدين اختاره مرة ثانية.';

export function viewNew(ctx, el, { file, recId = null }) {
  ctx.setBar('sub', { title: 'محاضرة جديدة' });
  ctx.ribbon.set({ alpha: 0 });
  // output: نوع الملزمة (highyield / notes / integrated)، أو 'transcript' نص مفرّغ فقط
  // لغة الكلام تُكتشف تلقائياً، والملزمة تُكتب دائماً بالعربية والإنجليزية معاً
  const form = { title: '', subject: '', lecturer: '', date: today(), keywords: '', speech: 'auto', output: 'notes', images: true, glossary: true };
  let info = null, pdfFile = null;

  const fileMeta = h('small', null, `${fmtSize(file.size)} · أقرأ الملف…`);
  const startBtn = h('button', { class: 'btn wide', disabled: true, onclick: start }, 'ابدأ التحويل');
  const warn = h('div');
  // ملف PDF المحاضرة (للنوع المتكامل)
  const pdfInput = h('input', { type: 'file', accept: '.pdf,application/pdf', hidden: true, onchange: () => {
    const f = pdfInput.files?.[0];
    pdfInput.value = '';
    if (f) ownCopy(f).then((c) => { pdfFile = c; paintPdf(); }).catch(() => ctx.toast(GONE_MSG, 'err'));
  } });
  const pdfBox = h('div', { class: 'stack', hidden: true });
  function paintPdf() {
    clear(pdfBox);
    if (!modernJs()) {
      pdfBox.append(h('div', { class: 'banner' }, icon('warn'), h('span', null, 'قراءة ملف PDF تحتاج نظاماً أحدث (iOS 16.4 أو أحدث). حدّث الجهاز، أو اختر النوع A أو B.')));
      paintStart();
      return;
    }
    if (pdfFile) {
      pdfBox.append(h('div', { class: 'filecard pdf' }, icon('book'), h('div', null, h('b', { dir: 'auto' }, pdfFile.name), h('small', null, `${fmtSize(pdfFile.size)} · ملف PDF المحاضرة`)),
        h('button', { class: 'btn ghost small', onclick: () => pdfInput.click() }, 'تغيير')));
    } else {
      pdfBox.append(h('button', { class: 'slab small', onclick: () => pdfInput.click() }, icon('book'), h('strong', null, 'اختر ملف PDF المحاضرة'), h('span', null, 'السلايدات أو الملزمة الأصلية، حتى 160 صفحة')));
    }
    paintStart();
  }
  function paintStart() { startBtn.disabled = !info || (form.output === 'integrated' && (!pdfFile || !modernJs())); }
  const field = (label, key, attrs = {}, hint) => {
    const input = h(attrs.rows ? 'textarea' : 'input', { type: 'text', value: form[key], dir: 'auto', ...attrs, oninput: () => { form[key] = input.value; } });
    return { input, el: h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', null, hint) : null) };
  };
  const fTitle = field('عنوان المحاضرة', 'title', { placeholder: 'اتركه فارغاً ويُقترح تلقائياً', maxLength: 140 });
  const fSubject = field('المادة', 'subject', { placeholder: 'مثال: التشريح الشعاعي', maxLength: 80, list: 'mv-subjects' });
  const fLecturer = field('اسم التدريسي', 'lecturer', { placeholder: 'اختياري', maxLength: 80 });
  const fKeywords = field('مصطلحات متوقعة', 'keywords', { rows: 2, placeholder: 'chest X-ray, pneumothorax, pleural effusion', dir: 'ltr', maxLength: 400 }, 'اختياري. بعض مصطلحات المحاضرة بالإنجليزية تزيد الدقة.');
  const subjects = h('datalist', { id: 'mv-subjects' });
  const types = h('div', { class: 'types', role: 'radiogroup', 'aria-label': 'نوع الملزمة' });
  const plainLink = h('button', { class: 'linkish', type: 'button', onclick: () => { form.output = form.output === 'transcript' ? 'notes' : 'transcript'; paintTypes(); } });
  const bilingual = h('p', { class: 'hint bilingual' }, 'كل ملزمة تطلع بنسختين كاملتين، عربية وإنجليزية، والمصطلحات الطبية بالإنجليزية في النسختين.');
  const toggles = h('div', { class: 'stack' });

  function paintTypes() {
    clear(types);
    for (const t of NOTE_TYPES) {
      const on = form.output === t.id;
      types.append(h('button', { type: 'button', class: `type${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), onclick: () => { form.output = t.id; paintTypes(); } },
        h('span', { class: 'type-letter' }, t.letter),
        h('span', { class: 'type-body' }, h('b', { class: 'ltr' }, t.name), h('span', null, t.title), h('small', null, t.desc)),
        h('span', { class: 'type-check' }, icon('check'))));
    }
    plainLink.textContent = form.output === 'transcript' ? 'اخترت النص المفرّغ فقط بدون شرح. رجّعني لأنواع الملزمة' : 'أريد النص المفرّغ فقط كما قيل، بدون شرح';
    bilingual.hidden = form.output === 'transcript';
    types.classList.toggle('dim-all', form.output === 'transcript');
    pdfBox.hidden = form.output !== 'integrated';
    if (form.output === 'integrated') paintPdf();
    paintStart();
  }
  function paintOptions() {
    paintTypes();
    clear(toggles).append(
      toggle('صور توضيحية', 'من مصادر طبية مفتوحة (Wikimedia Commons و NIH)، ولا تُوضع صورة إلا بعد التأكد أنها تطابق الشرح', form.images, (v) => { form.images = v; }),
      toggle('قاموس المصطلحات', 'ترجمة وتعريف لكل مصطلح بآخر الملزمة', form.glossary, (v) => { form.glossary = v; }));
  }
  paintOptions();

  el.append(h('div', { class: 'stack lg' },
    h('div', { class: 'filecard' }, icon('file'), h('div', null, h('b', { dir: 'auto' }, file.name || 'تسجيل'), fileMeta)),
    warn,
    h('div', { class: 'field' }, h('span', null, 'شكل الملزمة'), types, bilingual, pdfBox, pdfInput, plainLink),
    h('div', { class: 'stack' }, fTitle.el, h('div', { class: 'grid2' }, fSubject.el, fLecturer.el), subjects),
    toggles,
    fKeywords.el,
    startBtn));

  db.getPref('form').then((saved) => {
    if (!saved) return;
    for (const k of ['subject', 'lecturer', 'output', 'images', 'glossary']) if (saved[k] !== undefined) form[k] = saved[k];
    if (!isNotes(form.output) && form.output !== 'transcript') form.output = 'notes';
    fSubject.input.value = form.subject; fLecturer.input.value = form.lecturer;
    paintOptions();
  });
  db.getPref('subjects', []).then((list) => { for (const s of list || []) subjects.append(h('option', { value: s })); });

  ownCopy(file).then((c) => { file = c; return loadEngine(); }).then(({ probeAudio }) => probeAudio(file)).then((i) => {
    info = i;
    const u = ctx.session.usage;
    const left = Math.max(0, u.limit_sec - u.used_sec);
    fileMeta.textContent = `${fmtSize(file.size)} · ${fmtDuration(i.duration)}${i.hasVideo ? ' · فيديو (يُؤخذ الصوت فقط)' : ''}`;
    if (u.limit_sec && i.duration > left + 30) { // 0 = بلا حد يومي
      warn.append(h('div', { class: 'banner' }, icon('warn'), h('span', null, `مدة التسجيل ${fmtHM(i.duration)} ورصيدك المتبقي اليوم ${fmtHM(left)}. يتحوّل اللي يكفيه الرصيد ويتوقف، وتكمل الباقي بعدين من نفس الملف.`)));
    }
    paintStart();
  }).catch((e) => {
    fileMeta.textContent = fmtSize(file.size);
    const msg = lostFile(e) ? GONE_MSG
      : e?.code === 'no-audio' ? 'هذا الملف ما بيه صوت.'
      : e?.code === 'codec' ? 'ترميز الصوت بهذا الملف ما مدعوم (مثل تسجيلات الآيفون بجودة Lossless أو صيغة AMR القديمة). بالآيفون: الإعدادات ← المذكرات الصوتية ← جودة الصوت ← مضغوط، أو حوّل الملف إلى m4a أو mp3.'
      : e?.code === 'empty' ? 'الملف فارغ أو التسجيل ما اكتمل.'
      : 'ما قدرت أقرأ هذا الملف. جرّب صيغة m4a أو mp3 أو wav أو mp4.';
    clear(warn).append(h('div', { class: 'banner' }, icon('warn'), h('span', null, msg), h('button', { class: 'btn small amber', onclick: () => { history.back(); setTimeout(ctx.pickFile, 250); } }, 'ملف آخر')));
  });

  async function start() {
    if (!info || startBtn.disabled) return;
    const { output, ...rest } = form;
    // الشرح يُكتب من تفريغ حرفي أمين (بلهجة المحاضر)، ثم يُرتّب ويُصحّح
    const meta = { ...rest, mode: isNotes(output) ? output : 'transcript', style: 'verbatim', title: form.title.trim(), subject: form.subject.trim(), lecturer: form.lecturer.trim(), keywords: form.keywords.trim() };
    db.setPref('form', { subject: meta.subject, lecturer: meta.lecturer, output, images: meta.images, glossary: meta.glossary });
    if (meta.subject) db.getPref('subjects', []).then((list) => db.setPref('subjects', [meta.subject, ...(list || []).filter((s) => s !== meta.subject)].slice(0, 12)));
    ctx.go('run', { file, meta, info, pdfFile: meta.mode === 'integrated' ? pdfFile : null, recId }, { replace: true });
  }
}

// ───────────── شاشة التحويل ─────────────
/** ساعة لحظة قادمة بتوقيت الجهاز («4:35») */
const clockAt = (ms) => new Date(ms).toLocaleTimeString('ar-IQ', { hour: 'numeric', minute: '2-digit' });
/** موعد تجدد حصص Google المجانية: منتصف الليل بتوقيت كاليفورنيا (10 أو 11 الصبح ببغداد حسب التوقيت الصيفي هناك) */
function googleResetAt(now = Date.now()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(now)).map((p) => [p.type, p.value]));
    const into = (+parts.hour % 24) * 3600 + (+parts.minute) * 60 + (+parts.second);
    return now + (86400 - into) * 1000;
  } catch { return 0; }
}

const ERRORS = {
  key_groq: ['المفتاح الثاني ما يشتغل', 'ممكن انحذف أو انتهى. اربطه من جديد.', 'link'],
  key_gemini: ['المفتاح الأول ما يشتغل', 'ممكن انحذف أو انتهى. اربطه من جديد.', 'link'],
  gemini_restricted: ['Google قفل الحصة المجانية لمفتاحك الأول', 'Google وقّف الاستخدام المجاني لحساب Google اللي انسوّى منه المفتاح الأول (مو مشكلة بالموقع ولا بالتسجيل). سوّ مفتاح جديد من حساب Google ثاني وأضفه، وارفع نفس الملف ويكمل من مكانه، الأجزاء المكتملة محفوظة.', 'link'],
  busy: ['خوادم الذكاء مزدحمة هسه', 'گوگل وكروك مضغوطين هسه، والمشكلة مو بمفاتيحك. الأجزاء المكتملة محفوظة، ودوس «أكمل التحويل» بعد دقيقتين ويكمل من مكانه.', 'retry'],
  no_engine: ['خلصت حصة اليوم بمفاتيحك', 'المقاطع المكتملة محفوظة. أضف مفتاح آخر من حساب ثاني وارفع نفس الملف ويكمل من مكانه، أو جرّب بعدين.', 'link'],
  daily_limit: ['خلص رصيد اليوم', 'المقاطع المكتملة محفوظة. ارجع ارفع نفس الملف بعدين ويكمل من مكانه، أو اطلب ساعات أكثر من المسؤول.', 'support'],
  rate_limit: ['حصة المفتاح الثاني لهالساعة خلصت', 'Groq يعطي كل حساب حصة صوت محدودة بالساعة. المقاطع المكتملة محفوظة وتكمل من نفس المكان. مفتاح Groq من حساب ثاني يخليه يكمل هسه.', 'retry+link'],
  locked: ['توقف الكود', 'الكود موقوف أو انتهت مدته. راجع المسؤول.', 'reload'],
  audio: ['مشكلة بالملف', 'ما قدرت أقرأ الصوت من هذا الملف. جرّب صيغة ثانية.', 'home'],
  file_gone: ['اختر الملف مرة ثانية', 'الموبايل سكّر وصول الموقع للملف بعد ما طلعت من الصفحة. اختر نفس التسجيل (ونفس ملف PDF إذا موجود) ويكمل من مكانه، الأجزاء المكتملة محفوظة.', 'pick'],
  stalled: ['مفاتيحك مضغوطة هسه', 'صار وقت طويل والمزوّد ما يرد لأن حصة مفاتيحك مضغوطة. الأجزاء المكتملة محفوظة. جرّب بعد شوية بنفس الملف ويكمل من مكانه، وإضافة مفتاح ثاني تسرّع التحويل.', 'retry+link'],
  empty: ['ماكو كلام بالتسجيل', 'ما لقيت كلام واضح. تأكد إنه تسجيل محاضرة وصوته مسموع.', 'home'],
  not_lecture: ['هذا التسجيل مو محاضرة', 'ما لقيت بيه شرح علمي حتى أكتبه ملزمة مشروحة.', 'home'],
  network: ['انقطع الاتصال', 'المقاطع المكتملة محفوظة. تأكد من الإنترنت وكمّل.', 'retry'],
  bad_pdf: ['ما قدرت أقرأ ملف PDF', 'الملف تالف أو مو PDF. جرّب ملفاً ثانياً.', 'home'],
  password: ['ملف PDF مقفول بكلمة مرور', 'فك القفل من برنامج PDF ثم ارفعه مرة ثانية.', 'home'],
  too_many: ['ملف PDF كبير جداً', 'الحد 160 صفحة. قسّم الملف أو ارفع الجزء الذي يخص المحاضرة.', 'home'],
  slides_unsupported: ['المتصفح قديم على ملف PDF', 'قراءة السلايدات تحتاج iOS 16.4 أو أحدث. حدّث الجهاز أو اختر النوع A أو B.', 'home'],
};

/** عرض مختصر لكتل نص داخل لوحة المعاينة الحية. */
function liveNodes(blocks) {
  const out = [];
  const fill = (target, text) => { for (const part of splitInline(text)) target.append(part.term ? h('span', { class: 't' }, part.text) : part.text); return target; };
  for (const b of blocks) {
    if (b.t === 'figreq' || b.t === 'fig') continue;
    let node;
    if (b.t === 'h') node = fill(h(b.level === 3 ? 'h4' : 'h3'), b.text);
    else if (b.items) { node = h('ul'); b.items.forEach((it) => node.append(fill(h('li'), it))); }
    else if (b.rows) { node = h('ul'); b.rows.forEach((r) => node.append(fill(h('li'), r.filter(Boolean).join(' · ')))); }
    else node = fill(h('p', { class: b.t === 'note' ? 'n' : null }), b.text);
    node.dir = 'auto';
    out.push(node);
  }
  return out;
}

/**
 * واجهة التقدم المشتركة (تحويل تسجيل، أو كتابة شرح لمحاضرة محفوظة).
 * @param opts.stages [[المعرّف، الاسم]] · opts.weights { transcribe, write }
 */
function runScreen(ctx, el, { title, stages: stageNames, weights, retry, auto = null, recover = null }) {
  ctx.setBar('sub', { title });
  const controller = new AbortController();
  let running = true, waitTimer = null;
  // مراقب: إذا ما تقدم شي 8 دقائق والمحرك بس ينتظر حصة المفاتيح، نوقف برسالة واضحة بدل عدّ «لحظات ونكمل» بلا نهاية
  let progressAt = Date.now(), waitedSince = 0, stalled = null, stalledMin = 0;
  const STALL_MS = 8 * 60_000;
  // الوقت المعروض وقت العمل الفعلي: ما قضاه الطالب خارج الموقع لا يُحسب
  const clock = () => (ctx.io.activeNow ? ctx.io.activeNow() : Date.now());
  const t0 = clock();

  const pct = h('span', null, '0');
  const status = h('p', { class: 'run-status' }, 'أقرأ الملف…');
  const sub = h('p', { class: 'run-sub num' }, '');
  const strip = h('div', { class: 'strip', 'aria-hidden': 'true' });
  const live = h('div', { class: 'live', dir: 'auto' });
  const stages = h('ul', { class: 'stages' }, stageNames.map(([k, label]) => h('li', { dataset: { k } }, label)));
  const cancelBtn = h('button', { class: 'btn ghost', onclick: () => history.back() }, 'إلغاء');
  // لعبة تسلّي الانتظار؛ التحويل يكمل بالخلفية، واللعبة تنغلق وحدها عندما تجهز الملزمة
  let game = null;
  let choosing = false;
  const playGame = async () => {
    if (game || choosing || !running) return;
    choosing = true;
    const kind = await chooseGame();
    choosing = false;
    if (!kind || game || !running) return;
    ctx.ribbon.pause?.(); // الشريط المتحرك يتوقف أثناء اللعبة حتى لا يتنافسا على الرسم
    const onClose = () => { game = null; ctx.ribbon.resume?.(); flushLive(); };
    game = kind === 'xo' ? openXO({ onClose }) : openGame({ build: ctx.session.build, onClose });
    game.update(shown, status.textContent);
  };
  const gameBtn = h('button', { class: 'btn game-btn', onclick: playGame }, icon('play'), 'العب لحد ما تجهز الملزمة');
  // حلقة التقدم حول النسبة، بتدرّج الهوية
  const RING = 2 * Math.PI * 80;
  const ringFill = svgEl('circle', { class: 'r-fill', cx: 89, cy: 89, r: 80, 'stroke-dasharray': RING, 'stroke-dashoffset': RING });
  const ring = h('div', { class: 'ring' },
    svgEl('svg', { viewBox: '0 0 178 178', 'aria-hidden': 'true' },
      svgEl('defs', {}, svgEl('linearGradient', { id: 'mv-ring-grad', x1: '0', y1: '0', x2: '1', y2: '1' },
        svgEl('stop', { offset: '0', style: 'stop-color: var(--v1)' }),
        svgEl('stop', { offset: '0.55', style: 'stop-color: var(--v2)' }),
        svgEl('stop', { offset: '1', style: 'stop-color: var(--v3)' }))),
      svgEl('circle', { class: 'r-track', cx: 89, cy: 89, r: 80 }),
      ringFill),
    h('div', { class: 'run-pct num' }, pct, h('small', null, '%')));
  const paintRing = (v) => { ringFill.style.strokeDashoffset = String(RING * (1 - Math.max(0.012, v / 100))); };
  const body = h('div', { class: 'run' },
    h('div', { class: 'run-head' }, ring, status, sub),
    strip, stages, h('div', { class: 'row', style: { justifyContent: 'center' } }, gameBtn), live, h('div', { class: 'row', style: { justifyContent: 'center' } }, cancelBtn));
  el.append(body);

  ctx.ribbon.set({ y: Math.min(0.24, 170 / innerHeight), energy: 1, alpha: 1 });
  const guard = async () => {
    if (!running) return true;
    const yes = await confirm({ title: 'إيقاف التحويل؟', message: 'الأجزاء المكتملة تبقى محفوظة، وإذا رجعت لنفس الملف يكمل من مكانه.', ok: 'إيقاف', cancel: 'أكمل', danger: true });
    if (yes) controller.abort();
    return yes;
  };
  ctx.guard = guard;
  const beforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
  addEventListener('beforeunload', beforeUnload);
  // الشاشة تبقى مضاءة (وإلا قفل الهاتف يوقف التحويل)، حتى على iPhone الأقدم والتطبيق المثبت
  const release = keepAwake();
  // الجوال يوقف الصفحات التي في الخلفية: يتوقف التحويل مؤقتاً، والطلبات التي انقطعت تُعاد عند الرجوع
  // فيكمل من نفس المكان بدون أي نقص
  let hiddenAt = 0;
  const onVisible = () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (!running) return;
    if (hiddenAt && Date.now() - hiddenAt > 10_000) ctx.toast('رجعت، أكمل من نفس المكان.');
    hiddenAt = 0;
  };
  document.addEventListener('visibilitychange', onVisible);
  // كتابة الجزء طلب واحد طويل بلا تقدم وسيط، فنقدّر تقدمه بالوقت (حتى 85% من حصته) حتى لا تبدو النسبة عالقة
  const writing = { start: new Map(), done: 0, total: 0 };
  const tick = setInterval(() => {
    if (!running) return;
    if (!waitTimer) sub.textContent = `${fmtTime((clock() - t0) / 1000)} · تقدر تطلع وترجع، يكمل من نفس المكان`;
    game?.update(shown, status.textContent);
    if (writing.start.size && writing.total) {
      let partial = 0;
      for (const t of writing.start.values()) partial += Math.min(0.85, (Date.now() - t) / 100_000);
      P.write = Math.max(P.write, (writing.done + partial) / writing.total);
      paintPct();
    }
  }, 1000);

  // ── تقدم ──
  const P = { total: 1, chunk: [], write: 0, extra: 0 };
  const WEIGHT = { cut: 0.04, stt: 0.2, listen: 0.45, clean: 0.45, done: 1 };
  let shown = 0;
  function paintPct() {
    const heard = weights.transcribe ? P.chunk.reduce((a, s) => a + (WEIGHT[s] || 0), 0) / P.total : 0;
    const value = Math.min(99, Math.round((heard * weights.transcribe + P.write * weights.write + P.extra) * 100));
    if (value > shown) { shown = value; pct.textContent = String(value); paintRing(value); }
  }
  function setStage(k) {
    const order = stageNames.map(([n]) => n);
    const at = order.indexOf(k);
    if (at < 0) return;
    [...stages.children].forEach((li, i) => { li.classList.toggle('ok', i < at); li.classList.toggle('on', i === at); });
  }
  // أثناء اللعبة لا نرسم المعاينة (مخفية خلفها) حتى لا تنافس اللعبة على الرسم؛ تُرسم آخر حالة عند الإغلاق
  let liveQueue = [];
  function showLive(blocks, { reset = false, keep = 14 } = {}) {
    if (game) { if (reset) liveQueue = []; liveQueue.push({ blocks: blocks.slice(-keep), reset }); if (liveQueue.length > 6) liveQueue.splice(0, liveQueue.length - 6); return; }
    if (reset) clear(live);
    live.append(...liveNodes(blocks.slice(-keep)));
    while (live.children.length > 60) live.firstChild.remove();
    live.scrollTop = live.scrollHeight;
  }
  function flushLive() {
    const q = liveQueue; liveQueue = [];
    for (const { blocks, reset } of q) showLive(blocks, { reset });
  }
  const pending = new Map();
  let nextLive = 0, showingNotes = false, stageNow = '', imagesPicked = 0;
  function showParts() {
    while (pending.has(nextLive)) {
      const blocks = parseMarkup(pending.get(nextLive).markup);
      pending.delete(nextLive); nextLive++;
      if (!showingNotes) showLive(blocks);
    }
  }

  function emit(e) {
    if (!running) return;
    if (e.type === 'plan') {
      P.total = e.chunks;
      clear(strip);
      for (let i = 0; i < e.chunks; i++) strip.append(h('i'));
      setStage('transcribe');
    } else if (e.type === 'slides') {
      status.textContent = `أقرأ ملف PDF المحاضرة: صفحة ${e.page} من ${e.total}`;
    } else if (e.type === 'chunk') {
      // قد يختلف العدد الفعلي قليلاً عن التقدير
      while (strip.children.length <= e.index) { strip.append(h('i')); P.total = strip.children.length; }
      P.chunk[e.index] = e.stage;
      strip.children[e.index].className = e.stage;
      const n = `${e.index + 1} من ${P.total}`;
      if (e.stage === 'stt') status.textContent = `أحوّل المقطع ${n} إلى مسودة`;
      else if (e.stage === 'listen') status.textContent = `أستمع للمقطع ${n} وأدقّق المصطلحات`;
      else if (e.stage === 'clean') status.textContent = `أنقّح المقطع ${n}`;
      ctx.ribbon.kick(0.25);
      paintPct();
    } else if (e.type === 'part') {
      P.chunk[e.index] = 'done';
      if (strip.children[e.index]) strip.children[e.index].className = 'done';
      pending.set(e.index, e.part);
      showParts();
      ctx.ribbon.kick(0.5);
      paintPct();
    } else if (e.type === 'stage') {
      stageNow = e.name;
      if (e.name === 'slides') { setStage('slides'); status.textContent = 'أقرأ ملف PDF المحاضرة'; }
      else if (e.name === 'write') { setStage('write'); status.textContent = 'أقرأ المحاضرة كاملة حتى أفهمها'; }
      else if (e.name === 'review') { setStage('review'); status.textContent = 'أراجع الملزمة كاملة مقابل التسجيل قبل التسليم'; P.write = 1; P.extra = 0.02; }
      else if (e.name === 'glossary') { setStage('figures'); status.textContent = 'أجهّز قاموس المصطلحات'; P.write = 1; P.extra = Math.max(P.extra, 0.05); }
      else if (e.name === 'figures') { setStage('figures'); status.textContent = 'أجهّز القاموس وأختار صوراً مطابقة للشرح'; P.write = 1; P.extra = Math.max(P.extra, 0.07); }
      else if (e.name === 'images') { status.textContent = 'أبحث عن صور مطابقة للشرح في المصادر المفتوحة'; P.extra = Math.max(P.extra, 0.09); }
      else if (e.name === 'mcq') { status.textContent = 'أكتب أسئلة الاختيار من متعدد بالإنجليزية'; }
      else if (e.name === 'translate') { status.textContent = e.to === 'ar' ? 'أكتب النسخة العربية من الملزمة' : 'أكتب النسخة الإنجليزية من الملزمة'; }
      else if (e.name === 'gate') { status.textContent = 'أفحص كل صفحات الملزمة قبل التسليم: لا تكرار ولا فقرات ناقصة'; P.write = 1; P.extra = Math.max(P.extra, 0.13); }
      else if (e.name === 'done') { setStage('done'); P.write = 1; P.extra = 0.14; }
      paintPct();
    } else if (e.type === 'translate') {
      status.textContent = `النسخة ${e.total ? `${e.to === 'ar' ? 'العربية' : 'الإنجليزية'}: ${e.done} من ${e.total} أجزاء` : 'الثانية'}${imagesPicked ? ` · صور مطابقة: ${imagesPicked}` : ''}`;
      P.extra = Math.min(0.13, Math.max(P.extra, 0.05 + 0.07 * (e.done / Math.max(1, e.total))));
      paintPct();
    } else if (e.type === 'reviewed') {
      status.textContent = e.fixes || e.added ? `تمت المراجعة: ${[e.fixes ? countOf(e.fixes, ['تصحيح واحد', 'تصحيحان', 'تصحيحات', 'تصحيحاً']) : '', e.added ? countOf(e.added, ['إضافة واحدة', 'إضافتان', 'إضافات', 'إضافة']) : ''].filter(Boolean).join(' و ')}` : 'تمت المراجعة: الملزمة مطابقة للتسجيل';
    } else if (e.type === 'notes') {
      if (e.stage === 'slides') status.textContent = `أفحص صور السلايدات (${e.pages} صفحة)`;
      else if (e.stage === 'plan') status.textContent = 'أفهم المحاضرة وأقسّمها حسب المواضيع';
      else if (e.stage === 'write') {
        status.textContent = `أكتب الشرح المفصل (${countOf(e.total, ['جزء واحد', 'جزآن', 'أجزاء', 'جزءاً'])}). الجزء يأخذ دقيقة أو دقيقتين`;
        clear(strip);
        for (let i = 0; i < e.total; i++) strip.append(h('i'));
        P.write = 0.03;
      } else if (e.stage === 'review') status.textContent = 'أجهّز أهم النقاط للمراجعة';
      paintPct();
    } else if (e.type === 'section') {
      const cell = strip.children[e.index];
      writing.total = e.total;
      if (e.stage === 'write') {
        if (cell) cell.className = 'listen';
        writing.start.set(e.index, Date.now());
      } else if (e.stage === 'done') {
        writing.start.delete(e.index);
        writing.done = e.done;
        if (cell) cell.className = e.fallback ? 'review' : 'done';
        status.textContent = e.done < e.total ? `أكتب الشرح المفصل: جاهز ${e.done} من ${e.total}${imagesPicked ? ` · صور مطابقة: ${imagesPicked}` : ''}` : 'أراجع الشرح وأجهّز الخطوة الأخيرة';
        P.write = Math.max(P.write, e.done / e.total);
        showLive(parseMarkup(e.markup), { reset: !showingNotes, keep: 18 });
        showingNotes = true;
        ctx.ribbon.kick(0.5);
      }
      paintPct();
    } else if (e.type === 'note') {
      if (e.code === 'not_lecture') ctx.toast('هذا التسجيل ما بيه شرح علمي، فخليته نصاً مفرّغاً.');
      else if (e.code === 'notes_failed') ctx.toast('ما كدرت أكتب الشرح هسه، فبقت الملزمة نصاً مفرّغاً. تقدر تحوّلها لشرح بعدين من خيارات الملزمة.', 'err');
      else if (e.code === 'translate_failed') ctx.toast('ما كدرت أكتب النسخة الثانية (الترجمة) هسه لأن المحرك مضغوط. الملزمة جاهزة بلغتها، وتقدر تعيد كتابتها بعدين.', 'err');
      else if (e.code === 'translate_partial') ctx.toast('أجزاء قليلة من النسخة الثانية بقت بلغتها الأصلية لأن ترجمتها ما اكتملت، ومعلَّمة بملاحظة.');
      else if (e.code === 'figures_partial') ctx.toast('انقطع الاتصال أثناء فحص بعض الصور، فالملزمة كاملة بصور أقل.');
      else if (e.code === 'key_groq_dead') ctx.toast('المفتاح الثاني ما عاد يشتغل، فكمّلت بالمفتاح الأول. اربطه من جديد من «حسابي».', 'err');
      else if (e.code === 'gemini_restricted_dead') ctx.toast('Google قفل الحصة المجانية لمفتاحك الأول، فكمّلت بالمفتاح الثاني (أبطأ شوية). سوّ مفتاح من حساب Google ثاني وأضفه من «حسابي».', 'err');
      else if (e.code === 'key_gemini_dead') ctx.toast('المفتاح الأول ما عاد يشتغل، فكمّلت بالمفتاح الثاني. اربطه من جديد من «حسابي».', 'err');
      // نفاد حصة النماذج الدقيقة أو حصة Gemini: يكمل التحويل وحده بالمتاح، ولا رسالة للمستخدم (تبقى في التشخيص)
    } else if (e.type === 'images') {
      // الصور تُفحص أثناء الكتابة أيضاً: لا نغطي حالة الكتابة، ونعرض العدد فقط
      if (e.picked) imagesPicked = Math.max(imagesPicked, e.picked);
      if (stageNow === 'figures' || stageNow === 'images') {
        if (imagesPicked) status.textContent = `صور تأكدت أنها مطابقة للشرح: ${imagesPicked}`;
        P.extra = Math.min(0.13, P.extra + 0.005);
        paintPct();
      }
    } else if (e.type === 'wait') {
      let left = e.seconds;
      clearInterval(waitTimer);
      waitedSince ||= Date.now();
      if (Date.now() - progressAt > STALL_MS && !stalled) {
        stalled = e.what || 'wait';
        stalledMin = Math.round((Date.now() - progressAt) / 60000);
        controller.abort();
        return;
      }
      // انتظار طويل متكرر: نقول السبب، والحل اللي يسرّعه
      const long = Date.now() - waitedSince > 90_000;
      const paint = () => { sub.textContent = long ? `مفاتيحك مضغوطة، ننتظر دورها… ${left} ثانية (مفتاح ثاني يسرّع)` : `لحظات ونكمل… ${left} ثانية`; };
      paint();
      waitTimer = setInterval(() => { left--; if (left <= 0) { clearInterval(waitTimer); waitTimer = null; } else paint(); }, 1000);
    } else if (e.type === 'resume') {
      clearInterval(waitTimer); waitTimer = null;
    }
    if (e.type !== 'wait' && e.type !== 'resume' && e.type !== 'note') { progressAt = Date.now(); waitedSince = 0; }
  }

  function cleanup() {
    running = false;
    clearInterval(tick); clearInterval(waitTimer);
    removeEventListener('beforeunload', beforeUnload);
    document.removeEventListener('visibilitychange', onVisible);
    release();
    if (ctx.guard === guard) ctx.guard = null; // لا نمسح حماية شاشة تحويل أحدث
  }

  function fail(code, extra = {}) {
    cleanup();
    game?.close();
    if (!body.isConnected) return; // الطالب ترك الشاشة: لا نغيّر شاشة أخرى
    ctx.ribbon.set({ energy: 0.25, alpha: 0.5 });
    const [title, message, action] = ERRORS[code] || ['توقف التحويل', 'صار خطأ غير متوقع. الأجزاء المكتملة محفوظة، جرّب مرة ثانية.', 'retry'];
    let msg = message;
    if (code === 'daily_limit' && extra.retryAfter) msg += ` يرجع رصيدك كامل الساعة 12 بالليل (بعد ${fmtHM(extra.retryAfter)} ساعة).`;
    if (code === 'rate_limit' && extra.retryAfter) msg += ` يرجع يشتغل الساعة ${clockAt(Date.now() + extra.retryAfter * 1000)} تقريباً.`;
    if (code === 'no_engine') { const at = googleResetAt(); if (at) msg += ` حصة Google المجانية تتجدد كل يوم الساعة ${clockAt(at)}.`; }
    const actions = [];
    const want = action.split('+');
    const sup = ctx.session.support;
    if (want.includes('retry')) actions.push(h('button', { class: 'btn', onclick: retry }, 'أكمل التحويل'));
    if (want.includes('link')) actions.push(h('button', { class: want[0] === 'link' ? 'btn' : 'btn ghost', onclick: () => ctx.go('link', {}, { replace: true }) }, want[0] === 'link' ? 'ربط المفاتيح' : 'إضافة مفتاح'));
    if (want.includes('pick')) actions.push(h('button', { class: 'btn', onclick: () => { ctx.go('home', {}, { replace: true }); setTimeout(ctx.pickFile, 250); } }, 'اختر الملف'));
    if (want.includes('reload')) actions.push(h('button', { class: 'btn', onclick: () => location.reload() }, 'تحديث'));
    if (want.includes('support') && sup?.url) actions.push(h('a', { class: 'btn', href: sup.url, target: '_blank', rel: 'noopener' }, icon('external'), 'اطلب ساعات أكثر'));
    actions.push(h('button', { class: 'btn ghost', onclick: () => history.back() }, 'رجوع'));
    clear(body).append(h('div', { class: 'result' }, icon('warn', 'icon big'), h('h2', { class: 'h-section' }, title), h('p', { class: 'muted' }, msg), h('div', { class: 'row', style: { justifyContent: 'center' } }, actions)));
    ctx.setBar('sub', { title: 'توقف التحويل' });
  }

  /** @param opts.mem المستند نفسه إذا تعذّر حفظه على الجهاز: يُفتح من الذاكرة حتى يُنزَّل PDF ولا يضيع */
  async function finish(doc, { mem = null } = {}) {
    const here = running && body.isConnected;
    shown = 100; pct.textContent = '100'; paintRing(100);
    status.textContent = 'الملزمة جاهزة';
    ctx.ribbon.kick(1);
    cleanup();
    if (!here) { game?.close(); if (!mem) ctx.toast('ملزمتك الجديدة جاهزة في «محاضراتي».', 'ok'); return; }
    // اللعبة تعلن الجاهزية لحظة، ثم يُفتح المستند (فتح المستند يغلق اللعبة)
    game?.done();
    setTimeout(() => ctx.go('doc', { id: doc.id, fresh: true, mem }, { replace: true }), game ? 1500 : 650);
  }

  function failWith(e) {
    if (stalled) {
      loadEngine().then((m) => ctx.api('/api/diag', { method: 'POST', body: { m: `Stalled: waiting ${stalled} ${stalledMin} min: ${m.engineReport?.() || ''}`, st: stageNow, b: ctx.appBuild || ctx.session.build } })).catch(() => {});
      fail('stalled');
      return;
    }
    if (e?.name === 'AbortError' || e?.code === 'aborted') { cleanup(); game?.close(); return; }
    if (lostFile(e)) {
      ctx.api('/api/diag', { method: 'POST', body: { m: `${e?.name}: ${e?.message}`.slice(0, 160), st: stageNow, b: ctx.appBuild || ctx.session.build } }).catch(() => {});
      if (recover && auto && auto.n < 2 && body.isConnected) {
        cleanup(); game?.close();
        status.textContent = 'أكمل من النسخة المحفوظة على جهازك…';
        recover().then((ok) => { if (!body.isConnected) return; if (ok) auto.again(auto.n + 1); else fail('file_gone'); }, () => fail('file_gone'));
        return;
      }
      fail('file_gone');
      return;
    }
    console.error(e);
    if (!isPipelineError(e)) {
      // خطأ غير متوقع: يُسجَّل للتشخيص، ويكمل التحويل وحده من مكانه (مرتين على الأكثر) قبل أي رسالة
      const at = String(e?.stack || '').split('\n').find((l) => /\.js/.test(l)) || '';
      ctx.api('/api/diag', { method: 'POST', body: { m: `${e?.name || 'Error'}: ${e?.message || e}`, at: at.replace(/https?:\/\/[^/]+/g, '').replace(/\?v=\w+/g, ''), st: stageNow, b: ctx.appBuild || ctx.session.build } }).catch(() => {});
      if (auto && auto.n < 2 && navigator.onLine !== false && body.isConnected) {
        cleanup(); game?.close();
        status.textContent = 'أكمل من مكاني…';
        setTimeout(() => { if (body.isConnected) auto.again(auto.n + 1); }, 1200);
        return;
      }
    }
    if (isPipelineError(e) && ['busy', 'no_engine', 'rate_limit'].includes(e.code)) {
      // توقف بسبب المزوّدين: تقرير كل نموذج (نجاح/429/5xx) يُسجَّل حتى يبين السبب بالسجل
      loadEngine().then((m) => ctx.api('/api/diag', { method: 'POST', body: { m: `${e.code}: ${m.engineReport?.() || ''}`, st: stageNow, b: ctx.appBuild || ctx.session.build } })).catch(() => {});
      // حصة Groq للساعة ترجع خلال دقائق: عدّ تنازلي ويكمل وحده من نفس المكان إذا بقت الصفحة مفتوحة
      if (e.code === 'rate_limit' && e.retryAfter && e.retryAfter <= 20 * 60 && auto && auto.n < 3 && body.isConnected) {
        cleanup(); game?.close();
        let left = Math.ceil(e.retryAfter) + 15;
        status.textContent = `حصة المفتاح الثاني لهالساعة خلصت. أكمل وحدي الساعة ${clockAt(Date.now() + left * 1000)} من نفس المكان، خلي الصفحة مفتوحة`;
        const release2 = keepAwake();
        const t = setInterval(() => {
          if (!body.isConnected) { clearInterval(t); release2(); return; }
          if (--left <= 0) { clearInterval(t); release2(); auto.again(auto.n + 1); } else sub.textContent = `أكمل بعد ${fmtTime(left)}`;
        }, 1000);
        return;
      }
      // ضغط مؤقت: يكمل وحده بعد دقيقتين (مرتين على الأكثر) قبل ما يطلب من الطالب شي
      if (e.code === 'busy' && auto && auto.n < 2 && body.isConnected) {
        cleanup(); game?.close();
        let left = 120;
        status.textContent = 'خوادم الذكاء مزدحمة، أكمل وحدي بعد شوية من نفس المكان';
        const release2 = keepAwake(); // الشاشة تبقى مضاءة حتى لا يوقف قفل الهاتف العدّ
        const t = setInterval(() => {
          if (!body.isConnected) { clearInterval(t); release2(); return; }
          if (--left <= 0) { clearInterval(t); release2(); auto.again(auto.n + 1); } else sub.textContent = `أكمل بعد ${left} ثانية`;
        }, 1000);
        return;
      }
    }
    if (isPipelineError(e)) fail(e.code, e);
    else fail(navigator.onLine === false ? 'network' : 'unknown');
    ctx.refreshSession().catch(() => {});
  }

  return { emit, signal: controller.signal, finish, failWith, get stopped() { return controller.signal.aborted || !running; } };
}

/**
 * صور الملزمة: مصغّرات المرشحات (تبديل الصورة) تُحذف قبل الحفظ، فهي تضاعف حجم الملزمة على الجهاز وتُحمَّل
 * من جديد عند فتح نافذة التبديل. تبقى بيانات المرشحات نفسها.
 */
function slimFigures(doc) {
  for (const b of doc.blocks || []) if (Array.isArray(b.candidates)) b.candidates = b.candidates.map(({ tiny, ...c }) => c);
}

/** يحفظ الملزمة؛ وإذا تعذّر (مساحة ممتلئة، اتصال التخزين مغلق) يرجع false ويبقى المستند في الذاكرة. */
async function saveFinal(doc) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await db.saveLecture(doc); return true; } catch { await new Promise((r) => setTimeout(r, 600)); }
  }
  return false;
}

/** مراحل شاشة التحويل حسب نوع الملزمة */
function stagesFor(mode, { listen = true } = {}) {
  const out = [];
  if (mode === 'integrated') out.push(['slides', 'السلايدات']);
  if (listen) out.push(['transcribe', 'الاستماع']);
  if (isNotes(mode)) out.push(['write', 'الفهم والكتابة'], ['review', 'المراجعة']);
  out.push(['figures', isNotes(mode) ? 'الصور والترجمة' : 'الصور والقاموس'], ['done', 'جاهز']);
  return out;
}

/** السلايدات تُحفظ مع الملزمة بلا صورها (الصور المستعملة صارت أشكالاً داخلها) */
function slimSlides(doc) {
  if (doc.slides?.pages) doc.slides = { pages: doc.slides.pages.map((p) => ({ page: p.page, text: p.text })), figs: doc.slides.figs || [] };
}

export function viewRun(ctx, el, { file, meta, info, pdfFile = null, recId = null, resumes = 0, auto = 0 }) {
  const notes = isNotes(meta.mode);
  const cfg = { chunkSec: ctx.session.config.chunkSec, overlapSec: ctx.session.config.overlapSec };
  const job = hash([file.name, file.size, file.lastModified, meta.speech, meta.style, cfg.chunkSec].join('|'));
  // أثر التحويل الجاري: إذا أغلق الهاتف الصفحة أو أعاد تحميلها (يحصل بعد الخروج الطويل منها) يكمل من مكانه
  // عند فتح الموقع، بنفس الملف والإعدادات. failed/stopped: انتهى بخطأ أو أوقفه الطالب (لا يُستأنف وحده)
  const trace = { job, name: file.name || '', size: file.size, mode: meta.mode, recId, meta, resumes, at: Date.now() };
  let ended = false; // بعد العلامة الأخيرة (اكتمل/أوقف/فشل) لا تمسحها نبضة متأخرة
  const mark = (extra = {}) => db.setPref('active-run', { ...trace, ...extra, at: Date.now() }).catch(() => {});
  const finalMark = (extra) => { ended = true; return mark(extra); };
  /** نسخ بالذاكرة من التسجيل و PDF السلايدات */
  const inMemory = async (f, p) => [await ownCopy(f), p ? await ownCopy(p) : null];
  /** النسخة المحفوظة على الجهاز لهذا التحويل (التسجيل المباشر محفوظ بمكانه)، أو null */
  const storedSource = async () => {
    const src = await db.getSource(job).catch(() => null);
    const f = recId ? await db.getRecording(recId).catch(() => null) : src?.file;
    if (!f || (pdfFile && !src?.pdf)) return null;
    return { file: f, pdf: src?.pdf || null };
  };
  const screen = runScreen(ctx, el, {
    title: 'جارِ التحويل',
    stages: stagesFor(notes ? meta.mode : 'transcript'),
    weights: notes ? { transcribe: 0.55, write: 0.28 } : { transcribe: 0.86, write: 0 },
    retry: () => ctx.go('run', { file, meta, info, pdfFile, recId }, { replace: true }),
    auto: { n: auto, again: (n) => ctx.go('run', { file, meta, info, pdfFile, recId, auto: n }, { replace: true }) },
    // الملف ضاع بنص التحويل: إذا عندنا نسخة محفوظة يكمل منها وحده بدل ما يطلب اختياره
    recover: async () => !!(await storedSource()),
  });
  // نبضة كل 20 ثانية مع التقدم: آخر وقت كان فيه التحويل يعمل
  let beatAt = Date.now();
  const emit = (e) => { if (!ended && Date.now() - beatAt > 20_000) { beatAt = Date.now(); mark(); } screen.emit(e); };

  // قفل باسم التحويل طوال عمله: الاستئناف التلقائي في نافذة أخرى لا يبدأ نسخة ثانية منه
  let unlock = null;
  try { navigator.locks?.request?.(`mv-run:${job}`, () => new Promise((r) => { unlock = r; })).catch(() => {}); } catch { /* غير مدعوم */ }

  (async () => {
    try {
      const prev = await db.getPref('active-run');
      if (prev?.job && prev.job !== job) db.clearSource(prev.job).catch(() => {}); // نسخة تحويل سابق لم يكتمل: لم تعد تلزم
      mark();
      // نسخة بالذاكرة من التسجيل والسلايدات قبل أي شي. الملف المسترجع من تخزين الجهاز (استئناف بعد إغلاق الصفحة،
      // أو «أكمل» من الرئيسية) بسفاري الآيفون ممكن ينمسح من تحته (NotFoundError)؛ هنا ينكشف فوراً بدل منتصف التحويل
      try {
        [file, pdfFile] = await inMemory(file, pdfFile);
      } catch (e) {
        if (!lostFile(e)) throw e;
        // النسخة اللي بيدنا ما تنقرا (الموبايل سحب وصوله للملف، أو ضاعت نسخة الذاكرة والصفحة بالخلفية):
        // نكمل من النسخة المحفوظة على الجهاز إذا موجودة، وإذا هي نفسها تالفة تنمسح حتى الرئيسية تطلب اختيار الملف
        const stored = await storedSource();
        if (!stored) throw e;
        try { [file, pdfFile] = await inMemory(stored.file, pdfFile ? stored.pdf : null); }
        catch (e2) { if (lostFile(e2) && !recId) db.clearSource(job).catch(() => {}); throw e2; }
      }
      keepSource(job, recId ? null : file, pdfFile); // التسجيل المباشر محفوظ أصلاً، فيُحفظ معه PDF السلايدات فقط
      const [caps, { runLecture, PipelineError }] = await Promise.all([ctx.caps || ctx.loadCaps(), loadEngine()]);
      let slides = null;
      if (meta.mode === 'integrated' && pdfFile) {
        screen.emit({ type: 'stage', name: 'slides' });
        let mod;
        try { mod = await import(`/app/slides.js?v=${encodeURIComponent(ctx.session.build || '')}`); } catch { throw new PipelineError('slides_unsupported', 'pdf reader failed to load'); }
        const { readSlides, SlidesError } = mod;
        try {
          slides = await readSlides(pdfFile, { build: ctx.session.build, signal: screen.signal, onProgress: (i, n) => screen.emit({ type: 'slides', page: i, total: n }) });
        } catch (e) {
          if (e instanceof SlidesError) throw new PipelineError(e.code, e.message);
          throw e;
        }
      }
      const resumed = await db.countParts(job).catch(() => 0);
      if (resumed) ctx.toast(`أكمل من حيث توقفنا: ${resumed} مقطع جاهز.`);
      const doc = await runLecture({
        file, meta, cfg, caps, io: ctx.io, emit, signal: screen.signal, slides,
        checkpoint: { get: (i) => db.getPart(job, i).catch(() => null), set: (i, p) => db.setPart(job, i, p).catch(() => {}) },
      });
      if (screen.stopped) { finalMark({ stopped: true }); return; } // أوقفه الطالب: لا يُحفظ (الأجزاء المكتملة تبقى للاستئناف)
      doc.partial = false;
      slimSlides(doc);
      slimFigures(doc);
      let saved = await saveFinal(doc);
      // المساحة امتلأت: نسخة التسجيل لم تعد تلزم بعد اكتمال الملزمة، تُحذف ونحاول مرة ثانية
      if (!saved) { await db.clearSource(job).catch(() => {}); saved = await saveFinal(doc); }
      if (saved) {
        ended = true;
        await db.clearParts(job).catch(() => {});
        db.clearSource(job).catch(() => {});
        db.setPref('active-run', null).catch(() => {});
        if (recId) db.deleteRecording(recId).catch(() => {});
      } else finalMark({ saveFailed: true }); // الملزمة في الذاكرة لتنزيلها؛ لا يُعاد التحويل وحده عند فتح الموقع
      ctx.api('/api/done', { method: 'POST', body: {} }).then(() => ctx.refreshSession()).catch(() => {});
      screen.finish(doc, { mem: saved ? null : doc });
    } catch (e) {
      finalMark(e?.name === 'AbortError' || e?.code === 'aborted' ? { stopped: true } : { failed: true });
      screen.failWith(e);
    } finally {
      unlock?.();
    }
  })();
}

/**
 * نسخة من ملف التسجيل (و PDF السلايدات) للاستئناف بعد إعادة تحميل الصفحة، فقط إذا اتسعت لها مساحة الجهاز
 * بوضوح (حتى لا تزاحم حفظ الملزمة نفسها)؛ وإلا يُطلب اختيار الملف عند الإكمال كما كان.
 */
async function keepSource(job, file, pdf) {
  const size = (file?.size || 0) + (pdf?.size || 0);
  if (!size) return;
  // محفوظة من قبل لنفس التحويل: لا نكتب فوقها. الكتابة فوق السجل بسفاري تحذف ملفه القديم، والملف المفتوح منه
  // (استئناف) يصير غير مقروء (NotFoundError)
  const had = await db.getSource(job).catch(() => null);
  if (had?.file && (!pdf || had.pdf)) return;
  let room = 200e6;
  try {
    const e = await navigator.storage?.estimate?.();
    if (e?.quota) room = Math.min(400e6, (e.quota - (e.usage || 0)) * 0.4);
  } catch { /* تقدير غير متاح */ }
  if (size > room) return;
  await db.saveSource(job, { file: storable(file), pdf: storable(pdf) }).catch(() => {});
}

/** كتابة شرح مفصل لمحاضرة محفوظة (بدون إعادة الاستماع للتسجيل). تُحفظ كملزمة جديدة ويبقى الأصل. */
export async function viewRewrite(ctx, el, { id, mode = 'notes' }) {
  const src = await db.getLecture(id).catch(() => null);
  if (!src) { ctx.toast('ما لقيت هذي المحاضرة على الجهاز.', 'err'); ctx.go('home'); return; }
  if (mode === 'integrated' && !src.slides?.pages?.length) mode = 'notes';
  const type = NOTE_TYPES.find((t) => t.id === mode) || NOTE_TYPES[1];
  const screen = runScreen(ctx, el, {
    title: `كتابة ${type.name}`,
    stages: stagesFor(mode, { listen: false }),
    weights: { transcribe: 0, write: 0.86 },
    retry: () => ctx.go('rewrite', { id, mode }, { replace: true }),
  });
  try {
    const [caps, { rewriteLecture }] = await Promise.all([ctx.caps || ctx.loadCaps(), loadEngine()]);
    const job = `rw${id}:${mode}`; // الأقسام المكتوبة تُحفظ: إذا انقطعت الكتابة تكمل من مكانها
    const doc = await rewriteLecture({
      doc: src, caps, io: ctx.io, emit: screen.emit, signal: screen.signal, mode,
      checkpoint: { get: (k) => db.getPart(job, k).catch(() => null), set: (k, p) => db.setPart(job, k, p).catch(() => {}) },
    });
    if (screen.stopped) return;
    doc.partial = false;
    slimSlides(doc);
    slimFigures(doc);
    const saved = await saveFinal(doc);
    if (saved) await db.clearParts(job).catch(() => {});
    screen.finish(doc, { mem: saved ? null : doc });
  } catch (e) {
    screen.failWith(e);
  }
}

// ───────────── تسجيل مباشر ─────────────
/**
 * التسجيل يُحفظ على الجهاز قطعة كل 5 ثوانٍ أثناء التسجيل: إغلاق النافذة أو الصفحة أو تعطل الهاتف لا يضيعه،
 * ويظهر في الرئيسية لإكمال تحويله. لمسة خارج النافذة لا توقف التسجيل، وإغلاقها يحفظه وينتقل لتحويله.
 */
export function openRecorder(ctx) {
  let recorder = null, stream = null, chunks = [], started = 0, timer = null, release = null, audioCtx = null, raf = 0;
  let recId = null, pieces = 0, saving = Promise.resolve(), discarded = false;
  const beforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
  const time = h('div', { class: 'rec-time num' }, '0:00');
  const hint = h('p', { class: 'dim' }, 'خلّي الشاشة مفتوحة أثناء التسجيل. التسجيل يُحفظ على الجهاز أولاً بأول، وللمحاضرات الطويلة مسجّل الهاتف أضمن.');
  const btn = h('button', { class: 'btn', onclick: () => (recorder ? stop(true) : begin()) }, icon('mic'), 'ابدأ التسجيل');
  const discardBtn = h('button', { class: 'btn ghost small', hidden: true, onclick: async () => {
    if (!(await confirm({ title: 'حذف التسجيل؟', message: 'يُحذف التسجيل الحالي نهائياً ولا يتحوّل.', ok: 'حذف', danger: true }))) return;
    discarded = true;
    stop(false);
    s.close();
  } }, icon('trash'), 'حذف التسجيل');
  const s = sheet({ title: 'تسجيل مباشر', body: h('div', { class: 'rec' }, time, hint, btn, discardBtn), persistent: () => !!recorder, onClose: () => { if (recorder) stop(!discarded); } });

  async function begin() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, channelCount: 1 } });
    } catch {
      ctx.toast('لازم تسمح للموقع باستخدام المايكروفون.', 'err');
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
    try { recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 64000 } : undefined); }
    catch { ctx.toast('التسجيل غير مدعوم بهذا المتصفح.', 'err'); stream.getTracks().forEach((t) => t.stop()); return; }
    chunks = [];
    started = Date.now();
    recId = `${started.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const mime = recorder.mimeType || type || 'audio/webm';
    const stamp = new Date(started).toLocaleString('en-GB', { hour12: false }).replace(/[/,: ]+/g, '-');
    const meta = { name: `تسجيل-${stamp}.${/mp4/.test(mime) ? 'm4a' : 'webm'}`, type: mime, startedAt: started };
    recorder.ondataavailable = (e) => {
      if (!e.data?.size) return;
      chunks.push(e.data);
      const n = pieces++;
      const seconds = Math.round((Date.now() - started) / 1000);
      saving = saving.then(() => db.addRecPiece(recId, n, e.data, { ...meta, seconds })).catch(() => {});
    };
    recorder.start(5000);
    addEventListener('beforeunload', beforeUnload);
    timer = setInterval(() => { time.textContent = fmtTime((Date.now() - started) / 1000); }, 500);
    release = keepAwake();
    // مستوى الصوت يحرّك الشريط
    try {
      audioCtx = new AudioContext();
      const an = audioCtx.createAnalyser(); an.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        ctx.ribbon.set({ energy: 0.35 + Math.min(1, peak / 60) * 0.9, alpha: 1 });
        raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* اختياري */ }
    clear(btn).append(icon('stop'), 'إنهاء وتحويل');
    btn.classList.add('amber');
    discardBtn.hidden = false;
    clear(hint).append(h('span', { class: 'rec-dot' }), 'أسجّل الآن… يُحفظ على الجهاز أولاً بأول');
  }

  function stop(use) {
    clearInterval(timer);
    cancelAnimationFrame(raf);
    removeEventListener('beforeunload', beforeUnload);
    release?.();
    audioCtx?.close?.().catch(() => {});
    const rec = recorder;
    recorder = null;
    const finish = async () => {
      stream?.getTracks().forEach((t) => t.stop());
      // آخر القطع تُكتب على الجهاز، لكن لا ننتظر تخزيناً عالقاً أكثر من 3 ثوانٍ (التسجيل نفسه في الذاكرة)
      await Promise.race([saving, new Promise((r) => setTimeout(r, 3000))]);
      if (!use || !chunks.length) { if (recId) db.deleteRecording(recId).catch(() => {}); return; }
      const type = rec?.mimeType || chunks[0].type || 'audio/webm';
      const ext = /mp4/.test(type) ? 'm4a' : 'webm';
      const stamp = new Date(started).toLocaleString('en-GB', { hour12: false }).replace(/[/,: ]+/g, '-');
      const file = new File(chunks, `تسجيل-${stamp}.${ext}`, { type, lastModified: started });
      s.close();
      ctx.go('new', { file, recId });
    };
    if (rec && rec.state !== 'inactive') { rec.onstop = finish; rec.stop(); } else finish();
  }
}
