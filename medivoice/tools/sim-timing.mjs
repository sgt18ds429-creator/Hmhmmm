// محاكاة زمن تحويل محاضرة طويلة بساعة افتراضية (ثوانٍ حقيقية قليلة): نماذج وهمية بأزمنة استجابة وحدود
// بالدقيقة قريبة من الحقيقة، لقياس هل تجهز الملزمة خلال 8 دقائق في كل حالة.
//   node tools/sim-timing.mjs [--min=60] [--scenario=strong|lite|overload|gemini-only] [--mode=notes|highyield]
import { openAsBlob, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLecture } from '../public/app/pipeline.js';
import { chunkAudio, probeAudio } from '../public/app/chunker.js';

const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');
const minutes = Number(opt('min', '60'));
const scenario = opt('scenario', 'strong');
const mode = opt('mode', 'notes');

// ── ساعة افتراضية: كل انتظار يُسجَّل ويُقدَّم الوقت إليه عند الهدوء ──
let vt = 1_800_000_000_000;
const t0 = vt;
Date.now = () => vt;
const timers = [];
const vsleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
  timers.push({ t: vt + Math.max(0, ms), resolve });
  timers.sort((a, b) => a.t - b.t);
});
async function drive(promise) {
  let done = false, out, err;
  promise.then((v) => { done = true; out = v; }, (e) => { done = true; err = e; });
  while (!done) {
    // قراءة الملف وتقطيعه عمل حقيقي (أجزاء من ميلي ثانية): يُترك ينتهي قبل تقديم الساعة
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 4));
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    if (done) break;
    if (timers.length) { const n = timers.shift(); vt = Math.max(vt, n.t); n.resolve(); }
    else await new Promise((r) => setTimeout(r, 1));
  }
  if (err) throw err;
  return out;
}

// ── نص وهمي متنوع (حتى لا يحسبه حارس التكرار حلقة) ──
let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const AR = 'المريض الطبيب الفحص العلامة السبب العلاج الجرعة التشخيص الصورة الأشعة النتيجة المرحلة الحالة المزمنة الحادة الأعراض الدواء المتابعة المضاعفات الوقاية القلب الرئة الكبد الكلية الطحال المعدة الأمعاء العظم المفصل الدم الضغط النبض الحرارة التنفس الوزن الطول الألم الورم الالتهاب العدوى'.split(' ');
const TERMS = ['pneumothorax', 'pleural effusion', 'cardiomegaly', 'consolidation', 'atelectasis', 'mediastinum', 'costophrenic angle', 'air bronchogram', 'silhouette sign', 'Kerley B lines', 'hilum', 'trachea', 'diaphragm', 'pericardial effusion', 'aortic knuckle', 'bronchiectasis', 'emphysema', 'fibrosis', 'nodule', 'cavitation'];
const sentence = () => { const n = 9 + Math.floor(rand() * 9); const w = []; for (let i = 0; i < n; i++) w.push(rand() < 0.12 ? `[[${TERMS[Math.floor(rand() * TERMS.length)]}]]` : AR[Math.floor(rand() * AR.length)]); return `${w.join(' ')}.`; };
const paragraph = (words) => { const out = []; let n = 0; while (n < words) { const s = sentence(); out.push(s); n += s.split(' ').length; } return out.join(' '); };

