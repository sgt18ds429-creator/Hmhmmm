// اختبار لوحة التحكم في المتصفح: دخول، إنشاء كود، تفاصيل، نشاط، إعدادات.
//   ADMIN_PW=... node test/admin.e2e.mjs <shots-dir>
import { launch, BASE } from './browser.mjs';
const out = process.argv[2] || '.';
const { browser, page } = await launch({ mobile: true });
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const step = (m) => console.log('•', m);

await page.goto(`${BASE}/admin`);
await page.waitForSelector('.gate-card input');
await page.waitForTimeout(700);
await shot('a1-login');
await page.fill('.gate-card input', 'wrong-password');
await page.click('.gate-card .btn');
await page.waitForFunction(() => document.querySelector('.gate-msg').textContent.length > 0);
step('wrong password: ' + await page.textContent('.gate-msg'));
await page.fill('.gate-card input', process.env.ADMIN_PW);
await page.click('.gate-card .btn');
await page.waitForSelector('.nav');
step('logged in');
await page.waitForTimeout(500);
await shot('a2-codes');

// كود جديد
await page.click('.view .btn.wide');
await page.waitForSelector('.sheet.open form');
await page.fill('.sheet form input[type=text]', 'أحمد علي، مرحلة ثالثة');
await page.click('.sheet .seg button:nth-child(2)');
await page.waitForTimeout(350);
await shot('a3-create');
await page.click('.sheet form button[type=submit]');
await page.waitForSelector('.sheet.open .msg-preview');
await page.waitForTimeout(700);
await shot('a4-created');
step('created: ' + (await page.getAttribute('.sheet .code-box', 'aria-label')));
await page.click('.sheet .icon-btn');
await page.waitForTimeout(400);

// دفعة
await page.click('.view .btn.wide');
await page.waitForSelector('.sheet.open form');
await page.fill('.sheet form input[type=text]', 'شعبة أ');
await page.click('.sheet details summary');
await page.click('.sheet details .stepper button:last-child');
await page.click('.sheet details .stepper button:last-child');
await page.click('.sheet form button[type=submit]');
await page.waitForSelector('.sheet.open .code-list');
step('batch: ' + (await page.locator('.sheet .code-list div').count()));
await page.click('.sheet .icon-btn');
await page.waitForTimeout(400);
await shot('a5-list');

// تفاصيل
await page.locator('.cc').first().click();
await page.waitForSelector('.sheet.open .kv');
await page.waitForTimeout(600);
await shot('a6-detail');
await page.locator('.sheet .menu button', { hasText: 'إيقاف مؤقت' }).click();
await page.waitForFunction(() => !document.querySelector('.sheet'));
step('suspended chip: ' + (await page.locator('.cc .chip').first().textContent()));
await page.locator('.cc').first().click();
await page.waitForSelector('.sheet.open .kv');
await page.locator('.sheet .menu button', { hasText: 'إعادة التشغيل' }).click();
await page.waitForFunction(() => !document.querySelector('.sheet'));

// النشاط والإعدادات
await page.locator('.nav button', { hasText: 'النشاط' }).click();
await page.waitForSelector('.chart');
await page.waitForTimeout(500);
await shot('a7-activity');
await page.locator('.nav button', { hasText: 'الإعدادات' }).click();
await page.waitForSelector('.view .card');
await page.fill('.view input[dir=ltr]', '@medivoice_support');
await page.locator('.view .btn.wide', { hasText: 'حفظ الإعدادات' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('انحفظت')));
step('support url → ' + (await page.inputValue('.view input[dir=ltr]')));
await page.waitForTimeout(400);
await shot('a8-settings');
await browser.close();
console.log('admin e2e ok');
