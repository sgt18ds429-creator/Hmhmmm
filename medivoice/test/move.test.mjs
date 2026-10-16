// تحزيم النقل بين الروابط (public/move.js): كل ما يحفظه المتصفح يرجع مثل ما هو، والملف الناقص يُرفض.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pack, unpack } from '../public/move.js';

test('تحزيم النقل: محاضرات وتسجيلات وملفات ومصفوفات ترجع مثل ما هي، والناقص يُرفض', async () => {
  const file = new File([new Uint8Array([1, 2, 3, 4])], 'محاضرة.m4a', { type: 'audio/mp4', lastModified: 1700000000000 });
  const data = {
    stores: {
      lectures: [['L1', { id: 'L1', meta: { title: 'التشريح الشعاعي' }, blocks: [{ t: 'fig', img: { dataUrl: 'data:image/png;base64,AAAA', w: 2, h: 3 } }], at: new Date(5) }]],
      index: [['L1', { id: 'L1', title: 'التشريح الشعاعي', createdAt: 1 }]],
      parts: [
        ['rec:r1:000000', { blob: new Blob(['hello'], { type: 'audio/webm' }), _at: 3 }],
        ['src:j1', { file, pdf: null, _at: 4 }],
        ['j1:0', { text: 'نص', buf: new Uint8Array([9, 8, 7]).buffer, f32: new Float32Array([1.5, -2]), view: new Uint8Array([5, 6, 7, 8]).subarray(1, 3) }],
      ],
      kv: [['rec:r1', { id: 'r1', pieces: 1 }], ['pdf-lang', 'ar']],
    },
    ls: { 'mv-game': 'xo' },
  };
  const blob = pack(data);
  const back = await unpack(blob);
  const lec = back.stores.lectures[0][1];
  assert.equal(lec.meta.title, 'التشريح الشعاعي');
  assert.equal(lec.blocks[0].img.dataUrl, 'data:image/png;base64,AAAA');
  assert.equal(lec.at.getTime(), 5);
  const rec = back.stores.parts[0][1].blob;
  assert.equal(rec.type, 'audio/webm');
  assert.equal(await rec.text(), 'hello');
  const f = back.stores.parts[1][1].file;
  assert.ok(f instanceof File);
  assert.equal(f.name, 'محاضرة.m4a');
  assert.equal(f.type, 'audio/mp4');
  assert.equal(f.lastModified, 1700000000000);
  assert.deepEqual([...new Uint8Array(await f.arrayBuffer())], [1, 2, 3, 4]);
  const p = back.stores.parts[2][1];
  assert.deepEqual([...new Uint8Array(p.buf)], [9, 8, 7]);
  assert.ok(p.f32 instanceof Float32Array);
  assert.deepEqual([...p.f32], [1.5, -2]);
  assert.deepEqual([...p.view], [6, 7]);
  assert.deepEqual(back.stores.kv, data.stores.kv);
  assert.deepEqual(back.ls, { 'mv-game': 'xo' });
  // قطعة ما وصلت: يُرفض بدل بيانات مبتورة
  await assert.rejects(unpack(blob.slice(0, blob.size - 1)), /incomplete/);
  await assert.rejects(unpack(new Blob(['not a package'])), /bad_package/);
});
