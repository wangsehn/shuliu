# 生成 Android 启动图标并写入 res：legacy PNG + 自适应图标前景
# 用法：python tools/make_android_icons.py （在 test/first_app 下运行）
from PIL import Image, ImageDraw, ImageFont
import os, glob

PINE = (84, 115, 102)
PAPER = (248, 247, 242)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')

FONT_CANDIDATES = [r"C:\Windows\Fonts\simsun.ttc", r"C:\Windows\Fonts\msyh.ttc"]
def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size)
            except Exception: continue
    return ImageFont.load_default()

def glyph_img(canvas, ratio):
    """透明底 + 纸白「书」"""
    img = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    font = load_font(int(canvas * ratio))
    bbox = d.textbbox((0, 0), '书', font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((canvas - w) / 2 - bbox[0], (canvas - h) / 2 - bbox[1]), '书', font=font, fill=PAPER + (255,))
    return img

def rounded_launcher(canvas, radius_ratio=0.18):
    s = canvas * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * radius_ratio), fill=PINE + (255,))
    img = img.resize((canvas, canvas), Image.LANCZOS)
    g = glyph_img(canvas, 0.56)
    return Image.alpha_composite(img, g)

def circle_launcher(canvas):
    s = canvas * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([0, 0, s - 1, s - 1], fill=PINE + (255,))
    img = img.resize((canvas, canvas), Image.LANCZOS)
    g = glyph_img(canvas, 0.56)
    return Image.alpha_composite(img, g)

DENSITIES = [('mdpi', 1), ('hdpi', 1.5), ('xhdpi', 2), ('xxhdpi', 3), ('xxxhdpi', 4)]
BASE = 48

for name, mult in DENSITIES:
    d = os.path.join(RES, 'mipmap-' + name)
    os.makedirs(d, exist_ok=True)
    legacy = int(BASE * mult)
    fg_size = int(48 * 2.25 * mult)
    rounded_launcher(legacy).save(os.path.join(d, 'ic_launcher.png'))
    circle_launcher(legacy).save(os.path.join(d, 'ic_launcher_round.png'))
    glyph_img(fg_size, 0.34).save(os.path.join(d, 'ic_launcher_foreground.png'))
    print('ok mipmap-' + name, 'launcher', legacy, 'foreground', fg_size)

# 背景色 → 松绿
values = os.path.join(RES, 'values', 'ic_launcher_background.xml')
with open(values, 'r+', encoding='utf-8') as f:
    t = f.read().replace('#FFFFFF', '#547366')
    f.seek(0); f.write(t); f.truncate()
print('background color -> #547366')
