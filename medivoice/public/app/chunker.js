// chunker.js
// يقطّع أي ملف صوت أو فيديو إلى مقاطع صوتية صغيرة داخل المتصفح.
// الصيغ المضغوطة (AAC / MP3 / Opus / Vorbis / FLAC) تُنسخ حزمها كما هي بدون إعادة ترميز،
// فلا تنقص الجودة ولا يُحمَّل الملف كله في الذاكرة. ملفات WAV تُحوَّل إلى 16kHz أحادي.

import {
  Input, Output, BlobSource, BufferTarget, ALL_FORMATS,
  EncodedPacketSink, EncodedAudioPacketSource,
  Mp4OutputFormat, Mp3OutputFormat, OggOutputFormat, FlacOutputFormat, WavOutputFormat,
  Conversion,
} from './vendor.js';

export class AudioError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const COPY = {
  aac:    { fmt: () => new Mp4OutputFormat({ fastStart: 'in-memory' }), ext: 'm4a',  mime: 'audio/mp4'  },
  mp3:    { fmt: () => new Mp3OutputFormat(),                           ext: 'mp3',  mime: 'audio/mpeg' },
  opus:   { fmt: () => new OggOutputFormat(),                           ext: 'ogg',  mime: 'audio/ogg'  },
  vorbis: { fmt: () => new OggOutputFormat(),                           ext: 'ogg',  mime: 'audio/ogg'  },
  flac:   { fmt: () => new FlacOutputFormat(),                          ext: 'flac', mime: 'audio/flac' },
};

const isPcm = (codec) => !!codec && (codec.startsWith('pcm-') || codec === 'ulaw' || codec === 'alaw');

function newInput(blob) {
  return new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
}

/**
 * يفحص الملف ويرجع معلومات المسار الصوتي.
 * @returns {Promise<{duration:number, firstTs:number, end:number, codec:string|null, sampleRate:number, channels:number, mode:'copy'|'transcode', hasVideo:boolean}>}
 * duration طول الصوت بالثواني، و end زمن نهايته (يختلف عن الطول إذا بدأ الصوت بعد الصفر)
 */
export async function probeAudio(blob) {
  const input = newInput(blob);
  try {
    let track;
    try {
      track = await input.getPrimaryAudioTrack();
    } catch (e) {
      // السبب الأصلي يبقى (ملف سحب الموبايل وصول الصفحة له يختلف عن صيغة غير مدعومة)
      throw Object.assign(new AudioError('unsupported', 'صيغة الملف غير مدعومة'), { cause: e });
    }
    if (!track) throw new AudioError('no-audio', 'الملف لا يحتوي على صوت');
    const codec = track.codec;
    let mode = null;
    if (codec && COPY[codec]) mode = 'copy';
    else if (isPcm(codec)) mode = 'transcode';
    else if (await track.canDecode().catch(() => false)) mode = 'transcode';
    if (!mode) throw new AudioError('codec', 'ترميز الصوت في هذا الملف غير مدعوم');
    // بالتتابع وليس بالتوازي: بعض القارئات (FLAC) لا تتحمل قراءات متزامنة
    const firstTs = await track.getFirstTimestamp();
    // computeDuration ترجع زمن نهاية آخر حزمة، لا الطول: ملف يبدأ صوته عند 400 ثانية كان يُحسب طوله ضعفاً
    const end = await track.computeDuration();
    const duration = end - Math.max(0, firstTs);
    const videos = await input.getVideoTracks().catch(() => []);
    if (!(duration > 0)) throw new AudioError('empty', 'الملف فارغ');
    return {
      duration, firstTs, end, codec, mode,
      sampleRate: track.sampleRate, channels: track.numberOfChannels,
      hasVideo: videos.length > 0,
    };
  } finally {
    input.dispose();
  }
}

/**
 * مولّد غير متزامن يعطي المقاطع بالترتيب.
 * كل مقطع يغطي [start, end) من زمن الملف مع هامش تداخل من الجهتين،
 * و offset هو الزمن الحقيقي لبداية المقطع (الثانية صفر داخل المقطع).
 *
 * @param {Blob} blob
 * @param {{targetSec?:number, overlapSec?:number, maxBytes?:number, skipBefore?:number, signal?:AbortSignal}} opts
 * @yields {{index:number, start:number, end:number, offset:number, audioSec:number, blob:Blob, ext:string, mime:string, last:boolean}}
 */
export async function* chunkAudio(blob, opts = {}) {
  const targetSec = opts.targetSec ?? 300;
  const overlap = opts.overlapSec ?? 1;
  const maxBytes = opts.maxBytes ?? 18 * 1024 * 1024;
  const info = opts.info ?? await probeAudio(blob);
  if (info.mode === 'copy') yield* copyChunks(blob, info, { targetSec, overlap, maxBytes, signal: opts.signal });
  else yield* transcodeChunks(blob, info, { targetSec, overlap, maxBytes, signal: opts.signal });
}

const endOf = (info) => (Number.isFinite(info.end) ? info.end : info.firstTs + info.duration);

