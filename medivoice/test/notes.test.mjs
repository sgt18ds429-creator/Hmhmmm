// اختبارات الشرح المفصل والصور: النماذج والمصادر كلها وهمية، فلا يحتاج الاختبار مفاتيح ولا إنترنت.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, writeNotes, enrich, complete, normalizePlan, rewriteLecture, PipelineError } from '../public/app/pipeline.js';
import { parseMarkup, blockText, countWords, uid } from '../public/app/text.js';
import { buildPdfHtml } from '../public/app/pdf.js';

// ── تفريغ محاضرة قصيرة بموضوعين ──
const TRANSCRIPT_MD = `## مقدمة
السلام عليكم شباب، اليوم راح نحجي عن الـ [[pneumothorax]] والـ [[pleural effusion]].

الـ [[pneumothorax]] هو دخول هواء للـ [[pleural space]]، وأهم علامة بالأشعة هي الـ [[visceral pleural line]] وما نشوف [[lung markings]] وراها. ${'هذا كلام شرح طويل عن الحالة والأسباب والعلاج. '.repeat(30)}

> هذي تجي بالامتحان: [[tension pneumothorax]] حالة طارئة.

## الانصباب الجنبي
الـ [[pleural effusion]] هو تجمع سائل، ويبين كـ [[meniscus sign]] و [[blunting]] للـ [[costophrenic angle]]. ${'شرح إضافي عن السائل وكميته وأنواعه. '.repeat(30)}`;

function transcriptDoc(meta = {}) {
  const blocks = parseMarkup(TRANSCRIPT_MD).map((b) => ({ id: uid(), ...b }));
  return {
    id: 'src', createdAt: 1, meta: { title: '', subject: 'الأشعة', images: true, glossary: true, ...meta }, duration: 600, blocks, terms: [],
    stats: { words: blocks.reduce((n, b) => n + countWords(blockText(b)), 0), chunks: 1, engines: { gemini: 1 }, review: [] },
  };
}

const SECTION_NOTES = {
  pneumothorax: `## استرواح الصدر [[pneumothorax]]
### التعريف
استرواح الصدر هو دخول الهواء إلى المسافة الجنبية [[pleural space]]. ${'وهذا شرح مفصل لكل ما قاله المحاضر عن الأسباب والعلامات والعلاج. '.repeat(45)}

### العلامات على الأشعة
- ظهور خط الجنبة الحشوية [[visceral pleural line]]
- غياب العلامات الرئوية [[lung markings]] خلف الخط

@fig: radiograph | pneumothorax chest x-ray | pneumothorax | frontal chest radiograph with visible visceral pleural line | صورة أشعة صدر تُظهر [[pneumothorax]]

> [[tension pneumothorax]] حالة طارئة وتأتي بالامتحان.`,
  effusion: `## الانصباب الجنبي [[pleural effusion]]
الانصباب الجنبي تجمع سائل في المسافة الجنبية. ${'وهنا شرح مفصل للكمية والأنواع وما قاله المحاضر. '.repeat(45)}

| العلامة | ما تعنيه |
|---|---|
| [[meniscus sign]] | سطح السائل المقعّر |
| [[blunting]] للزاوية [[costophrenic angle]] | أول علامة لتجمع السائل |

@fig: radiograph | pleural effusion meniscus sign | pleural effusion | chest radiograph showing a meniscus sign | صورة أشعة تُظهر [[meniscus sign]]
@fig: diagram | pleura anatomy diagram | pleura | labelled diagram of parietal and visceral pleura | رسم للجنبة`,
};

function gemResponse(text, finishReason = 'STOP') {
  return { ok: true, status: 200, data: { candidates: [{ content: { parts: [{ text }] }, finishReason }] }, retryAfter: null };
}

