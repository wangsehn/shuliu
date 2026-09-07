# 书流应用图标生成：松绿底 + 纸白「书」字（宋体），含 maskable 全出血版
# 用法：python tools/make_icons.py  （在 test/first_app 目录下运行）
from PIL import Image, ImageDraw, ImageFont
import os

PINE = (84, 115, 102)     # #547366
PINE_DARK = (70, 97, 86)  # 描边/阴影用
PAPER = (248, 247, 242)   # #F8F7F2

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets')
os.makedirs(OUT, exist_ok=True)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\simsun.ttc",   # 宋体
    r"C:\Windows\Fonts\STSONG.TTF",
    r"C:\Windows\Fonts\msyh.ttc",     # 兜底：微软雅黑
]

def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

def rounded_square(size, radius, scale=4):
    s = size * scale
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius * scale, fill=PINE + (255,))
    return img

def draw_glyph(img, scale=4, glyph_ratio=0.56):
    s = img.width
    font = load_font(int(s * glyph_ratio))
    text = '书'
    d = ImageDraw.Draw(img)
    bbox = d.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (s - w) / 2 - bbox[0]
    y = (s - h) / 2 - bbox[1] - s * 0.02
    d.text((x, y), text, font=font, fill=PAPER + (255,))
    return img

def save(img, name, size):
    img = img.resize((size, size), Image.LANCZOS)
    img.save(os.path.join(OUT, name), 'PNG')
    print('ok', name, size)

# any（圆角）：512 master
master = draw_glyph(rounded_square(512, 110))
save(master, 'icon-512.png', 512)
save(master, 'icon-192.png', 192)
save(master, 'apple-touch-icon.png', 180)

# maskable（全出血方形，字形缩至 60% 安全区）
master_m = draw_glyph(Image.new('RGBA', (2048, 2048), PINE + (255,)), scale=4, glyph_ratio=0.42)
save(master_m, 'maskable-512.png', 512)
save(master_m, 'maskable-192.png', 192)

# Capacitor / 商店用 1024
save(master_m, 'icon-1024.png', 1024)
print('done ->', os.path.abspath(OUT))
