// تشغيل المسار الكامل على تسجيل من Node باتصال مباشر بالمزوّدين (لتجربة الدقة والسرعة خارج المتصفح).
//   GROQ_KEY=... GEMINI_KEY=... node tools/run-lecture.mjs <audio> [--mode=highyield|notes|integrated|transcript] [--engines=both|groq|gemini]
//                                [--chunk=600] [--pdf=slides.pdf (يحتاج playwright لقراءة PDF)] [--out=doc.json] [--subject=..] [--keywords=..]
//                                [--exhaust=strong@3,whisper@1,groq@0] (محاكاة نفاد الحصة اليومية بعد N طلبات)
import { openAsBlob } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runLecture } from '../public/app/pipeline.js';
import { blocksToMarkup } from '../public/app/text.js';
import { nodeIO, withQuota } from './node-io.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: node tools/run-lecture.mjs <audio> [--mode=..]'); process.exit(1); }
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');
const engines = opt('engines', 'both');
const mode = opt('mode', 'notes');
const chunkSec = Number(opt('chunk', '600'));
const out = opt('out', '');

const say = (m) => console.log(`   · ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${m}`);
const io = withQuota(nodeIO({ groqKey: process.env.GROQ_KEY, geminiKey: process.env.GEMINI_KEY, log: say }), opt('exhaust', ''), say);
const blob = await openAsBlob(file);
Object.defineProperty(blob, 'name', { value: path.basename(file) });

const meta = {
  title: '', subject: opt('subject', 'التصوير الشعاعي'), lecturer: opt('lecturer', ''), date: new Date().toISOString().slice(0, 10),
  keywords: opt('keywords', ''), speech: opt('speech', 'ar'), style: 'verbatim', mode, images: opt('images', 'yes') === 'yes', glossary: true,
};
const caps = {
  groq: engines !== 'gemini', gemini: engines !== 'groq',
  sttModels: ['whisper-large-v3', 'whisper-large-v3-turbo'],
  groqModels: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'],
  geminiModels: (opt('gemini', 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-3.1-flash-lite,gemini-3.5-flash-lite')).split(','),
  transcribeModels: opt('tx', 'gemini-3.5-transcribe') ? [opt('tx', 'gemini-3.5-transcribe')] : [],
};
const store = new Map();
const t0 = Date.now();
const doc = await runLecture({
  file: blob, meta, cfg: { chunkSec, overlapSec: 3 }, caps, io,
  checkpoint: { get: async (i) => store.get(i) || null, set: async (i, p) => store.set(i, p) },
  emit: (e) => {
    const t = `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
    if (e.type === 'part') console.log(`   ✓ ${t} part ${e.index} [${e.part.start.toFixed(0)}→${e.part.end.toFixed(0)}] ${e.part.engine} ${e.part.model} words=${e.part.words}${e.part.review ? ' REVIEW' : ''}`);
    else if (e.type === 'section' && e.stage === 'done') console.log(`   ✓ ${t} section ${e.index + 1}/${e.total} «${e.title}» ${e.fallback ? 'FALLBACK' : ''}`);
    else if (['stage', 'wait', 'note', 'plan', 'reviewed', 'images'].includes(e.type)) console.log(`   » ${t} ${JSON.stringify(e).slice(0, 160)}`);
  },
});
console.log(`\n===== ${mode} · ${engines} · ${((Date.now() - t0) / 1000).toFixed(1)}s · calls`, io.counts);
console.log('title:', doc.meta.title, '| mode:', doc.meta.mode, '| words:', doc.stats.words, '| sections:', doc.stats.sections, '| engines:', doc.stats.engines, '| audit:', JSON.stringify(doc.stats.audit || null));
console.log('\n' + blocksToMarkup(doc.blocks.filter((b) => b.t !== 'fig')).slice(0, 6000));
console.log('\n--- terms', doc.terms.length, '| figs', doc.blocks.filter((b) => b.t === 'fig').length, '| mcq', doc.blocks.filter((b) => b.t === 'mcq').length);
doc.blocks.forEach((b, i) => { if (b.t === 'fig') console.log(`  fig @${i} "${b.caption}" → ${b.pick?.source}: ${b.pick?.title} img=${b.img ? Math.round(b.img.dataUrl.length / 1024) + 'KB' : 'none'}`); });
if (out) { await writeFile(out, JSON.stringify(doc)); console.log('saved', out); }
