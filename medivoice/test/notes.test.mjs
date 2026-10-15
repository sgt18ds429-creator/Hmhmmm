// اختبارات الشرح المفصل والصور: النماذج والمصادر كلها وهمية، فلا يحتاج الاختبار مفاتيح ولا إنترنت.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, writeNotes, enrich, complete, normalizePlan, rewriteLecture, sameContent, pickFigures, PipelineError, qualityGate, refineChunk } from '../public/app/pipeline.js';
import { parseMarkup, blockText, countWords, uid, blocksToMarkup, bracketTerms, trimHeading, dialectLines } from '../public/app/text.js';
import { notesSectionPrompt } from '../public/app/prompts.js';
import { buildPdfHtml } from '../public/app/pdf.js';

// ── تفريغ محاضرة قصيرة بموضوعين ──
// نص حشو بلا تكرار: حارس التكرار يطوي الجمل والعبارات المكررة، فالحشو جمل مختلفة من مفردات متنوعة
const VOCAB = 'المريض الطبيب الفحص السريري العلامة العرض السبب العلاج الجرعة التشخيص الصورة الأشعة التحليل النتيجة المرحلة الحالة الطارئة المزمنة الحادة الأطفال البالغين الأعراض التاريخ المرضي العائلي الدواء الجراحة المتابعة المضاعفات الوقاية التغذية الوزن الطول الحرارة النبض الضغط التنفس القلب الرئة الكبد الكلية'.split(' ');
const filler = (sentence, n) => {
  let x = 7 + sentence.length;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x; };
  return Array.from({ length: n }, () => {
    const len = 7 + (rnd() % 3); // 7 إلى 9 كلمات كالجمل الأصلية
    const words = [];
    while (words.length < len) { const w = VOCAB[rnd() % VOCAB.length]; if (w !== words[words.length - 1]) words.push(w); }
    return `${sentence.split(' ')[0]} ${words.join(' ')}. `;
  }).join('');
};
const TRANSCRIPT_MD = `## مقدمة
السلام عليكم شباب، اليوم راح نحجي عن الـ [[pneumothorax]] والـ [[pleural effusion]].

الـ [[pneumothorax]] هو دخول هواء للـ [[pleural space]]، وأهم علامة بالأشعة هي الـ [[visceral pleural line]] وما نشوف [[lung markings]] وراها. ${filler('هذا كلام شرح طويل عن الحالة والأسباب والعلاج. ', 30)}

> هذي تجي بالامتحان: [[tension pneumothorax]] حالة طارئة.

## الانصباب الجنبي
الـ [[pleural effusion]] هو تجمع سائل، ويبين كـ [[meniscus sign]] و [[blunting]] للـ [[costophrenic angle]]. ${filler('شرح إضافي عن السائل وكميته وأنواعه. ', 30)}`;

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
استرواح الصدر هو دخول الهواء إلى المسافة الجنبية [[pleural space]]. ${filler('وهذا شرح مفصل لكل ما قاله المحاضر عن الأسباب والعلامات والعلاج. ', 45)}

### العلامات على الأشعة
- ظهور خط الجنبة الحشوية [[visceral pleural line]]
- غياب العلامات الرئوية [[lung markings]] خلف الخط

@fig: radiograph | pneumothorax chest x-ray | pneumothorax | frontal chest radiograph with visible visceral pleural line | صورة أشعة صدر تُظهر [[pneumothorax]]

> [[tension pneumothorax]] حالة طارئة وتأتي بالامتحان.`,
  effusion: `## الانصباب الجنبي [[pleural effusion]]
