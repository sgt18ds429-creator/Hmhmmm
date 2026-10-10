// icons.cjs — يولّد أيقونات PNG من public/logo.svg (يحتاج Playwright مع Chromium).
// node tools/icons.cjs
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const pub = path.join(__dirname, '..', 'public');
const logo = fs.readFileSync(path.join(pub, 'logo.svg'), 'utf8');
const square = logo.replace(/rx="\d+"/, 'rx="0"'); // بلا زوايا: iOS والأيقونات القابلة للقص تقصّها بنفسها

const ICONS = [
  ['icon-192.png', 192, logo],
  ['icon-512.png', 512, logo],
  ['apple-touch-icon.png', 180, square],
  ['icon-maskable.png', 512, square],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, size, svg] of ICONS) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`);
    await page.screenshot({ path: path.join(pub, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', name);
  }
  await browser.close();
})();