/** io وهمي: يرد على كل نوع طلب حسب نص التعليمات، ويسجّل الطلبات. */
function makeIO({ section = (user, n) => null, verify = () => ({ choice: 'A', confidence: 0.9, caption: 'تعليق مطابق للصورة' }), plan = null, figPlan = null } = {}) {
  const calls = { plan: 0, section: [], review: 0, glossary: 0, verify: [] };
  const io = {
    sleep: async () => {},
    blobToBase64: async () => '',
    async gemini(model, body) {
      const system = body.systemInstruction?.parts?.[0]?.text || '';
      const parts = body.contents[0].parts;
      const user = parts.map((p) => p.text || '').join('\n');
      if (system.includes('تقسمها إلى أقسام')) {
        calls.plan++;
        return gemResponse(JSON.stringify(plan || { kind: 'lecture', title: 'استرواح الصدر والانصباب الجنبي', sections: [{ from: 0, title: 'استرواح الصدر', points: 'التعريف والعلامات' }, { from: 4, title: 'الانصباب الجنبي', points: 'العلامات' }] }));
      }
      if (system.includes('شرحاً مكتوباً مفصلاً')) {
        calls.section.push(user);
        const custom = section(user, calls.section.length);
        if (custom) return custom;
        return gemResponse(user.includes('«استرواح الصدر»') ? SECTION_NOTES.pneumothorax : SECTION_NOTES.effusion);
      }
      if (system.includes('قائمة مراجعة')) {
        calls.review++;
        return gemResponse('- [[pneumothorax]] هو دخول الهواء للمسافة الجنبية.\n- [[tension pneumothorax]] حالة طارئة.\n- [[meniscus sign]] علامة الانصباب.\n- أول علامة للانصباب هي [[blunting]] للزاوية.');
      }
      if (system.includes('قاموس')) {
        calls.glossary++;
        return gemResponse(JSON.stringify({ terms: [{ en: 'Pneumothorax', ar: 'استرواح الصدر', def: 'هواء في المسافة الجنبية' }] }));
      }
      if (system.includes('تضع عنواناً لنص مفرّغ')) {
        calls.planner = (calls.planner || 0) + 1;
        return gemResponse(JSON.stringify(figPlan || { title: 'عنوان', figures: [] }));
      }
      if (system.includes('تختار صورة توضيحية')) {
        calls.verify.push({ user, images: parts.filter((p) => p.inline_data).length });
        return gemResponse(JSON.stringify(verify(user, calls.verify.length)));
      }
      return { ok: false, status: 400, data: { error: { message: 'unexpected prompt' } } };
    },
    async groq() { return { ok: false, status: 500, data: null }; },
    net: {
      async json(url) {
        if (url.includes('commons.wikimedia.org')) {
          const q = new URL(url).searchParams.get('gsrsearch');
          return { query: { pages: [0, 1, 2].map((k) => ({
            pageid: Math.abs([...q].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) + k, index: k, title: `File:${q.split(' filetype')[0]} ${k}.jpg`,
            imageinfo: [{ url: `https://upload.wikimedia.org/${encodeURIComponent(q)}/${k}.jpg`, thumburl: `https://upload.wikimedia.org/t/${encodeURIComponent(q)}/${k}.jpg`, width: 800, height: 600, mime: 'image/jpeg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:x', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } } }],
          })) } };
        }
        return { list: [], results: [] };
      },
    },
    async loadImage(c) { return { mime: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${Buffer.from(c.small).toString('base64')}`, base64: 'AAAA', w: 800, h: 600 }; },
  };
  return { io, calls };
}

const CAPS = { gemini: true, groq: false, geminiModels: ['gemini-test'], groqModels: [], sttModels: [] };

test('يكتب شرحاً مفصلاً مقسماً حسب المواضيع ويحتفظ بالنص المفرّغ', async () => {
  const { io, calls } = makeIO();
  const doc = transcriptDoc();
  const engine = new Engine(io, CAPS);
  const original = doc.blocks;
  assert.equal(await writeNotes(doc, engine), true);
  await complete(doc, engine, { io });
  assert.equal(calls.plan, 1);
  assert.equal(calls.section.length, 2);
  assert.equal(doc.meta.mode, 'notes');
  assert.equal(doc.meta.title, 'استرواح الصدر والانصباب الجنبي');
  assert.equal(doc.transcript, original, 'النص المفرّغ الأصلي محفوظ');
  const h2 = doc.blocks.filter((b) => b.t === 'h' && b.level === 2).map((b) => b.text);
  assert.deepEqual(h2, ['استرواح الصدر [[pneumothorax]]', 'الانصباب الجنبي [[pleural effusion]]', 'أهم النقاط للمراجعة']);
  assert.ok(doc.blocks.some((b) => b.t === 'table' && b.rows.length === 2), 'الجدول محفوظ');
  assert.equal(doc.blocks.filter((b) => b.t === 'figreq').length, 0, 'طلبات الصور تحوّلت لصور أو حُذفت');
  assert.equal(calls.verify.length, 3, 'كل طلب صورة فُحص');
  assert.equal(doc.blocks[doc.blocks.length - 1].box, true, 'قائمة المراجعة آخر شيء في الملزمة');
  const box = doc.blocks.find((b) => b.box);
  assert.ok(box && box.items.length === 4, 'قائمة المراجعة في الآخر');
  assert.equal(doc.stats.sections, 2);
  assert.equal(doc.stats.fallback, 0);
  // كل قسم يعرف خطة المحاضرة كاملة وموقعه منها
  assert.match(calls.section[0], /1\. استرواح الصدر {3}← القسم الحالي/);
  assert.match(calls.section[1], /2\. الانصباب الجنبي {3}← القسم الحالي/);
});

test('يعيد كتابة القسم إذا خرج مختصراً، ويقبل الأوفى', async () => {
  const { io, calls } = makeIO({
    section: (user, n) => (n === 1 ? gemResponse('## استرواح الصدر\nملخص قصير جداً عن [[pneumothorax]].') : null),
  });
  const doc = transcriptDoc();
  await writeNotes(doc, new Engine(io, CAPS));
  assert.equal(calls.section.length, 3, 'محاولة ثانية للقسم المختصر');
  const retried = calls.section.find((u) => u.includes('محاولتك السابقة كانت مختصرة'));
  assert.ok(retried, 'المحاولة الثانية تنبّه إلى الاختصار');
  assert.match(retried, /لم تذكر هذه المصطلحات/);
  assert.ok(countWords(doc.blocks.map(blockText).join(' ')) > 300);
});

test('القسم الذي تتعذّر كتابته يبقى نصه المفرّغ كاملاً ولا يضيع', async () => {
  const { io } = makeIO({
    section: (user) => (user.includes('«الانصباب الجنبي»') ? { ok: false, status: 400, data: { error: { message: 'bad request' } } } : null),
  });
  const doc = transcriptDoc();
  await writeNotes(doc, new Engine(io, CAPS));
  assert.equal(doc.stats.fallback, 1);
  const text = doc.blocks.map(blockText).join(' ');
  assert.ok(text.includes('شرح إضافي عن السائل وكميته وأنواعه'), 'تفريغ القسم موجود');
  assert.ok(doc.blocks.some((b) => b.t === 'h' && b.text === 'الانصباب الجنبي'));
});

test('بدون أي محرك متاح يتوقف بخطأ واضح بدل ملزمة فارغة', async () => {
  const { io } = makeIO();
  const doc = transcriptDoc();
  await assert.rejects(writeNotes(doc, new Engine(io, { ...CAPS, gemini: false })), (e) => e instanceof PipelineError && e.code === 'no_engine');
});

test('التسجيل غير التعليمي يبقى نصاً مفرّغاً', async () => {
  const { io, calls } = makeIO({ plan: { kind: 'other', title: 'أغنية', sections: [] } });
  const doc = transcriptDoc();
  const before = doc.blocks;
  assert.equal(await writeNotes(doc, new Engine(io, CAPS)), false);
  assert.equal(doc.blocks, before);
  assert.equal(calls.section.length, 0);
});

test('الصور: تُوضع فقط بعد التحقق بالنظر، والتعليق يصف الصورة المختارة', async () => {
  const { io, calls } = makeIO({
    verify: (user) => {
      const want = user.match(/المطلوب أن تُظهره الصورة: (.*)/)[1];
      if (want.includes('meniscus sign')) return { choice: 'B', confidence: 0.92, caption: 'أشعة صدر تُظهر [[meniscus sign]] بوضوح' };
      if (want.includes('parietal and visceral pleura')) return { choice: 'none', confidence: 0.2 };
      return { choice: 'A', confidence: 0.55, caption: 'غير متأكد' };
    },
  });
  const doc = transcriptDoc();
  const engine = new Engine(io, CAPS);
  await writeNotes(doc, engine);
  await enrich(doc, engine, { io });
  assert.equal(calls.verify.length, 3, 'كل صورة تُفحص');
  assert.ok(calls.verify.every((v) => v.images >= 1), 'الفحص يرى الصور نفسها');
  const figs = doc.blocks.filter((b) => b.t === 'fig');
  assert.equal(figs.length, 1, 'فقط الصورة المؤكدة (الثقة المنخفضة و none مرفوضتان)');
  assert.equal(figs[0].caption, 'أشعة صدر تُظهر [[meniscus sign]] بوضوح');
  assert.equal(figs[0].pick.title, 'pleural effusion meniscus sign 1', 'المرشح الثاني (B)');
  assert.equal(doc.blocks.filter((b) => b.t === 'figreq').length, 0, 'لا تبقى طلبات صور');
  // الصورة في موضع الشرح: بعد جدول علامات الانصباب
  const at = doc.blocks.indexOf(figs[0]);
  assert.equal(doc.blocks[at - 1].t, 'table');
  // سياق الفحص هو الشرح الذي قبل الصورة
  assert.match(calls.verify.find((v) => v.user.includes('meniscus')).user, /الانصباب الجنبي/);
  assert.equal(doc.terms.length, 1);
});

test('بدون Gemini لا تُوضع صورة إلا بثقة عالية من العناوين، وفشل الصور لا يُفشل الملزمة', async () => {
  const { io } = makeIO();
  const doc = transcriptDoc();
  await writeNotes(doc, new Engine(io, CAPS));
  const groqOnly = new Engine({ ...io, async groq() { return { ok: true, status: 200, data: { choices: [{ message: { content: JSON.stringify({ choice: 'A', confidence: 0.6 }) }, finish_reason: 'stop' }] } }; } }, { ...CAPS, gemini: false, groq: true, groqModels: ['openai/gpt-oss-120b'] });
  await enrich(doc, groqOnly, { io });
  assert.equal(doc.blocks.filter((b) => b.t === 'fig').length, 0);
  assert.equal(doc.blocks.filter((b) => b.t === 'figreq').length, 0);
});

test('تحويل ملزمة محفوظة إلى شرح ينشئ ملزمة جديدة ويبقي الأصل', async () => {
  const { io } = makeIO();
  const src = transcriptDoc();
  src.blocks.splice(2, 0, { id: 'oldfig', t: 'fig', caption: 'صورة قديمة خاطئة', img: { dataUrl: 'x' } });
  const snapshot = JSON.stringify(src);
  const out = await rewriteLecture({ doc: src, caps: CAPS, io });
  assert.equal(JSON.stringify(src), snapshot, 'الأصل لم يتغيّر');
  assert.notEqual(out.id, src.id);
  assert.equal(out.meta.mode, 'notes');
  assert.ok(!out.blocks.some((b) => b.id === 'oldfig'), 'الصور القديمة لا تُنقل');
  assert.ok(!out.transcript.some((b) => b.t === 'fig'));
  assert.ok(out.blocks.some((b) => b.t === 'fig'));
});

test('الخطة تغطي كل الفقرات بالترتيب وتقسم الطويل وتدمج القصير', () => {
  const paras = Array.from({ length: 40 }, (_, i) => ({ text: `فقرة ${i}`, words: i === 10 ? 20 : 100, h: i === 25 }));
  const plan = normalizePlan({ kind: 'lecture', title: 'T', sections: [{ from: 3, title: 'B' }, { from: 0, title: 'A' }, { from: 10, title: 'tiny' }, { from: 11, title: 'C' }, { from: 99, title: 'bad' }, { from: 'x' }] }, paras, 1500);
  // تغطية كاملة بلا فجوات ولا تداخل
  let at = 0;
  for (const s of plan.sections) { assert.equal(s.from, at); assert.ok(s.to > s.from); at = s.to; }
  assert.equal(at, paras.length);
  assert.deepEqual(plan.titles, ['A', 'B', 'C'], 'القسم الصغير (20 كلمة) دُمج');
  const c = plan.sections.filter((s) => s.title === 'C');
  assert.ok(c.length >= 2 && c.every((s) => s.parts === c.length), 'القسم الطويل (2900 كلمة) جُزّئ');
  assert.ok(c.every((s) => paras.slice(s.from, s.to).reduce((n, p) => n + p.words, 0) <= 1500 * 1.15));
  // خطة فاسدة: أقسام احتياطية عند العناوين
  const fb = normalizePlan(null, paras, 1500, 'ar');
  assert.equal(fb.sections[0].from, 0);
  assert.ok(fb.sections.some((s) => s.from === 25));
});

test('ملف PDF يعرض الجداول وصندوق المراجعة ونوع الملزمة', async () => {
  const { io } = makeIO();
  const doc = transcriptDoc();
  const engine = new Engine(io, CAPS);
  await writeNotes(doc, engine);
  await complete(doc, engine, { io });
  const html = buildPdfHtml(doc, { paged: true });
  assert.match(html, /<table class="tbl" dir="rtl"><thead><tr><th dir="rtl">العلامة<\/th>/);
  assert.match(html, /<ul class="box" dir="rtl">/);
  assert.match(html, /ملزمة مشروحة/);
  assert.ok(!html.includes('@fig'));
});

test('Groq يرفض طلباً أكبر من حده: يرجع فوراً بدل الانتظار والمحاولة', async () => {
  let n = 0;
  const io = { sleep: async () => {}, async groq() { n++; return { ok: false, status: 413, data: { error: { message: 'Request too large for model on tokens per minute (TPM)' } } }; } };
  const engine = new Engine(io, { gemini: false, groq: true, groqModels: ['a', 'b'], geminiModels: [], sttModels: [] });
  assert.equal(await engine.groq({ system: 's', user: 'u' }), null);
  assert.equal(n, 2, 'محاولة واحدة لكل نموذج');
});

test('النص المفرّغ أيضاً: صوره تمر بالتحقق، والثقة المكتوبة بكلمة تُفهم', async () => {
  const doc = transcriptDoc();
  const at = doc.blocks.findIndex((b) => b.t === 'p' && b.text.includes('visceral pleural line'));
  const { io, calls } = makeIO({
    figPlan: { title: 'استرواح الصدر', figures: [
      { after: at, query: 'pneumothorax chest x-ray', alt: 'pneumothorax', kind: 'radiograph', show: 'chest radiograph with visceral pleural line', caption: 'أشعة' },
      { after: at + 1, query: 'tension pneumothorax', alt: '', kind: 'radiograph', show: 'tension pneumothorax with mediastinal shift', caption: 'أشعة' },
    ] },
    verify: (user) => (user.includes('mediastinal shift') ? { choice: 'none' } : { choice: 'B', confidence: 'high', caption: 'صورة مطابقة' }),
  });
  const engine = new Engine(io, CAPS);
  await enrich(doc, engine, { io });
  assert.equal(calls.planner, 1);
  assert.equal(calls.verify.length, 2);
  const figs = doc.blocks.filter((b) => b.t === 'fig');
  assert.equal(figs.length, 1);
  assert.equal(doc.blocks[doc.blocks.indexOf(figs[0]) - 1].text.includes('visceral pleural line'), true, 'بعد الفقرة التي تشرحها');
  assert.equal(doc.meta.title, 'استرواح الصدر');
});

test('الكتابة المنقطعة تكمل من المحفوظ بدون إعادة الطلبات', async () => {
  const store = new Map();
  const checkpoint = { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const first = makeIO();
  const a = transcriptDoc();
  await writeNotes(a, new Engine(first.io, CAPS), { checkpoint });
  assert.ok(store.has('n:plan') && store.has('n:s0') && store.has('n:s1'));
  const second = makeIO();
  const b = transcriptDoc();
  await writeNotes(b, new Engine(second.io, CAPS), { checkpoint });
  assert.equal(second.calls.plan, 0);
  assert.equal(second.calls.section.length, 0);
  assert.deepEqual(b.blocks.map((x) => x.t), a.blocks.map((x) => x.t));
});

test('إذا خلصت حصة Gemini أثناء الكتابة يكمل Groq بأجزاء أصغر', async () => {
  const { io } = makeIO();
  const groqUsers = [];
  io.groq = async (body) => {
    groqUsers.push(body.messages[1].content);
    return { ok: true, status: 200, data: { choices: [{ message: { content: `## قسم\n${'شرح مفصل جداً لكل ما ورد في هذا الجزء. '.repeat(60)}` }, finish_reason: 'stop' }] } };
  };
  // تفريغ طويل: قسم واحد بنحو 1400 كلمة، يناسب Gemini لكنه أكبر من حد Groq
  const doc = transcriptDoc();
  doc.blocks = parseMarkup(Array.from({ length: 14 }, (_, i) => `فقرة ${i} ${'كلام عن [[pneumothorax]] وشرحه وأسبابه. '.repeat(20)}`).join('\n\n')).map((b) => ({ id: uid(), ...b }));
  const plan = { kind: 'lecture', title: 'T', sections: [{ from: 0, title: 'كل المحاضرة' }] };
  const checkpoint = { get: async (k) => (k === 'n:plan' ? null : null), set: async () => {} };
  const engine = new Engine(io, { ...CAPS, groq: true, groqModels: ['openai/gpt-oss-120b'] });
  // الخطة تُكتب بحجم Gemini، ثم «تخلص حصته» قبل كتابة الأقسام
  const origGemini = io.gemini;
  io.gemini = async (model, body) => {
    const system = body.systemInstruction?.parts?.[0]?.text || '';
    if (system.includes('تقسمها إلى أقسام')) return gemResponse(JSON.stringify(plan));
    return { ok: false, status: 429, data: { error: { message: 'quota per day exceeded', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] }] } } };
  };
  assert.equal(await writeNotes(doc, engine, { checkpoint }), true);
  const sections = groqUsers.filter((u) => u.includes('تفريغ هذا الجزء'));
  assert.ok(sections.length >= 3, `كُتب على ${sections.length} أجزاء`);
  assert.ok(sections.every((u) => u.match(/<<<\n([\s\S]*?)\n>>>/)[1].split(/\s+/).length <= 520 * 1.15), 'كل جزء ضمن حد Groq');
  assert.ok(!sections[0].includes('تكملة مباشرة') && sections[0].includes('ابدأ بسطر العنوان'), 'الجزء الأول يبدأ بعنوان القسم');
  sections.slice(1).forEach((u, k) => assert.match(u, new RegExp(`هذا الجزء ${k + 2} من ${sections.length} من القسم نفسه`)));
  assert.equal(doc.stats.fallback, 0);
  io.gemini = origGemini;
});

