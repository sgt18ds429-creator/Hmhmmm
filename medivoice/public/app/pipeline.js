// pipeline.js — مسار التحويل الكامل: تقطيع → Whisper (مسودة + توقيت) → Gemini (استماع وتدقيق)
// → لصق → فهم المحاضرة وكتابتها شرحاً مفصلاً → قاموس المصطلحات → صور توضيحية مُتحقَّق من مطابقتها.
// لا يعتمد على المتصفح مباشرة: كل اتصال يمر عبر كائن io حتى يُختبر في Node أيضاً.

import { chunkAudio, probeAudio, AudioError } from './chunker.js';
import {
  cleanWhisper, pickCut, wordsBetween, wordsToText, splitByWords, parseMarkup, joinChunks, blocksToMarkup,
  countWords, collectTerms, blockText, stripMarkup, parseJsonLoose, uid, langOf, termsIn, textHash, normalize, isNotes,
} from './text.js';
import {
  whisperPrompt, audioPrompt, cleanupPrompt, glossaryPrompt, figuresPrompt,
  notesPlanPrompt, notesSectionPrompt, reviewPrompt, proofreadPrompt, figureTextPickPrompt,
  reviewNotesPrompt, mcqPrompt, figuresBatchPrompt, slideFiguresPrompt,
} from './prompts.js';
import { findCandidates } from './images.js';

export class PipelineError extends Error {
  constructor(code, message, extra = {}) { super(message || code); this.code = code; Object.assign(this, extra); }
}

