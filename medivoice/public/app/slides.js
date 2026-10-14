// slides.js — قراءة ملف PDF المحاضرة في المتصفح (pdf.js): نص كل صفحة، وصورة مصغّرة لفحص الأشكال بالنظر،
// وصورة كبيرة تُقصّ منها الأشكال التي تُوضع في الملزمة. كل شيء يبقى على جهاز المستخدم.

const BIG = 1400;   // عرض الصورة الكبيرة (للقص)
const SMALL = 640;  // عرض المصغّرة (للفحص بالنظر)

let lib = null;
async function pdfjs(build) {
  if (!lib) {
    lib = await import(`/app/pdfjs.js?v=${encodeURIComponent(build || '')}`);
    lib.GlobalWorkerOptions.workerSrc = `/app/pdfjs.worker.js?v=${encodeURIComponent(build || '')}`;
  }
  return lib;
}

function pageText(content) {
  // نجمع الأسطر حسب موضعها العمودي حتى يبقى ترتيب السلايد مفهوماً
  const lines = [];
  let last = null;
  for (const it of content.items) {
    if (!('str' in it)) continue;
    const y = Math.round(it.transform[5]);
    if (last !== null && Math.abs(y - last) > 3) lines.push('\n');
    else if (lines.length && !it.hasEOL) lines.push(' ');
    lines.push(it.str);
    if (it.hasEOL) lines.push('\n');
    last = y;
  }
  return lines.join('').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

function jpeg(canvas, width, quality) {
  const k = Math.min(1, width / canvas.width);
  if (k === 1) return canvas.toDataURL('image/jpeg', quality);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

export class SlidesError extends Error { constructor(code, message) { super(message || code); this.code = code; } }

/**
 * يقرأ ملف PDF ويرجع صفحاته.
 * @returns {Promise<{ pages: [{ page, text, big, small:{mime, base64} }], count }>}
 */
export async function readSlides(file, { build = '', onProgress = () => {}, signal, maxPages = 160 } = {}) {
  const { getDocument } = await pdfjs(build);
  const data = new Uint8Array(await file.arrayBuffer());
  let pdf;
  try {
    pdf = await getDocument({ data, isEvalSupported: false, disableFontFace: false }).promise;
  } catch (e) {
    throw new SlidesError(/password/i.test(String(e?.name || e)) ? 'password' : 'bad_pdf', String(e?.message || e));
  }
  const count = pdf.numPages;
  if (count > maxPages) throw new SlidesError('too_many', `${count} pages`);
  const pages = [];
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: false });
  for (let i = 1; i <= count; i++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const page = await pdf.getPage(i);
    const text = pageText(await page.getTextContent()).slice(0, 6000);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(BIG / base.width, 2.6);
    const vp = page.getViewport({ scale });
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: g, viewport: vp, canvas }).promise;
    const big = jpeg(canvas, BIG, 0.82);
    const smallUrl = jpeg(canvas, SMALL, 0.7);
    pages.push({ page: i, text, big, w: canvas.width, h: canvas.height, small: { mime: 'image/jpeg', base64: smallUrl.slice(smallUrl.indexOf(',') + 1) } });
    page.cleanup();
    onProgress(i, count);
  }
  await pdf.destroy().catch(() => {});
  if (!pages.some((p) => p.text.length > 20)) {
    // سلايدات مصوّرة بلا نص: يُستخرج نصها بالنظر لاحقاً إن لزم؛ الآن نعلّمها فقط
    pages.forEach((p) => { p.scanned = true; });
  }
  return { pages, count };
}
