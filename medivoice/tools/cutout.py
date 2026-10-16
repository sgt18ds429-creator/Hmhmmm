#!/usr/bin/env python3
"""cutout.py — العلامة مفرّغة من مربعها البنفسجي، بألوانها الأصلية كما هي في اللوكو (tools/brand/logo-src.jpg):

  public/mark-color.webp       العلامة كاملة (الدرع والقاعدة وأعمدة الصوت) بلا خلفية — للخلفيات الداكنة والبنفسجية
  public/mark-color-mic.webp   الدرع والقاعدة فقط   ┐ بنفس مقاس mark-color.webp تماماً، فتُركَّب فوق بعض
  public/mark-color-bars.webp  أعمدة الصوت فقط       ┘ وتتحرك الأعمدة وحدها في الافتتاحية
  public/mark-grad.png         العلامة بتدرّج الهوية (بلا خلفية) — للصفحات البيضاء (ترويسة الـ PDF)

صورة اللوكو الأصلية صغيرة (439 نقطة) فتظهر مغبّشة إذا كُبّرت. الرسم نفسه لا يتغير، لكن حوافه تُعاد بدقة عالية:
  1) نسبة تغطية كل نقطة من القناة الخضراء (العلامة: أبيض ووردي، أخضرها 90–255؛ الخلفية البنفسجية أخضرها شبه صفر)،
     مقسومة على أعلى قيمة حولها (فالأعمدة الوردية والدرع الأبيض حافتهما عند منتصف لونهما)
  2) تُكبَّر 8 مرات بتنعيم، ثم تُقطع عند منتصفها بانتقال ضيّق: حافة حادة وناعمة الانحناء بأي حجم
  3) الألوان من داخل الأشكال فقط (بلا خلط مع الخلفية)، تمتد للحافة وتُنعَّم: نفس التدرّج الأبيض→الوردي
يحتاج Pillow و numpy و scipy:  python3 tools/cutout.py
"""
import os
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, '..', 'public')
SRC = os.path.join(HERE, 'brand', 'logo-src.jpg')
UP = 8          # دقة العمل: 8 أضعاف الأصل
WIDTH = 960     # عرض الناتج: يكفي الافتتاحية على شاشة بكثافة 3 وأكثر


def coverage(rgb):
    """نسبة تغطية العلامة لكل نقطة (0..1) بدقة الأصل: الأخضر مقسوماً على مستوى الشكل المحلي (متوسط نقاط
    الشكل حولها، فيتبع التدرّج داخل الدرع والأعمدة)"""
    g = ndimage.gaussian_filter(rgb[..., 1], 0.45)  # تنعيم خفيف لضجيج JPEG
    bg = 6.0
    shape = g > 40
    w8 = ndimage.gaussian_filter(shape.astype(np.float32), 3)
    ref = ndimage.gaussian_filter(np.where(shape, g, 0), 3) / np.maximum(w8, 1e-3)
    ref = np.maximum(ref, 60.0)
    cov = np.clip((g - bg) / (ref - bg), 0, 1)
    cov[~ndimage.binary_dilation(shape, iterations=2)] = 0
    h, w = cov.shape
    mx, my = int(w * 0.07), int(h * 0.07)  # لمعة حواف المربع ليست من العلامة
    cov[:my, :] = 0; cov[-my:, :] = 0; cov[:, :mx] = 0; cov[:, -mx:] = 0
    lab, n = ndimage.label(cov > 0.5)
    sizes = ndimage.sum(np.ones_like(cov), lab, range(1, n + 1))
    keep = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= 0.0012 * h * w])
    return cov * ndimage.binary_dilation(keep, iterations=3)


def crisp_alpha(cov):
    """تكبير التغطية ثم قطعها عند المنتصف: حافة حادة بعرض نقطة تقريباً"""
    big = ndimage.zoom(cov, UP, order=3)
    t = np.clip((big - 0.36) / 0.28, 0, 1)
    return t * t * (3 - 2 * t)  # smoothstep


def interior_colors(rgb, cov):
    """ألوان العلامة من داخل أشكالها فقط، ممدودة للحافة ومنعّمة، بدقة العمل"""
    inside = ndimage.binary_erosion(cov > 0.9, iterations=1)  # بلا نقاط الحافة المخلوطة بالخلفية
    _, (iy, ix) = ndimage.distance_transform_edt(~inside, return_indices=True)
    filled = rgb[iy, ix]
    smooth = np.stack([ndimage.gaussian_filter(filled[..., c], 1.1) for c in range(3)], -1)
    return np.stack([ndimage.zoom(smooth[..., c], UP, order=3) for c in range(3)], -1)


def to_image(F, a, box, width=WIDTH):
    out = np.zeros(F.shape[:2] + (4,), dtype=np.uint8)
    out[..., :3] = np.round(np.clip(F, 0, 255)).astype(np.uint8)
    out[..., 3] = np.round(np.clip(a, 0, 1) * 255).astype(np.uint8)
    img = Image.fromarray(out, 'RGBA').crop(box)
    # التصغير بشفافية مسبقة الضرب حتى لا تتلوّن الحواف
    small = img.convert('RGBa').resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    return small.convert('RGBA')


def save(img, name, **kw):
    p = os.path.join(PUB, name)
    img.save(p, **kw)
    print(f'{name:24} {img.width}×{img.height} {os.path.getsize(p) // 1024} KB')


def main():
    rgb = np.asarray(Image.open(SRC).convert('RGB')).astype(np.float32)
    cov = coverage(rgb)
    a = crisp_alpha(cov)
    F = interior_colors(rgb, cov)

    ys, xs = np.where(a > 0.02)
    pad = int(a.shape[1] * 0.012)
    box = (max(0, xs.min() - pad), max(0, ys.min() - pad), min(a.shape[1], xs.max() + pad + 1), min(a.shape[0], ys.max() + pad + 1))

    # الدرع والقاعدة: الكتل التي تقطع منتصف الصورة؛ والأعمدة كل ما عداها (كل نقطة تتبع أقرب كتلة)
    lab, n = ndimage.label(a > 0.5)
    cx = a.shape[1] // 2
    mid = {int(l) for l in np.unique(lab[:, cx - UP * 3: cx + UP * 3]) if l}
    _, (iy, ix) = ndimage.distance_transform_edt(lab == 0, return_indices=True)
    is_mic = np.isin(lab[iy, ix], list(mid))

    # ألوان بجودة 95 (فرق غير مرئي) وشفافية بلا فقد إطلاقاً
    webp = dict(quality=95, alpha_quality=100, method=6)
    save(to_image(F, a, box), 'mark-color.webp', **webp)
    save(to_image(F, a * is_mic, box), 'mark-color-mic.webp', **webp)
    save(to_image(F, a * ~is_mic, box), 'mark-color-bars.webp', **webp)

    # بتدرّج الهوية (135°: #4a2fe0 → #8521d5 → #c923c1) للصفحات البيضاء
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    t = np.clip(((xx / w) + (yy / h)) / 2, 0, 1)[..., None]
    c1, c2, c3 = (np.array(c, np.float32) for c in ((74, 47, 224), (133, 33, 213), (201, 35, 193)))
    G = np.where(t < 0.55, c1 + (c2 - c1) * (t / 0.55), c2 + (c3 - c2) * ((t - 0.55) / 0.45))
    grad = to_image(G, a, box, 320)
    save(grad.resize((160, round(grad.height * 160 / grad.width)), Image.LANCZOS), 'mark-grad.png', optimize=True)


if __name__ == '__main__':
    main()