test('الأقسام تُكتب معاً (3 مع Gemini) والصور والقاموس والمراجعة تعمل في نفس الوقت', async () => {
  const sections = Array.from({ length: 8 }, (_, i) => ({ from: i * 2, title: `موضوع ${i + 1}` }));
  const paras = Array.from({ length: 16 }, (_, i) => `فقرة ${i} عن [[topic ${Math.floor(i / 2)}]] ${'وشرح طويل لها. '.repeat(30)}`);
  const doc = transcriptDoc();
  doc.blocks = parseMarkup(paras.join('\n\n')).map((b) => ({ id: uid(), ...b }));
  let inFlight = 0, maxWriting = 0;
  const { io } = makeIO({
    plan: { kind: 'lecture', title: 'T', sections },
    section: (user) => {
      const n = Number(user.match(/«موضوع (\d+)»/)[1]);
      return gemResponse(`## موضوع ${n}\n${'شرح مفصل جداً عن [[topic ' + (n - 1) + ']] وكل ما قيل فيه. '.repeat(26)}\n\n@fig: diagram | topic ${n} diagram | topic | a diagram of topic ${n} | رسم`);
    },
  });
  const base = io.gemini;
  io.gemini = async (model, body) => {
    const system = body.systemInstruction?.parts?.[0]?.text || '';
    const writing = system.includes('شرحاً مكتوباً مفصلاً');
    if (writing) { inFlight++; maxWriting = Math.max(maxWriting, inFlight); }
    await new Promise((r) => setTimeout(r, 15));
    try { return await base(model, body); } finally { if (writing) inFlight--; }
  };
  const engine = new Engine(io, CAPS);
  await writeNotes(doc, engine);
  assert.equal(maxWriting, 3, 'ثلاثة أقسام في نفس الوقت');
  // القاموس يبدأ مع الصور، لا بعدها
  const order = [];
  const base2 = io.gemini;
  io.gemini = async (model, body) => {
    const system = body.systemInstruction?.parts?.[0]?.text || '';
    order.push(system.includes('قاموس') ? 'glossary' : system.includes('تختار صورة') ? 'figure' : system.includes('قائمة مراجعة') ? 'review' : 'other');
    return base2(model, body);
  };
  await complete(doc, engine, { io });
  assert.ok(order.indexOf('glossary') < order.lastIndexOf('figure'), `الترتيب: ${order.join(',')}`);
  assert.ok(order.indexOf('review') < order.lastIndexOf('figure'), 'المراجعة لا تنتظر الصور');
  assert.equal(doc.blocks[doc.blocks.length - 1].box, true);
});

test('الشرح الأقصر من الكلام المنطوق (حذف الحشو والتكرار) لا يُعاد بلا داعٍ', async () => {
  // التفريغ نحو 330 كلمة لكل قسم، والشرح نحو 40% منه ويذكر كل المصطلحات
  const { io, calls } = makeIO({
    section: (user) => gemResponse(user.includes('«استرواح الصدر»')
      ? `## استرواح الصدر\n[[pneumothorax]] هو دخول هواء إلى [[pleural space]]، وعلامته [[visceral pleural line]] مع غياب [[lung markings]]، و[[tension pneumothorax]] طارئ. ${'شرح مركز بلا تكرار. '.repeat(30)}`
      : `## الانصباب الجنبي\n[[pleural effusion]] سائل يظهر بـ [[meniscus sign]] و[[blunting]] للـ [[costophrenic angle]]. ${'شرح مركز بلا تكرار. '.repeat(30)}`),
  });
  const doc = transcriptDoc();
  await writeNotes(doc, new Engine(io, CAPS));
  assert.equal(calls.section.length, 2, 'طلب واحد لكل قسم');
});

