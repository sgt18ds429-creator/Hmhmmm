// زمن التحويل: محاضرة ساعة (وساعة ونصف تحت ضغط Google) تجهز خلال 8 دقائق بكل محتواها،
// بنماذج وهمية بأزمنة استجابة وحدود قريبة من الحقيقة وساعة افتراضية (tools/sim-timing.mjs). يحتاج ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }

const sim = (...args) => JSON.parse(execFileSync(process.execPath, [join(root, 'tools', 'sim-timing.mjs'), ...args, '--json'], { encoding: 'utf8', timeout: 120_000 }).trim().split('\n').at(-1));

for (const [min, scenario, mode] of [[60, 'strong', 'notes'], [60, 'lite', 'highyield'], [60, 'gemini-only', 'notes'], [90, 'overload', 'notes'], [120, 'strong', 'notes']]) {
  test(`${min} دقيقة · ${scenario} · ${mode}: خلال 8 دقائق وبلا نقص`, { skip: !ffmpeg && 'ffmpeg غير موجود' }, () => {
    const r = sim(`--min=${min}`, `--scenario=${scenario}`, `--mode=${mode}`);
    assert.ok(r.totalSec <= 480, `${r.totalSec}s`);
    assert.equal(r.fallback, 0, 'كل الأقسام مكتوبة');
    assert.equal(r.partial, false, 'الترجمة كاملة');
    assert.ok(r.alt > 0);
    assert.equal(r.audit, true, 'المراجعة الأخيرة تمت');
    if (mode === 'highyield') assert.ok(r.mcq >= 8);
    assert.ok(r.figs > 0, 'الصور تُبحث وتُفحص ضمن الوقت');
    assert.equal(r.dialect, false, 'أسطر العامية أُعيدت بالفصحى ضمن الوقت');
  });
}