/**
 * فرصة للمتصفح ليرسم ويستجيب (شريط التقدم واللعبة) أثناء عمل طويل متواصل. عندما تكون الصفحة مخفية لا نتوقف:
 * المؤقتات هناك مُبطَّأة لثانية أو أكثر، ولا واجهة تُرسم أصلاً.
 */
let lastYield = 0;
async function breathe() {
  const now = performance.now();
  if (now - lastYield < 30) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { lastYield = now; return; }
  if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
  else await new Promise((r) => setTimeout(r, 0));
  lastYield = performance.now();
}

async function* copyChunks(blob, info, { targetSec, overlap, maxBytes, signal }) {
  const input = newInput(blob);
  try {
    const track = await input.getPrimaryAudioTrack();
    const codec = track.codec;
    const spec = COPY[codec];
    const decoderConfig = await track.getDecoderConfig();
    const sink = new EncodedPacketSink(track);
    const endOfFile = endOf(info);

    let index = 0;
    let start = info.firstTs;      // البداية الاسمية للمقطع الحالي
    let cur = null;                // المقطع المفتوح
    let recent = [];               // آخر الحزم (ضعف هامش التداخل) لتبدأ بها القطعة التالية

    const open = async (seed) => {
      const output = new Output({ format: spec.fmt(), target: new BufferTarget() });
      const source = new EncodedAudioPacketSource(codec);
      output.addAudioTrack(source);
      await output.start();
      const c = { output, source, base: null, bytes: 0, lastEnd: 0, first: true };
      for (const p of seed) await push(c, p);
      return c;
    };
    const push = async (c, p) => {
      if (c.base === null) c.base = p.timestamp;
      // نسخة من بيانات الحزمة: الأصل جزء من ذاكرة قراءة الملف (وفي الفيديو معظمها صورة)، وإبقاؤه يحجز
      // مئات الميغابايتات حتى ينتهي المقطع
      const local = p.clone({ timestamp: Math.max(0, p.timestamp - c.base), data: p.data.slice() });
      await c.source.add(local, c.first ? { decoderConfig } : undefined);
      c.first = false;
      c.bytes += p.data.byteLength + 16; // + حجز الحاوية لكل حزمة (جداول MP4)، حتى لا يتجاوز الحد بعد التغليف
      c.lastEnd = p.timestamp + p.duration;
    };
    const close = async (c, end, last) => {
      await c.output.finalize();
      const buffer = c.output.target.buffer;
      return {
        index: index++, start, end, offset: c.base, audioSec: Math.max(0, c.lastEnd - c.base),
        blob: new Blob([buffer], { type: spec.mime }), ext: spec.ext, mime: spec.mime, last,
      };
    };

    // قراءة الحزم واحدة واحدة (مكرر packets() في المكتبة بطيء جداً مع الملفات الطويلة)، مع فرصة للواجهة كل 30ms
    let keepAt = 0;
    for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
      if (signal?.aborted) throw new AudioError('aborted', 'أُلغيت العملية');
      await breathe();
      const ts = packet.timestamp;
      if (!cur) cur = await open([]);
      let end = start + targetSec;
      // لا نترك ذيلاً أقصر من 20 ثانية كمقطع مستقل
      if (endOfFile - end < 20) end = Infinity;
      // حد الحجم يسري على المقطع الأخير أيضاً (كان يُهمل فيتجاوز ذيل الملف حد الرفع)
      const overBytes = cur.bytes + packet.data.byteLength + 16 > maxBytes && ts - start > 30;
      if (overBytes && ts < end) end = ts - overlap; // قطع مبكر بسبب الحجم

      if (ts >= end + overlap) {
        const boundary = end;
        yield await close(cur, boundary, false);
        start = boundary;
        cur = await open(recent.slice(keepAt).filter((p) => p.timestamp >= boundary - overlap));
      }
      await push(cur, packet);
      recent.push(packet.clone({ data: packet.data.slice() }));
      const keepFrom = ts - 2 * overlap - 0.5;
      while (keepAt < recent.length && recent[keepAt].timestamp < keepFrom) keepAt++;
      if (keepAt > 512) { recent = recent.slice(keepAt); keepAt = 0; } // shift() متكرر بطيء على المصفوفات الطويلة
    }
    if (cur && cur.base !== null) yield await close(cur, endOfFile, true);
    else throw new AudioError('empty', 'الملف فارغ');
  } finally {
    input.dispose();
  }
}

/**
 * يضغط مقطعاً إلى Opus أحادي منخفض المعدل (للكلام) قبل رفعه: نحو ربع الحجم، فيصير الرفع أسرع بكثير على
 * بيانات الهاتف. النماذج تحوّل الصوت إلى 16kHz أحادي على أي حال، فلا تنقص دقة السمع.
 * يرجع المقطع نفسه بلا تغيير إذا لم يدعم المتصفح الترميز أو فشل أي شيء.
 */
