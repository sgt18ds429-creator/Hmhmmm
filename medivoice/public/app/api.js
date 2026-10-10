// api.js — اتصالات المتصفح: كل طلب للمزوّدين يمر عبر بروكسي الخادم (المفاتيح محفوظة هناك مشفّرة).

const headers = { 'x-mv': '1' };

async function wrap(promise) {
  try {
    const res = await promise;
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    const ra = parseFloat(res.headers.get('retry-after'));
    return { ok: res.ok, status: res.status, data, retryAfter: Number.isFinite(ra) ? ra : (data?.retry_after ?? null) };
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return { ok: false, status: 0, data: null, retryAfter: null };
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
  // المحاولة الأولى مباشرة من جهاز المستخدم، وإذا مُنعت (حدّ طلبات أو CORS) نمر عبر الخادم
  if (!proxy) {
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.startsWith('image/')) return blob;
      }
    } catch (e) { if (e?.name === 'AbortError') throw e; }
  }
  const res = await fetch(viaProxy(url), { credentials: 'same-origin', signal });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const blob = await res.blob();
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
      return wrap(fetch(`/api/stt?sec=${Math.round(sec)}`, { method: 'POST', headers, body: fd, credentials: 'same-origin', signal }));
    },
    groq(body, { signal } = {}) {
      return wrap(fetch('/api/groq', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', signal }));
    },
    gemini(model, body, { sec = 0, signal } = {}) {
      return wrap(fetch(`/api/gemini?model=${encodeURIComponent(model)}&sec=${Math.round(sec)}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', signal }));
    },
    net: {
      async json(url, { proxy = false } = {}) {
        if (!proxy) {
          try {
            const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
            if (res.ok) return await res.json();
          } catch { /* نجرب عبر الخادم */ }
        }
        const res = await fetch(viaProxy(url), { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        return res.json();
      },
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