const GEMINI_MAX_INLINE = 13 * 1024 * 1024; // حد الطلب 20MB بعد base64
const FATAL = ['aborted', 'locked'];
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
    // الوقت المسموح للمهمة كلها: محاضرة ساعة أو أقل تجهز خلال 9 دقائق. عند التأخر تُترك الأعمال الإضافية
    this.t0 = Date.now();
    this.budgetMs = 9 * 60_000;
    this.stt = new Lanes(caps.groq ? caps.sttModels : []);
    this.llm = new Lanes(caps.groq ? caps.groqModels : []);
    this.gem = new Lanes(caps.gemini ? caps.geminiModels : []);
    // نموذج النسخ الحرفي من Google: مرجع ثانٍ لاكتمال الاستماع، وله حصة مستقلة
    this.tx = new Lanes(caps.gemini ? caps.transcribeModels || [] : []);
  }

  check() { if (this.signal?.aborted) throw new PipelineError('aborted', 'aborted'); }

  /** هل استُهلك هذا الجزء من الوقت المسموح؟ */
  late(fraction) { return Date.now() - this.t0 > this.budgetMs * fraction; }

  async pause(ms, what) {
    if (ms > 4000) this.emit({ type: 'wait', seconds: Math.ceil(ms / 1000), what });
    await this.io.sleep(ms, this.signal);
    this.check();
    if (ms > 4000) this.emit({ type: 'resume' });
  }

  get hasGemini() { return this.gem.alive.length > 0; }
  get hasGroqLlm() { return this.llm.alive.length > 0; }
  get hasStt() { return this.stt.alive.length > 0; }
  get hasTx() { return this.tx.alive.length > 0; }

  // ── نسخ حرفي (Gemini Transcribe) ──
  /** @returns {Promise<{text:string, model:string}|null>} نص حرفي للمقطع (المصطلحات قد تأتي بحروف عربية) */
  async transcribe(chunk, { sec = 0 } = {}) {
    let fails = 0;
    for (let attempt = 0; attempt < 7; attempt++) {
      this.check();
      const m = this.tx.pick();
      if (!m) {
        const wait = this.tx.waitMs();
        if (wait === null || wait > 45_000) return null;
        await this.pause(wait + 300, 'gemini');
        continue;
      }
      const body = {
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: MIME[chunk.ext] || chunk.mime, data: await this.io.blobToBase64(chunk.blob) } }, { text: 'Transcribe this audio verbatim, in the language spoken.' }] }],
        generationConfig: { temperature: 0 },
      };
      const res = await this.io.gemini(m.id, body, { sec, signal: this.signal });
      if (res.ok && res.data) {
        const parts = res.data.candidates?.[0]?.content?.parts || [];
        const text = parts.map((p) => p.audioTranscription?.text || (typeof p.text === 'string' && !p.thought ? p.text : '')).join(' ').trim();
        return text ? { text, model: m.id } : null;
      }
      const fatal = fatalFromServer(res, 'gemini');
      if (fatal) throw fatal;
      const msg = String(res.data?.error?.message || '');
      if (res.status === 429) {
        const details = Array.isArray(res.data?.error?.details) ? res.data.error.details : [];
        const perDay = details.some((d) => (d.violations || []).some((v) => /PerDay/i.test(v.quotaId || '')));
        const retry = details.map((d) => parseFloat(d.retryDelay)).find((x) => x > 0) || res.retryAfter || 20;
        if (perDay || retry > 45) m.dead = true; else this.tx.cool(m, (retry + 1) * 1000);
        continue;
      }
      if (res.status === 404 || res.status === 400 || res.status === 413) { m.dead = true; continue; }
      if (res.status === 503 || res.status === 500 || res.status === 0) { if (++fails > 3) return null; await this.pause(2500 * fails, 'net'); continue; }
      if (++fails > 3) return null;
    }
    return null;
  }

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
  async gemini({ system, parts, json = false, maxTokens = 8192, sec = 0, lite = false, temperature = 0, strongWaitMs = 75_000, thinking = null }) {
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
        // الاستماع للصوت وكتابة الشرح: النماذج الخفيفة أضعف بالمصطلحات واللهجة. إذا النماذج الدقيقة في تهدئة
        // قصيرة (حد الدقيقة) ننتظرها، ولا ننزل للخفيفة إلا إذا طال الانتظار أو خلصت حصتها اليومية.
        const strong = order.filter((x) => !x.dead && !/lite/.test(x.id));
        if (strong.length) {
          const wait = Math.min(...strong.map((x) => x.until)) - now;
          if (wait <= strongWaitMs) { await this.pause(Math.max(wait, 0) + 400, 'gemini'); continue; }
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
      if (!m.plain && /^gemini-3/.test(m.id)) generationConfig.thinkingConfig = { thinkingLevel: thinking || (isLite ? 'minimal' : 'low') };
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
    const tooLarge = new Set(); // نماذج رفضت الطلب لأنه أكبر من حدها بالدقيقة
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
        const choice = res.data.choices?.[0];
        const text = choice?.message?.content;
        if (typeof text === 'string' && text.trim()) return { text, model: m.id, truncated: choice.finish_reason === 'length' };
        this.llm.cool(m, 20_000);
        continue;
      }
      const fatal = fatalFromServer(res, 'groq');
      if (fatal) throw fatal;
      if (res.status === 401 || res.status === 403) throw new PipelineError('key_groq', 'groq key rejected');
      if (res.status === 413 || (res.status === 429 && /request too large|reduce your message/i.test(JSON.stringify(res.data?.error || '')))) {
        // الانتظار لا يفيد طلباً أكبر من حد النموذج: نجرب نموذجاً آخر، وإذا رفضه الكل نرجع فوراً
        tooLarge.add(m.id);
        if (this.llm.alive.every((x) => tooLarge.has(x.id))) return null;
        this.llm.cool(m, 30_000);
        continue;
      }
      if (res.status === 429) { this.llm.cool(m, Math.max(2, res.retryAfter || 15) * 1000); continue; }
      if (res.status === 400 && !m.plain) { m.plain = true; continue; }
      if (res.status === 404 || res.status === 400) { m.dead = true; continue; }
      if (++netFails > 4) return null;
      await this.pause(1200 * 2 ** netFails, 'net');
    }
    return null;
  }

  /**
   * كتابة نص طويل (الشرح المفصل): أدق نماذج Gemini أولاً، ثم Groq.
   * @returns {Promise<{text, model, truncated}|{blocked:true}|null>} null = لا يوجد محرك متاح الآن
   */
  async write({ system, user, maxTokens = 16000, groqTokens = 4000, temperature = 0.2, groq = true, thinking = null }) {
    let blocked = null;
    if (this.hasGemini) {
      // عند التأخر لا ننتظر النماذج الدقيقة إذا كانت في تهدئة: الخفيفة أسرع ولها حدود أعلى
      const r = await this.gemini({ system, parts: [{ text: user }], maxTokens, temperature, thinking, strongWaitMs: this.late(0.6) ? 0 : 40_000 });
      if (r && !r.blocked) return r;
      if (r?.blocked) blocked = r;
    }
    if (groq && this.hasGroqLlm) {
      const r = await this.groq({ system, user, maxTokens: groqTokens, temperature });
      if (r) return r;
    }
    return blocked;
  }

  /**
   * مهمة نصية ترجع JSON.
   * prefer: 'groq' (الافتراضي، يحفظ حصة Gemini للصوت) أو 'gemini-lite' (أدق بالمصطلحات العربية) أو 'gemini'.
   */
  async json({ system, user, maxTokens = 3500, groqTokens = maxTokens, prefer = 'groq' }) {
    const order = prefer.startsWith('gemini') ? ['gemini', 'groq'] : ['groq', 'gemini'];
    for (const via of order) {
      let r = null;
      if (via === 'groq' && this.hasGroqLlm) r = await this.groq({ system, user, json: true, maxTokens: groqTokens });
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
  const notes = isNotes(meta.mode);
  let review = false;

  // نسخ حرفي موازٍ (Gemini Transcribe): مرجع أدق من Whisper لاكتمال ما سمعه النموذج الرئيسي،
  // وبديل أفضل من المسودة إذا تعذّر الاستماع. يعمل بالتوازي فلا يبطئ المقطع إلا قليلاً.
  const txJob = engine.hasTx && chunk.blob.size <= GEMINI_MAX_INLINE ? engine.transcribe(chunk).catch((e) => { if (e instanceof PipelineError && FATAL.includes(e.code)) throw e; return null; }) : null;
  const reference = async (waitMs) => {
    if (!txJob) return null;
    const r = await Promise.race([txJob, io.sleep(waitMs, engine.signal).then(() => undefined)]);
    return r && countWords(r.text) >= 30 ? r : null;
  };

  // 1) Gemini يستمع للصوت
  if (engine.hasGemini && chunk.blob.size <= GEMINI_MAX_INLINE) {
    emit({ type: 'chunk', index: chunk.index, stage: 'listen' });
    const audio = { inline_data: { mime_type: MIME[chunk.ext] || chunk.mime, data: await io.blobToBase64(chunk.blob) } };
    let sec = draft === null ? chunk.audioSec : 0; // إذا لم يُحسب المقطع عند Whisper يُحسب هنا (مرة واحدة)
    let best = null, useDraft = trusted, anchor = draft, insist = false, ref = null;
    for (let tries = 0; tries < 3; tries++) {
      const { system, user } = audioPrompt(meta, { draft: useDraft ? anchor : '', first, last, exact: exact && useDraft && anchor === draft, insist, known });
      const r = await engine.gemini({ system, parts: [audio, { text: user }], sec, maxTokens: 16000, thinking: 'minimal' });
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
      // فحص الاكتمال: مقابل النسخ الحرفي إن وصل (الأدق)، وإلا مقابل مسودة Whisper الموثوقة
      if (ref === null) ref = await reference(35_000);
      const refWords = ref ? countWords(ref.text) : trusted ? draftWords : 0;
      if (refWords < 40 || words >= refWords * (ref ? 0.78 : 0.62)) break;
      review = true;
      if (tries === 0 && ref) { useDraft = true; anchor = ref.text; insist = true; } // نعيد الاستماع والمرجع الأكمل أمامه
      else if (tries >= 1) break;
    }
    if (best) {
      const words = countWords(best.text);
      const refWords = ref ? countWords(ref.text) : 0;
      if (ref && refWords >= 40 && words < refWords * 0.55) {
        // النموذج أسقط جزءاً كبيراً ولم تنفع الإعادة: النسخ الحرفي كامل، والكاتب يصحح مصطلحاته من السياق
        const markup = notes ? ref.text : (await cleanupDraft(engine, ref.text, meta, first)) || ref.text;
        return { markup, engine: 'gemini-tx', model: ref.model, review: true };
      }
      if (!ref && trusted && draftWords >= 40 && words < draftWords * 0.45) {
        // أسقط كلاماً كثيراً مقارنة بمسودة موثوقة: نعتمد المسودة المنقّحة ونعلّم المقطع للمراجعة
        const cleaned = await cleanupDraft(engine, draft, meta, first);
        return { markup: cleaned || draft, engine: cleaned ? 'groq' : 'raw', review: true };
      }
      if (best.truncated) review = true;
      return { markup: best.text, engine: 'gemini', model: best.model, review: (refWords >= 40 ? review && words < refWords * 0.78 : trusted && review && words < draftWords * 0.62) || !!best.truncated };
    }
  }

  // 2) النسخ الحرفي وحده (تعذّر الاستماع بالنموذج الرئيسي)
  const ref = await reference(60_000);
  if (ref && (!draft || weak || countWords(ref.text) >= draftWords * 0.8)) {
    emit({ type: 'chunk', index: chunk.index, stage: 'clean' });
    const markup = notes ? ref.text : (await cleanupDraft(engine, ref.text, meta, first)) || ref.text;
    return { markup, engine: 'gemini-tx', model: ref.model, review: false };
  }

  // 3) تنقيح نصي لمسودة Whisper (Gemini غير مربوط، أو خلصت حصته، أو حُجب عنه المقطع)
  if (draft) {
    emit({ type: 'chunk', index: chunk.index, stage: 'clean' });
    const cleaned = await cleanupDraft(engine, draft, meta, first);
    if (cleaned) return { markup: cleaned, engine: engine.hasGroqLlm ? 'groq' : 'gemini-text', review: weak || wanted };
    // 4) آخر احتياط: المسودة كما هي
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
export async function runLecture({ file, meta, cfg, caps, io, emit = () => {}, signal, checkpoint, slides = null }) {
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
  engine.budgetMs = Math.max(9 * 60_000, info.duration * 150); // نحو 15% من مدة التسجيل، و 9 دقائق على الأقل
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
      while (running.size >= 5) await Promise.race(running);
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

  if (slides) doc.slides = slides;
  if (isNotes(meta.mode)) {
    if (await writeNotes(doc, engine, { emit, checkpoint })) await reviewNotes(doc, engine, { emit });
    else doc.meta.mode = 'transcript';
  }
  await complete(doc, engine, { io, emit });
  emit({ type: 'stage', name: 'done' });
  return doc;
}

/**
 * يحوّل محاضرة محفوظة (نص مفرّغ) إلى شرح مفصل بدون إعادة الاستماع للتسجيل.
 * يرجع مستنداً جديداً ويبقى الأصلي كما هو.
 */
export async function rewriteLecture({ doc, caps, io, emit = () => {}, signal, checkpoint = null, mode = 'notes' }) {
  if (!caps.groq && !caps.gemini) throw new PipelineError('no_engine', 'link a key first');
  const engine = new Engine(io, caps, emit, signal);
  engine.budgetMs = 8 * 60_000; // بدون استماع: الكتابة والصور فقط
  const transcript = (doc.transcript || doc.blocks).filter((b) => !['fig', 'figreq', 'slidereq', 'mcq'].includes(b.t)).map((b) => ({ ...b, items: b.items ? [...b.items] : undefined }));
  const copy = {
    ...doc,
    id: uid() + uid(),
    createdAt: Date.now(),
    meta: { ...doc.meta, mode: isNotes(mode) ? mode : 'notes', images: doc.meta.images !== false },
    blocks: transcript,
    transcript: undefined,
    slides: doc.slides && mode === 'integrated' ? doc.slides : undefined,
    terms: [],
    stats: { ...doc.stats, review: [...(doc.stats?.review || [])], audit: undefined },
  };
  if (copy.meta.mode === 'integrated' && !copy.slides?.pages?.length) copy.meta.mode = 'notes';
  if (!(await writeNotes(copy, engine, { emit, checkpoint }))) throw new PipelineError('not_lecture', 'not a lecture');
  await reviewNotes(copy, engine, { emit });
  await complete(copy, engine, { io, emit });
  emit({ type: 'stage', name: 'done' });
  return copy;
}

// ───────────── الشرح المفصل ─────────────
//
// التفريغ الحرفي فيه أخطاء سمع وتكرار ولهجة، فلا يصلح للمذاكرة كما هو. هنا يقرأ النموذج المحاضرة كلها،
// يقسمها حسب المواضيع، ثم يكتب كل قسم شرحاً مرتباً بالفصحى بدون إسقاط أي معلومة، ويحدد مواضع الصور.
// كل قسم يُفحص: إذا خرج أقصر بكثير من تفريغه أو أسقط مصطلحاته يُعاد مرة بتنبيه، وإذا فشل يبقى نصه المفرّغ.

// حجم القسم الواحد بكلمات التفريغ، وحد الكتابة بالرموز: Gemini يسع أقساماً طويلة، وحدود Groq المجانية أضيق
const LIMIT = { gemini: { words: 1500, tokens: 16000 }, groq: { words: 520, tokens: 4000 } };
const limitFor = (engine, mode) => (engine.hasGemini ? (mode === 'highyield' ? { words: 2400, tokens: 12000 } : LIMIT.gemini) : LIMIT.groq);
const isFatal = (e) => e instanceof PipelineError && FATAL.includes(e.code);

const cleanTitle = (t) => stripMarkup(String(t || '')).replace(/\[\[|\]\]/g, '').replace(/^#+\s*/, '').replace(/[:：]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 140);
const sectionLabel = (i, lang) => (lang === 'en' ? `Part ${i + 1}` : `القسم ${i + 1}`);
const sumWords = (paras, from, to) => { let n = 0; for (let i = from; i < to; i++) n += paras[i].words; return n; };

/** فقرات التفريغ بصيغة الترميز، والطويل منها مقسوم حتى يمكن تقسيم الأقسام عند حدودها. */
function transcriptParas(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.t === 'fig' || b.t === 'figreq') continue;
    const md = blocksToMarkup([b]);
    const words = countWords(blockText(b));
    if (!words) continue;
    if (words > 300) for (const piece of splitByWords(md, 240)) out.push({ text: piece, words: countWords(piece), h: false });
    else out.push({ text: md, words, h: b.t === 'h' });
  }
  return out;
}

/** يقسم مدى من الفقرات إلى أجزاء متقاربة لا يتجاوز كل منها maxWords، ويفضّل القطع قبل العناوين. */
function splitRange(paras, from, to, maxWords) {
  const total = sumWords(paras, from, to);
  if (total <= maxWords || to - from < 2) return [[from, to]];
  const count = Math.ceil(total / maxWords);
  const target = total / count;
  const out = [];
  let start = from, acc = 0;
  for (let i = from; i < to; i++) {
    const w = paras[i].words;
    const room = out.length < count - 1 && i > start;
    if (room && (acc + w > target * 1.15 || (paras[i].h && acc >= target * 0.7))) { out.push([start, i]); start = i; acc = 0; }
    acc += w;
  }
  out.push([start, to]);
  return out;
}

/** أقسام احتياطية عند فشل الخطة: عند عناوين التفريغ، وإلا قسم واحد يُجزّأ بالحجم. */
function fallbackSections(paras, lang) {
  const out = [];
  paras.forEach((p, i) => { if (p.h || i === 0) out.push({ from: i, title: p.h ? cleanTitle(p.text) : '', points: '' }); });
  return out.map((s, i) => ({ ...s, title: s.title || sectionLabel(i, lang) }));
}

/** يحوّل خطة النموذج إلى أقسام صالحة تغطي كل الفقرات بالترتيب، مقسومة حسب حجم المحرك. */
export function normalizePlan(raw, paras, maxWords, lang = 'ar', pageCount = 0) {
  const n = paras.length;
  let secs = (Array.isArray(raw?.sections) ? raw.sections : [])
    .map((s) => ({ from: Number(s?.from), title: cleanTitle(s?.title), points: stripMarkup(String(s?.points || '')).replace(/\[\[|\]\]/g, '').trim().slice(0, 300) }))
    .filter((s) => Number.isInteger(s.from) && s.from >= 0 && s.from < n)
    .sort((a, b) => a.from - b.from)
    .filter((s, i, arr) => i === 0 || s.from !== arr[i - 1].from);
  if (!secs.length) secs = fallbackSections(paras, lang);
  secs[0].from = 0;
  let ranges = secs.map((s, i) => ({ ...s, to: i + 1 < secs.length ? secs[i + 1].from : n }));
  // قسم صغير جداً (مقدمة أو انتقال) يُضم لما قبله، أو لما بعده إذا كان الأول
  const merged = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && sumWords(paras, prev.from, prev.to) < 60) { merged[merged.length - 1] = { ...r, from: prev.from }; continue; }
    if (prev && sumWords(paras, r.from, r.to) < 60) { prev.to = r.to; continue; }
    merged.push({ ...r });
  }
  ranges = merged;
  const titles = ranges.map((r, i) => r.title || sectionLabel(i, lang));
  // صفحات السلايدات لكل قسم (تُقرأ من الخطة الخام بترتيب الأقسام غير المدمجة؛ إن لم تطابق توزَّع بالتساوي)
  const pages = assignPages(ranges.length === secs.length ? raw : null, ranges, pageCount);
  const sections = [];
  ranges.forEach((r, index) => {
    const pieces = splitRange(paras, r.from, r.to, maxWords);
    pieces.forEach(([from, to], k) => sections.push({ index, title: titles[index], points: r.points, from, to, part: k + 1, parts: pieces.length, pages: pages[index] }));
  });
  return { kind: raw?.kind === 'other' ? 'other' : 'lecture', title: cleanTitle(raw?.title), titles, sections };
}