// ── أزمنة الاستجابة (ثوانٍ) وحدود الطلبات بالدقيقة لكل نموذج ──
const tier = (m) => (/transcribe/.test(m) ? 'tx' : /lite/.test(m) ? 'lite' : 'strong');
const LAT = {
  listen: { strong: 38, lite: 16, tx: 22 }, section: { strong: 45, lite: 22, groq: 12 }, plan: { strong: 22, lite: 9, groq: 6 },
  translate: { strong: 24, lite: 12, groq: 8 }, proof: { strong: 15, lite: 8 }, review: { strong: 55, lite: 26 },
  json: { strong: 12, lite: 7, groq: 5 }, other: { strong: 10, lite: 6, groq: 4 },
};
const RPM = { strong: 8, lite: 15, tx: 10, groq: 30, stt: 20 };
const windows = new Map();
function limited(model, rpm) {
  const w = (windows.get(model) || []).filter((t) => vt - t < 60_000);
  windows.set(model, w);
  if (w.length >= rpm) return Math.ceil((w[0] + 60_000 - vt) / 1000);
  w.push(vt);
  return 0;
}
const gemOk = (text) => ({ ok: true, status: 200, data: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }, retryAfter: null });
const perMinute = (retry) => ({ ok: false, status: 429, retryAfter: null, data: { error: { code: 429, message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${retry}s` }] } } });
const perDay = () => ({ ok: false, status: 429, retryAfter: null, data: { error: { code: 429, message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } } });
const overloaded = () => ({ ok: false, status: 503, retryAfter: null, data: { error: { code: 503, message: 'The model is overloaded.' } } });

function kindOf(system, parts) {
  if (parts.some((p) => p.inline_data) && !/تختار/.test(system)) return /Transcribe this audio/.test(JSON.stringify(parts.at(-1))) ? 'tx' : 'listen';
  if (/قاموس/.test(system)) return 'json';
  if (/تختار/.test(system) && parts.some((p) => p.inline_data)) return 'json';
  if (/تقسمها إلى أقسام/.test(system)) return 'plan';
  if (/شرحاً مكتوباً مفصلاً|ملخصات امتحانية/.test(system)) return 'section';
  if (/medical translator|مترجم طبي/.test(system)) return 'translate';
  if (/مدقق لغوي/.test(system)) return 'proof';
  if (/محرر تفريغ محاضرات/.test(system)) return 'merge';
  if (/تراجع ملزمة|reviewer of lecture notes|You review/.test(system)) return 'review';
  return 'json';
}
const between = (user) => (user.match(/<<<\n([\s\S]*)\n>>>/) || [])[1] || '';

function answer(kind, system, user) {
  if (kind === 'merge') { const m = user.match(/التفريغ \(ب\)[^\n]*\n<<<\n([\s\S]*?)\n>>>/); return m ? m[1] : user; }
  if (kind === 'listen' || kind === 'tx') {
    const paras = [];
    for (let i = 0; i < 12; i++) paras.push(paragraph(95));
    return paras.join('\n\n');
  }
  if (kind === 'plan') {
    const n = (user.match(/^\[\d+\]/gm) || []).length;
    const sections = [];
    for (let i = 0; i < n; i += 9) sections.push({ from: i, title: `قسم ${sections.length + 1} عن ${AR[sections.length % AR.length]}`, points: 'النقاط' });
    return JSON.stringify({ kind: 'lecture', title: 'محاضرة تجريبية طويلة', sections });
  }
  if (kind === 'section') {
    const src = (user.match(/\[\[[^\]]+\]\]/g) || []);
    const terms = [...new Set(src)].slice(0, 30).join(' و ');
    const words = Math.max(80, Math.round((user.split(/\s+/).length - 300) * 0.55));
    const fig = /@fig/.test(system) ? `\n\n@fig: radiograph | chest x-ray ${Math.floor(rand() * 999)} | chest x-ray | frontal chest radiograph | صورة أشعة للصدر` : '';
    return `## قسم مكتوب\n\n${paragraph(Math.round(words * 0.4))}${fig}\n\n- ${sentence()} ${terms}\n- ${sentence()}\n- ${sentence()}\n\n> انتبهوا، ${sentence()}\n\n### تفصيل\n\n${paragraph(Math.round(words * 0.45))}`;
  }
  if (kind === 'translate') {
    return between(user).split('\n').map((line) => {
      const m = line.match(/^(#{2,3} |- |\d+\. |> )(.*)$/);
      if (m) return `${m[1]}EN ${m[2]}`;
      if (/^\|/.test(line) || !line.trim()) return line;
      return `EN ${line}`;
    }).join('\n');
  }
  if (kind === 'proof') return between(user);
  if (kind === 'review') return JSON.stringify({ fixes: [], missing: [], verdict: 'جيدة' });
  if (/examiner|ممتحن/.test(system)) return JSON.stringify({ questions: Array.from({ length: 10 }, (_, i) => ({ q: `Question ${i + 1} about [[pneumothorax]]?`, options: ['Alpha', 'Beta', 'Gamma', 'Delta'], answer: i % 4, why: 'Because of the notes.' })) });
  if (/exam reviewer/.test(system)) return JSON.stringify({ checks: [] });
  if (/قاموس/.test(system)) return JSON.stringify({ terms: TERMS.map((t) => ({ en: t, ar: 'مصطلح', def: 'تعريف قصير' })) });
  if (/قائمة مراجعة/.test(system)) return Array.from({ length: 8 }, () => `- ${sentence()}`).join('\n');
  if (/تختار الصور/.test(system)) return JSON.stringify({ picks: [...user.matchAll(/الشكل (\d+)/g)].map((m) => ({ fig: Number(m[1]), choice: `${m[1]}A`, confidence: 0.9, caption: 'تعليق مطابق' })) });
  if (/تختار صورة/.test(system)) return JSON.stringify({ choice: 'A', confidence: 0.9, caption: 'تعليق مطابق' });
  if (/عامية العراقية/.test(system)) {
    const list = user.slice(user.indexOf('رقمه):') + 6);
    const lines = JSON.parse(list.slice(list.indexOf('['), list.indexOf('\n\n') > 0 ? list.indexOf('\n\n') : undefined));
    return JSON.stringify({ lines: lines.map((x) => ({ n: x.n, text: x.text.replace('انتبهوا، ', 'يجب الانتباه إلى أن ') })) });
  }
  return JSON.stringify({ ok: true });
}

const counts = { gemini: 0, groq: 0, stt: 0, r429: 0, r503: 0 };
const byKind = {}; // طلبات Gemini لكل مهمة ومستوى (strong/lite): لتقدير حصة اليوم
const io = {
  activeNow: () => vt,
  sleep: (ms, signal) => vsleep(ms, signal),
  blobToBase64: async () => 'AAAA',
  async stt(req) {
    counts.stt++;
    const wait = limited(req.model, RPM.stt);
    await vsleep(4000);
    if (wait) { counts.r429++; return { ok: false, status: 429, retryAfter: wait, data: { error: { message: 'rate limit' } } }; }
    const words = [];
    for (let i = 0; i < 1100; i++) words.push({ word: AR[Math.floor(rand() * AR.length)], start: i * 0.43, end: i * 0.43 + 0.3 });
    return { ok: true, status: 200, data: { text: words.map((w) => w.word).join(' '), words, segments: [{ start: 0, end: 480, avg_logprob: -0.2, no_speech_prob: 0.01, text: 'x' }], language: 'arabic' } };
  },
  async groq(body) {
    counts.groq++;
    const system = body.messages[0].content, user = body.messages[1].content;
    const k = kindOf(system, [{ text: user }]);
    if (process.env.SIM_TRACE) console.log(`   ${((vt - t0) / 1000).toFixed(0)}s groq ${body.model} ${k} ${system.slice(0, 40).replace(/\n/g, ' ')}`);
    const wait = limited(body.model, RPM.groq);
    await vsleep(((LAT[k] || LAT.other).groq || 6) * 1000);
    if (wait) { counts.r429++; return { ok: false, status: 429, retryAfter: wait, data: { error: { message: 'Rate limit reached on tokens per minute (TPM)' } } }; }
    const text = /مدقق تفريغ/.test(system) ? between(user) || user.slice(-2000) : answer(k, system, user);
    return { ok: true, status: 200, data: { choices: [{ message: { content: text }, finish_reason: 'stop' }] } };
  },
  async gemini(model, body) {
    counts.gemini++;
    const system = body.systemInstruction?.parts?.[0]?.text || '';
    const parts = body.contents[0].parts;
    const user = parts.map((p) => p.text || '').join('\n');
    const k = kindOf(system, parts);
    const t = tier(model);
    const fine = k !== 'json' ? k : /قاموس/.test(system) ? 'glossary' : /examiner|ممتحن/.test(system) ? 'mcq' : /exam reviewer/.test(system) ? 'mcqcheck' : /تختار/.test(system) ? 'figpick' : /lines|أسطر/.test(system) && /فصحى|formal/.test(system) ? 'formalize' : `json(${system.slice(0, 18).replace(/\n/g, ' ')})`;
    byKind[`${fine}:${t}`] = (byKind[`${fine}:${t}`] || 0) + 1;
    if (process.env.SIM_TRACE) console.log(`   ${((vt - t0) / 1000).toFixed(0)}s gemini ${model} ${k} ${system.slice(0, 40).replace(/\n/g, ' ')}`);
    if ((scenario === 'lite' || scenario === 'gemini-only') && t === 'strong') { await vsleep(500); counts.r429++; return perDay(); }
    if (scenario === 'overload' && t === 'strong' && rand() < 0.5) { await vsleep(8000); counts.r503++; return overloaded(); }
    const wait = limited(model, RPM[t]);
    if (wait) { await vsleep(400); counts.r429++; return perMinute(wait); }
    await vsleep(((LAT[k] || LAT.other)[t] || 10) * 1000);
    return gemOk(answer(k, system, user));
  },
  net: {
    async json(url) {
      await vsleep(700);
      if (url.includes('commons.wikimedia.org')) {
        const q = new URL(url).searchParams.get('gsrsearch') || 'x';
        return { query: { pages: [0, 1, 2].map((k) => ({ pageid: Math.floor(rand() * 1e9), index: k, title: `File:${q.split(' filetype')[0]} ${k}.jpg`,
          imageinfo: [{ url: `https://upload.wikimedia.org/${k}.jpg`, thumburl: `https://upload.wikimedia.org/t/${Math.floor(rand() * 1e9)}.jpg`, width: 800, height: 600, mime: 'image/jpeg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:x', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } } }] })) } };
      }
      return { list: [], results: [] };
    },
  },
  async loadImage(c) { await vsleep(900); return { mime: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${Buffer.from(String(c.small)).toString('base64')}`, base64: 'AAAA', w: 800, h: 600 }; },
};

const file = join(tmpdir(), `sim-${minutes}min.mp3`);
if (!existsSync(file)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${minutes * 60}`, '-ac', '1', '-b:a', '24k', file]);
const blob = await openAsBlob(file);
Object.defineProperty(blob, 'name', { value: 'sim.mp3' });
const caps = {
  groq: scenario !== 'gemini-only', gemini: true,
  sttModels: ['whisper-large-v3', 'whisper-large-v3-turbo'],
  groqModels: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'],
  geminiModels: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
  transcribeModels: ['gemini-3.5-transcribe'],
};
const marks = [];
const emit = (e) => {
  if (e.type === 'stage') marks.push(`${((vt - t0) / 1000).toFixed(0)}s ${e.name}`);
  if (e.type === 'note') marks.push(`${((vt - t0) / 1000).toFixed(0)}s note:${e.code}`);
  if (process.env.SIM_TRACE && (e.type === 'part' || (e.type === 'section' && e.stage === 'done') || e.type === 'wait' || e.type === 'translate' || (e.type === 'chunk' && e.stage !== 'cut'))) console.log(`   ${((vt - t0) / 1000).toFixed(0)}s`, JSON.stringify(e).slice(0, 110));
};
const meta = { title: '', subject: 'الأشعة', lecturer: '', date: '2026-10-15', keywords: '', speech: 'ar', style: 'verbatim', mode, images: true, glossary: true };
// المقاطع تُقطع مسبقاً بالوقت الحقيقي (في المتصفح القص والضغط يجريان أثناء الاستماع للمقاطع السابقة)
const info = await probeAudio(blob);
const chunks = [];
for await (const c of chunkAudio(blob, { info, targetSec: 480, overlapSec: 3, maxBytes: 12.5 * 1024 * 1024 })) chunks.push(c);
const realStart = performance.now();
async function* cutting() { for (const c of chunks) { await vsleep(5000); yield c; } } // القص والضغط على الهاتف
const doc = await drive(runLecture({ file: blob, meta, cfg: { chunkSec: 480, overlapSec: 3, compress: false, chunks: cutting() }, caps, io, emit, checkpoint: null }));
const total = (vt - t0) / 1000;
if (args.includes('--json')) {
  const text = doc.blocks.map((b) => b.text || (b.items || []).join(' ')).join(' ');
  console.log(JSON.stringify({ scenario, mode, minutes, totalSec: Math.round(total), sections: doc.stats.sections, fallback: doc.stats.fallback, alt: doc.alt?.blocks?.length || 0, partial: !!doc.alt?.partial, audit: !!doc.stats.audit, mcq: doc.blocks.filter((b) => b.t === 'mcq').length, figs: doc.blocks.filter((b) => b.t === 'fig').length, figStats: process.env.SIM_FIGS ? doc.stats.figures : undefined, dialect: /انتبهوا/.test(text), counts, byKind }));
  process.exit(0);
}
console.log(`${scenario} · ${mode} · ${minutes} min audio → ${(total / 60).toFixed(1)} min (${total.toFixed(0)}s virtual, ${((performance.now() - realStart) / 1000).toFixed(1)}s real)`);
console.log('  stages:', marks.join(' | '));
console.log('  calls:', JSON.stringify(counts), '| sections', doc.stats.sections, '| fallback', doc.stats.fallback, '| alt', doc.alt?.blocks?.length || 0, doc.alt?.partial ? 'PARTIAL' : '', '| audit', doc.stats.audit ? 'yes' : 'skipped', '| mcq', doc.blocks.filter((b) => b.t === 'mcq').length);
