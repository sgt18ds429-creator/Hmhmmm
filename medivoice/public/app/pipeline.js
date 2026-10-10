// pipeline.js — مسار التحويل الكامل: تقطيع → Whisper (مسودة + توقيت) → Gemini (استماع وتدقيق)
// → لصق → قاموس المصطلحات → صور توضيحية.
// لا يعتمد على المتصفح مباشرة: كل اتصال يمر عبر كائن io حتى يُختبر في Node أيضاً.

import { chunkAudio, probeAudio, AudioError } from './chunker.js';
import {
  cleanWhisper, pickCut, wordsBetween, wordsToText, splitByWords, parseMarkup, joinChunks,
  countWords, collectTerms, blockText, stripMarkup, parseJsonLoose, uid,
} from './text.js';
import { whisperPrompt, audioPrompt, cleanupPrompt, glossaryPrompt, figuresPrompt, visionPickPrompt } from './prompts.js';
import { findCandidates } from './images.js';

export class PipelineError extends Error {
  constructor(code, message, extra = {}) { super(message || code); this.code = code; Object.assign(this, extra); }
}

const GEMINI_MAX_INLINE = 13 * 1024 * 1024; // حد الطلب 20MB بعد base64
const MIME = { m4a: 'audio/m4a', mp3: 'audio/mp3', ogg: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav' };
const SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map((category) => ({ category, threshold: 'BLOCK_NONE' }));

// ───────────── تدوير النماذج مع فترات التهدئة ─────────────

class Lanes {
  constructor(ids) { this.items = ids.map((id) => ({ id, until: 0, dead: false, plain: false })); }
  get alive() { return this.items.filter((m) => !m.dead); }
  pick(filter) {
    const now = Date.now();
    return this.items.find((m) => !m.dead && m.until <= now && (!filter || filter(m))) || null;
  }
  waitMs(filter) {
    const alive = this.alive.filter((m) => !filter || filter(m));
    if (!alive.length) return null;
    return Math.max(0, Math.min(...alive.map((m) => m.until)) - Date.now());
  }
  cool(m, ms) { m.until = Date.now() + ms; }
}

function fatalFromServer(res, provider) {
  const e = res.data?.error;
  const code = typeof e === 'string' ? e : '';
  if (res.status === 401 && ['locked', 'suspended', 'expired', 'device_mismatch'].includes(code)) return new PipelineError('locked', code);
  if (res.status === 429 && code === 'daily_limit') return new PipelineError('daily_limit', 'daily limit', { retryAfter: res.data.retry_after });
  if (res.status === 412) return new PipelineError(`key_${provider}`, 'no key');
  return null;
}

export class Engine {
  /**
   * @param io اتصالات (stt, groq, gemini, sleep, blobToBase64, loadImage, net)
   * @param caps { groq:boolean, gemini:boolean, sttModels, groqModels, geminiModels }
   * @param emit دالة أحداث التقدم
   */
  constructor(io, caps, emit = () => {}, signal) {
    this.io = io; this.caps = caps; this.emit = emit; this.signal = signal;
    this.stt = new Lanes(caps.groq ? caps.sttModels : []);
    this.llm = new Lanes(caps.groq ? caps.groqModels : []);
    this.gem = new Lanes(caps.gemini ? caps.geminiModels : []);
  }

  check() { if (this.signal?.aborted) throw new PipelineError('aborted', 'aborted'); }

  async pause(ms, what) {
    if (ms > 4000) this.emit({ type: 'wait', seconds: Math.ceil(ms / 1000), what });
    await this.io.sleep(ms, this.signal);
    this.check();
    if (ms > 4000) this.emit({ type: 'resume' });
  }

  get hasGemini() { return this.gem.alive.length > 0; }
  get hasGroqLlm() { return this.llm.alive.length > 0; }
  get hasStt() { return this.stt.alive.length > 0; }

  // ── Whisper ──
  /** @returns {Promise<object|null>} استجابة verbose_json أو null إذا تعذّر الآن */
  async whisper(chunk, { language, prompt, sec }) {
    let netFails = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      this.check();
      const m = this.stt.pick();
      if (!m) {
        const wait = this.stt.waitMs();
        if (wait === null) return null;
        // إذا الانتظار طويل ويوجد Gemini نكمل بدونه
        if (wait > 45_000 && this.hasGemini) return null;
        if (wait > 40 * 60_000) throw new PipelineError('rate_limit', 'groq audio limit', { retryAfter: Math.ceil(wait / 1000) });
        await this.pause(wait + 500, 'stt');
        continue;
      }
      const res = await this.io.stt({ blob: chunk.blob, filename: `part${chunk.index}.${chunk.ext}`, model: m.id, language, prompt }, { sec, signal: this.signal });
      if (res.ok && res.data && (res.data.words || res.data.segments || typeof res.data.text === 'string')) return res.data;
      const fatal = fatalFromServer(res, 'groq');
      if (fatal) throw fatal;
      if (res.status === 401 || res.status === 403) throw new PipelineError('key_groq', 'groq key rejected');
      if (res.status === 429) { this.stt.cool(m, Math.max(2, res.retryAfter || 20) * 1000); continue; }
      if (res.status === 404 || res.status === 400 && /model/i.test(JSON.stringify(res.data || ''))) { m.dead = true; continue; }
      if (res.status === 413 || res.status === 400) return null; // ملف غير مقبول عند Groq — نعتمد على Gemini
      if (++netFails > 3) return null;
      await this.pause(1500 * 2 ** netFails, 'net');
    }
    return null;
  }

  // ── Gemini ──
  /**
   * @returns {Promise<{text:string, model:string}|{blocked:true}|null>} null = لا يوجد نموذج متاح
   */
  async gemini({ system, parts, json = false, maxTokens = 8192, sec = 0, lite = false, temperature = 0 }) {
    // المهام المساعدة (نص/صور) تبدأ بالنماذج الخفيفة ثم الأقدم، حتى تبقى حصة أفضل النماذج للصوت
    const order = lite
      ? [...this.gem.items.filter((x) => /lite/.test(x.id)), ...this.gem.items.filter((x) => !/lite/.test(x.id)).reverse()]
      : this.gem.items;
    let netFails = 0, blocked = 0;
    for (let attempt = 0; attempt < 24; attempt++) {
      this.check();
      const now = Date.now();
      let m = order.find((x) => !x.dead && x.until <= now);
      if (!lite && m && /lite/.test(m.id)) {
        // الاستماع للصوت: النماذج الخفيفة أضعف بالمصطلحات واللهجة. إذا النماذج الدقيقة في تهدئة قصيرة
        // (حد الدقيقة) ننتظرها، ولا ننزل للخفيفة إلا إذا خلصت حصتها اليومية كلها.
        const strong = order.filter((x) => !x.dead && !/lite/.test(x.id));
        if (strong.length) {
          const wait = Math.min(...strong.map((x) => x.until)) - now;
          if (wait <= 75_000) { await this.pause(Math.max(wait, 0) + 400, 'gemini'); continue; }
        }
      }
      if (!m) {
        const wait = this.gem.waitMs();
        if (wait === null) return null;
        if (wait > 90_000) return null;
        await this.pause(wait + 500, 'gemini');
        continue;
      }
      const isLite = /lite/.test(m.id);
      const generationConfig = { temperature, maxOutputTokens: maxTokens };
      if (json) generationConfig.responseMimeType = 'application/json';
      if (!m.plain && /^gemini-3/.test(m.id)) generationConfig.thinkingConfig = { thinkingLevel: isLite ? 'minimal' : 'low' };
      const body = { contents: [{ role: 'user', parts }], generationConfig, safetySettings: SAFETY };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const res = await this.io.gemini(m.id, body, { sec, signal: this.signal });
      if (res.ok && res.data) {
        const cand = res.data.candidates?.[0];
        const text = (cand?.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
        const reason = cand?.finishReason || '';
        if (text.trim() && (reason === 'STOP' || reason === '' || reason === 'MAX_TOKENS')) return { text, model: m.id, truncated: reason === 'MAX_TOKENS' };
        // حجب أو رد فارغ: نجرب نموذجاً آخر مرة واحدة ثم نستسلم
        if (++blocked >= 2) return { blocked: true, reason: reason || res.data.promptFeedback?.blockReason || 'empty' };
        this.gem.cool(m, 60_000);
        continue;
      }
      const fatal = fatalFromServer(res, 'gemini');
      if (fatal) throw fatal;
      const err = res.data?.error || {};
      const msg = typeof err === 'object' ? String(err.message || '') : String(err);
      if (res.status === 429) {
        const details = Array.isArray(err.details) ? err.details : [];
        const perDay = details.some((d) => (d.violations || []).some((v) => /PerDay/i.test(v.quotaId || ''))) || /per day|daily/i.test(msg);
        const retry = details.map((d) => parseFloat(d.retryDelay)).find((x) => x > 0) || res.retryAfter || 20;
        if (perDay) m.dead = true; else this.gem.cool(m, (retry + 1) * 1000);
        continue;
      }
      if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg) || res.status === 401 || res.status === 403 && /key|permission/i.test(msg)) {
        throw new PipelineError('key_gemini', 'gemini key rejected');
      }
      if (res.status === 400 && /thinking/i.test(msg) && !m.plain) { m.plain = true; continue; }
      if (res.status === 404 || res.status === 400 && /not (found|supported)|no longer available/i.test(msg)) { m.dead = true; continue; }
      if (res.status === 400 || res.status === 413) return { blocked: true, reason: `bad_request: ${msg.slice(0, 120)}` };
      if (res.status === 503 || res.status === 500) { this.gem.cool(m, 8000); if (++netFails > 6) return null; continue; }
      if (++netFails > 4) return null;
      await this.pause(1200 * 2 ** netFails, 'net');
    }
    return null;
  }

  // ── نماذج Groq النصية ──
  async groq({ system, user, json = false, maxTokens = 3000, temperature = 0.1 }) {
    let netFails = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      this.check();
      const m = this.llm.pick();
      if (!m) {
        const wait = this.llm.waitMs();
        if (wait === null || wait > 120_000) return null;
        await this.pause(wait + 400, 'llm');
        continue;
      }
      const body = {
        model: m.id, temperature, max_completion_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      };
      if (json && !m.plain) body.response_format = { type: 'json_object' };
      if (!m.plain) {
        if (/gpt-oss/.test(m.id)) body.reasoning_effort = 'low';
        else if (/qwen/.test(m.id)) body.reasoning_effort = 'none';
      }
      const res = await this.io.groq(body, { signal: this.signal });
      if (res.ok && res.data) {
        const text = res.data.choices?.[0]?.message?.content;
        if (typeof text === 'string' && text.trim()) return { text, model: m.id };
        this.llm.cool(m, 20_000);
        continue;
      }
      const fatal = fatalFromServer(res, 'groq');
      if (fatal) throw fatal;
      if (res.status === 401 || res.status === 403) throw new PipelineError('key_groq', 'groq key rejected');
      if (res.status === 429) { this.llm.cool(m, Math.max(2, res.retryAfter || 15) * 1000); continue; }
      if (res.status === 413) { this.llm.cool(m, 30_000); continue; }
      if (res.status === 400 && !m.plain) { m.plain = true; continue; }
      if (res.status === 404 || res.status === 400) { m.dead = true; continue; }
      if (++netFails > 4) return null;
      await this.pause(1200 * 2 ** netFails, 'net');
    }
    return null;
  }

  /**
   * مهمة نصية ترجع JSON.
   * prefer: 'groq' (الافتراضي، يحفظ حصة Gemini للصوت) أو 'gemini-lite' (أدق بالمصطلحات العربية) أو 'gemini'.
   */
  async json({ system, user, maxTokens = 3500, prefer = 'groq' }) {
    const order = prefer.startsWith('gemini') ? ['gemini', 'groq'] : ['groq', 'gemini'];
    for (const via of order) {
      let r = null;
      if (via === 'groq' && this.hasGroqLlm) r = await this.groq({ system, user, json: true, maxTokens });
      if (via === 'gemini' && this.hasGemini) r = await this.gemini({ system, parts: [{ text: user }], json: true, maxTokens, lite: prefer !== 'gemini' });
      const parsed = r?.text ? parseJsonLoose(r.text) : null;
      if (parsed) return parsed;
    }
    return null;
  }
}

