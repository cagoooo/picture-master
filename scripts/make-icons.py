"""
試卷生圖 Studio · 一鍵產 favicon + og:image
================================================
用 Pillow 直接畫，不依賴 SVG 轉檔工具。
產出:
  - favicon.svg            (32px 視窗，現代瀏覽器主用)
  - favicon-32.png         (傳統 fallback)
  - favicon-16.png         (傳統 fallback)
  - apple-touch-icon.png   (180x180，iOS 主畫面圖示)
  - og-image.png           (1200x630，FB/LINE/Twitter 分享卡)

設計語彙：黑板 × 木框 × 黃色粉筆字「試」。
重跑：python scripts/make-icons.py
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# Windows cp950 console fix
sys.stdout.reconfigure(encoding="utf-8")

REPO = Path(__file__).resolve().parent.parent

# 設計色票（對齊 index.html :root）
INK            = (26, 23, 20)
BOARD          = (43, 58, 53)
BOARD_DEEP     = (31, 42, 38)
WOOD           = (90, 58, 31)
WOOD_LIGHT     = (122, 85, 50)
WOOD_SHADOW    = (42, 26, 12)
CHALK_WHITE    = (240, 235, 216)
CHALK_SOFT     = (207, 202, 176)
CHALK_YELLOW   = (246, 197, 96)
CHALK_RED      = (224, 124, 94)
PAPER          = (255, 255, 255)
PAPER_INK      = (31, 28, 20)
PAPER_MUTED    = (122, 116, 102)

FONT_TC_SANS   = "C:/Windows/Fonts/NotoSansTC-VF.ttf"
FONT_TC_SERIF  = "C:/Windows/Fonts/NotoSerifTC-VF.ttf"
FONT_MONO      = "C:/Windows/Fonts/consola.ttf"
FONT_MONO_BOLD = "C:/Windows/Fonts/consolab.ttf"
FONT_EMOJI     = "C:/Windows/Fonts/seguiemj.ttf"  # Segoe UI Emoji (彩色)


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


# ============================================================
# 1. favicon.svg — 純向量，現代瀏覽器主用
# ============================================================
def make_favicon_svg() -> None:
    svg = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <title>試卷生圖 Studio</title>
  <!-- 木框 -->
  <rect x="0" y="0" width="64" height="64" rx="8" fill="#5a3a1f"/>
  <rect x="0" y="0" width="64" height="64" rx="8" fill="url(#wood)"/>
  <!-- 黑板 -->
  <rect x="5" y="5" width="54" height="54" rx="4" fill="#2b3a35"/>
  <rect x="5" y="5" width="54" height="54" rx="4" fill="url(#board)"/>
  <!-- 內框（粉筆灰光） -->
  <rect x="6" y="6" width="52" height="52" rx="3" fill="none" stroke="rgba(240,235,216,0.08)" stroke-width="0.5"/>
  <!-- 黃色「試」 -->
  <text x="32" y="48" font-family="'Noto Serif TC', 'PingFang TC', 'Microsoft JhengHei', serif"
        font-weight="900" font-size="44" text-anchor="middle" fill="#f6c560">試</text>
  <defs>
    <linearGradient id="wood" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7a5532"/>
      <stop offset="0.5" stop-color="#5a3a1f"/>
      <stop offset="1" stop-color="#4a2e16"/>
    </linearGradient>
    <linearGradient id="board" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b3a35"/>
      <stop offset="1" stop-color="#1f2a26"/>
    </linearGradient>
  </defs>
</svg>
"""
    (REPO / "favicon.svg").write_text(svg, encoding="utf-8")
    print("✓ favicon.svg")


