// api.js — اتصالات المتصفح: كل طلب للمزوّدين يمر عبر بروكسي الخادم (المفاتيح محفوظة هناك مشفّرة).

const headers = { 'x-mv': '1' };

/**
 * إشارة إلغاء بحد زمني تجمع إلغاء المستخدم (signal) مع مهلة. انتهاء المهلة ليس إلغاءً: الطلب يُعامل
 * كانقطاع شبكة فيُعاد، أما إلغاء المستخدم فيوقف كل شيء. (timedOut يميّزهما حتى في المتصفحات الأقدم)
 */
function withTimeout(ms, signal) {
  const ctrl = new AbortController();
  const tm = { signal: ctrl.signal, timedOut: false };
  const t = setTimeout(() => { tm.timedOut = true; ctrl.abort(); }, ms);
  const onAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  tm.done = () => { clearTimeout(t); signal?.removeEventListener?.('abort', onAbort); };
  return tm;
}

async function wrap(promise, tm = null) {
  try {
    const res = await promise;
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    const ra = parseFloat(res.headers.get('retry-after'));
    return { ok: res.ok, status: res.status, data, retryAfter: Number.isFinite(ra) ? ra : (data?.retry_after ?? null) };
  } catch (e) {
    if (tm?.timedOut) return { ok: false, status: 0, data: { error: { message: 'timeout' } }, retryAfter: null };
    if (e?.name === 'AbortError') throw e;
    return { ok: false, status: 0, data: null, retryAfter: null };
  } finally {
    tm?.done();
  }
}

/** طلب JSON للخادم بمهلة (لا يعلق التحويل أبداً على اتصال متوقف). */
function call(url, init, ms) {
  const tm = withTimeout(ms, init.signal);
  return wrap(fetch(url, { ...init, signal: tm.signal }), tm);
}

/** fetch بمهلة يرمي عند انتهائها خطأ عادياً (لا AbortError) حتى يُعامل كفشل وليس كإلغاء. */
async function fetchWithin(url, init = {}, ms = 20_000) {
  const tm = withTimeout(ms, init.signal);
  try {
    const res = await fetch(url, { ...init, signal: tm.signal });
    // الجسم يُقرأ داخل المهلة نفسها
    const blob = await res.blob();
    return { res, blob };
  } catch (e) {
    if (tm.timedOut) throw new Error('timeout');
    throw e;
  } finally {
    tm.done();
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const viaProxy = (url) => `/api/fetch?u=${encodeURIComponent(url)}`;

async function fetchBlob(url, { proxy = false, signal } = {}) {
  // المحاولة الأولى مباشرة من جهاز المستخدم، وإذا مُنعت (حدّ طلبات أو CORS) أو تأخرت نمر عبر الخادم
  if (!proxy) {
    try {
      const { res, blob } = await fetchWithin(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal }, 15_000);
      if (res.ok && blob.type.startsWith('image/')) return blob;
    } catch (e) { if (e?.name === 'AbortError') throw e; }
  }
  const { res, blob } = await fetchWithin(viaProxy(url), { credentials: 'same-origin', signal }, 30_000);
  if (!res.ok) throw new Error(`image ${res.status}`);
  if (!blob.type.startsWith('image/')) throw new Error('not an image');
  return blob;
}

/** يصغّر الصورة ويحوّلها إلى JPEG بخلفية بيضاء (للطباعة والحفظ). */
async function toJpeg(blob, maxSide, quality) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    // SVG وبعض الصيغ: نمر عبر <img>
    const url = URL.createObjectURL(blob);
    try {
      bmp = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = url; });
    } finally { setTimeout(() => URL.revokeObjectURL(url), 4000); }
  }
  const sw = bmp.width || bmp.naturalWidth, sh = bmp.height || bmp.naturalHeight;
  if (!sw || !sh) throw new Error('bad image');
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const dataUrl = c.toDataURL('image/jpeg', quality);
  return { mime: 'image/jpeg', dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1), w, h };
}

export function makeIO() {
  return {
    sleep,
    blobToBase64,
    stt({ blob, filename, model, language, prompt }, { sec = 0, signal } = {}) {
      const fd = new FormData();
      fd.append('file', blob, filename);
      fd.append('model', model);
      if (language) fd.append('language', language);
      if (prompt) fd.append('prompt', prompt);
      fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'word');
      fd.append('timestamp_granularities[]', 'segment');
      fd.append('temperature', '0');
      return call(`/api/stt?sec=${Math.round(sec)}&m=${encodeURIComponent(model)}`, { method: 'POST', headers, body: fd, credentials: 'same-origin', signal }, 240_000);
    },
    groq(body, { signal } = {}) {
      return call(`/api/groq?m=${encodeURIComponent(body?.model || '')}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', signal }, 240_000);
    },
    gemini(model, body, { sec = 0, signal } = {}) {
      // كتابة قسم طويل قد تأخذ دقيقتين أو ثلاثاً؛ المهلة تمنع التعليق فقط إذا توقف الاتصال
      return call(`/api/gemini?model=${encodeURIComponent(model)}&sec=${Math.round(sec)}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', signal }, 420_000);
    },
    net: {
      async json(url, { proxy = false } = {}) {
        if (!proxy) {
          try {
            const { res, blob } = await fetchWithin(url, { mode: 'cors', credentials: 'omit' }, 12_000);
            if (res.ok) return JSON.parse(await blob.text());
          } catch { /* نجرب عبر الخادم */ }
        }
        const { res, blob } = await fetchWithin(viaProxy(url), { credentials: 'same-origin' }, 30_000);
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        return JSON.parse(await blob.text());
      },
    },
    /** يقصّ جزءاً من صورة (data URL) حسب مربع [ymin, xmin, ymax, xmax] على مقياس 0..1000، ويرجع JPEG */
    async cropImage(dataUrl, box = [0, 0, 1000, 1000], maxSide = 1400) {
      const im = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = dataUrl; });
      const W = im.naturalWidth, H = im.naturalHeight;
      const pad = 0.012; // هامش صغير حول الشكل
      const y1 = Math.max(0, (box[0] / 1000 - pad) * H), x1 = Math.max(0, (box[1] / 1000 - pad) * W);
      const y2 = Math.min(H, (box[2] / 1000 + pad) * H), x2 = Math.min(W, (box[3] / 1000 + pad) * W);
      const cw = Math.max(16, x2 - x1), ch = Math.max(16, y2 - y1);
      const k = Math.min(1, maxSide / Math.max(cw, ch));
      const c = document.createElement('canvas');
      c.width = Math.round(cw * k); c.height = Math.round(ch * k);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingQuality = 'high';
      g.drawImage(im, x1, y1, cw, ch, 0, 0, c.width, c.height);
      const out = c.toDataURL('image/jpeg', 0.86);
      return { mime: 'image/jpeg', dataUrl: out, base64: out.slice(out.indexOf(',') + 1), w: c.width, h: c.height };
    },
    /** size: 'small' للمعاينة والاختيار، 'large' للملزمة */
    async loadImage(candidate, size) {
      const url = size === 'large' ? candidate.large || candidate.small : candidate.small;
      let blob;
      try {
        blob = await fetchBlob(url, { proxy: !!candidate.proxy });
      } catch (e) {
        if (size !== 'large' || !candidate.original || candidate.original === url) throw e;
        blob = await fetchBlob(candidate.original, { proxy: !!candidate.proxy });
      }
      return size === 'large' ? toJpeg(blob, 1280, 0.84) : toJpeg(blob, 400, 0.74);
    },
  };
}