الانصباب الجنبي تجمع سائل في المسافة الجنبية. ${filler('وهنا شرح مفصل للكمية والأنواع وما قاله المحاضر. ', 45)}

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
function makeIO({ section = (user, n) => null, verify = () => ({ choice: 'A', confidence: 0.9, caption: 'تعليق مطابق للصورة' }), plan = null, figPlan = null, proof = null, review = null, mcq = null } = {}) {
  const calls = { plan: 0, section: [], review: 0, glossary: 0, verify: [], proof: 0, audit: [], mcq: 0 };
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
      if (system.includes('شرحاً مكتوباً مفصلاً') || system.includes('ملخصات امتحانية')) {
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
      if (system.includes('مدقق لغوي') && proof) {
        calls.proof++;
        return gemResponse(proof(user.match(/<<<\n([\s\S]*)\n>>>/)[1]));
      }
      if (system.includes('تضع عنواناً لنص مفرّغ')) {
        calls.planner = (calls.planner || 0) + 1;
        return gemResponse(JSON.stringify(figPlan || { title: 'عنوان', figures: [] }));
      }
      if (system.includes('تختار الصور التوضيحية')) {
        // دفعة أشكال في طلب واحد: نفكّكها ونسأل verify عن كل شكل بصيغة الطلب المفرد
        const figs = [...user.matchAll(/الشكل (\d+)(?: \(قسم «([^»]*)»\))?:\n- الشرح الذي ستوضّحه: «([^»]*)»\n- المطلوب أن تُظهره: (.*)\n- نوعها المطلوب: .*\n- مرشحاتها: (.*)/g)];
        const picks = figs.map(([, n, sec, ctx, show, labels]) => {
          const single = `الشرح الذي ستوضّحه الصورة${sec ? ` (من قسم «${sec}»)` : ''}:\n«${ctx}»\n\nالمطلوب أن تُظهره الصورة: ${show}`;
          calls.verify.push({ user: single, images: labels.split('، ').length });
          const v = verify(single, calls.verify.length);
          const choice = String(v.choice || 'none');
          return { fig: Number(n), choice: /^[A-Z]$/i.test(choice) ? `${n}${choice.toUpperCase()}` : choice, confidence: v.confidence, caption: v.caption };
        });
        return gemResponse(JSON.stringify({ picks }));
      }
      if (system.includes('تراجع ملزمة')) {
        calls.audit.push(user);
        return gemResponse(JSON.stringify(review ? review(user) : { fixes: [], missing: [], verdict: 'جيدة' }));
      }
      if (system.includes('ممتحن') || system.includes('examiner')) {
        calls.mcq++;
        return gemResponse(JSON.stringify(mcq ? mcq(user) : { questions: Array.from({ length: 8 }, (_, i) => ({ q: `Question ${i + 1} about [[pneumothorax]]?`, options: ['A', 'B', 'C', 'D'], answer: i % 4, why: 'Because' })) }));
      }
      if (system.includes('medical translator') || system.includes('مترجم طبي')) {
        // ترجمة وهمية تحافظ على الترميز سطراً بسطر
        calls.translate = (calls.translate || 0) + 1;
        const src = user.match(/<<<\n([\s\S]*)\n>>>/)[1];
        const out = src.split('\n').map((line) => {
          const m = line.match(/^(#{2,3} |- |\d+\. |> )(.*)$/);
          if (m) return `${m[1]}EN ${m[2]}`;
          if (/^\|/.test(line) || !line.trim()) return line;
          return `EN ${line}`;
        }).join('\n');
        return gemResponse(out);
      }
      if (system.includes('metadata') || system.includes('بيانات ملزمة')) {
        calls.extras = (calls.extras || 0) + 1;
        const end = Math.max(user.indexOf('\nOutput'), user.indexOf('\nأخرج'));
        const data = JSON.parse(user.slice(user.indexOf('{'), end));
        return gemResponse(JSON.stringify({ title: `EN ${data.title}`, captions: data.captions.map((c) => `EN ${c}`) }));
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
  assert.deepEqual(doc.transcript.map(blockText), original.map(blockText), 'النص المفرّغ الأصلي محفوظ');
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
  assert.ok(text.includes('هو تجمع سائل'), 'تفريغ القسم موجود');
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
  const wants = calls.verify.map((v) => v.user.match(/المطلوب أن تُظهره الصورة: (.*)/)[1]);
  assert.equal(wants.length, 5, 'كل صورة تُفحص، والمرفوضة تُبحث مرة ثانية بعبارة أخرى');
  assert.equal(wants.filter((w) => w.includes('meniscus')).length, 1, 'المقبولة من أول جولة');
  assert.equal(wants.filter((w) => w.includes('parietal and visceral pleura')).length, 2);
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

test('بدون Gemini لا تُوضع صورة إلا بثقة عالية من العناوين', async () => {
  const { io } = makeIO();
  const wanted = [{ anchor: 'a', query: 'pneumothorax chest x-ray', alt: 'pneumothorax', kind: 'radiograph', show: 'pneumothorax', caption: 'أشعة', context: 'شرح' }];
  const judge = (confidence) => new Engine({ ...io, async groq() { return { ok: true, status: 200, data: { choices: [{ message: { content: JSON.stringify({ choice: 'A', confidence, caption: 'صورة' }) }, finish_reason: 'stop' }] } }; } },
    { ...CAPS, gemini: false, groq: true, groqModels: ['openai/gpt-oss-120b'] });
  assert.equal((await pickFigures(wanted, judge(0.6), io)).length, 0, 'ثقة متوسطة من العنوان فقط: لا صورة');
  assert.equal((await pickFigures(wanted, judge(0.9), io)).length, 1);
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
  assert.match(html, /Comprehensive/);
  assert.match(html, /روجعت كاملة|ملزمة/);
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
  assert.equal(calls.verify.length, 3, 'المقبولة مرة، والمرفوضة جولتان');
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
    return { ok: true, status: 200, data: { choices: [{ message: { content: `## قسم\n${filler('شرح مفصل جداً لكل ما ورد في هذا الجزء. ', 60)}` }, finish_reason: 'stop' }] } };
  };
  // تفريغ طويل: قسم واحد بنحو 1400 كلمة، يناسب Gemini لكنه أكبر من حد Groq
  const doc = transcriptDoc();
  doc.blocks = parseMarkup(Array.from({ length: 14 }, (_, i) => `فقرة ${i} [[pneumothorax]] ${filler('كلام عن [[pneumothorax]] وشرحه وأسبابه. ', 11)}`).join('\n\n')).map((b) => ({ id: uid(), ...b }));
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

test('الأقسام تُكتب معاً (6 مع مفتاح Gemini واحد) والصور والقاموس والمراجعة تعمل في نفس الوقت', async () => {
  const sections = Array.from({ length: 8 }, (_, i) => ({ from: i * 2, title: `موضوع ${i + 1}` }));
  const paras = Array.from({ length: 16 }, (_, i) => `فقرة ${i} عن [[topic ${Math.floor(i / 2)}]] ${filler('وشرح طويل لها. ', 30)}`);
  const doc = transcriptDoc();
  doc.blocks = parseMarkup(paras.join('\n\n')).map((b) => ({ id: uid(), ...b }));
  let inFlight = 0, maxWriting = 0;
  const { io } = makeIO({
    plan: { kind: 'lecture', title: 'T', sections },
    section: (user) => {
      const n = Number(user.match(/«موضوع (\d+)»/)[1]);
      return gemResponse(`## موضوع ${n}\n${'شرح مفصل جداً عن [[topic ' + (n - 1) + filler(']] وكل ما قيل فيه. ', 26)}\n\n@fig: diagram | topic ${n} diagram | topic | a diagram of topic ${n} | رسم`);
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
  assert.equal(maxWriting, 6, 'ستة أقسام في نفس الوقت');
  // القاموس يبدأ مع الصور، لا بعدها
  const order = [];
  const base2 = io.gemini;
  io.gemini = async (model, body) => {
    const system = body.systemInstruction?.parts?.[0]?.text || '';
    order.push(system.includes('قاموس') ? 'glossary' : system.includes('تختار الصور') ? 'figure' : system.includes('قائمة مراجعة') ? 'review' : 'other');
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
      ? `## استرواح الصدر\n[[pneumothorax]] هو دخول هواء إلى [[pleural space]]، وعلامته [[visceral pleural line]] مع غياب [[lung markings]]، و[[tension pneumothorax]] طارئ. ${filler('شرح مركز بلا تكرار. ', 30)}`
      : `## الانصباب الجنبي\n[[pleural effusion]] سائل يظهر بـ [[meniscus sign]] و[[blunting]] للـ [[costophrenic angle]]. ${filler('شرح مركز بلا تكرار. ', 30)}`),
  });
  const doc = transcriptDoc();
  await writeNotes(doc, new Engine(io, CAPS));
  assert.equal(calls.section.length, 2, 'طلب واحد لكل قسم');
});

test('التدقيق الإملائي يصحح الأخطاء دون أن يغير المحتوى', async () => {
  const typo = (md) => md.replace('تجمع سائل', 'تجمّع سائلل').replace('استرواح الصدر هو', 'استرواح الصدر هوو');
  const { io, calls } = makeIO({
    section: (user) => gemResponse(typo(user.includes('«استرواح الصدر»') ? SECTION_NOTES.pneumothorax : SECTION_NOTES.effusion)),
    proof: (md) => md.replace('سائلل', 'سائل').replace('هوو', 'هو'),
  });
  const doc = transcriptDoc();
  await writeNotes(doc, new Engine(io, CAPS));
  assert.equal(calls.proof, 2, 'كل قسم يُدقق');
  const text = doc.blocks.map(blockText).join(' ');
  assert.ok(!text.includes('سائلل') && !text.includes('هوو'), 'الأخطاء صُححت');
  assert.equal(doc.blocks.filter((b) => b.t === 'figreq').length, 3, 'طلبات الصور باقية');
  assert.ok(doc.blocks.some((b) => b.t === 'table'), 'الجدول باق');
});

test('إذا حذف المدقق أو غيّر المحتوى يُرفض تصحيحه ويبقى النص كما كُتب', async () => {
  const { io, calls } = makeIO({
    // المدقق «يختصر»: يحذف نقطة من القائمة ويغير صورة
    proof: (md) => md.replace(/^- غياب العلامات الرئوية.*$/m, '').replace('pneumothorax chest x-ray', 'lung x-ray'),
  });
  const doc = transcriptDoc();
  await writeNotes(doc, new Engine(io, CAPS));
  assert.equal(calls.proof, 2);
  const text = doc.blocks.map(blockText).join(' ');
  assert.ok(text.includes('غياب العلامات الرئوية'), 'النقطة المحذوفة باقية');
  assert.ok(doc.blocks.some((b) => b.t === 'figreq' && b.query === 'pneumothorax chest x-ray'));
});

test('sameContent يقبل تصحيح الإملاء ويرفض الحذف والإضافة', () => {
  const md = SECTION_NOTES.effusion;
  assert.equal(sameContent(md, md.replace('الانصباب الجنبي تجمع', 'الانصباب الجنبي تجمّع')), true);
  assert.equal(sameContent(md, md.replace('[[meniscus sign]] | سطح', '[[meniscus sign]] | سطح')), true);
  assert.equal(sameContent(md, md.replace(/^\| \[\[blunting.*$/m, '')), false, 'حذف صف من الجدول');
  assert.equal(sameContent(md, `${md}\n\n- نقطة جديدة لم يقلها المحاضر`), false, 'إضافة');
  assert.equal(sameContent(md, md.replace(/وهنا [^.]*\. /g, '')), false, 'اختصار الشرح');
});

test('الصور والتدقيق يجريان أثناء كتابة الأقسام الباقية ولا ينتظران نهايتها', async () => {
  // أقسام أكثر من عدد الكتّاب المتوازين (6) حتى تبقى أقسام تُكتب بعد انتهاء الأولى
  const sections = Array.from({ length: 10 }, (_, i) => ({ from: i * 2, title: `موضوع ${i + 1}` }));
  const doc = transcriptDoc();
  doc.blocks = parseMarkup(Array.from({ length: 20 }, (_, i) => `فقرة ${i} عن [[topic ${Math.floor(i / 2)}]] ${filler('وشرح طويل لها. ', 30)}`).join('\n\n')).map((b) => ({ id: uid(), ...b }));
  const log = [];
  const { io } = makeIO({
    plan: { kind: 'lecture', title: 'T', sections },
    section: (user) => {
      const n = Number(user.match(/«موضوع (\d+)»/)[1]);
      return gemResponse(`## موضوع ${n}\n${'شرح مفصل عن [[topic ' + (n - 1) + filler(']] وكل ما قيل فيه. ', 26)}\n\n@fig: diagram | topic ${n} diagram | topic ${n} | a diagram of topic ${n} | رسم`);
    },
    proof: (md) => md,
  });
  const base = io.gemini;
  io.gemini = async (model, body) => {
    const system = body.systemInstruction?.parts?.[0]?.text || '';
    const kind = system.includes('شرحاً مكتوباً مفصلاً') ? 'write' : system.includes('مدقق لغوي') ? 'proof' : system.includes('تختار الصور') ? 'verify' : 'other';
    log.push(`${kind}:start`);
    await new Promise((r) => setTimeout(r, kind === 'write' ? 80 : kind === 'proof' ? 20 : 10)); // كما في الواقع: الكتابة أطول بكثير
    const res = await base(model, body);
    log.push(`${kind}:end`);
    return res;
  };
  const engine = new Engine(io, CAPS);
  await writeNotes(doc, engine);
  const lastWrite = log.lastIndexOf('write:end');
  assert.ok(log.indexOf('verify:start') < lastWrite, 'فحص الصور بدأ قبل انتهاء الكتابة');
  assert.ok(log.indexOf('proof:end') > log.indexOf('write:start', log.indexOf('proof:start')), 'العامل لم ينتظر التدقيق');
  await complete(doc, engine, { io });
  assert.ok(doc.blocks.filter((b) => b.t === 'fig').length >= 6, 'صور مطابقة للأقسام');
});

test('عند تجاوز الوقت المسموح تُترك الأعمال الإضافية ولا تتعطل الملزمة', async () => {
  const { io, calls } = makeIO({
    section: () => gemResponse('## قسم\nشرح قصير جداً عن [[pneumothorax]].\n\n@fig: radiograph | pneumothorax chest x-ray | pneumothorax | chest radiograph | صورة'),
    proof: (md) => md,
  });
  const doc = transcriptDoc();
  const engine = new Engine(io, CAPS);
  engine.budgetMs = 1; // انتهى الوقت
  await new Promise((r) => setTimeout(r, 5));
  await writeNotes(doc, engine);
  await complete(doc, engine, { io });
  assert.equal(calls.section.length, 2, 'لا إعادة كتابة للأقسام القصيرة');
  assert.equal(calls.proof, 0, 'لا تدقيق');
  assert.equal(calls.verify.length, 0, 'لا بحث عن صور');
  assert.equal(doc.blocks.filter((b) => b.t === 'figreq').length, 0);
  assert.ok(doc.blocks.some((b) => b.t === 'h'), 'الملزمة نفسها مكتوبة');
});


// ───────────── المراجعة النهائية، الأسئلة، السلايدات ─────────────
import { applyReview, reviewNotes, detectSlideFigures, cleanBlockList, fallbackMarkup } from '../public/app/pipeline.js';

test('المراجعة النهائية تطبّق التصحيحات المطابقة فقط وتضيف الناقص تحت عنوانه', async () => {
  const blocks = parseMarkup(`## استرواح الصدر
### التعريف
استرواح الصدر هو دخول الهواء إلى [[plural space]].
- علامة [[visceral pleural line]]
## الانصباب الجنبي
الانصباب تجمع سائل، ونسبته 15%.`).map((b) => ({ id: uid(), ...b }));
  const { fixes, added } = applyReview(blocks, {
    fixes: [
      { find: '[[plural space]]', replace: '[[pleural space]]' },          // مصطلح: يُوحَّد في كل المواضع
      { find: 'ونسبته 15%', replace: 'ونسبته 50%' },                        // رقم يخالف المحاضر
      { find: 'جملة غير موجودة في الملزمة أصلاً', replace: 'x' },          // لا تطابق: تُتجاهل
      { find: 'الانصباب تجمع سائل', replace: 'إعادة كتابة طويلة جداً '.repeat(40) }, // إعادة كتابة: تُرفض
    ],
    missing: [
      { after: '## الانصباب الجنبي', add: '- أول علامة هي [[blunting]] للزاوية\n> [[meniscus sign]] تأتي بالامتحان' },
      { after: 'عنوان غير موجود', add: '- شيء' },
    ],
  });
  assert.equal(fixes, 2);
  assert.equal(added, 1);
  const md = blocksToMarkup(blocks);
  assert.ok(md.includes('[[pleural space]]') && !md.includes('plural space'));
  assert.ok(md.includes('ونسبته 50%'));
  assert.ok(md.includes('الانصباب تجمع سائل'), 'إعادة الكتابة رُفضت');
  assert.ok(md.endsWith('> [[meniscus sign]] تأتي بالامتحان'), 'الإضافة في آخر قسمها');
});

test('runLecture-like flow: المراجعة تُسجَّل في الإحصاءات وتظهر في الـ PDF', async () => {
  const { io, calls } = makeIO({ review: () => ({ fixes: [{ find: 'المسافة الجنبية [[pleural space]]', replace: 'المسافة الجنبية [[pleural space]] (بين الجنبتين)' }], missing: [], verdict: 'جيدة' }) });
  const doc = transcriptDoc();
  const engine = new Engine(io, CAPS);
  await writeNotes(doc, engine);
  await reviewNotes(doc, engine);
  assert.equal(calls.audit.length, 1);
  assert.match(calls.audit[0], /تفريغ المحاضرة/);
  assert.deepEqual([doc.stats.audit.fixes, doc.stats.audit.added], [1, 0]);
  assert.ok(doc.blocks.some((b) => blockText(b).includes('(بين الجنبتين)')));
  await complete(doc, engine, { io });
  assert.match(buildPdfHtml(doc, { paged: true }), /روجعت كاملة مقابل التسجيل/);
});

test('High-Yield: أسئلة MCQ في آخر الملزمة بدل قائمة المراجعة، وتظهر في الـ PDF مع مفتاح الإجابات', async () => {
  const { io, calls } = makeIO({ section: (user) => gemResponse(`## ${user.includes('«استرواح الصدر»') ? 'استرواح الصدر' : 'الانصباب الجنبي'}\n- نقطة عن [[pneumothorax]] و [[pleural effusion]] و [[meniscus sign]] و [[blunting]] و [[costophrenic angle]] و [[visceral pleural line]] و [[lung markings]] و [[pleural space]] و [[tension pneumothorax]].`) });
  const doc = transcriptDoc({ mode: 'highyield' });
  const engine = new Engine(io, CAPS);
  assert.equal(await writeNotes(doc, engine), true);
  assert.equal(doc.meta.mode, 'highyield');
  assert.ok(calls.section[0].includes('النقاط الامتحانية'), 'تعليمات High-Yield');
  await complete(doc, engine, { io });
  assert.equal(calls.mcq, 1);
  assert.equal(calls.review, 0, 'لا قائمة مراجعة');
  const qs = doc.blocks.filter((b) => b.t === 'mcq');
  assert.equal(qs.length, 8);
  assert.equal(qs[0].opts.length, 4);
  const html = buildPdfHtml(doc, { paged: true });
  assert.match(html, /High-Yield/);
  assert.match(html, /class="mcq/);
  assert.match(html, /Answer key/);
  assert.ok(!html.includes('?? '), 'الأسئلة لا تظهر بترميزها الخام');
});

test('Integrated: الخطة تأخذ السلايدات، والكاتب يطلب صور السلايدات، وتُقصّ من صفحاتها', async () => {
  const pages = [1, 2, 3, 4].map((n) => ({ page: n, text: `سلايد ${n} عن ${n <= 2 ? 'pneumothorax' : 'pleural effusion'}`, big: `data:image/jpeg;base64,BIG${n}`, w: 1400, h: 1000, small: { mime: 'image/jpeg', base64: `S${n}` } }));
  const seen = { plan: '', sections: [], slidesVision: 0, crops: [] };
  const { io } = makeIO({
    plan: { kind: 'lecture', title: 'T', sections: [{ from: 0, title: 'استرواح الصدر', points: '', pages: [1, 2] }, { from: 4, title: 'الانصباب الجنبي', points: '', pages: [3, 4] }] },
    section: (user) => {
      seen.sections.push(user);
      const first = user.includes('«استرواح الصدر»');
      return gemResponse(`## ${first ? 'استرواح الصدر' : 'الانصباب الجنبي'}\n${filler('شرح يدمج السلايد مع الكلام عن [[pneumothorax]] و [[pleural effusion]]. ', 30)}\n\n@slide: ${first ? 2 : 3} | ${first ? 'رسم من السلايد' : 'أشعة من السلايد'}`);
    },
  });
  const base = io.gemini;
  io.gemini = async (model, body) => {
    const system = body.systemInstruction?.parts?.[0]?.text || '';
    if (system.includes('تقسمها إلى أقسام')) seen.plan = body.contents[0].parts.map((p) => p.text || '').join('\n');
    if (system.includes('تفحص سلايدات')) { seen.slidesVision++; return gemResponse(JSON.stringify({ figures: [{ page: 2, box: [100, 100, 900, 900], what: 'رسم للجنبة', kind: 'diagram' }, { page: 3, box: [0, 0, 1000, 1000], what: 'أشعة انصباب', kind: 'radiograph' }] })); }
    return base(model, body);
  };
  io.cropImage = async (dataUrl, box) => { seen.crops.push({ dataUrl, box }); return { mime: 'image/jpeg', dataUrl: `${dataUrl}#crop`, base64: 'C', w: 800, h: 600 }; };
  const doc = transcriptDoc({ mode: 'integrated' });
  doc.slides = { pages };
  const engine = new Engine(io, CAPS);
  assert.equal(await writeNotes(doc, engine), true);
  assert.equal(seen.slidesVision, 1, 'فحص السلايدات بالنظر مرة واحدة');
  assert.match(seen.plan, /سلايدات المحاضرة/);
  assert.match(seen.sections[0], /سلايدات هذا الجزء/);
  assert.match(seen.sections[0], /\[ص1\] سلايد 1/);
  assert.ok(!seen.sections[0].includes('[ص3]'), 'كل قسم يأخذ صفحاته فقط');
  assert.match(seen.sections[0], /ص2: رسم للجنبة/);
  await complete(doc, engine, { io });
  const figs = doc.blocks.filter((b) => b.t === 'fig');
  const fromSlides = figs.filter((f) => f.pick?.source === 'slides');
  assert.equal(fromSlides.length, 2);
  assert.deepEqual(seen.crops.map((c) => c.dataUrl), ['data:image/jpeg;base64,BIG2', 'data:image/jpeg;base64,BIG3']);
  assert.deepEqual(seen.crops[0].box, [100, 100, 900, 900]);
  assert.equal(fromSlides[0].caption, 'رسم من السلايد');
  assert.equal(doc.blocks.filter((b) => b.t === 'slidereq').length, 0);
  const html = buildPdfHtml(doc, { paged: true });
  assert.match(html, /Integrated/);
  assert.match(html, /من ملف المحاضرة/);
});

test('detectSlideFigures يتجاهل الصفحات غير الموجودة والمربعات الصغيرة', async () => {
  const io = { sleep: async () => {}, async gemini() { return gemResponse(JSON.stringify({ figures: [{ page: 1, box: [10, 10, 30, 30], what: 'صغير' }, { page: 9, box: [0, 0, 1000, 1000], what: 'غير موجودة' }, { page: 2, box: [50, 50, 950, 950], what: 'شكل', kind: 'photo' }] })); } };
  const figs = await detectSlideFigures(new Engine(io, CAPS), [{ page: 1, small: { base64: 'a' } }, { page: 2, small: { base64: 'b' } }]);
  assert.deepEqual(figs.map((f) => [f.page, f.kind]), [[1, 'diagram'], [2, 'photo']]);
  assert.deepEqual(figs[0].box, [0, 0, 1000, 1000], 'المربع الصغير يصير الصفحة كلها');
});


test('الملزمة بلغتين: نسخة إنجليزية مترجمة بنفس العناوين، صورها تشير إلى صور الأصل، والـ PDF فيه الجزءان والأسئلة بالإنجليزية', async () => {
  const { io, calls } = makeIO();
  const doc = transcriptDoc({ mode: 'notes' });
  const engine = new Engine(io, CAPS);
  assert.equal(await writeNotes(doc, engine), true);
  await complete(doc, engine, { io });
  assert.ok(calls.translate >= 2, 'ترجمة قسم قسم');
  assert.equal(doc.alt?.lang, 'en');
  const heads = (l) => l.filter((b) => b.t === 'h').length;
  const body = doc.blocks.filter((b) => b.t !== 'mcq');
  assert.equal(heads(doc.alt.blocks), heads(body), 'نفس عدد العناوين (مع أهم النقاط)');
  assert.ok(doc.alt.blocks.some((b) => b.t === 'h' && /^EN /.test(b.text)));
  const figs = doc.blocks.filter((b) => b.t === 'fig');
  const altFigs = doc.alt.blocks.filter((b) => b.t === 'fig');
  assert.equal(altFigs.length, figs.length, 'كل صورة لها نظير في الترجمة');
  for (const f of altFigs) { assert.ok(figs.some((x) => x.id === f.ref)); assert.match(f.caption, /^EN /); }
  assert.ok(doc.alt.blocks.some((b) => b.box), 'أهم النقاط مترجمة داخل صندوق');
  assert.match(doc.alt.title, /^EN /);
  const html = buildPdfHtml(doc, { paged: true });
  assert.match(html, /النسخة العربية/);
  assert.match(html, /English edition/);
  assert.match(html, /data-dir="ltr"/);
  assert.match(html, /AR \+ EN/);
  assert.ok(html.indexOf('English edition') > html.indexOf('النسخة العربية'));
});

test('حارس التكرار: قسم خرج في حلقة تكرار يُطوى ويُعاد مرة بتنبيه، وبوابة الجودة تحذف الفقرات المكررة', async () => {
  const loop = `## استرواح الصدر\n${'هسة إحنا بال first session، '.repeat(40)}\n\n- [[pneumothorax]] دخول هواء.\n\n${Array.from({ length: 12 }, () => 'هذا abdominal pain، mid-abdomen، relieved by defecation.').join(' ')}`;
  let n = 0;
  const { io, calls } = makeIO({ section: (user) => (user.includes('«استرواح الصدر»') ? (++n === 1 ? gemResponse(loop) : null) : null) });
  const doc = transcriptDoc();
  const engine = new Engine(io, CAPS);
  assert.equal(await writeNotes(doc, engine), true);
  const pneumoCalls = calls.section.filter((u) => u.includes('«استرواح الصدر»'));
  assert.equal(pneumoCalls.length, 2, 'المحاولة الثانية بعد حلقة التكرار');
  assert.match(pneumoCalls[1], /كررت الجمل/);
  await complete(doc, engine, { io });
  const text = doc.blocks.map(blockText).join('\n');
  assert.ok(!/first session.*first session.*first session/.test(text), 'لا حلقة تكرار في الناتج');
  assert.ok(doc.stats.gate, 'بوابة الجودة سُجّلت');
  // فقرات مكررة تُحذف في البوابة
  doc.blocks.push({ id: uid(), t: 'p', text: 'فقرة مكررة تماماً عن الانصباب الجنبي وعلاماته الشعاعية' }, { id: uid(), t: 'p', text: 'فقرة مكررة تماماً عن الانصباب الجنبي وعلاماته الشعاعية' });
  const before = doc.blocks.length;
  const g = qualityGate(doc);
  assert.equal(doc.blocks.length, before - 1);
  assert.equal(g.duplicates + g.cycles, 1);
});


test('بوابة الجودة تطوي حواراً يعيد نفسه في حلقة (فقرات قصيرة متتالية)، وتبقي الحوار الطبيعي', () => {
  const blocks = [
    { id: uid(), t: 'h', level: 2, text: 'تاريخ التغذية' },
    { id: uid(), t: 'p', text: 'زين شنو ترضعه؟' },
    ...Array.from({ length: 7 }, () => [{ t: 'p', text: 'إي، كم مرة تعطيه؟' }, { t: 'p', text: 'أربعة.' }, { t: 'p', text: 'أربعة؟' }]).flat().map((b) => ({ id: uid(), ...b })),
    { id: uid(), t: 'p', text: 'أربعة.' },
    { id: uid(), t: 'p', text: 'زين نكمل بالوزن.' },
  ];
  const stat = { repeats: 0, duplicates: 0, empty: 0, cycles: 0 };
  const out = cleanBlockList(blocks, stat);
  assert.deepEqual(out.map((b) => b.text), ['تاريخ التغذية', 'زين شنو ترضعه؟', 'إي، كم مرة تعطيه؟', 'أربعة.', 'أربعة؟', 'أربعة.', 'زين نكمل بالوزن.']);
  assert.equal(stat.cycles, 18);
});

test('التفريغ المنسوخ احتياطاً يُقرأ: بلا تكرار، والأسطر القصيرة تُجمع في فقرات', () => {
  const source = ['زين شنو ترضعه؟', ...Array.from({ length: 6 }, () => ['كم مرة تعطيه؟', 'أربعة.']).flat(), 'هسه نقيس الوزن ونطلعه على الـ [[growth chart]].'].join('\n');
  const md = fallbackMarkup({ title: 'تاريخ التغذية', part: 1 }, source);
  const blocks = parseMarkup(md);
  assert.equal(blocks[0].t, 'h');
  assert.equal(blocks.filter((b) => b.t === 'p').length, 1, 'فقرة واحدة مقروءة');
  assert.equal((md.match(/كم مرة تعطيه/g) || []).length, 1);
});

test('المراجعة تعمل بالتوازي مع الترجمة، والقسم الذي صحّحته المراجعة يُترجم من جديد', async () => {
  const { io, calls } = makeIO({ review: () => ({ fixes: [{ find: 'دخول الهواء إلى المسافة الجنبية', replace: 'تجمّع الهواء في المسافة الجنبية' }], missing: [], verdict: 'جيدة' }) });
  const doc = transcriptDoc({ mode: 'notes' });
  const engine = new Engine(io, CAPS);
  assert.equal(await writeNotes(doc, engine), true);
  await complete(doc, engine, { io, review: true });
  assert.equal(calls.audit.length, 1, 'المراجعة جرت داخل complete');
  assert.equal(doc.stats.audit.fixes, 1);
  assert.ok(doc.blocks.some((b) => /تجمّع الهواء في المسافة الجنبية/.test(blockText(b))), 'التصحيح في النسخة العربية');
  assert.equal(doc.stats.retranslated, 1, 'قسم واحد أعيدت ترجمته');
  assert.ok(doc.alt.blocks.some((b) => /تجمّع الهواء في المسافة الجنبية/.test(blockText(b))), 'النسخة الثانية تحمل التصحيح (الترجمة الوهمية تبقي النص)');
});

test('ضغط متواصل على Gemini (503) أثناء الكتابة: يكمل Groq القسم بأجزاء صغيرة ولا يبقى نص مفرّغ خام', async () => {
  const { io } = makeIO();
  const origGemini = io.gemini;
  let sections503 = 0;
  io.gemini = async (model, body) => {
    const system = body.systemInstruction?.parts?.[0]?.text || '';
    if (system.includes('شرحاً مكتوباً مفصلاً')) { sections503++; return { ok: false, status: 503, data: { error: { message: 'high demand' } } }; }
    return origGemini(model, body);
  };
  const groqCalls = [];
  io.groq = async (body) => {
    const user = body.messages[1].content;
    groqCalls.push(user);
    const title = (user.match(/«([^»]+)»/) || [])[1] || 'قسم';
    return { ok: true, status: 200, data: { choices: [{ message: { content: `## ${title}\n${filler('شرح مكتوب بمحرك Groq عن [[pneumothorax]] و [[pleural effusion]]. ', 40)}` }, finish_reason: 'stop' }] } };
  };
  const doc = transcriptDoc();
  const engine = new Engine(io, { ...CAPS, groq: true, groqModels: ['openai/gpt-oss-120b'] });
  assert.equal(await writeNotes(doc, engine), true);
  assert.ok(sections503 > 0, 'Gemini جُرّب أولاً');
  assert.ok(groqCalls.filter((u) => u.includes('تفريغ هذا الجزء')).length >= 2, 'Groq كتب الأقسام');
  assert.equal(doc.stats.fallback, 0, 'لا أقسام بقيت نصاً خاماً');
});

// ───────────── حارس التكرار: لا يمس القيم الحقيقية، ويكشف كل أشكال الحلقات، ولا يجمّد الصفحة ─────────────
import { collapseRepeats, collapseMarkup, inlineRuns, parseJsonLoose, stripMarkup } from '../public/app/text.js';

test('حارس التكرار يبقي القيم الحقيقية المتكررة ويطوي الحلقات الطويلة بسرعة', () => {
  for (const t of ['APGAR scored 2, 2, 2, 1, 2 = 9.', 'BP was 90/60, 90/60, 90/60 despite fluids.', 'Reflexes graded + + + on the right.', '| MCV | ↓ | ↓ | ↓ | N |']) {
    assert.equal(collapseRepeats(t), t, t);
  }
  assert.equal(collapseRepeats('إنت، إنت، إنت، إنت، إنت'), 'إنت');
  // الأقواس جزء من الكلمة: لا يُطوى المصطلح مع كلمة بلا أقواس فيضيع قوس الإغلاق
  assert.equal(collapseRepeats('الـ [[pneumothorax]] pneumothorax pneumothorax هو'), 'الـ [[pneumothorax]] pneumothorax pneumothorax هو');
  assert.equal(collapseRepeats('[[X]] [[X]] [[X]] و'), '[[X]] و');
  assert.equal(collapseRepeats('إنت إنت إنت روح، إنت إنت إنت روح، إنت إنت إنت روح.'), 'إنت روح.', 'حلقة متداخلة');
  assert.equal(collapseRepeats('قال: إنت، إنت، إنت. ثم سكت.'), 'قال: إنت. ثم سكت.');
  const clause = 'الألم يكون في منتصف البطن ويخف بعد التبرز ويزداد بعد الأكل';
  assert.equal(collapseRepeats(`${Array.from({ length: 15 }, () => clause).join('، ')}.`), `${clause}.`);
  // عبارة قصيرة مرتين متتاليتين تبقى (تأكيد طبيعي)، والطويلة (10 كلمات فأكثر) مرتين تُطوى
  assert.equal(collapseRepeats('the sound is lub-dub lub-dub at rest'), 'the sound is lub-dub lub-dub at rest');
  const long = 'الصورة الشعاعية تظهر خط الجنبة الحشوية بوضوح مع غياب العلامات الرئوية خلفه';
  assert.equal(collapseRepeats(`${long}، ${long}، ثم ننتقل للعلاج`), `${long}، ثم ننتقل للعلاج`);
  const t0 = Date.now();
  collapseRepeats('،'.repeat(40000)); collapseRepeats('.'.repeat(40000)); collapseRepeats('إنت، '.repeat(10000));
  stripMarkup('\n'.repeat(50000)); parseJsonLoose(`{"a":[${' '.repeat(40000)}`);
  assert.ok(Date.now() - t0 < 2000, `بطيء: ${Date.now() - t0}ms`);
});

test('الجداول تبقى سليمة: سطر الفاصل والقيم المتشابهة، والصف المكرر في حلقة يُحذف', () => {
  const md = ['| الخاصية | CT | MRI | US |', '| --- | --- | --- | --- |', '| إشعاع مؤين | نعم | نعم | لا |', '| MCV | ↓ | ↓ | ↓ |', '| MCH | ↓ | ↑ | ↓ |',
    '', '| الدواء | الجرعة |', '| --- | --- |', '| [[amoxicillin]] | 500 mg |', ...Array.from({ length: 20 }, () => '| [[ibuprofen]] | 400 mg كل 8 ساعات |')].join('\n');
  const out = collapseMarkup(md).text;
  const tables = parseMarkup(out).filter((b) => b.t === 'table');
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[0].head, ['الخاصية', 'CT', 'MRI', 'US']);
  assert.deepEqual(tables[0].rows, [['إشعاع مؤين', 'نعم', 'نعم', 'لا'], ['MCV', '↓', '↓', '↓'], ['MCH', '↓', '↑', '↓']]);
  assert.equal(tables[1].rows.length, 2, 'الصف المكرر عشرين مرة يبقى مرة');
  // البوابة: الصفوف المكررة في جدول محفوظ تُحذف أيضاً، والقيم تبقى
  const doc = { blocks: [{ id: uid(), t: 'table', head: ['a', 'b'], rows: [['x', '↓'], ['y', '↓'], ['x', '↓'], ['x', '↓']] }], stats: {} };
  const g = qualityGate(doc);
  assert.deepEqual(doc.blocks[0].rows, [['x', '↓'], ['y', '↓']]);
  assert.equal(g.duplicates, 2);
});

test('بوابة الجودة تكشف أشكال الحلقات الأخرى: عنوان+فقرة، بنود قصيرة، قائمة مرقمة، سؤال مكرر', () => {
  const md = `## الفحص\n${'### فحص الرأس\nننظر للوجه.\n\n'.repeat(8)}## الأعراض\n${'- حمى\n'.repeat(20)}\n## الخطوات\n${Array.from({ length: 12 }, (_, i) => `${i + 1}. فحص البطن`).join('\n')}\n\n## MCQs\n${'?? Which sign indicates [[pneumothorax]]?\na) Visceral pleural line\nb) Kerley B lines\nc) Air bronchogram\nd) Meniscus sign\n= a | Because\n\n'.repeat(2)}`;
  const doc = { blocks: parseMarkup(md).map((b) => ({ id: uid(), ...b })), stats: {} };
  qualityGate(doc);
  const shape = doc.blocks.map((b) => (b.items ? `${b.t}:${b.items.length}` : `${b.t}${b.level || ''}`));
  assert.deepEqual(shape, ['h2', 'h3', 'p', 'h2', 'ul:1', 'h2', 'ol:1', 'h2', 'mcq']);
});

test('المقاطع الإنجليزية المربوطة تبقى معاً في السطر العربي (AP/PA، [[CT]]/[[MRI]]، [[CT]] scan)', () => {
  const runs = (t) => inlineRuns(t, true).filter((r) => r.latin || r.group || r.term).map((r) => r.text);
  assert.deepEqual(runs('صورة AP/PA للصدر'), ['AP/PA']);
  assert.deepEqual(runs('مقطع T1/T2 والتركيز mg/dL وصبغة H&E'), ['T1/T2', 'mg/dL', 'H&E']);
  assert.deepEqual(runs('نطلب [[CT]]/[[MRI]] حسب الحالة'), ['CT/MRI']);
  assert.deepEqual(runs('نطلب [[CT]] scan للمريض'), ['CT scan']);
  assert.deepEqual(runs('نطلب [[CT]] أو [[MRI]]'), ['CT', 'MRI'], 'كلمة عربية بينهما: يبقيان منفصلين');
  assert.deepEqual(runs('قاعدة 3-6-9 والمدى 70 - 100 للسكر'), ['3-6-9', '70 - 100'], 'الأرقام المربوطة بشرطة بترتيبها');
  assert.deepEqual(parseMarkup('- > لتشخيص الانثقاب نطلب [[erect chest X-ray]]')[0].items, ['لتشخيص الانثقاب نطلب [[erect chest X-ray]]']);
  const html = buildPdfHtml({ meta: { title: 'x', mode: 'notes' }, blocks: [{ id: 'a', t: 'p', text: 'نطلب [[CT]]/[[MRI]] حسب الحالة' }], stats: {}, terms: [] });
  assert.match(html, /<span class="lt nw"><span class="t nw">CT<\/span>\/<span class="t nw">MRI<\/span><\/span>/);
});

test('المراجعة: التصحيح القصير الوارد في أكثر من موضع لا يُطبَّق، وتصحيح المصطلح يوحَّد بلا أقواس متداخلة', () => {
  const blocks = [
    { id: uid(), t: 'ul', items: ['[[amoxicillin]] يعطى 500 mg كل 8 ساعات.', '[[paracetamol]] يعطى 500 mg كل 8 ساعات.'] },
    { id: uid(), t: 'p', text: 'الانصباب [[pleural effusion]] يظهر بعلامة الهلال، و pleural effusion الصغير لا يظهر.' },
    { id: uid(), t: 'p', text: 'دخول [[plural air]] للمسافة الجنبية، ثم [[plural air]] مرة أخرى.' },
  ];
  const r = applyReview(blocks, { fixes: [
    { find: '500 mg كل 8', replace: '875 mg كل 12' },
    { find: 'pleural effusion', replace: '[[pleural effusion]]' },
    { find: '[[plural air]]', replace: '[[pleural air]]' },
  ] });
  assert.equal(r.fixes, 2);
  assert.match(blocks[0].items[0], /500 mg كل 8/);
  assert.match(blocks[0].items[1], /500 mg كل 8/);
  assert.ok(!/\[\[\[\[/.test(blocks[1].text), blocks[1].text);
  assert.equal((blocks[1].text.match(/\[\[pleural effusion\]\]/g) || []).length, 2);
  assert.equal((blocks[2].text.match(/\[\[pleural air\]\]/g) || []).length, 2);
});

test('القسم الذي انزلق في حلقة ثم كُتب نظيفاً: تُعتمد المحاولة النظيفة لا الأطول', async () => {
  const loop = `## استرواح الصدر\n| الدواء | الجرعة |\n|---|---|\n${'| [[ibuprofen]] | 400 mg كل 8 ساعات |\n'.repeat(40)}\n${Array.from({ length: 30 }, () => 'الألم يكون في منتصف البطن ويخف بعد التبرز ويزداد بعد الأكل').join('، ')}`;
  let n = 0;
  const { io } = makeIO({ section: (user) => (user.includes('«استرواح الصدر»') ? (++n === 1 ? gemResponse(loop) : gemResponse(`${SECTION_NOTES.pneumothorax}\n\nعلامة نظيفة CLEANMARK.`)) : null) });
  const doc = transcriptDoc();
  const engine = new Engine(io, CAPS);
  assert.equal(await writeNotes(doc, engine), true);
  assert.equal(n, 2);
  const text = doc.blocks.map(blockText).join('\n');
  assert.match(text, /CLEANMARK/);
  assert.ok(!/ibuprofen/.test(text), 'المحاولة المتكررة لم تُعتمد');
});

test('الترجمة لا تسقط بصمت: الجزء الذي تعذّرت ترجمته يبقى بلغته مع تنبيه، والباقي مترجم', async () => {
  const { io } = makeIO();
  const orig = io.gemini;
  io.gemini = async (model, body) => {
    const system = body.systemInstruction?.parts?.[0]?.text || '';
    const user = body.contents[0].parts.map((p) => p.text || '').join('\n');
    if ((system.includes('medical translator') || system.includes('مترجم طبي')) && user.includes('الانصباب')) return { ok: false, status: 400, data: { error: { message: 'bad' } } };
    return orig(model, body);
  };
  const doc = transcriptDoc({ mode: 'notes' });
  const engine = new Engine(io, CAPS);
  assert.equal(await writeNotes(doc, engine), true);
  const notes = [];
  await complete(doc, engine, { io, emit: (e) => { if (e.type === 'note') notes.push(e.code); } });
  assert.ok(doc.alt, 'النسخة الثانية موجودة');
  assert.equal(doc.alt.partial, true);
  assert.ok(doc.alt.blocks.some((b) => b.t === 'note' && /could not be translated/.test(b.text)));
  assert.ok(doc.alt.blocks.some((b) => /^EN /.test(blockText(b))), 'الأجزاء الأخرى مترجمة');
  assert.ok(notes.includes('translate_partial'));
});

test('ضغط متواصل (503) على النماذج الدقيقة: ينزل للنموذج الخفيف بدل الاستسلام', async () => {
  const seen = [];
  // ساعة وهمية: الانتظار يقدّم الوقت (التهدئة تُحسب بـ Date.now)
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  const io = {
    sleep: async (ms) => { skew += ms; },
    async gemini(model) {
      seen.push(model);
      if (!/lite/.test(model)) return { ok: false, status: 503, data: { error: { message: 'The model is overloaded.' } } };
      return gemResponse('نص كامل من النموذج الخفيف');
    },
  };
  const engine = new Engine(io, { gemini: true, groq: false, geminiModels: ['gemini-strong-a', 'gemini-strong-b', 'gemini-x-lite'], groqModels: [], sttModels: [] });
  let r;
  try { r = await engine.gemini({ system: 's', parts: [{ text: 'u' }] }); } finally { Date.now = realNow; }
  assert.equal(r?.model, 'gemini-x-lite');
  assert.ok(seen.filter((m) => !/lite/.test(m)).length >= 3);
});

test('المراجعة لا تضيف كلام المحاضر بلهجته ولا ما هو موجود أصلاً، وتضيف الناقص فعلاً', () => {
  const blocks = parseMarkup(`## انسداد الأمعاء الغليظة
- التواء الأعور [[cecal volvulus]]: يتوسع الأعور [[dilated cecum]] وينتقل نحو الربع العلوي الأيسر [[left upper quadrant]].
- يكون فيها القولون متوسعاً.

## الخلاصة
- نقرأ الصورة بطريقة مرتبة.`).map((b) => ({ id: uid(), ...b }));
  const r = applyReview(blocks, {
    fixes: [{ find: 'يكون فيها القولون متوسعاً', replace: 'يكون فيها القولون متوسعاً بس هسة أكثر المراكز ما تطلبه' }],
    missing: [
      { after: 'انسداد الأمعاء الغليظة', add: 'وعندنا الـ [[cecal volvulus]] والـ [[dilated cecum]] يروح للـ [[left upper quadrant]].' },
      { after: 'الخلاصة', add: 'والمحاضرة الجاية راح تكون عن الـ [[barium studies]] فراجعوا الأناتومي.' },
      { after: 'انسداد الأمعاء الغليظة', add: '> متلازمة أوجيلفي [[Ogilvie syndrome]] توسع في القولون دون سبب ميكانيكي.' },
    ],
  }, { lang: 'ar' });
  assert.deepEqual(r, { fixes: 0, added: 1 });
  const text = blocks.map(blockText).join('\n');
  assert.match(text, /Ogilvie syndrome/);
  assert.ok(!/هسة|يروح للـ|الجاية/.test(text), text);
});

test('High-Yield: الأسئلة تُكتب بالتوازي، وتُعاد من الشرح المصحَّح فقط إذا غيّرته المراجعة', async () => {
  for (const [fixes, expected] of [[[], 1], [[{ find: 'دخول الهواء إلى المسافة الجنبية', replace: 'تجمّع الهواء في المسافة الجنبية' }], 2]]) {
    const { io, calls } = makeIO({ review: () => ({ fixes, missing: [], verdict: 'جيدة' }) });
    const doc = transcriptDoc({ mode: 'highyield' });
    const engine = new Engine(io, CAPS);
    assert.equal(await writeNotes(doc, engine), true);
    await complete(doc, engine, { io, review: true });
    assert.equal(calls.mcq, expected, `mcq calls with ${fixes.length} fixes`);
    assert.ok(doc.blocks.some((b) => b.t === 'mcq'));
  }
});

test('أسئلة MCQ بالإنجليزية حصراً: إذا كتبها النموذج بالعربية يعيدها، ثم يترجمها إن لزم', async () => {
  const arabic = { questions: Array.from({ length: 8 }, (_, i) => ({ q: `ما هي العلامة رقم ${i + 1} في [[pneumothorax]]؟`, options: ['خط الجنبة', 'خطوط كيرلي', 'هواء القصبات', 'علامة الهلال'], answer: i % 4, why: 'لأنها مذكورة في الشرح' })) };
  const english = { questions: Array.from({ length: 8 }, (_, i) => ({ q: `Which sign number ${i + 1} indicates [[pneumothorax]]?`, options: ['Pleural line', 'Kerley lines', 'Air bronchogram', 'Meniscus sign'], answer: i % 4, why: 'Because the notes say so' })) };
  // 1) الإعادة بتنبيه تكفي
  {
    const { io } = makeIO({ mcq: (user) => (/previous answer was in Arabic/.test(user) ? english : arabic) });
    const doc = transcriptDoc({ mode: 'highyield' });
    const engine = new Engine(io, CAPS);
    assert.equal(await writeNotes(doc, engine), true);
    await complete(doc, engine, { io });
    const qs = doc.blocks.filter((b) => b.t === 'mcq');
    assert.equal(qs.length, 8);
    assert.ok(qs.every((q) => /^Which sign/.test(q.q)), qs[0].q);
  }
  // 2) يصرّ على العربية: تُترجم الأسئلة نفسها ويبقى مفتاح الإجابة
  {
    const { io } = makeIO({ mcq: () => arabic });
    const orig = io.gemini;
    io.gemini = async (model, body) => {
      const system = body.systemInstruction?.parts?.[0]?.text || '';
      if (/translate exam MCQs/.test(system)) return gemResponse(JSON.stringify(english));
      return orig(model, body);
    };
    const doc = transcriptDoc({ mode: 'highyield' });
    const engine = new Engine(io, CAPS);
    assert.equal(await writeNotes(doc, engine), true);
    await complete(doc, engine, { io });
    const qs = doc.blocks.filter((b) => b.t === 'mcq');
    assert.equal(qs.length, 8);
    assert.ok(qs.every((q) => /^Which sign/.test(q.q)));
    assert.deepEqual(qs.map((q) => q.ans), arabic.questions.map((q) => q.answer));
  }
});

test('أسئلة MCQ تُراجَع مقابل الملزمة: المخالف يُصحَّح أو يُحذف', async () => {
  const { io } = makeIO();
  const orig = io.gemini;
  let checked = 0;
  io.gemini = async (model, body) => {
    const system = body.systemInstruction?.parts?.[0]?.text || '';
    if (/exam reviewer/.test(system)) {
      checked++;
      return gemResponse(JSON.stringify({ checks: [
        { n: 1, ok: false, fixed: { q: 'Which sign indicates [[pneumothorax]] correctly?', options: ['Visceral pleural line', 'Kerley B lines', 'Air bronchogram', 'Meniscus sign'], answer: 0, why: 'Per the notes.' } },
        { n: 2, ok: false, drop: true },
        { n: 3, ok: true },
      ] }));
    }
    return orig(model, body);
  };
  const doc = transcriptDoc({ mode: 'highyield' });
  const engine = new Engine(io, CAPS);
  assert.equal(await writeNotes(doc, engine), true);
  await complete(doc, engine, { io });
  const qs = doc.blocks.filter((b) => b.t === 'mcq');
  assert.equal(checked, 1);
  assert.equal(qs.length, 7, 'سؤال حُذف');
  assert.equal(qs[0].q, 'Which sign indicates [[pneumothorax]] correctly?');
  assert.equal(qs[0].ans, 0);
});

// رد Google عند نفاد الحصة اليومية لنموذج (كما يصل من الخادم)
const dayQuota = (model) => ({ ok: false, status: 429, retryAfter: null, data: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.',
  details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model } }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '79525s' }] } } });

test('حصة النماذج القوية تخلص بنص الملزمة: تكمل كلها بالخفيفة، بلا نص خام ولا ترجمة ناقصة ولا توقف', async () => {
  for (const mode of ['notes', 'highyield']) {
    const { io, calls } = makeIO();
    const inner = io.gemini;
    let strong = 0;
    const used = [];
    io.gemini = async (model, body, opts) => {
      used.push(model);
      if (!/lite/.test(model) && ++strong > 2) return dayQuota(model); // أول طلبين بالقوية ثم تخلص حصتها
      return inner(model, body, opts);
    };
    const notes = [];
    const doc = transcriptDoc({ mode });
    const engine = new Engine(io, { ...CAPS, geminiModels: ['gemini-strong-a', 'gemini-strong-b', 'gemini-x-lite'] });
    assert.equal(await writeNotes(doc, engine), true, mode);
    await complete(doc, engine, { io, review: true, emit: (e) => { if (e.type === 'note') notes.push(e.code); } });
    assert.equal(doc.stats.fallback, 0, `${mode}: كل الأقسام مكتوبة`);
    assert.equal(engine.gem.items[0].dead && engine.gem.items[1].dead, true, `${mode}: النماذج القوية تُركت لباقي المحاضرة`);
    assert.ok(used.lastIndexOf('gemini-strong-a') < used.length - 5, `${mode}: لا رجوع للقوية بعد نفادها`);
    assert.ok(doc.alt?.blocks?.length && !doc.alt.partial, `${mode}: الترجمة كاملة`);
    assert.deepEqual(notes, [], `${mode}: بلا تنبيه نقص`);
    assert.deepEqual(doc.stats.gate, { repeats: 0, duplicates: 0, empty: 0, cycles: 0 });
    if (mode === 'highyield') assert.ok(doc.blocks.filter((b) => b.t === 'mcq').length >= 4, 'أسئلة MCQ موجودة');
    else assert.ok(doc.blocks.some((b) => b.box), 'أهم النقاط موجودة');
    assert.ok(calls.section.length >= 2);
  }
});

test('بعد نفاد القوية والخفيفة في حد الدقيقة: Groq الجاهز يكتب بدل الانتظار، وإذا لم يتوفر يُنتظر Gemini', async () => {
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    const seen = [];
    const io = {
      sleep: async (ms) => { skew += ms; },
      async gemini(model) { seen.push(model); return gemResponse('نص من Gemini'); },
      async groq(body) { seen.push(body.model); return { ok: true, status: 200, data: { choices: [{ message: { content: 'نص من Groq' }, finish_reason: 'stop' }] } }; },
    };
    const engine = new Engine(io, { gemini: true, groq: true, geminiModels: ['gemini-strong', 'gemini-x-lite'], groqModels: ['openai/gpt-oss-120b'], sttModels: [] });
    engine.gem.items[0].dead = true; // خلصت حصة اليوم
    engine.gem.cool(engine.gem.items[1], 50_000); // الخفيفة في حد الدقيقة
    const r = await engine.write({ system: 's', user: 'u', lite: true });
    assert.equal(r.text, 'نص من Groq');
    assert.deepEqual(seen, ['openai/gpt-oss-120b']);
    // Groq أيضاً في تهدئة: ينتظر Gemini الخفيف (لا يستسلم)
    engine.llm.cool(engine.llm.items[0], 80_000);
    const r2 = await engine.write({ system: 's', user: 'u', lite: true });
    assert.equal(r2.text, 'نص من Gemini');
    assert.equal(seen.at(-1), 'gemini-x-lite');
  } finally { Date.now = realNow; }
});

test('المصطلح بين قوسين عاديين بعد كلام عربي يصير [[ ]] (كاتب Groq)، وما ليس مصطلحاً يبقى', () => {
  assert.equal(bracketTerms('يُعدّ تصوير الصدر (Chest X-ray) الأكثر طلباً، والتكبير ([[magnification]]) يكبّر القلب.'),
    'يُعدّ تصوير الصدر [[Chest X-ray]] الأكثر طلباً، والتكبير [[magnification]] يكبّر القلب.');
  assert.equal(bracketTerms('انظر (Fig. 2) و(e.g. CT) و(5 mm).'), 'انظر (Fig. 2) و(e.g. [[CT]]) و(5 mm).');
  assert.equal(bracketTerms('الـ PA view هو المعيار، والـ detector أمام المريض، والقطر 5 mm.'), 'الـ [[PA view]] هو المعيار، والـ [[detector]] أمام المريض، والقطر 5 mm.');
  assert.equal(bracketTerms('علامة القصبات الهوائية الهوائية [[air bronchogram]]'), 'علامة القصبات الهوائية [[air bronchogram]]');
  assert.equal(bracketTerms('قارن بين AP or PA في الصورة'), 'قارن بين [[AP]] or [[PA]] في الصورة');
  for (const keep of ['### أنواع الزوايا (Projections)', 'The heart (cardiac silhouette) is big.', '@fig: radiograph | chest (PA) | a | b | صورة (PA)', 'نص (this is a long english sentence inside parentheses here) هنا']) {
    assert.equal(bracketTerms(keep), keep);
  }
});

test('Groq للكتابة الطويلة: ينتظر أفضل نموذج إذا كانت تهدئته قصيرة بدل نموذج أضعف', async () => {
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    const seen = [];
    const io = {
      sleep: async (ms) => { skew += ms; },
      async groq(body) { seen.push(body.model); return { ok: true, status: 200, data: { choices: [{ message: { content: `نص ${body.model}` }, finish_reason: 'stop' }] } }; },
    };
    const engine = new Engine(io, { gemini: false, groq: true, geminiModels: [], groqModels: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'], sttModels: [] });
    engine.llm.cool(engine.llm.items[0], 6000); // حد الدقيقة: ثوانٍ
    const r = await engine.write({ system: 's', user: 'u' });
    assert.equal(r.model, 'openai/gpt-oss-120b');
    engine.llm.cool(engine.llm.items[0], 5 * 60_000); // تهدئة طويلة: الأضعف أفضل من الانتظار
    const r2 = await engine.write({ system: 's', user: 'u' });
    assert.equal(r2.model, 'qwen/qwen3.8-27b');
  } finally { Date.now = realNow; }
});

test('خلصت حصة Gemini كلها والعمل يكمل بـ Groq: تنبيه واحد للطالب، وبدون Groq لا تنبيه (شاشة الخطأ تكفي)', async () => {
  for (const groq of [true, false]) {
    const notes = [];
    const io = {
      sleep: async () => {},
      async gemini(model) { return dayQuota(model); },
      async groq() { return { ok: true, status: 200, data: { choices: [{ message: { content: 'نص من Groq' }, finish_reason: 'stop' }] } }; },
    };
    const engine = new Engine(io, { gemini: true, groq, geminiModels: ['gemini-strong', 'gemini-x-lite'], groqModels: groq ? ['openai/gpt-oss-120b'] : [], sttModels: [] }, (e) => { if (e.type === 'note') notes.push(e.code); });
    const r = await engine.write({ system: 's', user: 'u' });
    await engine.write({ system: 's', user: 'u' });
    assert.equal(engine.hasGemini, false);
    // تنبيه نفاد الدقيقة مرة، ثم نفاد Gemini كله مرة (فقط إذا كان Groq يكمل)
    if (groq) { assert.equal(r.text, 'نص من Groq'); assert.deepEqual(notes, ['strong_out', 'gemini_out']); }
    else { assert.equal(r, null); assert.deepEqual(notes, ['strong_out']); }
  }
});

test('Groq: انتظار أفضل نموذج مرتين على الأكثر ثم أي نموذج متاح (لا يضيع القسم بانتظار لا ينتهي)', async () => {
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    const seen = [];
    const io = {
      sleep: async (ms) => { skew += ms; },
      async groq(body) {
        seen.push(body.model);
        if (body.model === 'openai/gpt-oss-120b') return { ok: false, status: 429, retryAfter: 5, data: { error: { message: 'Rate limit reached on tokens per minute (TPM)' } } };
        return { ok: true, status: 200, data: { choices: [{ message: { content: `نص ${body.model}` }, finish_reason: 'stop' }] } };
      },
    };
    const engine = new Engine(io, { gemini: false, groq: true, geminiModels: [], groqModels: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'], sttModels: [] });
    const r = await engine.write({ system: 's', user: 'u' });
    assert.equal(r.model, 'qwen/qwen3.8-27b');
    assert.equal(seen.filter((m) => m === 'openai/gpt-oss-120b').length, 3, 'محاولة أولى + انتظاران');
  } finally { Date.now = realNow; }
});

test('العنوان العربي لا يحمل ترجمته الإنجليزية الكاملة، والمصطلح القصير بين قوسين يبقى', () => {
  assert.equal(trimHeading('التمييز بين الحصوات الوريدية والحصوات الحالبية (Differentiation Between Phleboliths and Ureteric Stones)'), 'التمييز بين الحصوات الوريدية والحصوات الحالبية');
  assert.equal(trimHeading('طرق التصوير الشعاعي (Projections)'), 'طرق التصوير الشعاعي (Projections)');
  assert.equal(trimHeading('Introduction (to the whole course here)'), 'Introduction (to the whole course here)');
});

test('كلام المحاضر بلهجته أو خطابه للطلبة يُكتشف ويُعاد بالفصحى سطراً بسطر، والفصحى لا تُمس', async () => {
  const md = `## الوضعيات\n\n> انتبهوا، بالـ [[AP view]] القلب يبين أكبر، فلا تشخصون [[cardiomegaly]] عليها.\n\nيعني هذا أن [[magnification]] يحدث في [[AP view]]. ${filler('شرح مفصل للوضعيات والتكبير. ', 60)}\n\n- قاعدة 3-6-9 تأتي بالامتحان، فاحفظوها زين.`;
  assert.deepEqual(dialectLines(md).map((x) => x.word), ['انتبهوا', 'فاحفظوها']);
  assert.deepEqual(dialectLines(filler('شرح مفصل للوضعيات والتكبير. ', 60)), [], 'الحشو الفصيح لا يُحسب عامية');
  const seen = [];
  const io = {
    sleep: async () => {},
    async gemini(model, body) {
      const user = body.contents[0].parts.map((p) => p.text || '').join('');
      seen.push(user);
      // الرد ناقص سطراً (السطر 1 فقط): لا يزحزح شيئاً، والسطر 2 يبقى كما هو
      if (seen.length === 1) return gemResponse(JSON.stringify({ lines: [{ n: 2, text: 'قاعدة 3-6-9 مهمة للامتحان.' }, { n: 1, text: 'يجب الانتباه إلى أن القلب يظهر أكبر في [[AP view]]، فلا يُشخَّص [[cardiomegaly]] عليها.' }] }));
      return gemResponse('{}');
    },
  };
  const engine = new Engine(io, { gemini: true, groq: false, geminiModels: ['gemini-x-lite'], groqModels: [], sttModels: [] });
  const sections = [{ from: 0, title: 'الوضعيات' }];
  const doc = transcriptDoc();
  const { io: base } = makeIO({ plan: { kind: 'lecture', title: 'T', sections }, section: () => gemResponse(md) });
  // الكتابة بالمحاكي العام، ثم طلب الفصحى بـ io أعلاه
  engine.io = { ...base, gemini: async (model, body) => (/عامية العراقية/.test(body.systemInstruction?.parts?.[0]?.text || '') ? io.gemini(model, body) : base.gemini(model, body)) };
  assert.equal(await writeNotes(doc, engine), true);
  const text = doc.blocks.map(blockText).join('\n');
  assert.match(text, /يجب الانتباه إلى أن القلب يظهر أكبر/);
  assert.doesNotMatch(text, /انتبهوا|فاحفظوها/);
  assert.ok(doc.blocks.some((b) => b.t === 'note'), 'سطر > بقي ملاحظة');
  assert.match(text, /يعني هذا أن/, 'الفصحى («يعني» بمعنى «يدل») لا تُمس');
  assert.equal(seen.length, 1, 'طلب واحد للأسطر كلها');
});

test('الرد الناقص لا يضع سطراً مكان غيره: كل سطر برقمه، والمفقود يبقى كما هو', async () => {
  const md = `## قسم\n\n- هسه الـ [[PA view]] هو المعيار.\n- [[AP view]] للمريض اللي ما يوكف.\n- شلون نعرف [[magnification]]؟\n\n${filler('شرح فصيح طويل. ', 50)}`;
  const io = {
    sleep: async () => {},
    async gemini(model, body) {
      const system = body.systemInstruction?.parts?.[0]?.text || '';
      if (/عامية العراقية/.test(system)) return gemResponse(JSON.stringify({ lines: [{ n: 3, text: 'كيف يُعرف [[magnification]]؟' }, { n: 1, text: 'يُعد [[PA view]] الوضعية المعيارية.' }] }));
      return gemResponse(md);
    },
  };
  const engine = new Engine(io, { gemini: true, groq: false, geminiModels: ['gemini-x-lite'], groqModels: [], sttModels: [] });
  const doc = transcriptDoc();
  const { io: base } = makeIO({ plan: { kind: 'lecture', title: 'T', sections: [{ from: 0, title: 'قسم' }] }, section: () => gemResponse(md) });
  engine.io = { ...base, gemini: (m, b) => (/عامية العراقية/.test(b.systemInstruction?.parts?.[0]?.text || '') ? io.gemini(m, b) : base.gemini(m, b)) };
  assert.equal(await writeNotes(doc, engine), true);
  const items = doc.blocks.find((b) => b.t === 'ul').items;
  assert.equal(items[0], 'يُعد [[PA view]] الوضعية المعيارية.');
  assert.equal(items[1], '[[AP view]] للمريض اللي ما يوكف.', 'السطر 2 بلا رد: يبقى ولا يأخذ رد غيره');
  assert.equal(items[2], 'كيف يُعرف [[magnification]]؟');
});

test('مفتاح مزوّد رُفض (ملغى) أثناء العمل: يكمل بالمزوّد الآخر مع تنبيه واحد، ولا يتوقف إلا إذا لم يبقَ غيره', async () => {
  const rejected = { ok: false, status: 401, data: { error: { message: 'Invalid API Key' } } };
  const gemOk = { ok: true, status: 200, data: { candidates: [{ content: { parts: [{ text: 'نص من Gemini' }] }, finishReason: 'STOP' }] } };
  const groqOk = { ok: true, status: 200, data: { choices: [{ message: { content: 'نص من Groq' }, finish_reason: 'stop' }] } };
  // Groq ملغى و Gemini يعمل
  let notes = [];
  let engine = new Engine({ sleep: async () => {}, async gemini() { return gemOk; }, async groq() { return rejected; }, async stt() { return rejected; } },
    { gemini: true, groq: true, geminiModels: ['gemini-strong'], groqModels: ['openai/gpt-oss-120b'], sttModels: ['whisper-large-v3'] }, (e) => { if (e.type === 'note') notes.push(e.code); });
  assert.equal((await engine.groq({ system: 's', user: 'u' })), null);
  assert.equal((await engine.whisper({ blob: new Blob(['x']), index: 0, ext: 'ogg' }, { sec: 10 })), null);
  assert.equal((await engine.write({ system: 's', user: 'u' })).text, 'نص من Gemini');
  assert.deepEqual(notes, ['key_groq_dead'], 'تنبيه واحد');
  assert.equal(engine.hasGroqLlm, false); assert.equal(engine.hasStt, false);
  // Gemini ملغى و Groq يعمل
  notes = [];
  engine = new Engine({ sleep: async () => {}, async gemini() { return { ok: false, status: 400, data: { error: { message: 'API key not valid. Please pass a valid API key.' } } }; }, async groq() { return groqOk; } },
    { gemini: true, groq: true, geminiModels: ['gemini-strong', 'gemini-x-lite'], groqModels: ['openai/gpt-oss-120b'], sttModels: [] }, (e) => { if (e.type === 'note') notes.push(e.code); });
  assert.equal((await engine.write({ system: 's', user: 'u' })).text, 'نص من Groq');
  assert.deepEqual(notes, ['key_gemini_dead']);
  // المزوّد الوحيد ملغى: خطأ قاطع (شاشة «مفتاح ما يشتغل»)
  engine = new Engine({ sleep: async () => {}, async gemini() { return rejected; } }, { gemini: true, groq: false, geminiModels: ['gemini-strong'], groqModels: [], sttModels: [] });
  await assert.rejects(engine.gemini({ system: 's', parts: [] }), (e) => e instanceof PipelineError && e.code === 'key_gemini');
  // نموذج Gemini محجوب عن الحساب (403 بلا ذكر المفتاح): يُترك ذلك النموذج وحده ويكمل الباقي
  notes = [];
  engine = new Engine({ sleep: async () => {}, async gemini(model) { return model === 'gemini-strong' ? { ok: false, status: 403, data: { error: { code: 403, message: 'Permission denied on resource project for model gemini-strong.', status: 'PERMISSION_DENIED' } } } : gemOk; } },
    { gemini: true, groq: false, geminiModels: ['gemini-strong', 'gemini-b'], groqModels: [], sttModels: [] }, (e) => { if (e.type === 'note') notes.push(e.code); });
  assert.equal((await engine.gemini({ system: 's', parts: [] })).text, 'نص من Gemini');
  assert.equal(engine.gem.alive.length, 1);
  assert.deepEqual(notes, [], 'لا تنبيه: Gemini ما زال يعمل');
  // نموذج Groq غير متاح لهذا الحساب (403 يذكر النموذج): يُترك النموذج وحده لا المفتاح
  engine = new Engine({ sleep: async () => {}, async groq(body) { return body.model === 'a' ? { ok: false, status: 403, data: { error: { message: 'The model `a` is not available for this account' } } } : groqOk; } },
    { gemini: false, groq: true, geminiModels: [], groqModels: ['a', 'b'], sttModels: [] });
  assert.equal((await engine.groq({ system: 's', user: 'u' })).text, 'نص من Groq');
  assert.equal(engine.llm.alive.length, 1);
});

test('انقطاع الشبكة (حالة 0) لا يُحسب ضغطاً على النموذج الدقيق ولا يهدّئه: بعد رجوع الشبكة يكمل بنفس النموذج', async () => {
  let calls = 0;
  const models = [];
  const io = { sleep: async () => {}, async gemini(model) { models.push(model); return ++calls <= 3 ? { ok: false, status: 0, data: null } : { ok: true, status: 200, data: { candidates: [{ content: { parts: [{ text: 'رجع' }] }, finishReason: 'STOP' }] } }; } };
  const engine = new Engine(io, { gemini: true, groq: false, geminiModels: ['gemini-strong', 'gemini-x-lite'], groqModels: [], sttModels: [] });
  const r = await engine.gemini({ system: 's', parts: [] });
  assert.equal(r.text, 'رجع');
  assert.deepEqual(models, ['gemini-strong', 'gemini-strong', 'gemini-strong', 'gemini-strong'], 'لم ينزل للخفيف ولم يترك النموذج');
  assert.equal(engine.strong5xx, 0);
});

test('حد الدقيقة يتكرر بلا نهاية: الاستدعاء يرجع بعد مدة الصبر بدل أن يدور دقائق', async () => {
  let t = 0;
  const minute = { ok: false, status: 429, data: { error: { message: 'quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { retryDelay: '20s' }] } } };
  const io = { sleep: async (ms) => { t += ms; }, activeNow: () => t, async gemini() { return minute; } };
  const engine = new Engine(io, { gemini: true, groq: false, geminiModels: ['gemini-strong'], groqModels: [], sttModels: [] });
  const r = await engine.gemini({ system: 's', parts: [], patienceMs: 60_000, strongWaitMs: 0 });
  assert.equal(r, null);
  assert.ok(t <= 200_000, `توقف خلال الصبر (${t}ms)`);
  assert.equal(engine.hasGemini, true, 'النموذج لم يُترك (حد دقيقة لا يوم)');
});


test('خطة JSON انقطعت قبل نهايتها: تبقى أقسامها المكتملة بدل قسم واحد', () => {
  const cut = '```json\n{"kind":"lecture","title":"الجفاف عند الأطفال","sections":[{"from":0,"title":"تقييم درجات الجفاف","points":"الدرجات"},{"from":6,"title":"خطة العلاج","points":"السوائل"},{"from":13,"title":"المتابعة","poi';
  const p = parseJsonLoose(cut);
  assert.equal(p.title, 'الجفاف عند الأطفال');
  assert.deepEqual(p.sections.map((x) => x.from), [0, 6]);
  assert.equal(parseJsonLoose('{"a": [1, 2'), null, 'لا كائن مكتمل داخله: لا شيء');
});

test('محاضرة طويلة بخطة من قسم واحد (أو بلا خطة): أقسام بالحجم وعنوان كل قسم يختاره كاتبه', () => {
  const paras = Array.from({ length: 60 }, (_, i) => ({ text: `فقرة ${i} ` + 'كلمة '.repeat(150), words: 150, h: false })); // 9000 كلمة
  for (const raw of [null, { kind: 'lecture', title: 'هستري', sections: [{ from: 0, title: 'كل المحاضرة', points: '' }] }]) {
    const plan = normalizePlan(raw, paras, 2400, 'ar');
    assert.ok(plan.titles.length >= 7 && plan.titles.length <= 10, `أقسام بالحجم (${plan.titles.length})`);
    assert.ok(plan.sections.every((s) => s.untitled && s.parts === 1));
    let at = 0;
    for (const s of plan.sections) { assert.equal(s.from, at); at = s.to; }
    assert.equal(at, paras.length);
    const { user } = notesSectionPrompt({ title: '' }, plan.sections[2], { lang: 'ar', outline: plan.titles, source: 'x', words: 1000 });
    assert.match(user, /عنوان تختاره أنت/);
    assert.doesNotMatch(user, /ابدأ بسطر العنوان: ## القسم 3/);
  }
  // محاضرة قصيرة بقسم واحد تبقى قسماً واحداً
  const short = normalizePlan(null, paras.slice(0, 8), 2400, 'ar');
  assert.equal(short.titles.length, 1);
  assert.ok(!short.sections[0].untitled);
});

test('استماع Gemini أسقط ربع الكلام: يُدمج مع النسخ الحرفي فيخرج المقطع كاملاً بلا علامة مراجعة', async () => {
  // جمل مختلفة الكلمات (نص متكرر يُعدّ حلقة تكرار لا كلاماً ناقصاً)
  const sentence = (i) => `${Array.from({ length: 9 }, (_, k) => `كلمة${i * 9 + k}`).join(' ')} [[${['pleural effusion', 'pneumothorax', 'CT', 'MRI', 'costophrenic angle'][i % 5]}]].`;
  const full = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ');            // 40 جملة كاملة (نسخ حرفي)
  const precise = Array.from({ length: 24 }, (_, i) => sentence(i)).join(' ');         // الاستماع سمع 60% فقط
  const calls = [];
  const io = {
    sleep: async () => {}, blobToBase64: async () => 'AAAA',
    async gemini(model, body) {
      const parts = body.contents[0].parts, text = parts.map((p) => p.text || '').join('\n');
      const kind = parts.some((p) => p.inline_data) ? (/Transcribe this audio/.test(text) ? 'tx' : 'listen') : /التفريغ \(أ\) الدقيق/.test(text) ? 'merge' : 'other';
      calls.push(`${kind}:${model}`);
      const out = kind === 'tx' ? full : kind === 'listen' ? precise : kind === 'merge' ? full.replace(/الجملة رقم/g, 'الجملة رقم') : 'x';
      return { ok: true, status: 200, data: { candidates: [{ content: { parts: [{ text: out }] }, finishReason: 'STOP' }] } };
    },
  };
  const engine = new Engine(io, { gemini: true, groq: false, geminiModels: ['gemini-strong', 'gemini-x-lite'], transcribeModels: ['gemini-tx'], groqModels: [], sttModels: [] });
  const chunk = { index: 1, blob: new Blob(['x']), ext: 'ogg', mime: 'audio/ogg', audioSec: 480, start: 3840, end: 4320 };
  const r = await refineChunk(engine, chunk, null, { title: '', mode: 'notes', style: 'verbatim' }, { first: false, last: false, exact: false });
  assert.equal(r.engine, 'gemini+merge');
  assert.equal(r.review, false, 'لا علامة مراجعة: الكلام كامل');
  assert.ok(countWords(r.markup) >= countWords(full) * 0.95, 'المقطع كامل');
  assert.ok(calls.some((c) => c.startsWith('merge:gemini-x-lite')), 'الدمج بنموذج خفيف (لا يستهلك حصة الدقيقة)');
  // الدمج فشل (خرج ناقصاً): النسخ الحرفي الكامل يُعتمد بدل الاستماع الناقص
  const io2 = { ...io, async gemini(model, body) { const r = await io.gemini(model, body); if (calls.at(-1).startsWith('merge')) r.data.candidates[0].content.parts[0].text = precise; return r; } };
  const engine2 = new Engine(io2, { gemini: true, groq: false, geminiModels: ['gemini-strong', 'gemini-x-lite'], transcribeModels: ['gemini-tx'], groqModels: [], sttModels: [] });
  const r2 = await refineChunk(engine2, chunk, null, { title: '', mode: 'notes', style: 'verbatim' }, { first: false, last: false, exact: false });
  assert.equal(r2.engine, 'gemini-tx');
  assert.ok(countWords(r2.markup) >= countWords(full) * 0.95, 'الكلام كله موجود');
});


test('طلب تجاوز 100 ثانية (524 من Cloudflare): النموذج البطيء يُهدّأ ويكمل غيره فوراً بدل إعادته مرتين', async () => {
  const calls = [];
  const io = { sleep: async () => {}, async gemini(model) { calls.push(model); return model === 'gemini-slow' ? { ok: false, status: 524, data: null } : { ok: true, status: 200, data: { candidates: [{ content: { parts: [{ text: 'تم' }] }, finishReason: 'STOP' }] } }; } };
  const engine = new Engine(io, { gemini: true, groq: false, geminiModels: ['gemini-slow', 'gemini-fast', 'gemini-x-lite'], groqModels: [], sttModels: [] });
  const r = await engine.gemini({ system: 's', parts: [] });
  assert.equal(r.text, 'تم');
  assert.deepEqual(calls, ['gemini-slow', 'gemini-fast'], 'محاولة واحدة على البطيء ثم التالي');
  assert.ok(engine.gem.items[0].until > Date.now(), 'البطيء في تهدئة');
});
