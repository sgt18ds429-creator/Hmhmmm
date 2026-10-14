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
