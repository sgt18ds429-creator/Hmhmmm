// memfile.js
// ملف التسجيل (و PDF السلايدات) بذاكرة الصفحة نفسها: ArrayBuffer، لا Blob ولا File.
//
// سفاري الآيفون يفقد بيانات الـ Blob والملف المختار إذا بقت الصفحة بالخلفية فترة (يقفل عملية الشبكة اللي تحمل
// بياناتها)، فأي قراءة بعدها ترمي «NotFoundError: The object can not be found here». بيانات الصفحة نفسها
// (ArrayBuffer) تبقى ما دامت الصفحة مفتوحة، فالتحويل يقرأ منها، ويُصنع Blob جديد وقت الحاجة فقط (رفع مقطع، حفظ).

/** أكبر ملف يُنسخ للذاكرة (أكبر منه يبقى كما هو: ذاكرة الهاتف محدودة) */
export const MEM_MAX = 400 * 1024 * 1024;

export class MemFile {
  /** @param {ArrayBuffer} buffer */
  constructor(buffer, { name = '', type = '', lastModified = Date.now() } = {}) {
    this.buffer = buffer;
    this.name = name;
    this.type = type;
    this.lastModified = lastModified;
    this.size = buffer.byteLength;
  }

  /** نسخة من البيانات: بعض القارئات (pdf.js) تنقل الذاكرة لعامل آخر فتفرغ الأصل */
  arrayBuffer() { return Promise.resolve(this.buffer.slice(0)); }

  /** Blob جديد لجزء من الملف (يُصنع وقت الطلب، فلا يكون قديماً ضائعاً) */
  slice(start = 0, end = this.size, type = this.type) {
    return new Blob([new Uint8Array(this.buffer, start, Math.max(0, Math.min(end, this.size) - start))], { type });
  }

  /** File حقيقي (للحفظ على الجهاز) */
  toFile() { return new File([this.buffer], this.name, { type: this.type, lastModified: this.lastModified }); }
}

/**
 * نسخة بالذاكرة من ملف أو Blob، بنفس الاسم والحجم والتاريخ (فالتحويل يكمل من مكانه). ما هو MemFile أصلاً يرجع كما هو،
 * والملف الضخم جداً يبقى كما هو. ترمي نفس خطأ القراءة (NotFoundError) إذا الملف نفسه ما ينقرا.
 */
export async function toMemory(f) {
  if (!f || f instanceof MemFile || f.size > MEM_MAX) return f;
  return new MemFile(await f.arrayBuffer(), { name: f.name || '', type: f.type || '', lastModified: f.lastModified || Date.now() });
}

/** للحفظ في IndexedDB: MemFile يُحفظ كملف عادي (المخزن لا يحفظ أصناف JavaScript) */
export const storable = (f) => (f instanceof MemFile ? f.toFile() : f);

/** Base64 من بيانات بالذاكرة (بدل FileReader على Blob) */
export function bytesToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
