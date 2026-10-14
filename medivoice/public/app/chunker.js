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
 * @returns {Promise<{duration:number, firstTs:number, codec:string|null, sampleRate:number, channels:number, mode:'copy'|'transcode', hasVideo:boolean}>}
 */
export async function probeAudio(blob) {
  const input = newInput(blob);
  try {
    let track;
    try {
      track = await input.getPrimaryAudioTrack();
    } catch (e) {
      throw new AudioError('unsupported', 'صيغة الملف غير مدعومة');
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
    const duration = await track.computeDuration();
    const videos = await input.getVideoTracks().catch(() => []);
    if (!(duration > 0)) throw new AudioError('empty', 'الملف فارغ');
    return {
      duration, firstTs, codec, mode,
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
  else yield* transcodeChunks(blob, info, { targetSec, overlap, signal: opts.signal });
}

async function* copyChunks(blob, info, { targetSec, overlap, maxBytes, signal }) {
  const input = newInput(blob);
  try {
    const track = await input.getPrimaryAudioTrack();
    const codec = track.codec;
    const spec = COPY[codec];
    const decoderConfig = await track.getDecoderConfig();
    const sink = new EncodedPacketSink(track);
    const endOfFile = info.firstTs + info.duration;

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
      const local = p.clone({ timestamp: Math.max(0, p.timestamp - c.base) });
      await c.source.add(local, c.first ? { decoderConfig } : undefined);
      c.first = false;
      c.bytes += p.data.byteLength;
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

    for await (const packet of sink.packets()) {
      if (signal?.aborted) throw new AudioError('aborted', 'أُلغيت العملية');
      const ts = packet.timestamp;
      if (!cur) cur = await open([]);
      let end = start + targetSec;
      // لا نترك ذيلاً أقصر من 20 ثانية كمقطع مستقل
      if (endOfFile - end < 20) end = Infinity;
      const overBytes = cur.bytes + packet.data.byteLength > maxBytes && ts - start > 30;
      if (overBytes && end !== Infinity && ts < end) end = ts - overlap; // قطع مبكر بسبب الحجم

      if (ts >= end + overlap) {
        const boundary = end;
        yield await close(cur, boundary, false);
        start = boundary;
        cur = await open(recent.filter((p) => p.timestamp >= boundary - overlap));
      }
      await push(cur, packet);
      recent.push(packet);
      const keepFrom = ts - 2 * overlap - 0.5;
      while (recent.length && recent[0].timestamp < keepFrom) recent.shift();
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
export async function compressChunk(chunk, { bitrate = 32000, signal } = {}) {
  if (opusOk === false || !chunk?.blob || chunk.ext === 'ogg') return chunk;
  if (chunk.blob.size < 400_000) return chunk; // صغير أصلاً
  const input = newInput(chunk.blob);
  try {
    const output = new Output({ format: new OggOutputFormat(), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input, output,
      video: { discard: true },
      audio: { codec: 'opus', numberOfChannels: 1, sampleRate: 16000, bitrate, forceTranscode: true },
      showWarnings: false,
    });
    if (!conversion.isValid) { opusOk = false; return chunk; }
    if (signal) signal.addEventListener('abort', () => conversion.cancel().catch(() => {}), { once: true });
    // حد زمني: إذا علق الترميز على متصفح ما، نلغيه ونرفع المقطع كما هو (لا يتوقف التحويل أبداً بسببه)
    const limitMs = Math.max(40_000, (chunk.audioSec || 0) * 120);
    let timer = null;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { conversion.cancel().catch(() => {}); rej(new Error('compress timeout')); }, limitMs); });
    try { await Promise.race([conversion.execute(), timeout]); } finally { clearTimeout(timer); }
    const buffer = output.target.buffer;
    if (!buffer || buffer.byteLength < 1000 || buffer.byteLength >= chunk.blob.size * 0.8) return chunk;
    opusOk = true;
    return { ...chunk, blob: new Blob([buffer], { type: 'audio/ogg' }), ext: 'ogg', mime: 'audio/ogg', compressed: { from: chunk.blob.size, to: buffer.byteLength } };
  } catch (e) {
    if (signal?.aborted) throw new AudioError('aborted', 'أُلغيت العملية');
    if (opusOk === null || /timeout/.test(e?.message || '')) opusOk = false; // فشل من أول مرة أو بطيء جداً: لا نحاول ثانية
    return chunk;
  } finally {
    input.dispose();
  }
}

async function* transcodeChunks(blob, info, { targetSec, overlap, signal }) {
  const endOfFile = info.firstTs + info.duration;
  let index = 0;
  let start = info.firstTs;
  while (start < endOfFile - 0.05) {
    if (signal?.aborted) throw new AudioError('aborted', 'أُلغيت العملية');
    let end = start + targetSec;
    if (endOfFile - end < 20) end = endOfFile;
    const last = end >= endOfFile;
    const from = Math.max(info.firstTs, start - overlap);
    const to = Math.min(endOfFile, end + overlap);
    const input = newInput(blob);
    try {
      const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
      const conversion = await Conversion.init({
        input, output,
        trim: { start: from, end: to },
        video: { discard: true },
        audio: { codec: 'pcm-s16', sampleRate: 16000, numberOfChannels: 1 },
        showWarnings: false,
      });
      if (!conversion.isValid) throw new AudioError('codec', 'تعذّر تحويل هذا الملف');
      await conversion.execute();
      const buffer = output.target.buffer;
      yield {
        index: index++, start, end, offset: from, audioSec: to - from,
        blob: new Blob([buffer], { type: 'audio/wav' }), ext: 'wav', mime: 'audio/wav', last,
      };
    } finally {
      input.dispose();
    }
    start = end;
  }
}