async function planNotes(engine, meta, paras, lang, slides = null) {
  // Gemini يقرأ التفريغ كاملاً؛ Groq حدوده أضيق فيأخذ بداية كل فقرة فقط
  const budget = engine.hasGemini ? 120_000 : 11_000;
  const full = paras.map((p, i) => `[${i}] ${p.text}`).join('\n');
  const condensed = full.length > budget;
  const per = Math.max(6, Math.min(24, Math.floor(budget / paras.length / 7)));
  const numbered = condensed
    ? paras.map((p, i) => { const w = p.text.split(/\s+/); return `[${i}] ${w.slice(0, per).join(' ')}${w.length > per ? '…' : ''}`; }).join('\n').slice(0, budget)
    : full;
  const { system, user } = notesPlanPrompt(meta, numbered, { lang, condensed, slides: slides?.pages?.length && engine.hasGemini ? slides.pages : null });
  return engine.json({ system, user, maxTokens: 6000, groqTokens: 2500, prefer: 'gemini' });
}

/** يوزّع صفحات السلايدات على الأقسام: من الخطة إن ذكرتها، وإلا بالتساوي حسب الترتيب. */
function assignPages(raw, ranges, pageCount) {
  if (!pageCount) return ranges.map(() => null);
  const given = (Array.isArray(raw?.sections) ? raw.sections : []).map((s) => (Array.isArray(s?.pages) && s.pages.length === 2 ? s.pages.map((v) => parseInt(v, 10)) : null));
  const ok = given.length === ranges.length && given.every((p) => p && p[0] >= 1 && p[1] >= p[0] && p[1] <= pageCount);
  if (ok) return given;
  const per = pageCount / ranges.length;
  return ranges.map((_, i) => [Math.floor(i * per) + 1, Math.min(pageCount, Math.floor((i + 1) * per))]);
}


/** يرتب عناوين القسم: «##» مرة واحدة في أوله (أو لا شيء في الأجزاء التالية)، وكل عنوان بعده فرعي. */
function tidySection(markup, s) {
  const lines = String(markup).replace(/\r/g, '').replace(/^```[a-z]*\n?|```\s*$/gim, '').trim().split('\n');
  let seenTop = false;
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (!m) { out.push(line); continue; }
    // المصطلحات بين [[ ]] تبقى في العناوين حتى يُعزل اتجاهها عند العرض
    const text = m[2].replace(/\*\*/g, '').replace(/[:：]+$/, '').replace(/\s+/g, ' ').trim();
    if (!cleanTitle(text)) continue;
    const isTop = m[1].length <= 2;
    if (isTop && !seenTop && s.part === 1 && !out.some((l) => l.trim())) { seenTop = true; out.push(`## ${text}`); continue; }
    if (isTop && normalize(cleanTitle(text)) === normalize(s.title)) continue; // تكرار عنوان القسم
    out.push(`### ${text}`);
  }
  let md = out.join('\n').trim();
  if (s.part === 1 && !seenTop) md = `## ${s.title}\n\n${md}`;
  return md;
}

/** عند تعذّر الكتابة: يبقى تفريغ القسم كما هو تحت عنوانه حتى لا يضيع شيء. */
function fallbackMarkup(s, source) {
  return tidySection(source, s);
}