// ───────────── تحويل مقطع واحد ─────────────

function isEmptyMarkup(text) {
  const t = stripMarkup(text).trim();
  return !t || /^\[?\s*لا يوجد كلام\s*\]?\.?$/.test(t);
}

async function refineChunk(engine, chunk, draft, meta, { first, last, exact, weak = false, known = [] }) {
  const { io, emit } = engine;
  const draftWords = draft ? countWords(draft) : 0;
  // مسودة Whisper تصلح مرجعاً فقط إذا كانت موثوقة. على الموسيقى والتسجيل الضعيف تكون مشوّهة،
  // وإعطاؤها لـ Gemini يضلله، فنعتمد حينها على سمعه وحده.
  const trusted = !!draft && !weak;
  const wanted = engine.hasGemini;
  let review = false;

  // 1) Gemini يستمع للصوت
  if (engine.hasGemini && chunk.blob.size <= GEMINI_MAX_INLINE) {
    emit({ type: 'chunk', index: chunk.index, stage: 'listen' });
    const audio = { inline_data: { mime_type: MIME[chunk.ext] || chunk.mime, data: await io.blobToBase64(chunk.blob) } };
    let sec = draft === null ? chunk.audioSec : 0; // إذا لم يُحسب المقطع عند Whisper يُحسب هنا (مرة واحدة)
    let best = null, useDraft = trusted, insist = false;
    for (let tries = 0; tries < 2; tries++) {
      const { system, user } = audioPrompt(meta, { draft: useDraft ? draft : '', first, last, exact: exact && useDraft, insist, known });
      const r = await engine.gemini({ system, parts: [audio, { text: user }], sec, maxTokens: 16000 });
      if (!r || r.blocked) break;
      sec = 0;
      const words = countWords(r.text);
      if (isEmptyMarkup(r.text)) {
        // قال «لا يوجد كلام» و Whisper سمع كلاماً: محاولة ثانية بدون المسودة مع تأكيد كتابة أي كلام أو غناء
        if (draftWords > 25 && tries === 0) { useDraft = false; insist = true; continue; }
        if (!best) best = { ...r, text: '' };
        break;
      }
      if (!best || words > countWords(best.text)) best = r;
      // فحص الاكتمال مقابل مسودة موثوقة
      if (!trusted || draftWords < 40 || words >= draftWords * 0.62) break;
      review = true;
    }
    if (best) {
      const words = countWords(best.text);
      if (trusted && draftWords >= 40 && words < draftWords * 0.45) {
        // Gemini أسقط كلاماً كثيراً مقارنة بمسودة موثوقة: نعتمد المسودة المنقّحة ونعلّم المقطع للمراجعة
        const cleaned = await cleanupDraft(engine, draft, meta, first);
        return { markup: cleaned || draft, engine: cleaned ? 'groq' : 'raw', review: true };
      }
      if (best.truncated) review = true;
      return { markup: best.text, engine: 'gemini', model: best.model, review: trusted && review && words < draftWords * 0.62 || !!best.truncated };
    }
  }

  // 2) تنقيح نصي لمسودة Whisper (Gemini غير مربوط، أو خلصت حصته، أو حُجب عنه المقطع)
  if (draft) {
    emit({ type: 'chunk', index: chunk.index, stage: 'clean' });
    const cleaned = await cleanupDraft(engine, draft, meta, first);
    if (cleaned) return { markup: cleaned, engine: engine.hasGroqLlm ? 'groq' : 'gemini-text', review: weak || wanted };
    // 3) آخر احتياط: المسودة كما هي
    return { markup: draft, engine: 'raw', review: true };
  }
  if (draft === '') return { markup: '', engine: 'none', review: false };
  throw new PipelineError('no_engine', 'no engine available for this chunk');
}