# ============================================================
# 2. apple-touch-icon.png (180x180) + favicon-32 / 16 PNG fallback
# ============================================================
def draw_icon(size: int) -> Image.Image:
    # 小於 24 時用簡化版（黑板 + 試，不畫木框）讓字盡量大
    minimal = size < 24

    img = Image.new("RGB", (size, size), WOOD if not minimal else BOARD)
    d = ImageDraw.Draw(img)

    if not minimal:
        # 木框漸層
        for y in range(size):
            t = y / size
            if t < 0.5:
                ratio = t * 2
                r = int(WOOD_LIGHT[0] + (WOOD[0] - WOOD_LIGHT[0]) * ratio)
                g = int(WOOD_LIGHT[1] + (WOOD[1] - WOOD_LIGHT[1]) * ratio)
                b = int(WOOD_LIGHT[2] + (WOOD[2] - WOOD_LIGHT[2]) * ratio)
            else:
                ratio = (t - 0.5) * 2
                r = int(WOOD[0] + (74 - WOOD[0]) * ratio)
                g = int(WOOD[1] + (46 - WOOD[1]) * ratio)
                b = int(WOOD[2] + (22 - WOOD[2]) * ratio)
            d.line([(0, y), (size, y)], fill=(r, g, b))

        # 黑板漸層（內縮 ~12%）
        margin = int(size * 0.12)
        for y in range(margin, size - margin):
            t = (y - margin) / (size - margin * 2)
            r = int(BOARD[0] + (BOARD_DEEP[0] - BOARD[0]) * t)
            g = int(BOARD[1] + (BOARD_DEEP[1] - BOARD[1]) * t)
            b = int(BOARD[2] + (BOARD_DEEP[2] - BOARD[2]) * t)
            d.line([(margin, y), (size - margin, y)], fill=(r, g, b))

        # 黑板內陰影
        inner_margin = margin + max(1, int(size * 0.015))
        d.rectangle(
            (inner_margin, inner_margin, size - inner_margin, size - inner_margin),
            outline=(20, 30, 28),
            width=max(1, int(size * 0.008)),
        )
        font_ratio = 0.62
    else:
        # 簡化版：直接畫深綠底，試字撐滿
        font_ratio = 0.92

    # 黃色「試」字
    font_size = int(size * font_ratio)
    f = font(FONT_TC_SERIF, font_size)
    text = "試"
    bbox = d.textbbox((0, 0), text, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) / 2 - bbox[0]
    ty = (size - th) / 2 - bbox[1] - int(size * 0.02)
    d.text((tx, ty), text, font=f, fill=CHALK_YELLOW)

    # 角落粉筆亮點 — 只在 >= 64 時加
    if size >= 64:
        margin = int(size * 0.12)
        spot = max(1, int(size * 0.012))
        d.ellipse(
            (size - margin - int(size * 0.08), margin + int(size * 0.05),
             size - margin - int(size * 0.08) + spot, margin + int(size * 0.05) + spot),
            fill=CHALK_SOFT,
        )

    return img


def make_pngs() -> None:
    # Apple touch icon — iOS 主畫面
    draw_icon(180).save(REPO / "apple-touch-icon.png", optimize=True)
    print("✓ apple-touch-icon.png (180x180)")

    # 傳統 favicon PNG fallback
    icon_32 = draw_icon(32)
    icon_16 = draw_icon(16)
    icon_32.save(REPO / "favicon-32.png", optimize=True)
    icon_16.save(REPO / "favicon-16.png", optimize=True)
    print("✓ favicon-32.png")
    print("✓ favicon-16.png")

    # ICO 多尺寸（給最舊瀏覽器）
    icon_48 = draw_icon(48)
    icon_32.save(REPO / "favicon.ico", format="ICO",
                 sizes=[(16, 16), (32, 32), (48, 48)],
                 append_images=[icon_16, icon_48])
    print("✓ favicon.ico (16+32+48)")