async function writeSection(engine, meta, plan, s, paras, opts, depth = 0) {
  const { lang, known, images, mode = 'notes', slides = null } = opts;
  const words = sumWords(paras, s.from, s.to);
  const splittable = s.to - s.from > 1 && depth < 2;
  const lim = () => limitFor(engine, mode);
  const high = mode === 'highyield';
  // نص سلايدات هذا القسم وصورها (النوع المتكامل)
  let slideText = null, slideFigs = [];
  if (slides?.pages?.length && s.pages) {
    const inRange = (p) => p.page >= s.pages[0] && p.page <= s.pages[1];
    slideText = slides.pages.filter(inRange).map((p) => `[ص${p.page}] ${String(p.text || '').trim() || '(بلا نص)'}`).join('\n\n').slice(0, 40_000);
    slideFigs = (slides.figs || []).filter(inRange).map((f) => ({ page: f.page, what: f.what }));
  }
  // يكتب القسم على أجزاء متتالية (المحرك المتاح أضيق من القسم، أو انقطع الناتج لطوله)
  const inPieces = async (pieces) => {
    const outs = [];
    for (let k = 0; k < pieces.length; k++) {
      outs.push(await writeSection(engine, meta, plan, { ...s, from: pieces[k][0], to: pieces[k][1], part: s.part + k, parts: s.parts + pieces.length - 1 }, paras, opts, depth + 1));
    }
    return joinResults(outs);
  };
  const tooBig = () => splittable && words > lim().words * 1.3;
  if (tooBig()) return inPieces(splitRange(paras, s.from, s.to, lim().words));

  const source = paras.slice(s.from, s.to).map((p) => p.text).join('\n\n');
  const srcTerms = termsIn(source);
  let best = null, retry = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { system, user } = notesSectionPrompt(meta, s, { lang, outline: plan.titles, source, words, known, images, retry, mode, slides: slideText, slideFigs });
    // قسم بحجم Gemini لا يُرسل لـ Groq كاملاً (أكبر من حده بالدقيقة)
    const r = await engine.write({ system, user, maxTokens: lim().tokens, groqTokens: LIMIT.groq.tokens, groq: !splittable || words <= LIMIT.groq.words * 1.3 });
    // خلصت حصة Gemini أثناء الطلب: نكمل القسم على أجزاء بحجم Groq
    if (!r && !best && tooBig()) return inPieces(splitRange(paras, s.from, s.to, lim().words));
    if (!r || r.blocked) break;
    const text = tidySection(r.text, s);
    const blocks = parseMarkup(text);
    const outWords = blocks.reduce((n, b) => n + countWords(blockText(b)), 0);
    // مصطلحات التفريغ التي لم ترد في الشرح لا بين [[ ]] ولا بدونها
    const got = termsIn(text);
    const plain = ` ${normalize(stripMarkup(text)).replace(/[^a-z0-9]+/g, ' ')} `;
    const missing = [...srcTerms.keys()].filter((k) => !got.has(k) && !plain.includes(` ${k}`)).map((k) => srcTerms.get(k));
    const cand = { text, words: outWords, missing, truncated: !!r.truncated, model: r.model || '' };
    // الشرح: الأوفى أفضل. النقاط الامتحانية: ما لم يتجاوز حجم التفريغ أفضل، ثم الأقل نقصاً
    const score = (c) => (high ? -(c.words > words * 1.1 ? (c.words - words) : 0) - c.missing.length * 15 : c.words - c.missing.length * 15);
    if (!best || score(cand) > score(best)) best = cand;
    // انقطع لطول الناتج: نقسم القسم نصفين ونكتب كلاً منهما
    if (cand.truncated && splittable) {
      const halves = splitRange(paras, s.from, s.to, Math.ceil(words / 2));
      if (halves.length > 1) return inPieces(halves);
    }
    // الشرح بالفصحى يحذف الحشو والتكرار والكلام الإداري، فيخرج طبيعياً بنصف كلام المحاضر أو أقل،
    // والنقاط الامتحانية أقصر بكثير عمداً. نعيد الكتابة (طلب طويل ثانٍ) فقط إذا خرج أقصر بكثير من المتوقع أو أسقط أغلب المصطلحات
    const minRatio = high ? 0.1 : 0.3;
    const short = words >= 200 && outWords < words * minRatio;
    const long = high && words >= 150 && outWords > words * 1.1; // نقاط امتحانية أطول من الكلام نفسه: توسّع واختراع
    const lost = srcTerms.size >= 8 && missing.length > srcTerms.size * (high ? 0.6 : 0.4);
    if ((!short && !lost && !long) || engine.late(0.7)) break; // عند التأخر نقبل الناتج ولا نعيد
    retry = { prevWords: short ? outWords : 0, missing: missing.slice(0, 30), tooLong: long ? outWords : 0, target: Math.max(60, Math.round(words * 0.4)) };
  }
  if (!best || (words >= 120 && best.words < words * (high ? 0.06 : 0.25))) return { markup: fallbackMarkup(s, source), fallback: true, review: true, words };
  return { markup: best.text, review: best.truncated || (words >= 200 && best.words < words * minRatioOf(high)), model: best.model, words: best.words };
}
const minRatioOf = (high) => (high ? 0.1 : 0.3);

/** هل بقي محتوى القسم كما هو بعد التدقيق؟ نفس البنية والصور والمصطلحات وعدد الكلمات تقريباً. */
export function sameContent(before, after) {
  const A = parseMarkup(before), B = parseMarkup(after);
  const count = (list, t) => list.filter((b) => b.t === t).length;
  for (const t of ['h', 'ul', 'ol', 'table', 'note', 'figreq', 'slidereq', 'mcq']) if (count(A, t) !== count(B, t)) return false;
  if (Math.abs(count(A, 'p') - count(B, 'p')) > 2) return false;
  const items = (list) => list.reduce((n, b) => n + (b.items ? b.items.length : b.rows ? b.rows.length : 0), 0);
  if (items(A) !== items(B)) return false;
  const figs = (list) => list.filter((b) => b.t === 'figreq' || b.t === 'slidereq').map((b) => (b.t === 'figreq' ? `${b.kind}|${b.query}` : `slide|${b.page}`)).join('\n');
  if (figs(A) !== figs(B)) return false;
  const words = (list) => list.reduce((n, b) => n + countWords(blockText(b)), 0);
  const wa = words(A), wb = words(B);
  if (wb < wa * 0.93 || wb > wa * 1.07) return false;
  // المصطلحات: يُسمح بتصحيح إملاء القليل منها
  const ta = termsIn(before), tb = termsIn(after);
  let kept = 0;
  for (const k of ta.keys()) if (tb.has(k)) kept++;
  return kept >= ta.size * 0.85;
}

/**
 * تدقيق إملائي ولغوي للقسم بنموذج خفيف وسريع، دون أي تغيير في المحتوى. إذا غيّر المدقق شيئاً غير
 * الإملاء (حذف أو أضاف أو أعاد الترتيب) يُرفض تصحيحه ويبقى النص كما كُتب.
 */
async function proofread(engine, markup, lang) {
  if (!engine.hasGemini || countWords(markup) < 30) return markup;
  const { system, user } = proofreadPrompt(markup, { lang });
  const r = await engine.gemini({ system, parts: [{ text: user }], maxTokens: 12000, lite: true });
  if (!r?.text || r.blocked || r.truncated) return markup;
  const out = r.text.replace(/\r/g, '').replace(/^```[a-z]*\n?|```\s*$/gim, '').trim()
    .replace(/^(?:الملزمة|The notes)\s*:\s*\n/i, '').replace(/^<<<\n?|\n?>>>$/g, '').trim();
  return sameContent(markup, out) ? out : markup;
}

function joinResults(outs) {
  return {
    markup: outs.map((o) => o.markup).join('\n\n'),
    fallback: outs.every((o) => o.fallback),
    partial: outs.some((o) => o.fallback),
    review: outs.some((o) => o.review),
    model: outs.find((o) => o.model)?.model || '',
    words: outs.reduce((n, o) => n + (o.words || 0), 0),
  };
}

/** قائمة «أهم النقاط للمراجعة» في آخر الملزمة. */
async function keyPoints(engine, meta, blocks, lang) {
  const text = blocksToMarkup(blocks.filter((b) => !['figreq', 'slidereq', 'mcq', 'fig'].includes(b.t)));
  if (!engine.hasGemini && text.length > 14_000) return null; // أطول من حدود Groq المجانية
  const { system, user } = reviewPrompt(meta, text.slice(0, 120_000), { lang });
  const r = await engine.write({ system, user, maxTokens: 4000, groqTokens: 1600 });
  if (!r?.text) return null;
  const items = parseMarkup(r.text).filter((b) => b.items).flatMap((b) => b.items).filter((x) => countWords(x) >= 4).slice(0, 18);
  if (items.length < 4) return null;
  return [
    { id: uid(), t: 'h', level: 2, text: lang === 'en' ? 'Key points for review' : 'أهم النقاط للمراجعة' },
    { id: uid(), t: 'ul', items, box: true },
  ];
}