/**
 * هل مسودة Whisper ضعيفة الثقة؟ (غناء فوق موسيقى، تسجيل بعيد جداً، هلوسة على الصمت)
 * القياس من أرقام Whisper نفسها: ثقة المقاطع، احتمال «لا كلام»، كثافة الكلمات، وما حذفته التنقية.
 * على محاضرة واضحة: الثقة ≈ ‎-0.2‎ وكثافة ≈ 145 كلمة/دقيقة. على أغنية: ‎-0.66‎ و 20 كلمة/دقيقة.
 */
function weakDraft(data, keptWords, audioSec) {
  const segs = Array.isArray(data.segments) ? data.segments : [];
  let dur = 0, lp = 0, ns = 0;
  for (const s of segs) {
    const d = Math.max(0.01, (s.end || 0) - (s.start || 0));
    dur += d;
    lp += (Number.isFinite(s.avg_logprob) ? s.avg_logprob : -0.3) * d;
    ns += (Number.isFinite(s.no_speech_prob) ? s.no_speech_prob : 0) * d;
  }
  if (!dur) return keptWords < 8;
  const raw = Array.isArray(data.words) ? data.words.length : keptWords;
  const wpm = keptWords / Math.max(audioSec / 60, 0.25);
  return lp / dur < -0.5 || ns / dur > 0.2 || (audioSec > 45 && wpm < 45) || (raw > 20 && keptWords < raw * 0.85);
}