let opusOk = null; // null = لم يُجرَّب بعد، false = غير مدعوم في هذا المتصفح
let opusFails = 0;  // إخفاقات متتالية (خطأ عابر أو بطء): بعد اثنين نتوقف عن المحاولة لهذه المحاضرة
/** يبدأ كل محاضرة بمحاولة ضغط جديدة (خطأ عابر في محاضرة سابقة لا يحرم اللاحقة من الضغط). */
export function resetCompression() { if (opusOk !== false) opusOk = null; opusFails = 0; }

export async function compressChunk(chunk, { bitrate = 32000, signal } = {}) {
  if (opusOk === false || opusFails >= 2 || !chunk?.blob || chunk.ext === 'ogg') return chunk;
  if (chunk.blob.size < 400_000) return chunk; // صغير أصلاً
  const input = newInput(chunk.blob);
  let onAbort = null;
  try {
    const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input, output,
      video: { discard: true },
      audio: { codec: 'opus', numberOfChannels: 1, sampleRate: 16000, bitrate, forceTranscode: true },
      showWarnings: false,
    });
    if (!conversion.isValid) { opusOk = false; return chunk; } // المتصفح لا يدعم ترميز Opus
    // المستمع يُزال في النهاية: بقاؤه كان يمسك كل مقطع خام في الذاكرة حتى آخر المحاضرة
    onAbort = () => conversion.cancel().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    // حد زمني: إذا علق الترميز على متصفح ما، نلغيه ونرفع المقطع كما هو (لا يتوقف التحويل أبداً بسببه)
    const limitMs = Math.max(40_000, (chunk.audioSec || 0) * 120);
    let timer = null;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { conversion.cancel().catch(() => {}); rej(new Error('compress timeout')); }, limitMs); });
    try { await Promise.race([conversion.execute(), timeout]); } finally { clearTimeout(timer); }
    const buffer = output.target.buffer;
    if (!buffer || buffer.byteLength < 1000 || buffer.byteLength >= chunk.blob.size * 0.8) return chunk;
    opusOk = true;
    opusFails = 0;
    return { ...chunk, blob: new Blob([buffer], { type: 'audio/ogg' }), ext: 'ogg', mime: 'audio/ogg', compressed: { from: chunk.blob.size, to: buffer.byteLength } };
  } catch (e) {
    if (signal?.aborted) throw new AudioError('aborted', 'أُلغيت العملية');
    opusFails++; // هذا المقطع يُرفع كما هو، والمقطع التالي يحاول من جديد
    return chunk;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    input.dispose();
  }
}

async function* transcodeChunks(blob, info, { targetSec, overlap, maxBytes, signal }) {
  const endOfFile = endOf(info);
  let index = 0;
  let start = info.firstTs;
  let opus = opusOk !== false; // Opus مباشرة (نحو 2MB للمقطع)؛ وإلا WAV بطول لا يتجاوز حد الرفع (32KB لكل ثانية)
  // هامش 30 ثانية: الذيل الأقصر من 20 ثانية يُضم للمقطع الأخير ويبقى تحت الحد
  const wavSec = Math.max(60, Math.floor((maxBytes - 64 * 1024) / 32000) - 2 * overlap - 30);
  while (start < endOfFile - 0.05) {
    if (signal?.aborted) throw new AudioError('aborted', 'أُلغيت العملية');
    const span = opus ? targetSec : Math.min(targetSec, wavSec);
    let end = start + span;
    if (endOfFile - end < 20) end = endOfFile;
    const last = end >= endOfFile;
    const from = Math.max(info.firstTs, start - overlap);
    const to = Math.min(endOfFile, end + overlap);
    const input = newInput(blob);
    let onAbort = null;
    try {
      const output = new Output({ format: opus ? new OggOutputFormat() : new WavOutputFormat(), target: new BufferTarget() });
      const conversion = await Conversion.init({
        input, output,
        trim: { start: from, end: to },
        video: { discard: true },
        audio: opus ? { codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 32000, forceTranscode: true } : { codec: 'pcm-s16', sampleRate: 16000, numberOfChannels: 1 },
        showWarnings: false,
      });
      if (!conversion.isValid) {
        if (opus) { opus = false; continue; } // لا ترميز Opus هنا: نعيد المقطع نفسه بصيغة WAV
        throw new AudioError('codec', 'تعذّر تحويل هذا الملف');
      }
      onAbort = () => conversion.cancel().catch(() => {});
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await conversion.execute();
      } catch (e) {
        if (signal?.aborted) throw new AudioError('aborted', 'أُلغيت العملية');
        if (opus) { opus = false; continue; }
        throw e;
      }
      const buffer = output.target.buffer;
      // الطول الحقيقي من البيانات نفسها (WAV) أو من الحدود المطلوبة
      const audioSec = opus ? to - from : Math.max(0, (buffer.byteLength - 44) / 32000);
      yield opus
        ? { index: index++, start, end, offset: from, audioSec, blob: new Blob([buffer], { type: 'audio/ogg' }), ext: 'ogg', mime: 'audio/ogg', last }
        : { index: index++, start, end, offset: from, audioSec, blob: new Blob([buffer], { type: 'audio/wav' }), ext: 'wav', mime: 'audio/wav', last };
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      input.dispose();
    }
    start = end;
  }
}