/**
 * يكتب الشرح المفصل من نص المحاضرة المفرّغ (doc.blocks أو doc.transcript).
 * عند النجاح: doc.transcript = النص المفرّغ، doc.blocks = الشرح. يرجع false إذا لم يكن التسجيل محاضرة
 * أو تعذّرت كتابة كل الأقسام (فيبقى النص المفرّغ).
 */
export async function writeNotes(doc, engine, { emit = () => {}, checkpoint = null } = {}) {
  const meta = doc.meta;
  const mode = isNotes(meta.mode) ? meta.mode : 'notes';
  const transcript = doc.transcript || doc.blocks;
  const paras = transcriptParas(transcript);
  if (!paras.length) return false;
  const lang = langOf(paras.map((p) => p.text).join(' '));
  const slides = mode === 'integrated' && doc.slides?.pages?.length ? doc.slides : null;
  const sig = textHash(paras.map((p) => p.text).join('\n') + `|${mode}|${slides ? slides.pages.length : 0}`);

  emit({ type: 'stage', name: 'write' });
  // سلايدات المحاضرة: فحص صورها مرة واحدة بالنظر، بالتوازي مع التخطيط
  let slideFigsJob = null;
  if (slides && !Array.isArray(slides.figs)) {
    emit({ type: 'notes', stage: 'slides', pages: slides.pages.length });
    slideFigsJob = detectSlideFigures(engine, slides.pages, lang).catch((e) => { if (isFatal(e)) throw e; return []; });
  }
  emit({ type: 'notes', stage: 'plan' });
  let plan = checkpoint ? await checkpoint.get('n:plan') : null;
  if (!plan || plan.sig !== sig || !Array.isArray(plan.sections)) {
    let raw = null;
    try { raw = await planNotes(engine, meta, paras, lang, slides); } catch (e) { if (isFatal(e)) throw e; }
    plan = { ...normalizePlan(raw, paras, limitFor(engine, mode).words, lang, slides ? slides.pages.length : 0), sig };
    if (checkpoint) await checkpoint.set('n:plan', plan);
  }
  if (plan.kind === 'other') { emit({ type: 'note', code: 'not_lecture' }); return false; }
  if (plan.title && !String(meta.title || '').trim()) meta.title = plan.title;
  if (slideFigsJob) slides.figs = await slideFigsJob;

  const total = plan.sections.length;
  emit({ type: 'notes', stage: 'write', total, titles: plan.titles });
  const results = new Array(total);
  const seen = new Map(); // مصطلحات الأقسام المكتوبة: تُعطى للأقسام اللاحقة حتى يتوحّد إملاؤها
  // صور كل قسم تُبحث وتُفحص بمجرد كتابته، بالتوازي مع كتابة الأقسام الباقية
  const figures = meta.images !== false && engine.io?.net ? figureQueue(engine, { lang, emit }) : null;
  let next = 0, done = 0, failure = null;
  const finishing = [];

  // بعد كتابة القسم: التدقيق الإملائي والحفظ وطلب صوره. العامل لا ينتظرها وينتقل للقسم التالي
  const finish = async (i, s, r, fresh) => {
    try {
      if (fresh && !r.fallback && !engine.late(0.9)) {
        try { r.markup = await proofread(engine, r.markup, lang); } catch (e) { if (isFatal(e)) throw e; }
      }
      if (fresh && checkpoint && !r.fallback) await checkpoint.set(`n:s${i}`, r);
      results[i] = { ...r, blocks: parseMarkup(r.markup).map((b) => ({ id: uid(), ...b })) };
      for (const [k, v] of termsIn(r.markup)) if (!seen.has(k)) seen.set(k, v);
      emit({ type: 'section', index: i, total, stage: 'done', done: ++done, title: s.title, markup: r.markup, fallback: !!r.fallback });
      figures?.add(results[i].blocks, s.title);
    } catch (e) {
      failure = failure || e;
    }
  };
  const worker = async () => {
    while (next < total && !failure) {
      const i = next++;
      const s = plan.sections[i];
      try {
        let r = checkpoint ? await checkpoint.get(`n:s${i}`) : null;
        const fresh = !r || r.sig !== sig;
        if (fresh) {
          emit({ type: 'section', index: i, total, stage: 'write', title: s.title, part: s.part, parts: s.parts });
          r = { ...(await writeSection(engine, meta, plan, s, paras, { lang, known: [...seen.values()].slice(-60), images: meta.images !== false, mode, slides })), sig };
        }
        finishing.push(finish(i, s, r, fresh));
      } catch (e) {
        failure = failure || e;
      }
    }
  };
  // كل قسم طلب طويل (دقيقة تقريباً)، فنكتب عدة أقسام معاً، دون تجاوز حد الطلبات بالدقيقة. حدود Groq أضيق
  await Promise.all(Array.from({ length: engine.hasGemini ? 4 : 2 }, worker));
  await Promise.all(finishing);
  figures?.writingDone();
  if (failure) { figures?.cancel(); throw failure; }

  if (results.every((r) => r.fallback)) {
    figures?.cancel();
    if (!engine.hasGemini && !engine.hasGroqLlm) throw new PipelineError('no_engine', 'no engine left to write the notes');
    emit({ type: 'note', code: 'notes_failed' });
    return false;
  }

  const blocks = results.flatMap((r) => r.blocks);
  if (figures) pendingFigures.set(doc, figures);

  const countText = (list) => list.reduce((n, b) => n + countWords(blockText(b)), 0);
  doc.transcript = transcript;
  doc.blocks = blocks;
  doc.lang = lang;
  meta.mode = mode;
  doc.stats = {
    ...doc.stats,
    words: countText(blocks),
    transcriptWords: countText(transcript),
    sections: plan.titles.length,
    fallback: results.filter((r) => r.fallback || r.partial).length,
    notesReview: results.filter((r) => r.review).length,
  };
  return true;
}

// ───────────── القاموس والعنوان والصور ─────────────

/** نص الشرح قبل موضع الصورة (الفقرات السابقة حتى العنوان)، لتعرف أداة التحقق ماذا توضّح الصورة. */
function contextBefore(blocks, at) {
  const parts = [];
  let words = 0, section = '';
  for (let i = at - 1; i >= 0 && words < 110; i--) {
    const b = blocks[i];
    if (b.t === 'fig' || b.t === 'figreq') continue;
    const text = stripMarkup(blockText(b));
    if (b.t === 'h') { if (!section) section = text; if (b.level !== 3 || words > 40) break; continue; }
    parts.unshift(text);
    words += countWords(text);
  }
  if (!section) for (let i = at - 1; i >= 0; i--) if (blocks[i].t === 'h' && blocks[i].level !== 3) { section = stripMarkup(blocks[i].text); break; }
  return { context: parts.join(' ').split(/\s+/).slice(-140).join(' '), section };
}

/** يختار طلبات الصور بالتناوب بين الأقسام حتى لا تتكدس الصور في أول الملزمة. */
function spreadRequests(blocks, max) {
  const bySection = [];
  let cur = null;
  blocks.forEach((b, i) => {
    if (b.t === 'h' && b.level !== 3) { cur = []; bySection.push(cur); }
    if (b.t === 'figreq') { if (!cur) { cur = []; bySection.push(cur); } cur.push(i); }
  });
  const picked = [];
  for (let round = 0; picked.length < max; round++) {
    let any = false;
    for (const list of bySection) if (list[round] !== undefined && picked.length < max) { picked.push(list[round]); any = true; }
    if (!any) break;
  }
  return picked.sort((a, b) => a - b);
}

/**
 * المراحل الأخيرة معاً: نقاط المراجعة (للشرح المفصل) + القاموس + الصور.
 * كلها اختيارية: فشل أي منها لا يُفشل المحاضرة.
 */
