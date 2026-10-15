#!/usr/bin/env python3
"""cutout.py — العلامة مفرّغة من مربعها البنفسجي، بألوانها الأصلية كما هي في اللوكو (tools/brand/logo-src.jpg):

  public/mark-color.webp       العلامة كاملة (الدرع والقاعدة وأعمدة الصوت) بلا خلفية — للخلفيات الداكنة والبنفسجية
  public/mark-color-mic.webp   الدرع والقاعدة فقط   ┐ بنفس مقاس mark-color.webp تماماً، فتُركَّب فوق بعض
  public/mark-color-bars.webp  أعمدة الصوت فقط       ┘ وتتحرك الأعمدة وحدها في الافتتاحية
  public/mark-grad.png         العلامة بتدرّج الهوية (بلا خلفية) — للصفحات البيضاء (ترويسة الـ PDF)

الحواف تُنظَّف من لون الخلفية (فك الخلط: الحافة نصف بيضاء ونصف بنفسجية تصير بيضاء بشفافية) حتى لا تظهر
هالة بنفسجية حول العلامة فوق الخلفيات الفاتحة. يحتاج Pillow و numpy و scipy:  python3 tools/cutout.py
"""
import os
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, '..', 'public')
SRC = os.path.join(HERE, 'brand', 'logo-src.jpg')
UP = 4          # تكبير مؤقت: الحواف تُحسب بدقة أعلى ثم تُصغَّر
WIDTH = 640     # عرض الناتج (يكفي شاشة بكثافة 3 بعرض نحو 210 نقطة)


def alpha_of(rgb):
    """قناع العلامة: العلامة (أبيض، وردي فاتح، أعمدة وردية→بنفسجية) عالية بالأحمر والأخضر معاً، أما خلفية
    المربع فإما زرقاء بنفسجية (أحمر منخفض) أو أرجوانية (أخضر شبه صفر)، والفراغات داخل الدرع داكنة.
    الحد الأدنى للقناتين يفصلها حتى أسفل الأعمدة الأغمق (~170، 65، 255)."""
    r, g = rgb[..., 0], rgb[..., 1]
    a = np.clip(np.minimum((r - 105) / 55, (g - 22) / 38), 0, 1)
    h, w = a.shape
    mx, my = int(w * 0.07), int(h * 0.07)  # لمعة حواف المربع ليست من العلامة
    a[:my, :] = 0; a[-my:, :] = 0; a[:, :mx] = 0; a[:, -mx:] = 0
    lab, n = ndimage.label(a > 0.35)
    sizes = ndimage.sum(np.ones_like(a), lab, range(1, n + 1))
    big = [i + 1 for i, s in enumerate(sizes) if s >= 0.0012 * h * w]
    keep = ndimage.binary_dilation(np.isin(lab, big), iterations=3 * UP)
    return a * keep


def decontaminate(rgb, a):
    """لون العلامة الصافي عند الحواف: F = (I − (1 − α)·B) / α، و B لون الخلفية المحلي حول كل نقطة."""
    hard = a > 0.02
    bgw = (~ndimage.binary_dilation(hard, iterations=2 * UP)).astype(np.float32)
    sigma = 10 * UP
    den = ndimage.gaussian_filter(bgw, sigma) + 1e-6
    B = np.stack([ndimage.gaussian_filter(rgb[..., c] * bgw, sigma) / den for c in range(3)], -1)
    al = a[..., None]
    F = np.where(al > 0.04, (rgb - (1 - al) * B) / np.maximum(al, 0.04), rgb)
    return np.clip(F, 0, 255)


def to_image(F, a, box):
    out = np.zeros(F.shape[:2] + (4,), dtype=np.uint8)
    out[..., :3] = np.round(F).astype(np.uint8)
    out[..., 3] = np.round(a * 255).astype(np.uint8)
    img = Image.fromarray(out, 'RGBA').crop(box)
    # التصغير بشفافية مسبقة الضرب حتى لا تتلوّن الحواف
    small = img.convert('RGBa').resize((WIDTH, round(img.height * WIDTH / img.width)), Image.LANCZOS)
    return small.convert('RGBA')


def save(img, name, **kw):
    p = os.path.join(PUB, name)
    img.save(p, **kw)
    print(f'{name:24} {img.width}×{img.height} {os.path.getsize(p) // 1024} KB')


def main():
    src = Image.open(SRC).convert('RGB')
    big = src.resize((src.width * UP, src.height * UP), Image.LANCZOS)
    rgb = np.asarray(big).astype(np.float32)
    a = alpha_of(rgb)
    F = decontaminate(rgb, a)

    ys, xs = np.where(a > 0.03)
    pad = int(a.shape[1] * 0.015)
    box = (max(0, xs.min() - pad), max(0, ys.min() - pad), min(a.shape[1], xs.max() + pad + 1), min(a.shape[0], ys.max() + pad + 1))

    # الدرع والقاعدة: الكتلة الوسطى. كل نقطة تتبع أقرب كتلة (فتبقى حواف الأعمدة معها)
    lab, n = ndimage.label(a > 0.35)
    cx = a.shape[1] // 2
    mid = {int(l) for l in np.unique(lab[:, cx - UP * 4: cx + UP * 4]) if l}
    _, (iy, ix) = ndimage.distance_transform_edt(lab == 0, return_indices=True)
    owner = lab[iy, ix]
    is_mic = np.isin(owner, list(mid))

    save(to_image(F, a, box), 'mark-color.webp', lossless=True, method=6)
    save(to_image(F, a * is_mic, box), 'mark-color-mic.webp', lossless=True, method=6)
    save(to_image(F, a * ~is_mic, box), 'mark-color-bars.webp', lossless=True, method=6)

    # بتدرّج الهوية (135°: #4a2fe0 → #8521d5 → #c923c1) للصفحات البيضاء
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    t = np.clip(((xx / w) + (yy / h)) / 2, 0, 1)[..., None]
    c1, c2, c3 = (np.array(c, np.float32) for c in ((74, 47, 224), (133, 33, 213), (201, 35, 193)))
    G = np.where(t < 0.55, c1 + (c2 - c1) * (t / 0.55), c2 + (c3 - c2) * ((t - 0.55) / 0.45))
    grad = to_image(G, a, box)
    save(grad.resize((160, round(grad.height * 160 / grad.width)), Image.LANCZOS), 'mark-grad.png', optimize=True)


if __name__ == '__main__':
    main()