async function cleanupDraft(engine, draft, meta, first) {
  const parts = splitByWords(draft, 380);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const { system, user } = cleanupPrompt(meta, parts[i], { first: first && i === 0 });
    let r = engine.hasGroqLlm ? await engine.groq({ system, user, maxTokens: 3200 }) : null;
    if (!r && engine.hasGemini) r = await engine.gemini({ system, parts: [{ text: user }], maxTokens: 6000, lite: true });
    const inWords = countWords(parts[i]);
    if (r?.text && countWords(r.text) >= inWords * 0.7 && countWords(r.text) <= inWords * 1.5 + 30) out.push(r.text.trim());
    else if (r === null && !out.length && i === 0) return null;
    else out.push(parts[i]); // النموذج اختصر أو فشل: نبقي الأصل حتى لا يضيع كلام
  }
  return out.join('\n\n');
}

// ───────────── المسار الكامل ─────────────

/**
 * @param opts.file Blob
 * @param opts.meta { title, subject, lecturer, date, keywords, speech:'ar'|'en'|'auto', style:'verbatim'|'formal', images:boolean, glossary:boolean }
 * @param opts.cfg  { chunkSec, overlapSec }
 * @param opts.caps { groq, gemini, sttModels, groqModels, geminiModels }
 * @param opts.io   اتصالات
 * @param opts.checkpoint { get(index), set(index, part) } لحفظ التقدم واستئنافه
 */