export async function complete(doc, engine, { io, emit = () => {} }) {
  const lang = doc.lang || langOf(doc.blocks.map(blockText).join(' '));
  const mode = doc.meta.mode;
  const safe = (p) => p.catch((e) => { if (isFatal(e)) throw e; return null; });
  // نص الشرح يُقرأ الآن قبل أن تُدرج الصور. النقاط للمراجعة للشرح المفصل، والأسئلة للنقاط الامتحانية
  const points = mode === 'notes' || mode === 'integrated' ? safe(keyPoints(engine, doc.meta, doc.blocks, lang)) : null;
  const mcq = mode === 'highyield' ? safe((async () => { emit({ type: 'stage', name: 'mcq' }); return mcqBlocks(engine, doc.meta, doc.blocks, lang); })()) : null;
  const slideFigs = doc.slides?.figs?.length ? safe(placeSlideFigures(doc, io)) : null;
  const [kp, qs] = await Promise.all([points, mcq, slideFigs, enrich(doc, engine, { io, emit })]);
  const extra = [...(kp || []), ...(qs || [])];
  if (extra.length) {
    doc.blocks.push(...extra);
    doc.stats.words = doc.blocks.reduce((n, b) => n + countWords(blockText(b)), 0);
  }
  doc.blocks = doc.blocks.filter((b) => b.t !== 'slidereq'); // طلبات سلايدات بلا صورة
  return doc;
}

/** قاموس المصطلحات + العنوان + الصور التوضيحية، معاً (فشلها لا يُفشل المحاضرة). */
export async function enrich(doc, engine, { io, emit = () => {} }) {
  const meta = doc.meta;
  const lang = doc.lang || langOf(doc.blocks.map(blockText).join(' '));

  // ── القاموس ──
  const glossary = async () => {
    if (meta.glossary === false) return;
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
      if (isFatal(e)) throw e;
      emit({ type: 'note', code: 'glossary_failed' });
    }
  };

  // ── العنوان والصور ──
  const figures = async () => {
    emit({ type: 'stage', name: 'figures' });
    const queue = pendingFigures.get(doc);
    pendingFigures.delete(doc);
    try {
      if (queue) {
        // الشرح المفصل: صوره بُحثت وفُحصت أثناء الكتابة؛ ننتظر ما بقي منها ونضعها مكان طلباتها
        emit({ type: 'stage', name: 'images' });
        const found = await queue.results();
        doc.blocks = doc.blocks.map((b) => (b.t === 'figreq' && found.has(b.id) ? figBlock(found.get(b.id)) : b));
        return;
      }
      const textWords = doc.stats?.words || doc.blocks.reduce((n, b) => n + countWords(blockText(b)), 0);
      const maxFigures = meta.images === false ? 0 : Math.min(14, Math.max(2, Math.round(textWords / 300)));
      let wanted = [];
      if (doc.blocks.some((b) => b.t === 'figreq')) {
        // الشرح المفصل: الكاتب حدد بنفسه موضع كل صورة وما يجب أن تُظهره
        wanted = spreadRequests(doc.blocks, maxFigures).map((i) => {
          const b = doc.blocks[i];
          return { anchor: b.id, replace: true, query: b.query, alt: b.alt, kind: b.kind, show: b.show, caption: b.caption, ...contextBefore(doc.blocks, i) };
        });
      } else {
        // النص المفرّغ: مخطط يقترح العنوان ومواضع الصور
        const textBlocks = doc.blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.t !== 'fig');
        const outline = textBlocks.map(({ b, i }) => {
          const kind = b.t === 'h' ? 'H' : b.t === 'note' ? 'N' : b.items || b.rows ? 'L' : 'P';
          const words = stripMarkup(blockText(b)).split(/\s+/);
          return `${i} ${kind}: ${words.slice(0, b.t === 'h' ? 14 : 26).join(' ')}${words.length > 26 ? '…' : ''}`;
        }).join('\n').slice(0, 14000);
        const { system, user } = figuresPrompt(meta, outline, Math.max(maxFigures, 1));
        const plan = await engine.json({ system, user, maxTokens: 3000 });
        if (plan?.title && !String(meta.title || '').trim()) doc.meta.title = cleanTitle(plan.title);
        if (maxFigures > 0 && Array.isArray(plan?.figures)) {
          wanted = plan.figures
            .filter((f) => f && typeof f.query === 'string' && f.query.trim() && Number.isInteger(f.after) && f.after >= 0 && f.after < doc.blocks.length && doc.blocks[f.after].t !== 'fig')
            .slice(0, maxFigures)
            .map((f) => ({
              anchor: doc.blocks[f.after].id, replace: false, query: f.query.trim().slice(0, 80), alt: String(f.alt || '').trim().slice(0, 80),
              kind: ['radiograph', 'diagram', 'photo', 'micrograph'].includes(f.kind) ? f.kind : 'diagram',
              show: String(f.show || '').trim().slice(0, 300), caption: String(f.caption || '').trim().slice(0, 200), ...contextBefore(doc.blocks, f.after + 1),
            }));
        }
      }
      if (wanted.length) {
        emit({ type: 'stage', name: 'images', total: wanted.length });
        const figs = await pickFigures(wanted, engine, io, emit, { lang });
        for (const f of figs) {
          const at = doc.blocks.findIndex((b) => b.id === f.anchor);
          if (at < 0) continue;
          const block = figBlock(f);
          if (f.replace) { doc.blocks.splice(at, 1, block); continue; }
          let pos = at + 1;
          if (doc.blocks[at].t === 'h' && doc.blocks[pos] && doc.blocks[pos].t !== 'h') pos++; // لا نضع الصورة بين العنوان وفقرته
          doc.blocks.splice(pos, 0, block);
        }
      }
    } catch (e) {
      if (isFatal(e)) throw e;
      emit({ type: 'note', code: 'figures_failed' });
    } finally {
      doc.blocks = doc.blocks.filter((b) => b.t !== 'figreq'); // طلبات صور لم تجد صورة مطابقة: تُحذف ولا توضع صورة خاطئة
    }
  };

  // القاموس يقرأ المصطلحات قبل أن تبدأ الصور بتعديل المستند، ثم يعملان معاً
  await Promise.all([glossary(), figures()]);
  if (!String(doc.meta.title || '').trim()) {
    const h = doc.blocks.find((b) => b.t === 'h');
    doc.meta.title = h ? stripMarkup(h.text) : doc.meta.subject || 'محاضرة';
  }
  return doc;
}

const pendingFigures = new WeakMap(); // مستند ← صور تُبحث له أثناء كتابة الشرح

const figBlock = (f) => ({ id: uid(), t: 'fig', caption: f.caption, query: f.query, kind: f.kind, pick: f.pick, candidates: f.candidates, img: f.img });

const KIND_WORDS = { radiograph: ['radiograph', 'x-ray'], diagram: ['diagram', 'anatomy'], micrograph: ['histology', 'micrograph'], photo: ['photo'] };
/**
 * عبارتا بحث للجولة الثانية لم تُستعملا في الأولى: الاسم العام مع نوع الصورة، مثل «pleura diagram».
 * @returns {{query:string, alt:string}|null}
 */
function secondRound(f) {
  const base = (f.alt || f.query).trim();
  const seen = new Set([f.query, f.alt].filter(Boolean).map((q) => q.toLowerCase()));
  const variants = (KIND_WORDS[f.kind] || KIND_WORDS.diagram)
    .map((w) => (base.toLowerCase().includes(w) ? '' : `${base} ${w}`))
    .filter((q) => q && !seen.has(q.toLowerCase()));
  return variants.length ? { query: variants[0], alt: variants[1] || '' } : null;
}

