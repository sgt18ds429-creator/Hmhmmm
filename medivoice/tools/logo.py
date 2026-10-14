#!/usr/bin/env python3
"""logo.py — يولّد ملفات الهوية من صورة اللوكو الأصلية (tools/brand/logo-src.jpg) كما هي، بلا تغيير في الرسم:
public/logo.png (المربع بزوايا شفافة)، public/mark.png و public/mark-mic.png (العلامة البيضاء بقناع شفافية
لتلوينها بـ CSS)، وأيقونات التطبيق icon-192/512، icon-maskable، apple-touch-icon.
يحتاج Pillow و numpy فقط:  python3 tools/logo.py
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, '..', 'public')
SRC = os.path.join(HERE, 'brand', 'logo-src.jpg')
SS = 4  # تكبير مؤقت لنعومة الحواف
RADIUS = 0.228  # نصف قطر الزوايا نسبةً إلى الضلع (مقاس من الصورة الأصلية)


def tile(size):
    """المربع بزوايا مدوّرة شفافة. الصورة الأصلية هي المربع نفسه حتى حوافه."""
    im = Image.open(SRC).convert('RGB').resize((size * SS, size * SS), Image.LANCZOS)
    mask = Image.new('L', (size * SS, size * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size * SS - 1, size * SS - 1], radius=int(RADIUS * size * SS), fill=255)
    im.putalpha(mask)
    return im.resize((size, size), Image.LANCZOS)


def white_mark(size, bars=True):
    """العلامة البيضاء فقط بقناع شفافية: البياض الصافي في الصورة الأصلية هو العلامة."""
    im = Image.open(SRC).convert('RGB')
    a = np.asarray(im).astype(np.float32)
    g = a[..., 1]  # القناة الخضراء: منخفضة في خلفية المربع البنفسجية/الوردية وعالية في العلامة (أبيض إلى وردي فاتح)
    alpha = np.clip((g - 35) / 45, 0, 1)
    h, w = alpha.shape
    # حواف المربع فيها لمعة خفيفة؛ العلامة لا تلامس الحواف فنستبعد إطاراً بعرض 7%
    mx, my = int(w * 0.07), int(h * 0.07)
    alpha[:my, :] = 0; alpha[-my:, :] = 0; alpha[:, :mx] = 0; alpha[:, -mx:] = 0
    # إزالة الشوائب الصغيرة: نُبقي الكتل المتصلة التي مساحتها أكبر من 0.1% من الصورة
    try:
        from scipy import ndimage
        lab, n = ndimage.label(alpha > 0.3)
        sizes = ndimage.sum(np.ones_like(alpha), lab, range(1, n + 1))
        keep = np.isin(lab, [i + 1 for i, sz in enumerate(sizes) if sz >= 0.001 * h * w])
        alpha = alpha * keep
    except ImportError:
        pass
    if not bars:
        # الأعمدة الجانبية تقع خارج ثلث العرض الأوسط؛ نحذفها ونقصّ حول الدرع والقاعدة
        cols = alpha.sum(axis=0)
        xs = np.where(cols > 2)[0]
        # الدرع هو الكتلة المتصلة الكبرى حول المنتصف
        mid = w // 2
        left = mid
        while left > 0 and cols[left - 1] > 2: left -= 1
        right = mid
        while right < w - 1 and cols[right + 1] > 2: right += 1
        keep = np.zeros_like(alpha); keep[:, left:right + 1] = 1
        alpha = alpha * keep
    ys, xs = np.where(alpha > 0.05)
    pad = int(w * 0.02)
    box = (max(0, xs.min() - pad), max(0, ys.min() - pad), min(w, xs.max() + pad + 1), min(h, ys.max() + pad + 1))
    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[..., :3] = 255
    out[..., 3] = (alpha * 255).astype(np.uint8)
    img = Image.fromarray(out, 'RGBA').crop(box)
    # نعومة طفيفة للحواف المضغوطة بـ JPEG
    r, g, b, al = img.split()
    al = al.filter(ImageFilter.GaussianBlur(0.6))
    img = Image.merge('RGBA', (r, g, b, al))
    scale = size / img.width
    return img.resize((size, max(1, round(img.height * scale))), Image.LANCZOS)


def save(img, name):
    p = os.path.join(PUB, name)
    img.save(p, optimize=True)
    print(f'{name:22} {img.width}×{img.height} {os.path.getsize(p) // 1024} KB')


def main():
    base = tile(1024)
    save(base.resize((512, 512), Image.LANCZOS), 'logo.png')
    save(base.resize((96, 96), Image.LANCZOS), 'logo-96.png')  # ترويسات صفحات الـ PDF (تتكرر في كل صفحة)
    save(base.resize((192, 192), Image.LANCZOS), 'icon-192.png')
    save(base.resize((512, 512), Image.LANCZOS), 'icon-512.png')
    # الأيقونة القابلة للقصّ: اللوكو داخل المنطقة الآمنة (80%) فوق خلفية بلون المربع نفسه (مكبّر وممدّد)
    bg = Image.open(SRC).convert('RGB').resize((640, 640), Image.LANCZOS).crop((64, 64, 576, 576)).filter(ImageFilter.GaussianBlur(40))
    m = bg.convert('RGBA')
    t = base.resize((410, 410), Image.LANCZOS)
    m.alpha_composite(t, (51, 51))
    save(m, 'icon-maskable.png')
    # أيقونة iOS: مربعة بلا شفافية، الزوايا تُملأ بلون حواف المربع
    bg2 = Image.open(SRC).convert('RGB').resize((224, 224), Image.LANCZOS).crop((22, 22, 202, 202)).filter(ImageFilter.GaussianBlur(12)).convert('RGBA')
    bg2.alpha_composite(base.resize((180, 180), Image.LANCZOS))
    save(bg2.convert('RGB'), 'apple-touch-icon.png')
    save(white_mark(512, bars=True), 'mark.png')
    save(white_mark(320, bars=False), 'mark-mic.png')


if __name__ == '__main__':
    main()