# ============================================================
# 3. og-image.png 1200x630 — FB / LINE / Twitter 分享卡
# ============================================================
def make_og_image() -> None:
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(img)

    # 背景紋理（粉筆灰隱約噪點）
    for y in range(H):
        t = y / H
        r = int(INK[0] + (BOARD_DEEP[0] - INK[0]) * t * 0.4)
        g = int(INK[1] + (BOARD_DEEP[1] - INK[1]) * t * 0.4)
        b = int(INK[2] + (BOARD_DEEP[2] - INK[2]) * t * 0.4)
        d.line([(0, y), (W, y)], fill=(r, g, b))

    # ===== 左半邊：黑板 + 主標 =====
    BOARD_X, BOARD_Y = 60, 80
    BOARD_W, BOARD_H = 680, 470
    # 木框
    d.rounded_rectangle(
        (BOARD_X - 14, BOARD_Y - 14, BOARD_X + BOARD_W + 14, BOARD_Y + BOARD_H + 14),
        radius=14,
        fill=WOOD,
    )
    d.rounded_rectangle(
        (BOARD_X - 14, BOARD_Y - 14, BOARD_X + BOARD_W + 14, BOARD_Y + BOARD_H + 14),
        radius=14,
        outline=WOOD_LIGHT,
        width=2,
    )
    # 黑板本體（含漸層）
    for y in range(BOARD_Y, BOARD_Y + BOARD_H):
        t = (y - BOARD_Y) / BOARD_H
        r = int(BOARD[0] + (BOARD_DEEP[0] - BOARD[0]) * t)
        g = int(BOARD[1] + (BOARD_DEEP[1] - BOARD[1]) * t)
        b = int(BOARD[2] + (BOARD_DEEP[2] - BOARD[2]) * t)
        d.line([(BOARD_X, y), (BOARD_X + BOARD_W, y)], fill=(r, g, b))
    d.rounded_rectangle(
        (BOARD_X, BOARD_Y, BOARD_X + BOARD_W, BOARD_Y + BOARD_H),
        radius=6,
        outline=(20, 30, 28),
        width=1,
    )

    # 黑板上 kicker
    kicker_f = font(FONT_MONO_BOLD, 18)
    d.text((BOARD_X + 40, BOARD_Y + 38),
           "PICTURE  MASTER  ·  STUDIO  ·  v0.5",
           font=kicker_f, fill=CHALK_SOFT)

    # 主標「試卷生圖」(大粉筆字)
    title_f = font(FONT_TC_SERIF, 140)
    d.text((BOARD_X + 40, BOARD_Y + 70), "試卷生圖", font=title_f, fill=CHALK_WHITE)

    # 副標「Studio」(英文，黃色)
    sub_f = font(FONT_TC_SERIF, 88)
    d.text((BOARD_X + 40, BOARD_Y + 220), "Studio", font=sub_f, fill=CHALK_YELLOW)
    # Studio 下方虛線（粉筆風）
    studio_bbox = d.textbbox((BOARD_X + 40, BOARD_Y + 220), "Studio", font=sub_f)
    dash_underline_y = studio_bbox[3] + 4
    for x in range(studio_bbox[0], studio_bbox[2], 10):
        d.line([(x, dash_underline_y), (x + 5, dash_underline_y)],
               fill=CHALK_YELLOW, width=3)

    # 黑板上虛線分隔
    dash_y = BOARD_Y + 340
    for x in range(BOARD_X + 40, BOARD_X + BOARD_W - 40, 12):
        d.line([(x, dash_y), (x + 6, dash_y)], fill=CHALK_SOFT, width=1)

    # 描述句（兩行）
    desc_f = font(FONT_TC_SANS, 28)
    d.text((BOARD_X + 40, BOARD_Y + 360),
           "備課一鍵生黑白線稿",
           font=desc_f, fill=CHALK_WHITE)
    d.text((BOARD_X + 40, BOARD_Y + 402),
           "學習單 · 試卷配圖 · 著色頁",
           font=desc_f, fill=CHALK_SOFT)

    # ===== 右半邊：紙張 + 範例縮圖 =====
    PAPER_X, PAPER_Y = 800, 95
    PAPER_W, PAPER_H = 340, 440

    # 膠帶（左上）
    d.polygon(
        [(PAPER_X + 20, PAPER_Y - 18),
         (PAPER_X + 100, PAPER_Y - 14),
         (PAPER_X + 102, PAPER_Y + 8),
         (PAPER_X + 22, PAPER_Y + 4)],
        fill=(246, 197, 96, 200),
        outline=(220, 175, 80, 255),
    )

    # 紙張陰影
    shadow = Image.new("RGBA", (PAPER_W + 60, PAPER_H + 60), (0, 0, 0, 0))
    s_draw = ImageDraw.Draw(shadow)
    s_draw.rounded_rectangle((30, 30, PAPER_W + 30, PAPER_H + 30), radius=4, fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=15))
    img.paste(shadow, (PAPER_X - 30, PAPER_Y - 10), shadow)

    # 紙張本體
    d.rounded_rectangle(
        (PAPER_X, PAPER_Y, PAPER_X + PAPER_W, PAPER_Y + PAPER_H),
        radius=4,
        fill=PAPER,
    )
    # 紙張點陣紋理
    for py in range(PAPER_Y + 6, PAPER_Y + PAPER_H - 6, 10):
        for px in range(PAPER_X + 6, PAPER_X + PAPER_W - 6, 10):
            d.ellipse((px, py, px + 1, py + 1), fill=(220, 215, 200))

    # 紙張標題
    paper_title_f = font(FONT_TC_SERIF, 30)
    d.text((PAPER_X + 22, PAPER_Y + 30), "學習單預覽", font=paper_title_f, fill=PAPER_INK)
    # 分隔線
    d.line(
        [(PAPER_X + 22, PAPER_Y + 78), (PAPER_X + PAPER_W - 22, PAPER_Y + 78)],
        fill=PAPER_INK,
        width=2,
    )

    # 縮圖 2x2 grid
    grid_size = 130
    gap = 12
    grid_x = PAPER_X + 22
    grid_y = PAPER_Y + 100
    examples = [("🔬", "Science"), ("🐷", "Farm"), ("➗", "數學"), ("🏃", "運動")]
    for i, (emo, label) in enumerate(examples):
        col = i % 2
        row = i // 2
        x = grid_x + col * (grid_size + gap)
        y = grid_y + row * (grid_size + gap)
        # 格框
        d.rectangle((x, y, x + grid_size, y + grid_size), outline=(200, 195, 180), width=1)
        # 斜線紋理
        for k in range(-grid_size, grid_size, 8):
            d.line(
                [(x + max(0, k), y + max(0, -k)),
                 (x + min(grid_size, k + grid_size), y + min(grid_size, -k + grid_size))],
                fill=(240, 238, 230), width=1
            )
        # emoji 用彩色 emoji 字型（Segoe UI Emoji 支援 COLR/CPAL → embedded_color）
        # Segoe UI Emoji 字型有最大尺寸限制（109），用 96 安全
        emo_f = font(FONT_EMOJI, 96)
        d.text((x + grid_size / 2, y + grid_size / 2 - 8), emo, font=emo_f,
               anchor="mm", embedded_color=True)
        # label
        label_f = font(FONT_TC_SANS, 14)
        d.text((x + grid_size / 2, y + grid_size - 14), label, font=label_f,
               fill=PAPER_MUTED, anchor="mm")

    # ===== 底部 strip =====
    strip_y = H - 70
    # 分隔線
    d.line([(60, strip_y - 12), (W - 60, strip_y - 12)], fill=(80, 75, 65), width=1)

    # 左：作者
    author_f = font(FONT_TC_SANS, 20)
    heart = "♡"
    d.text((60, strip_y + 5), "Made with", font=author_f, fill=CHALK_SOFT, anchor="lm")
    made_bbox = d.textbbox((60, strip_y + 5), "Made with ", font=author_f, anchor="lm")
    heart_x = made_bbox[2] + 4
    d.text((heart_x, strip_y + 5), heart, font=font(FONT_TC_SANS, 22),
           fill=CHALK_RED, anchor="lm")
    d.text((heart_x + 22, strip_y + 5),
           "by 阿凱老師 @ 桃園市龍潭區石門國民小學",
           font=author_f, fill=CHALK_WHITE, anchor="lm")

    # 右：URL
    url_f = font(FONT_MONO_BOLD, 18)
    d.text((W - 60, strip_y + 5),
           "cagoooo.github.io/picture-master",
           font=url_f, fill=CHALK_YELLOW, anchor="rm")

    img.save(REPO / "og-image.png", optimize=True, quality=92)
    print(f"✓ og-image.png ({W}x{H})")


if __name__ == "__main__":
    make_favicon_svg()
    make_pngs()
    make_og_image()
    print("\n全部產出完成 → 在 H:\\picture 目錄下")
