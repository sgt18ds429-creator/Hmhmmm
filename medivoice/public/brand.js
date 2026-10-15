// brand.js — لوكو ميدي فويز كما أرسله صاحب الموقع، بلا أي تغيير في الرسم.
// public/logo.png هو المربع نفسه (الزوايا شفافة)، و public/mark.png و mark-mic.png هما العلامة البيضاء
// المستخرجة منه بقناع شفافية حتى تُلوَّن بـ CSS (mask-image) في العناوين والترويسات. تُولَّد بـ tools/logo.py.

export const LOGO = '/logo.webp'; // نفس الصورة بلا أي فرق في البكسلات (WebP بلا فقد)، بثلثي حجم PNG
export const LOGO_PNG = '/logo.png';
export const LOGO_SMALL = '/logo-96.png'; // للترويسات المتكررة (الـ PDF)
export const MARK = '/mark.png'; // الدرع والقاعدة وأعمدة الصوت — نسبة العرض إلى الارتفاع 512:444
export const MARK_MIC = '/mark-mic.png'; // الدرع والقاعدة فقط — 320:433
export const MARK_RATIO = 512 / 444;
export const MIC_RATIO = 320 / 433;

/** اللوكو كصورة (المربع الكامل). */
export function logoEl({ cls = 'logo', size } = {}) {
  const img = document.createElement('img');
  img.src = LOGO;
  img.alt = 'ميدي فويز';
  img.className = cls;
  img.decoding = 'async';
  img.draggable = false;
  if (size) { img.width = size; img.height = size; }
  return img;
}

/** العلامة ملوّنة بلون النص الحالي (currentColor) عبر قناع، كعنصر DOM. */
export function markEl({ bars = true, cls = 'mark' } = {}) {
  const el = document.createElement('span');
  el.className = `mk ${cls}`;
  el.setAttribute('aria-hidden', 'true');
  el.style.setProperty('--mk', `url(${bars ? MARK : MARK_MIC})`);
  el.style.aspectRatio = String(bars ? MARK_RATIO : MIC_RATIO);
  return el;
}

/** العلامة كنص HTML (للـ PDF والمواضع التي تُبنى بنص). urls: روابط مطلقة أو data: عند الحاجة. */
export function markHtml({ color = '#fff', bars = true, cls = '', urls = {} } = {}) {
  const url = bars ? urls.mark || MARK : urls.mic || MARK_MIC;
  const ratio = bars ? MARK_RATIO : MIC_RATIO;
  return `<span class="mk${cls ? ` ${cls}` : ''}" aria-hidden="true" style="--mk:url(${url});background:${color};aspect-ratio:${ratio}"></span>`;
}

/** CSS المشترك لعنصر القناع. */
export const MARK_CSS = `.mk{display:inline-block;background:currentColor;-webkit-mask:var(--mk) center/contain no-repeat;mask:var(--mk) center/contain no-repeat;vertical-align:middle}`;

let assetsJob = null;
const toDataUrl = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const blob = await r.blob();
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
};
/**
 * اللوكو والعلامة كـ data URLs لتضمينها في HTML مستقل (ملف الـ PDF يُرسم على خادم لا يرى روابط الموقع النسبية).
 * عند الفشل تُعاد روابط مطلقة إلى الموقع.
 */
export function brandAssets() {
  if (!assetsJob) {
    assetsJob = Promise.all([LOGO, LOGO_SMALL, MARK, MARK_MIC].map((u) => toDataUrl(u).catch(() => new URL(u, location.href).href)))
      .then(([logo, logoSmall, mark, mic]) => ({ logo, logoSmall, mark, mic }));
  }
  return assetsJob;
}
