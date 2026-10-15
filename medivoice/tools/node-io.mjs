// اتصالات مباشرة بالمزوّدين لاختبار المسار من Node (المتصفح يمر عبر بروكسي الخادم).
const UA = 'MediVoice/1.0 (https://medivoice.nukhba-uni.workers.dev; medical lecture notes tool)';

let trace = () => {};
async function wrap(promise, label = '') {
  const t0 = Date.now();
  try {
    const res = await promise;
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    const ra = parseFloat(res.headers.get('retry-after'));
    const fin = data?.candidates?.[0]?.finishReason || data?.choices?.[0]?.finish_reason || '';
    trace(`${label} → ${res.status} ${((Date.now() - t0) / 1000).toFixed(1)}s ${fin} ${res.ok ? '' : JSON.stringify(data?.error?.message || data?.error || data).slice(0, 160)}`);
    if (process.env.TRACE_TEXT && res.ok) {
      const out = (data?.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('') || data?.choices?.[0]?.message?.content || data?.text || '';
      trace(`      ↳ ${out.split(/\s+/).filter(Boolean).length} كلمة: ${out.replace(/\s+/g, ' ').slice(0, Number(process.env.TRACE_TEXT) || 300)}`);
    }
    return { ok: res.ok, status: res.status, data, retryAfter: Number.isFinite(ra) ? ra : null };
  } catch (e) {
    return { ok: false, status: 0, data: null, retryAfter: null, error: String(e) };
  }
}

export function nodeIO({ groqKey, geminiKey, log = () => {} }) {
  trace = log;
  const counts = { stt: 0, groq: 0, gemini: 0, net: 0, img: 0, audioSec: 0 };
  return {
    counts,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    blobToBase64: async (blob) => Buffer.from(await blob.arrayBuffer()).toString('base64'),
    stt({ blob, filename, model, language, prompt }, { sec } = {}) {
      counts.stt++; counts.audioSec += sec || 0;
      const fd = new FormData();
      fd.append('file', blob, filename);
      fd.append('model', model);
      if (language) fd.append('language', language);
      if (prompt) fd.append('prompt', prompt);
      fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'word');
      fd.append('timestamp_granularities[]', 'segment');
      fd.append('temperature', '0');
      return wrap(fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${groqKey}` }, body: fd }), `stt ${model} ${filename} ${(blob.size / 1e6).toFixed(2)}MB`);
    },
    groq(body) {
      counts.groq++;
      return wrap(fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${groqKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), `groq ${body.model}`);
    },
    gemini(model, body, { sec } = {}) {
      counts.gemini++; counts.audioSec += sec || 0;
      return wrap(fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': geminiKey, 'content-type': 'application/json' }, body: JSON.stringify(body) }), `gemini ${model}${sec ? ' sec=' + Math.round(sec) : ''}`);
    },
    net: {
      async json(url) {
        counts.net++;
        const res = await fetch(url, { headers: { 'user-agent': UA, 'api-user-agent': UA } });
        if (!res.ok) throw new Error(`${res.status} ${new URL(url).host}`);
        return res.json();
      },
    },
    async loadImage(c, size) {
      counts.img++;
      const url = size === 'large' ? c.large : c.small;
      const res = await fetch(url, { headers: { 'user-agent': UA } });
      if (!res.ok) throw new Error(`${res.status} image`);
      const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
      if (!mime.startsWith('image/')) throw new Error('not an image');
      const base64 = Buffer.from(await res.arrayBuffer()).toString('base64');
      return { mime, base64, dataUrl: `data:${mime};base64,${base64}`, w: c.w, h: c.h };
    },
  };
}

/**
 * يحاكي نفاد الحصة اليومية (لاختبار أن التحويل يكمل بغيرها ولا يتوقف):
 *   rules: «strong@3,whisper@1,groq@0» — بعد N طلبات لنماذج الفئة يرد كل طلب بخطأ 429 كما يرسله المزوّد.
 *   الفئات: strong (Gemini غير الخفيفة) · lite · tx (النسخ الحرفي) · gemini (كلها) · whisper · groq (النصية) · أو اسم نموذج.
 */
export function withQuota(io, rules, log = () => {}) {
  const list = String(rules || '').split(',').filter(Boolean).map((x) => { const [what, n] = x.split('@'); return { what, after: Number(n) || 0, used: 0 }; });
  if (!list.length) return io;
  const kindOf = (provider, model) => {
    if (provider === 'stt') return 'whisper';
    if (provider === 'groq') return 'groq';
    if (/transcribe/.test(model)) return 'tx';
    return /lite/.test(model) ? 'lite' : 'strong';
  };
  const hit = (provider, model) => {
    const kind = kindOf(provider, model);
    for (const r of list) {
      if (r.what === model || r.what === kind || (r.what === 'gemini' && provider === 'gemini')) {
        if (r.used >= r.after) return true;
        r.used++;
      }
    }
    return false;
  };
  const geminiDay = (model) => ({
    ok: false, status: 429, retryAfter: null,
    data: { error: { code: 429, status: 'RESOURCE_EXHAUSTED',
      message: `You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: ${model}\nPlease retry in 37.6s.`,
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { location: 'global', model }, quotaValue: '20' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
      ] } },
  });
  const groqDay = (model, audio) => ({
    ok: false, status: 429, retryAfter: audio ? 7400 : 1296,
    data: { error: { code: 'rate_limit_exceeded', type: audio ? 'seconds' : 'tokens',
      message: audio
        ? `Rate limit reached for model \`${model}\` in organization \`org_sim\` service tier \`on_demand\` on seconds of audio per day (ASD): Limit 28800, Used 28700, Requested 480. Please try again in 2h3m20s.`
        : `Rate limit reached for model \`${model}\` in organization \`org_sim\` service tier \`on_demand\` on tokens per day (TPD): Limit 200000, Used 199500, Requested 3000. Please try again in 21m36s.` } },
  });
  return {
    ...io,
    stt(req, opts) {
      if (hit('stt', req.model)) { log(`quota✗ stt ${req.model}`); return Promise.resolve(groqDay(req.model, true)); }
      return io.stt(req, opts);
    },
    groq(body, opts) {
      if (hit('groq', body.model)) { log(`quota✗ groq ${body.model}`); return Promise.resolve(groqDay(body.model, false)); }
      return io.groq(body, opts);
    },
    gemini(model, body, opts) {
      if (hit('gemini', model)) { log(`quota✗ gemini ${model}`); return Promise.resolve(geminiDay(model)); }
      return io.gemini(model, body, opts);
    },
  };
}