export async function runLecture({ file, meta, cfg, caps, io, emit = () => {}, signal, checkpoint }) {
  if (!caps.groq && !caps.gemini) throw new PipelineError('no_engine', 'link a key first');
  const engine = new Engine(io, caps, emit, signal);

  emit({ type: 'stage', name: 'probe' });
  let info;
  try {
    info = await probeAudio(file);
  } catch (e) {
    throw e instanceof AudioError ? new PipelineError('audio', e.message, { audio: e.code }) : new PipelineError('audio', 'تعذّر قراءة الملف', { audio: 'unsupported' });
  }
  const dual = caps.groq; // Whisper متاح: نستخدم التداخل والقطع عند السكتات
  const overlap = dual ? cfg.overlapSec : 0.5;
  const total = Math.max(1, Math.ceil((info.duration - 20) / cfg.chunkSec));
  emit({ type: 'plan', duration: info.duration, chunks: total, info });
  emit({ type: 'stage', name: 'transcribe' });

  const parts = [];
  const running = new Set();
  const seenTerms = new Map(); // مصطلحات الأجزاء المنجزة: تُعطى للأجزاء اللاحقة حتى يتوحّد إملاؤها
  const noteTerms = (markup) => { for (const m of String(markup).matchAll(/\[\[([^\]]{2,60})\]\]/g)) { const k = m[1].trim().toLowerCase(); if (!seenTerms.has(k)) seenTerms.set(k, m[1].trim()); } };
  const language = meta.speech === 'en' ? 'en' : meta.speech === 'ar' ? 'ar' : undefined;
  let prev = { cutEnd: -Infinity, tail: '' };
  let failure = null;

  try {
    for await (const chunk of chunkAudio(file, { info, targetSec: cfg.chunkSec, overlapSec: overlap, maxBytes: GEMINI_MAX_INLINE, signal })) {
      engine.check();
      if (failure) throw failure;
      emit({ type: 'chunk', index: chunk.index, stage: 'cut', start: chunk.start, end: chunk.end, last: chunk.last });

      const saved = checkpoint ? await checkpoint.get(chunk.index) : null;
      if (saved && Math.abs(saved.start - chunk.start) < 0.01) {
        parts[chunk.index] = saved;
        noteTerms(saved.markup);
        prev = { cutEnd: saved.cutEnd ?? chunk.end, tail: saved.tail || '' };
        emit({ type: 'part', index: chunk.index, part: saved, resumed: true });
        continue;
      }

      // Whisper بالتتابع: كل مقطع يحتاج ذيل سابقه كسياق ونقطة قطعه
      let draft = null, cutEnd = chunk.end, tail = '', weak = false;
      if (engine.hasStt) {
        emit({ type: 'chunk', index: chunk.index, stage: 'stt' });
        const prompt = whisperPrompt(meta, prev.tail);
        const data = await engine.whisper(chunk, { language, prompt, sec: chunk.audioSec });
        if (data) {
          const kept = cleanWhisper(data, prompt);
          weak = weakDraft(data, kept.length, chunk.audioSec);
          const words = kept.map((x) => ({ w: x.w, s: x.s + chunk.offset, e: x.e + chunk.offset }));
          cutEnd = chunk.last ? Infinity : pickCut(words, chunk.end, overlap);
          const mine = wordsBetween(words, prev.cutEnd, cutEnd);
          draft = wordsToText(mine);
          tail = mine.slice(-12).map((x) => x.w).join(' ');
          if (cutEnd === Infinity) cutEnd = chunk.end;
        }
      }
      const exact = draft !== null && dual;
      const ctx = { first: chunk.index === 0, last: chunk.last, exact, weak, known: [...seenTerms.values()].slice(-70) };
      prev = { cutEnd, tail };

      const task = refineChunk(engine, chunk, draft, meta, ctx).then(async (r) => {
        const part = { index: chunk.index, start: chunk.start, end: chunk.end, cutEnd, tail, markup: r.markup, engine: r.engine, model: r.model || '', review: !!r.review, words: countWords(r.markup) };
        parts[chunk.index] = part;
        noteTerms(part.markup);
        if (checkpoint) await checkpoint.set(chunk.index, part);
        emit({ type: 'part', index: chunk.index, part });
      }).catch((e) => { failure = failure || e; }).finally(() => running.delete(task));
      running.add(task);
      // لا نتقدم كثيراً أمام التدقيق حتى لا تتراكم المقاطع في الذاكرة
      while (running.size >= 3) await Promise.race(running);
      if (failure) throw failure;
    }
    await Promise.all(running);
    if (failure) throw failure;
  } catch (e) {
    await Promise.allSettled([...running]);
    if (e instanceof PipelineError) throw e;
    if (e instanceof AudioError) throw new PipelineError(e.code === 'aborted' ? 'aborted' : 'audio', e.message, { audio: e.code });
    throw e;
  }

  const done = parts.filter(Boolean);
  const blocks = joinChunks(done.map((p) => parseMarkup(p.markup)));
  const doc = {
    id: uid() + uid(),
    createdAt: Date.now(),
    meta: { ...meta },
    duration: info.duration,
    blocks,
    terms: [],
    stats: {
      words: blocks.reduce((n, b) => n + countWords(blockText(b)), 0),
      chunks: done.length,
      engines: done.reduce((acc, p) => { acc[p.engine] = (acc[p.engine] || 0) + 1; return acc; }, {}),
      review: done.filter((p) => p.review).map((p) => ({ start: p.start, end: p.end })),
    },
    source: { name: file.name || '', size: file.size },
  };
  if (!blocks.length) throw new PipelineError('empty', 'no speech found');

  await enrich(doc, engine, { io, emit, signal });
  emit({ type: 'stage', name: 'done' });
  return doc;
}

