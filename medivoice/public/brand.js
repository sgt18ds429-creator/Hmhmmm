// brand.js — علامة ميدي فويز (اللوكو) كعناصر SVG، تُستخدم في القفل والتطبيق ولوحة التحكم وغلاف الـ PDF.
// العلامة: درع «M» على شكل مايكروفون فيه شيفرونان، وقاعدة، وأعمدة صوت على الجانبين.

const NS = 'http://www.w3.org/2000/svg';

/** مسارات العلامة (بالأبيض) داخل مربع 300×300 */
export const MARK = {
  shield: 'M95 76 L150 110 L205 76 L205 178 A55 55 0 0 1 95 178 Z',
  chevrons: ['M112 124 L150 154 L188 124 L188 148 L150 178 L112 148 Z', 'M112 166 L150 196 L188 166 L188 190 L150 220 L112 190 Z'],
  stand: ['M142 242h16v20h-16z', 'M124 260h52a9 9 0 0 1 0 18h-52a9 9 0 0 1 0-18z'],
  bars: [[61.5, 126, 74], [40.5, 150, 30], [238.5, 126, 74], [259.5, 150, 30]], // [x, y, height] عرض 13
};
const SHIELD_W = 23;

/** العلامة كنص SVG (للـ PDF والمواضع التي تُبنى بنص). color: لون العلامة */
export function markHtml({ color = '#fff', bars = true, cls = '' } = {}) {
  const parts = [
    `<path d="${MARK.shield}" fill="none" stroke="${color}" stroke-width="${SHIELD_W}" stroke-linejoin="miter" stroke-miterlimit="5"/>`,
    ...MARK.chevrons.map((d) => `<path d="${d}" fill="${color}"/>`),
    ...MARK.stand.map((d) => `<path d="${d}" fill="${color}"/>`),
    ...(bars ? MARK.bars.map(([x, y, h]) => `<rect x="${x - 6.5}" y="${y}" width="13" height="${h}" rx="6.5" fill="${color}"/>`) : []),
  ];
  return `<svg viewBox="${bars ? '20 60 260 230' : '80 60 140 230'}"${cls ? ` class="${cls}"` : ''} aria-hidden="true">${parts.join('')}</svg>`;
}

/** العلامة كعنصر DOM. أجزاؤها تحمل أصنافاً حتى تتحرك (الافتتاحية، مؤشر الاستماع) */
export function markEl({ bars = true, cls = 'mark' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', bars ? '20 60 260 230' : '80 60 140 230');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const el = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); return n; };
  el('path', { d: MARK.shield, class: 'mk-shield', fill: 'none', stroke: 'currentColor', 'stroke-width': SHIELD_W, 'stroke-linejoin': 'miter', 'stroke-miterlimit': 5, pathLength: 1 });
  MARK.chevrons.forEach((d, i) => el('path', { d, class: `mk-chev mk-chev-${i + 1}`, fill: 'currentColor' }));
  MARK.stand.forEach((d, i) => el('path', { d, class: `mk-stand mk-stand-${i + 1}`, fill: 'currentColor' }));
  if (bars) MARK.bars.forEach(([x, y, h], i) => el('rect', { x: x - 6.5, y, width: 13, height: h, rx: 6.5, class: `mk-bar mk-bar-${i + 1}`, fill: 'currentColor', style: `transform-origin:${x}px ${y + h / 2}px` }));
  return svg;
}
