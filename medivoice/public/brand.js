// brand.js — لوكو ميدي فويز كما أرسله صاحب الموقع، بلا أي تغيير في الرسم.
// public/logo.png هو المربع نفسه (الزوايا شفافة)، و public/mark.png و mark-mic.png هما العلامة البيضاء
// المستخرجة منه بقناع شفافية حتى تُلوَّن بـ CSS (mask-image) في العناوين والترويسات. تُولَّد بـ tools/logo.py.

export const LOGO = '/logo.webp'; // المربع الكامل (أيقونات التطبيق فقط)، WebP بلا فقد
export const LOGO_PNG = '/logo.png';
export const LOGO_SMALL = '/logo-96.png';
export const MARK = '/mark.png'; // العلامة البيضاء (قناع) — نسبة العرض إلى الارتفاع 512:444
export const MARK_MIC = '/mark-mic.png'; // الدرع والقاعدة فقط — 320:433
export const MARK_RATIO = 512 / 444;
export const MIC_RATIO = 320 / 433;
// العلامة مفرّغة من مربعها بألوانها الأصلية (tools/cutout.py): كاملة، والدرع وحده، والأعمدة وحدها بنفس المقاس
export const MARK_COLOR = '/mark-color.webp';
export const MARK_COLOR_MIC = '/mark-color-mic.webp';
export const MARK_COLOR_BARS = '/mark-color-bars.webp';
export const MARK_GRAD = '/mark-grad.png'; // بتدرّج الهوية للصفحات البيضاء (ترويسة الـ PDF)
export const CUT_RATIO = 960 / 828;

/**
 * الشعار بلا خلفيته: بألوانه الأصلية في الوضع الليلي، وبتدرّج الهوية في الوضع النهاري (الأبيض لا يظهر على
 * خلفية فاتحة). العنصران معاً والـ CSS يُظهر المناسب ([data-theme]).
 * layers: الدرع والأعمدة كطبقتين (للحركة).
 */
export function logoEl({ cls = '', layers = false } = {}) {
  const box = document.createElement('span');
  box.className = `logo-mark${cls ? ` ${cls}` : ''}`;
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', 'ميدي فويز');
  const img = (src, c) => {
    const i = document.createElement('img');
    i.src = src; i.alt = ''; i.className = c; i.decoding = 'async'; i.draggable = false;
    return i;
  };
  if (layers) box.append(img(MARK_COLOR_MIC, 'lm-color lm-mic'), img(MARK_COLOR_BARS, 'lm-color lm-bars'));
  else box.append(img(MARK_COLOR, 'lm-color'));
  const grad = document.createElement('span');
  grad.className = 'mk lm-grad';
  grad.style.setProperty('--mk', `url(${MARK_COLOR})`);
  box.append(grad);
  return box;
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
    // cover: العلامة المفرّغة على الغلاف البنفسجي، head: بتدرّج الهوية في ترويسة كل صفحة، mark: العلامة الخافتة
    assetsJob = Promise.all([LOGO, LOGO_SMALL, MARK, MARK_MIC, MARK_COLOR, MARK_GRAD].map((u) => toDataUrl(u).catch(() => new URL(u, location.href).href)))
      .then(([logo, logoSmall, mark, mic, cover, head]) => ({ logo, logoSmall, mark, mic, cover, head }));
  }
  return assetsJob;
}