/** قاموس المصطلحات + العنوان + الصور التوضيحية (كلها اختيارية: فشلها لا يُفشل المحاضرة). */
export async function enrich(doc, engine, { io, emit = () => {} }) {
  const meta = doc.meta;

  // ── القاموس ──
  if (meta.glossary !== false) {
    emit({ type: 'stage', name: 'glossary' });
    try {
      const found = collectTerms(doc.blocks).slice(0, 90).map((t) => t.term);
      const terms = [];
      for (let i = 0; i < found.length; i += 45) {
        const { system, user } = glossaryPrompt(meta, found.slice(i, i + 45));
        const r = await engine.json({ system, user, maxTokens: 8000, prefer: 'gemini-lite' });
        for (const t of r?.terms || []) {
          if (t && typeof t.en === 'string' && typeof t.ar === 'string' && t.en.trim()) terms.push({ en: t.en.trim().slice(0, 80), ar: t.ar.trim().slice(0, 80), def: String(t.def || '').trim().slice(0, 220) });
        }
      }
      const seen = new Set();
      doc.terms = terms.filter((t) => { const k = t.en.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => a.en.localeCompare(b.en, 'en', { sensitivity: 'base' }));
    } catch (e) {
      if (e instanceof PipelineError && ['aborted', 'locked'].includes(e.code)) throw e;
      emit({ type: 'note', code: 'glossary_failed' });
    }
  }

  // ── العنوان والصور ──
  emit({ type: 'stage', name: 'figures' });
  try {
    const textBlocks = doc.blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.t !== 'fig');
    const outline = textBlocks.map(({ b, i }) => {
      const kind = b.t === 'h' ? 'H' : b.t === 'note' ? 'N' : b.items ? 'L' : 'P';
      const words = stripMarkup(blockText(b)).split(/\s+/);
      return `${i} ${kind}: ${words.slice(0, b.t === 'h' ? 14 : 26).join(' ')}${words.length > 26 ? '…' : ''}`;
    }).join('\n').slice(0, 14000);
    const maxFigures = meta.images === false ? 0 : Math.min(12, Math.max(2, Math.round(doc.stats.words / 320)));
    const { system, user } = figuresPrompt(meta, outline, Math.max(maxFigures, 1));
    const plan = await engine.json({ system, user, maxTokens: 3000 });
    if (plan?.title && !String(meta.title || '').trim()) doc.meta.title = String(plan.title).replace(/\[\[|\]\]/g, '').trim().slice(0, 140);
    if (maxFigures > 0 && Array.isArray(plan?.figures)) {
      const wanted = plan.figures
        .filter((f) => f && typeof f.query === 'string' && f.query.trim() && Number.isInteger(f.after) && f.after >= 0 && f.after < doc.blocks.length)
        .slice(0, maxFigures)
        .map((f) => ({ after: f.after, query: f.query.trim().slice(0, 80), alt: String(f.alt || '').trim().slice(0, 80), kind: ['radiograph', 'diagram', 'photo', 'micrograph'].includes(f.kind) ? f.kind : 'diagram', caption: String(f.caption || '').trim().slice(0, 200) }));
      emit({ type: 'stage', name: 'images', total: wanted.length });
      const figs = await pickFigures(wanted, engine, io, emit);
      // ندرج من الأخير للأول حتى لا تتغير المواضع
      const anchors = doc.blocks.map((b) => b.id);
      for (const f of figs.sort((a, b) => b.after - a.after)) {
        const at = doc.blocks.findIndex((b) => b.id === anchors[f.after]);
        if (at < 0) continue;
        let pos = at + 1;
        if (doc.blocks[at].t === 'h' && doc.blocks[pos] && doc.blocks[pos].t !== 'h') pos++; // لا نضع الصورة بين العنوان وفقرته
        doc.blocks.splice(pos, 0, { id: uid(), t: 'fig', caption: f.caption, query: f.query, kind: f.kind, pick: f.pick, candidates: f.candidates, img: f.img });
      }
    }
  } catch (e) {
    if (e instanceof PipelineError && ['aborted', 'locked'].includes(e.code)) throw e;
    emit({ type: 'note', code: 'figures_failed' });
  }
  if (!String(doc.meta.title || '').trim()) {
    const h = doc.blocks.find((b) => b.t === 'h');
    doc.meta.title = h ? stripMarkup(h.text) : doc.meta.subject || 'محاضرة';
  }
  return doc;
}