/** ينفّذ مهام غير متزامنة بحد أقصى من التوازي. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/** درجة الثقة من 0 إلى 1، حتى لو كتبها النموذج نسبة مئوية أو كلمة. */
function confidenceOf(v) {
  if (typeof v === 'string' && !/\d/.test(v)) return /high|عال/i.test(v) ? 0.9 : /medium|متوسط/i.test(v) ? 0.6 : 0;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

/**
 * يسأل نموذجاً يرى الصور أي مرشح يطابق كل شكل من عدة أشكال، في طلب واحد (أسرع وأوفر من طلب لكل صورة).
 * @param items [{ f, ok:[{c, t}] }]
 * @returns Map<index, {idx, caption, vision}>
 */
async function chooseFigures(engine, items, lang) {
  const picks = new Map();
  if (!items.length) return picks;
  if (engine.hasGemini) {
    const figs = items.map(({ f, ok }, i) => ({ n: i + 1, context: f.context, section: f.section, show: f.show, query: f.query, kind: f.kind, labels: ok.map((_, k) => `${i + 1}${String.fromCharCode(65 + k)}`) }));
    const { system, user } = figuresBatchPrompt(figs, { lang });
    const parts = [{ text: user }];
    items.forEach(({ ok }, i) => ok.forEach((x, k) => {
      parts.push({ text: `${i + 1}${String.fromCharCode(65 + k)} — ${x.c.title || ''}` });
      parts.push({ inline_data: { mime_type: x.t.mime, data: x.t.base64 } });
    }));
    const r = await engine.gemini({ system, parts, json: true, maxTokens: 4000, strongWaitMs: 30_000 });
    const parsed = r?.text ? parseJsonLoose(r.text) : null;
    if (parsed && Array.isArray(parsed.picks)) {
      for (const p of parsed.picks) {
        const n = parseInt(p?.fig, 10);
        const m = String(p?.choice || '').trim().toUpperCase().match(/^(\d+)?([A-Z])$/);
        if (!Number.isInteger(n) || !m || !items[n - 1]) continue;
        if (m[1] && parseInt(m[1], 10) !== n) continue;
        const idx = m[2].charCodeAt(0) - 65;
        if (idx < 0 || idx >= items[n - 1].ok.length) continue;
        if (!(confidenceOf(p.confidence) >= 0.7)) continue;
        picks.set(n - 1, { idx, caption: String(p.caption || '').replace(/\s+/g, ' ').trim().slice(0, 320), vision: true });
      }
      return picks;
    }
  }
  if (!engine.hasGroqLlm) return picks;
  // بلا نموذج يرى الصور: اختيار صارم من عناوين المرشحات، شكلاً شكلاً
  for (let i = 0; i < items.length; i++) {
    const { f, ok } = items[i];
    const { system, user } = figureTextPickPrompt(f, ok.map((x) => x.c), { lang });
    const parsed = await engine.json({ system, user, maxTokens: 900 });
    const m = String(parsed?.choice || '').trim().toUpperCase().match(/^([A-Z])(?![A-Z])/);
    if (!m) continue;
    const idx = m[1].charCodeAt(0) - 65;
    if (idx < 0 || idx >= ok.length || !(confidenceOf(parsed.confidence) >= 0.85)) continue;
    picks.set(i, { idx, caption: String(parsed.caption || '').replace(/\s+/g, ' ').trim().slice(0, 320), vision: false });
  }
  return picks;
}

/**
 * دفعة أشكال (حتى 4): يبحث عن مرشحات كل شكل ويحمّل مصغّراتها معاً، ثم يتحقق منها بالنظر في طلب واحد،
 * ثم جولة ثانية بعبارات أعم لما لم يُطابَق (إن سمح الوقت). الصورة الخاطئة أسوأ من عدمها: ما لم يُطابَق يبقى بلا صورة.
 * @returns نتائج بنفس ترتيب figs (null = لا صورة)
 */
async function pickBatch(figs, engine, io, used, lang) {
  const results = new Array(figs.length).fill(null);
  const tried = figs.map(() => new Set());
  for (let round = 0; round < 2; round++) {
    const todo = [];
    figs.forEach((f, i) => {
      if (results[i]) return;
      const q = round === 0 ? f : (secondRound(f) ? { ...f, ...secondRound(f) } : null);
      if (q) todo.push({ i, q });
    });
    if (!todo.length || (round > 0 && engine.late(0.8))) break;
    const found = await mapLimit(todo, 4, async ({ i, q }) => {
      const cands = (await findCandidates(q, io.net, 6).catch(() => [])).filter((c) => {
        const k = c.original || c.id;
        if (used.has(k) || tried[i].has(k)) return false;
        tried[i].add(k);
        return true;
      }).slice(0, 6);
      const thumbs = await Promise.all(cands.map((c) => io.loadImage(c, 'small').catch(() => null)));
      cands.forEach((c, k) => { if (thumbs[k]) c.tiny = thumbs[k].dataUrl; }); // تبقى للمعاينة عند تبديل الصورة
      const ok = cands.map((c, k) => ({ c, t: thumbs[k] })).filter((x) => x.t);
      return { i, f: figs[i], ok };
    });
    const items = found.filter((x) => x.ok.length);
    if (!items.length) continue;
    const picks = await chooseFigures(engine, items, lang);
    await mapLimit([...picks.entries()], 3, async ([k, v]) => {
      const { i, f, ok } = items[k];
      const pick = ok[v.idx].c;
      const key = pick.original || pick.id;
      if (used.has(key)) return; // اختارتها صورة أخرى في نفس اللحظة
      used.add(key);
      const img = await io.loadImage(pick, 'large').catch(() => null) || ok[v.idx].t;
      if (!img?.dataUrl) { used.delete(key); return; }
      results[i] = { ...f, caption: v.caption || f.caption, pick, candidates: ok.map((x) => x.c), img: { dataUrl: img.dataUrl, w: img.w, h: img.h } };
    });
  }
  return results;
}

/**
 * صور الشرح المفصل: لكل قسم دفعة واحدة تُبحث وتُفحص بمجرد كتابته، بالتوازي مع كتابة الأقسام الباقية.
 * حتى أربع صور للقسم، بنحو صورة لكل 250 كلمة من شرحه.
 */
function figureQueue(engine, { lang, emit }) {
  const used = new Set();
  const found = new Map();
  const jobs = [];
  const waiting = [];
  let active = 0, limit = 2, total = 0, picked = 0, cancelled = false;
  const take = async () => { while (active >= limit) await new Promise((r) => waiting.push(r)); active++; };
  const release = () => { active--; waiting.shift()?.(); };
  return {
    add(blocks, section) {
      const words = blocks.reduce((n, b) => n + countWords(blockText(b)), 0);
      const cap = Math.min(4, Math.max(1, Math.round(words / 250)));
      const reqs = blocks.map((b, i) => [b, i]).filter(([b]) => b.t === 'figreq').slice(0, cap);
      if (!reqs.length) return;
      const figs = reqs.map(([b, i]) => {
        const f = { anchor: b.id, replace: true, query: b.query, alt: b.alt, kind: b.kind, show: b.show, caption: b.caption, ...contextBefore(blocks, i) };
        if (!f.section) f.section = section;
        return f;
      });
      total += figs.length;
      const job = (async () => {
        await take();
        try {
          if (cancelled || engine.late(0.95)) return;
          const res = await pickBatch(figs, engine, engine.io, used, lang);
          res.forEach((r, i) => { if (r) { found.set(figs[i].anchor, r); emit({ type: 'images', picked: ++picked, total }); } });
        } catch (e) {
          if (isFatal(e)) throw e;
        } finally {
          release();
        }
      })();
      job.catch(() => {}); // تُقرأ النتيجة لاحقاً في results()
      jobs.push(job);
    },
    writingDone() { limit = 3; for (let k = 0; k < 3; k++) waiting.shift()?.(); },
    cancel() { cancelled = true; },
    async results() { await Promise.all(jobs); return found; },
  };
}

/** صور النص المفرّغ (أو أي قائمة طلبات): دفعات من أربعة، ثلاث دفعات في نفس الوقت، وكل صورة تمر بالتحقق. */
export async function pickFigures(wanted, engine, io, emit = () => {}, { lang = 'ar' } = {}) {
  const used = new Set();
  const batches = [];
  for (let i = 0; i < wanted.length; i += 4) batches.push(wanted.slice(i, i + 4));
  let picked = 0;
  const out = await mapLimit(batches, 3, async (figs) => {
    if (engine.late(0.95)) return figs.map(() => null);
    try {
      const res = await pickBatch(figs, engine, io, used, lang);
      for (const r of res) if (r) emit({ type: 'images', picked: ++picked, total: wanted.length });
      return res;
    } catch (e) {
      if (isFatal(e)) throw e;
      return figs.map(() => null);
    }
  });
  return out.flat().filter(Boolean);
}

// ───────────── صور السلايدات (النوع المتكامل) ─────────────

/**
 * يفحص صفحات السلايدات بالنظر مرة واحدة: أي الصفحات فيها شكل، وأين، وماذا يُظهر.
 * @param pages [{ page, small:{mime, base64} }]
 * @returns [{ page, box:[y1,x1,y2,x2] (0..1000), what, kind }]
 */
export async function detectSlideFigures(engine, pages, lang = 'ar') {
  const out = [];
  if (!engine.hasGemini) return out;
  for (let i = 0; i < pages.length; i += 30) {
    const group = pages.slice(i, i + 30).filter((p) => p.small?.base64);
    if (!group.length) continue;
    const { system, user } = slideFiguresPrompt(group, { lang });
    const parts = [{ text: user }];
    for (const p of group) { parts.push({ text: `ص${p.page}` }); parts.push({ inline_data: { mime_type: p.small.mime || 'image/jpeg', data: p.small.base64 } }); }
    const r = await engine.gemini({ system, parts, json: true, maxTokens: 6000, strongWaitMs: 30_000 });
    const parsed = r?.text ? parseJsonLoose(r.text) : null;
    for (const f of parsed?.figures || []) {
      const page = parseInt(f?.page, 10);
      if (!group.some((p) => p.page === page)) continue;
      let box = Array.isArray(f.box) && f.box.length === 4 ? f.box.map((v) => Math.min(1000, Math.max(0, Number(v) || 0))) : [0, 0, 1000, 1000];
      if (box[2] - box[0] < 60 || box[3] - box[1] < 60) box = [0, 0, 1000, 1000];
      out.push({ page, box, what: String(f.what || '').replace(/\s+/g, ' ').trim().slice(0, 240), kind: ['radiograph', 'diagram', 'photo', 'micrograph'].includes(f.kind) ? f.kind : 'diagram' });
    }
  }
  return out;
}

/** يحوّل طلبات @slide في الملزمة إلى صور مقصوصة من صفحات السلايدات. */
async function placeSlideFigures(doc, io) {
  const slides = doc.slides;
  if (!slides?.figs?.length || !io.cropImage) return;
  const usedPages = new Set();
  const byPage = new Map();
  for (const f of slides.figs) if (!byPage.has(f.page)) byPage.set(f.page, []);
  for (const f of slides.figs) byPage.get(f.page).push(f);
  for (let i = 0; i < doc.blocks.length; i++) {
    const b = doc.blocks[i];
    if (b.t !== 'slidereq') continue;
    const figs = byPage.get(b.page);
    const page = slides.pages.find((p) => p.page === b.page);
    if (!figs?.length || !page?.big || usedPages.has(b.page)) continue;
    // أكبر شكل في الصفحة
    const f = figs.reduce((a, c) => ((c.box[2] - c.box[0]) * (c.box[3] - c.box[1]) > (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) ? c : a));
    try {
      const img = await io.cropImage(page.big, f.box);
      if (!img?.dataUrl) continue;
      usedPages.add(b.page);
      doc.blocks[i] = { id: uid(), t: 'fig', caption: b.caption || f.what, query: '', kind: f.kind, pick: { id: `slide:${b.page}`, source: 'slides', title: `سلايد ${b.page}`, license: 'من ملف المحاضرة', page: '' }, candidates: [], img };
    } catch { /* تبقى بلا صورة */ }
  }
}

// ───────────── المراجعة النهائية ─────────────

const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/** يطبّق استبدالاً نصياً على كتلة (نص، بنود، خلايا، سؤال). يرجع عدد المواضع التي تغيّرت. */
function replaceInBlock(b, find, replace, all) {
  let n = 0;
  const sub = (s) => {
    if (typeof s !== 'string' || !s.includes(find)) return s;
    n++;
    return all ? s.split(find).join(replace) : s.replace(find, replace);
  };
  if (typeof b.text === 'string') b.text = sub(b.text);
  if (Array.isArray(b.items)) b.items = b.items.map(sub);
  if (Array.isArray(b.head)) b.head = b.head.map(sub);
  if (Array.isArray(b.rows)) b.rows = b.rows.map((r) => r.map(sub));
  if (b.t === 'mcq') { b.q = sub(b.q); b.opts = b.opts.map(sub); b.why = sub(b.why); }
  if (b.t === 'fig' && typeof b.caption === 'string') b.caption = sub(b.caption);
  return n;
}

/**
 * يطبّق نتيجة المراجعة بأمان: استبدالات يجب أن تطابق نصاً موجوداً، وإضافات تحت عناوين موجودة.
 * @returns { fixes, added }
 */
export function applyReview(blocks, parsed) {
  let fixes = 0, added = 0;
  for (const fx of Array.isArray(parsed?.fixes) ? parsed.fixes.slice(0, 40) : []) {
    const find = squash(fx?.find), replace = squash(fx?.replace);
    if (!find || find === replace || countWords(find) < 2) continue;
    if (replace.length > Math.max(find.length * 3, find.length + 300)) continue; // ليس تصحيحاً بل إعادة كتابة
    const all = countWords(find) <= 6; // مصطلح أو عبارة قصيرة: توحيد في كل المواضع
    let n = 0;
    for (const b of blocks) { n += replaceInBlock(b, find, replace, all); if (n && !all) break; }
    if (n) fixes++;
  }
  for (const add of Array.isArray(parsed?.missing) ? parsed.missing.slice(0, 15) : []) {
    const after = normalize(squash(add?.after).replace(/^#+\s*/, '').replace(/\[\[|\]\]/g, ''));
    const extra = parseMarkup(String(add?.add || '')).filter((b) => b.t !== 'figreq' && b.t !== 'slidereq' && b.t !== 'h');
    if (!after || !extra.length || extra.reduce((n, b) => n + countWords(blockText(b)), 0) < 3) continue;
    const at = blocks.findIndex((b) => b.t === 'h' && normalize(stripMarkup(b.text)) === after);
    if (at < 0) continue;
    const level = blocks[at].level || 2;
    let end = at + 1;
    while (end < blocks.length && !(blocks[end].t === 'h' && (blocks[end].level || 2) <= level)) end++;
    blocks.splice(end, 0, ...extra.map((b) => ({ id: uid(), ...b })));
    added++;
  }
  return { fixes, added };
}

/** مراجعة الملزمة كاملة مقابل التفريغ بأقوى نموذج، وتطبيق التصحيحات. اختيارية: فشلها لا يُفشل الملزمة. */
export async function reviewNotes(doc, engine, { emit = () => {} } = {}) {
  if (!engine.hasGemini || !doc.transcript?.length) return null;
  if (engine.late(1.5)) { emit({ type: 'note', code: 'review_skipped' }); return null; }
  emit({ type: 'stage', name: 'review' });
  const lang = doc.lang || langOf(doc.blocks.map(blockText).join(' '));
  const textBlocks = (list) => list.filter((b) => !['fig', 'figreq', 'slidereq'].includes(b.t));
  const notes = blocksToMarkup(textBlocks(doc.blocks));
  let transcript = blocksToMarkup(textBlocks(doc.transcript));
  let condensed = false;
  const budget = 420_000 - Math.min(notes.length, 200_000);
  if (transcript.length > budget) { transcript = transcript.slice(0, budget); condensed = true; }
  const { system, user } = reviewNotesPrompt(doc.meta, notes, transcript, { lang, mode: doc.meta.mode, condensed });
  try {
    const r = await engine.gemini({ system, parts: [{ text: user }], json: true, maxTokens: 14000, thinking: 'low', strongWaitMs: 45_000 });
    const parsed = r?.text ? parseJsonLoose(r.text) : null;
    if (!parsed) { emit({ type: 'note', code: 'review_failed' }); return null; }
    const { fixes, added } = applyReview(doc.blocks, parsed);
    doc.stats.audit = { fixes, added, verdict: String(parsed.verdict || '').slice(0, 200), model: r.model };
    doc.stats.words = doc.blocks.reduce((n, b) => n + countWords(blockText(b)), 0);
    emit({ type: 'reviewed', fixes, added });
    return doc.stats.audit;
  } catch (e) {
    if (isFatal(e)) throw e;
    emit({ type: 'note', code: 'review_failed' });
    return null;
  }
}

// ───────────── أسئلة الاختيار من متعدد ─────────────

/** أسئلة MCQ من الملزمة (للنوع High-Yield): يرجع كتلاً تُلحق بآخر الملزمة، أو null. */
async function mcqBlocks(engine, meta, blocks, lang) {
  const text = blocksToMarkup(blocks.filter((b) => !['fig', 'figreq', 'slidereq', 'mcq'].includes(b.t)));
  if (!engine.hasGemini && text.length > 14_000) return null;
  const words = countWords(text);
  const count = Math.min(20, Math.max(8, Math.round(words / 110)));
  const { system, user } = mcqPrompt(meta, text.slice(0, 160_000), { lang, count });
  const parsed = await engine.json({ system, user, maxTokens: 9000, groqTokens: 4000, prefer: 'gemini' });
  const qs = (Array.isArray(parsed?.questions) ? parsed.questions : [])
    .map((q) => ({ q: squash(q?.q), opts: (Array.isArray(q?.options) ? q.options : []).map(squash).filter(Boolean).slice(0, 4), ans: parseInt(q?.answer, 10), why: squash(q?.why) }))
    .filter((q) => q.q && q.opts.length === 4 && q.ans >= 0 && q.ans < 4)
    .slice(0, count);
  if (qs.length < 3) return null;
  return [
    { id: uid(), t: 'h', level: 2, text: lang === 'en' ? 'Self-assessment MCQs' : 'أسئلة اختيار من متعدد للمراجعة' },
    ...qs.map((q) => ({ id: uid(), t: 'mcq', ...q })),
  ];
}
