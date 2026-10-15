// يجلب خطوط الموقع من Google Fonts مرة واحدة ويحفظها في public/fonts مع public/fonts.css، حتى تُخدَم من
// الموقع نفسه (بلا نطاقين خارجيين تنتظرهما الصفحة عند كل فتح على الهاتف). يُشغَّل يدوياً عند تغيير الخطوط:
//   node tools/fetch-fonts.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAMILIES = [
  // [اسم العائلة، الأوزان، المجموعات المطلوبة]
  // المسيري يغطي العربية واللاتينية؛ IBM Plex Sans Arabic كان احتياطاً لا يُحمَّل عملياً فلم يُضمَّن (يبقى system-ui احتياطاً)
  ['El Messiri', [400, 500, 600, 700], ['arabic', 'latin']],
  ['IBM Plex Sans', [400, 500, 600], ['latin']],
  ['IBM Plex Mono', [400, 500], ['latin']],
];
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
mkdirSync(join(root, 'public', 'fonts'), { recursive: true });
let css = '/* خطوط الموقع (تُولَّد بـ tools/fetch-fonts.mjs من Google Fonts وتُخدَم من الموقع نفسه) */\n';
let files = 0, bytes = 0;
for (const [family, weights, subsets] of FAMILIES) {
  const url = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@${weights.join(';')}&display=swap`;
  const text = await (await fetch(url, { headers: { 'user-agent': UA } })).text();
  // كل كتلة @font-face يسبقها تعليق المجموعة (/* arabic */)
  const blocks = text.split(/(?=\/\* [a-z-]+ \*\/)/g).filter((b) => b.startsWith('/*'));
  // Google يخدم خطاً متغيّراً: الملف نفسه لكل الأوزان، فكتلة @font-face واحدة لكل مجموعة بمدى أوزان
  const bySrc = new Map();
  for (const block of blocks) {
    const subset = block.match(/^\/\* ([a-z-]+) \*\//)[1];
    if (!subsets.includes(subset)) continue;
    const weight = Number(block.match(/font-weight:\s*(\d+)/)[1]);
    const src = block.match(/url\((https:[^)]+\.woff2)\)/)[1];
    const e = bySrc.get(src) || { block, subset, min: weight, max: weight };
    e.min = Math.min(e.min, weight); e.max = Math.max(e.max, weight);
    bySrc.set(src, e);
  }
  const perSubset = {};
  for (const e of bySrc.values()) perSubset[e.subset] = (perSubset[e.subset] || 0) + 1;
  for (const [src, e] of bySrc) {
    // خط ثابت الوزن (ملف لكل وزن) يحمل وزنه في اسمه
    const name = `${slug(family)}-${e.subset}${perSubset[e.subset] > 1 ? `-${e.min}` : ''}.woff2`;
    const buf = Buffer.from(await (await fetch(src)).arrayBuffer());
    writeFileSync(join(root, 'public', 'fonts', name), buf);
    files++; bytes += buf.length;
    css += e.block.replace(src, `/fonts/${name}`).replace(/font-weight:\s*\d+/, `font-weight: ${e.min === e.max ? e.min : `${e.min} ${e.max}`}`).trim() + '\n';
  }
}
writeFileSync(join(root, 'public', 'fonts.css'), css);
console.log(`${files} ملفاً · ${Math.round(bytes / 1024)} KB → public/fonts + public/fonts.css`);