/** يجلب المرشحات لكل شكل ويختار الأنسب (بالنظر عبر Gemini إن توفر). */
export async function pickFigures(wanted, engine, io, emit = () => {}) {
  const figs = [];
  // البحث بالتتابع الخفيف احتراماً لحدود المصادر
  for (let i = 0; i < wanted.length; i += 2) {
    const batch = wanted.slice(i, i + 2);
    const found = await Promise.all(batch.map((f) => findCandidates(f, io.net, 5).catch(() => [])));
    batch.forEach((f, k) => figs.push({ ...f, candidates: found[k], pick: null, img: null }));
    emit({ type: 'images', searched: Math.min(i + 2, wanted.length), total: wanted.length });
  }
  const withC = figs.filter((f) => f.candidates.length);
  if (!withC.length) return [];

  // مصغّرات للاختيار
  await Promise.all(withC.map(async (f) => {
    const thumbs = await Promise.all(f.candidates.map((c) => io.loadImage(c, 'small').catch(() => null)));
    f.candidates.forEach((c, i) => { if (thumbs[i]) c.tiny = thumbs[i].dataUrl; }); // تبقى للمعاينة عند تبديل الصورة
    f.candidates = f.candidates.filter((_, i) => thumbs[i]);
    f.thumbs = thumbs.filter(Boolean);
  }));
  const usable = withC.filter((f) => f.candidates.length);

  let picks = null;
  if (engine.hasGemini && usable.length) {
    const parts = [];
    const desc = usable.map((f, i) => ({ caption: f.caption, query: f.query, labels: f.candidates.map((_, k) => `${i + 1}${String.fromCharCode(65 + k)}`) }));
    const { system, user } = visionPickPrompt(desc);
    parts.push({ text: user });
    usable.forEach((f, i) => f.thumbs.forEach((t, k) => {
      parts.push({ text: `${i + 1}${String.fromCharCode(65 + k)} — ${f.candidates[k].title}` });
      parts.push({ inline_data: { mime_type: t.mime, data: t.base64 } });
    }));
    const r = await engine.gemini({ system, parts, json: true, maxTokens: 3000, lite: true }).catch(() => null);
    const parsed = r?.text ? parseJsonLoose(r.text) : null;
    if (Array.isArray(parsed?.picks)) picks = parsed.picks;
  }

  const out = [];
  for (let i = 0; i < usable.length; i++) {
    const f = usable[i];
    let idx = 0;
    if (picks) {
      const p = picks.find((x) => Number(x.fig) === i + 1);
      const ch = String(p?.choice || '').trim().toUpperCase();
      if (!p || ch === 'NONE' || !ch) idx = -1;
      else idx = ch.charCodeAt(ch.length - 1) - 65;
      if (idx >= f.candidates.length) idx = -1;
    }
    if (idx < 0) continue;
    const pick = f.candidates[idx];
    const img = await io.loadImage(pick, 'large').catch(() => null) || (f.thumbs[idx] ? { ...f.thumbs[idx] } : null);
    if (!img) continue;
    out.push({ after: f.after, caption: f.caption, query: f.query, kind: f.kind, pick, candidates: f.candidates, img: { dataUrl: img.dataUrl, w: img.w, h: img.h } });
    emit({ type: 'images', picked: out.length, total: usable.length });
  }
  return out;
}
