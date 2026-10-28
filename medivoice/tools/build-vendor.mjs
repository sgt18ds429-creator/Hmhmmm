// build-vendor.mjs — يبني public/app/vendor.js من mediabunny (قاطع الصوت داخل المتصفح).
//   node tools/build-vendor.mjs
// الإصدار مثبّت بـ package.json (1.61.3)، والبناء نفسه يطلع نفس الملف بايتاً ببايت. نضيف للقائمة فقط ما يستعمله chunker.js
// (BufferSource: قراءة التسجيل من ذاكرة الصفحة بدل Blob يضيع بالخلفية على الآيفون).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORTS = ['ALL_FORMATS', 'BlobSource', 'BufferSource', 'BufferTarget', 'Conversion', 'EncodedAudioPacketSource', 'EncodedPacketSink',
  'FlacOutputFormat', 'Input', 'Mp3OutputFormat', 'Mp4OutputFormat', 'OggOutputFormat', 'Output', 'WavOutputFormat'];
const version = JSON.parse(readFileSync(join(root, 'node_modules', 'mediabunny', 'package.json'), 'utf8')).version;
const dir = mkdtempSync(join(tmpdir(), 'mv-vendor-'));
const entry = join(dir, 'entry.mjs');
writeFileSync(entry, `export { ${EXPORTS.join(', ')} } from 'mediabunny';\n`);
await build({
  entryPoints: [entry], bundle: true, format: 'esm', minify: true, target: 'es2020', legalComments: 'inline',
  nodePaths: [join(root, 'node_modules')], outfile: join(root, 'public', 'app', 'vendor.js'), logLevel: 'warning',
});
console.log(`public/app/vendor.js · mediabunny ${version}`);
