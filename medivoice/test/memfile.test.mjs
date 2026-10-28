// التحويل يقرأ التسجيل من ذاكرة الصفحة (MemFile) بدل Blob: نفس المقاطع بالضبط، والمقاطع بياناتها بالذاكرة أيضاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemFile, toMemory, storable, bytesToBase64 } from '../public/app/memfile.js';
import { chunkAudio, probeAudio, chunkSize, chunkBlob } from '../public/app/chunker.js';

let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }

test('MemFile: نفس الاسم والحجم والتاريخ، والقراءة نسخة (لا تفرغ الأصل)، ويُحفظ كملف عادي', async () => {
  const src = new File([new Uint8Array([1, 2, 3, 4, 5])], 'محاضرة.m4a', { type: 'audio/mp4', lastModified: 1234 });
  const m = await toMemory(src);
  assert.ok(m instanceof MemFile);
  assert.deepEqual([m.name, m.size, m.type, m.lastModified], ['محاضرة.m4a', 5, 'audio/mp4', 1234]);
  assert.equal(await toMemory(m), m, 'MemFile يرجع كما هو');
  const copy = await m.arrayBuffer();
  structuredClone(copy, { transfer: [copy] }); // قارئ ينقل الذاكرة (مثل pdf.js)
  assert.equal(m.buffer.byteLength, 5, 'الأصل باقٍ');
  assert.deepEqual([...new Uint8Array(await m.slice(1, 3).arrayBuffer())], [2, 3]);
  const f = storable(m);
  assert.ok(f instanceof File);
  assert.deepEqual([f.name, f.size, f.lastModified], ['محاضرة.m4a', 5, 1234]);
  assert.equal(bytesToBase64(new Uint8Array([104, 105]).buffer), 'aGk=');
  assert.equal(storable(null), null);
});

test('تقطيع التسجيل من الذاكرة = تقطيعه من الملف: نفس المقاطع والبايتات', { skip: !ffmpeg && 'ffmpeg غير متوفر' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mv-mem-'));
  const out = join(dir, 'a.m4a');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=130', '-c:a', 'aac', '-b:a', '48k', out]);
  const bytes = readFileSync(out);
  const blob = new Blob([bytes], { type: 'audio/mp4' });
  const mem = new MemFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { name: 'a.m4a', type: 'audio/mp4' });
  const info = await probeAudio(mem);
  assert.ok(Math.abs(info.duration - 130) < 1, `المدة ${info.duration}`);
  const cut = async (src) => { const list = []; for await (const c of chunkAudio(src, { info, targetSec: 60, overlapSec: 2 })) list.push(c); return list; };
  const a = await cut(blob), b = await cut(mem);
  assert.equal(b.length, a.length);
  assert.ok(b.length >= 2);
  for (let i = 0; i < a.length; i++) {
    assert.ok(b[i].bytes instanceof ArrayBuffer, 'بيانات المقطع بالذاكرة');
    assert.equal(chunkSize(b[i]), chunkSize(a[i]));
    assert.deepEqual([b[i].start, b[i].end, b[i].last], [a[i].start, a[i].end, a[i].last]);
    const x = new Uint8Array(await chunkBlob(a[i]).arrayBuffer()), y = new Uint8Array(await chunkBlob(b[i]).arrayBuffer());
    // نفس البايتات عدا وقت إنشاء الملف داخل ترويسة MP4 (يتغير كل تغليف)
    assert.equal(x.length, y.length);
    let diff = 0;
    for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) diff++;
    assert.ok(diff <= 12, `المقطع ${i}: ${diff} بايت مختلف`);
    assert.notEqual(chunkBlob(b[i]), chunkBlob(b[i]), 'Blob جديد كل رفعة');
  }
});
