# -*- coding: utf-8 -*-
"""
智能账本 · 图标生成器
====================================================================
为什么需要这个脚本？
  原生 tabBar 的图标只能是图片文件（iconPath / selectedIconPath），
  没法用 CSS 变量染色 —— 主题一换，选中图标就得换一套文件。
  所以「选中态」图标按主题各生成一份：<shape>-active-<themeId>.png

色值不在本文件里维护：
  主题清单从 utils/theme.js 里直接读（那才是单一数据源），
  改了主题色只需要重新跑一次本脚本。

画法：
  在 24x24 的设计坐标系里用矢量式描边绘制，先 16 倍超采样再 LANCZOS 缩放，
  得到任意尺寸都清晰的抗锯齿 PNG（比用 emoji 稳定 —— emoji 在 iOS/Android 上观感差异很大）。

运行：
  <python> tools/gen-icons.py            # 默认项目根 = 脚本上一级目录
  <python> tools/gen-icons.py <项目根>
依赖： Pillow
"""
import os
import re
import sys
from PIL import Image, ImageDraw

SS = 16                       # 超采样倍数（相对 24 单位坐标系）
U = 24                        # 设计坐标系边长
BASE = U * SS                 # 实际绘制画布 = 384

TAB_SIZE = 81                 # tabBar 图标：官方建议 81x81
FX_SIZE = 96                  # 功能图标
EMPTY_SIZE = 156              # 空状态插画

# tabBar 图标基础名，顺序必须与 app.json 的 tabBar.list 一致
TAB_SHAPES = [
    ('home', 'ic_house'),
    ('bill', 'ic_list'),
    ('chart', 'ic_bars'),
    ('ai', 'ic_spark'),
    ('user', 'ic_user'),
]


# ---------------------------------------------------------------- 基础绘制原语

def new_canvas():
    img = Image.new('RGBA', (BASE, BASE), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def _pt(x, y):
    return (x * SS, y * SS)


def _w(w):
    return max(1, int(round(w * SS)))


def stroke(d, points, color, width, close=False):
    """折线 + 圆形端点（模拟 round cap / round join）"""
    pts = [_pt(x, y) for x, y in points]
    if close:
        pts = pts + [pts[0]]
    d.line(pts, fill=color, width=_w(width), joint='curve')
    r = _w(width) / 2.0
    ends = pts if close else [pts[0], pts[-1]]
    for (x, y) in ends:
        d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def ring(d, cx, cy, r, color, width):
    """空心圆"""
    d.ellipse([_pt(cx - r, cy - r), _pt(cx + r, cy + r)], outline=color, width=_w(width))


def dot(d, cx, cy, r, color):
    """实心圆"""
    d.ellipse([_pt(cx - r, cy - r), _pt(cx + r, cy + r)], fill=color)


def rrect(d, x0, y0, x1, y1, rad, color, width):
    """描边圆角矩形"""
    d.rounded_rectangle([_pt(x0, y0), _pt(x1, y1)],
                        radius=int(rad * SS), outline=color, width=_w(width))


def poly(d, points, color):
    """实心多边形（用于填充类图形，如星芒）"""
    d.polygon([_pt(x, y) for x, y in points], fill=color)


def _star_points(cx, cy, r, k):
    """四角星（星芒）的 8 个顶点：4 个尖 + 4 个内凹。

    k 是内凹半径与尖端半径之比：k 越小越"瘦"（越像光点），
    0.30 左右是视觉上最像"AI 闪光"的比例。
    这里不用三角函数（避免依赖 math），45° 方向直接乘 cos45° = 0.7071。
    """
    inner = r * k * 0.7071
    return [
        (cx, cy - r),                 # 上尖
        (cx + inner, cy - inner),     # 右上凹
        (cx + r, cy),                 # 右尖
        (cx + inner, cy + inner),     # 右下凹
        (cx, cy + r),                 # 下尖
        (cx - inner, cy + inner),     # 左下凹
        (cx - r, cy),                 # 左尖
        (cx - inner, cy - inner),     # 左上凹
    ]


def ic_spark(d, c):
    """AI 分析：一大一小两颗星芒。

    ⚠️ 用**填充**多边形而不是描边：四角星是凹多边形，描边在 81px 下
       中心会糊成一团；填充的形状缩到小尺寸依然是干净的。
    """
    poly(d, _star_points(10.9, 13.3, 8.6, 0.30), c)
    poly(d, _star_points(18.7, 5.6, 3.9, 0.32), c)


def ic_crown(d, c):
    """会员（皇冠）：三尖冠 + 冠身横线 + 底座。

    描边画法（与其余菜单图标一致）：三根斜线搭出冠形，
    三个尖上各一颗小圆点 —— 皇冠的辨识度主要靠这三个点。
    """
    # 冠体：左下 → 左尖 → 中谷 → 右尖 → 右下
    stroke(d, [(4.5, 17.5), (4.5, 8.5), (9.4, 13.0), (12, 7.0),
               (14.6, 13.0), (19.5, 8.5), (19.5, 17.5)], c, 2.1, close=False)
    # 冠底座
    stroke(d, [(5.6, 20.2), (18.4, 20.2)], c, 2.1)
    # 三个尖上的圆点（左尖 / 顶 / 右尖）
    dot(d, 4.5, 6.6, 1.15, c)
    dot(d, 12, 5.0, 1.15, c)
    dot(d, 19.5, 6.6, 1.15, c)


# ---------------------------------------------------------------- 图标定义

def ic_plus(d, c):
    stroke(d, [(12, 4.6), (12, 19.4)], c, 2.4)
    stroke(d, [(4.6, 12), (19.4, 12)], c, 2.4)


def ic_download(d, c):
    stroke(d, [(4.6, 14.4), (4.6, 19.6), (19.4, 19.6), (19.4, 14.4)], c, 2.1)
    stroke(d, [(12, 3.6), (12, 14.6)], c, 2.1)
    stroke(d, [(7.9, 10.4), (12, 14.8), (16.1, 10.4)], c, 2.1)


def ic_upload(d, c):
    stroke(d, [(4.6, 13.0), (4.6, 19.6), (19.4, 19.6), (19.4, 13.0)], c, 2.1)
    stroke(d, [(12, 15.8), (12, 4.4)], c, 2.1)
    stroke(d, [(7.9, 9.0), (12, 4.6), (16.1, 9.0)], c, 2.1)


def ic_bars(d, c):
    stroke(d, [(5.4, 19.6), (5.4, 13.2)], c, 2.8)
    stroke(d, [(12.0, 19.6), (12.0, 5.8)], c, 2.8)
    stroke(d, [(18.6, 19.6), (18.6, 10.2)], c, 2.8)


def ic_list(d, c):
    for y in (6.4, 12.0, 17.6):
        dot(d, 5.6, y, 1.45, c)
        stroke(d, [(9.8, y), (19.0, y)], c, 2.1)


def ic_target(d, c):
    """靶心：预算额度。外圈 + 中圈 + 实心靶点 —— 与 ic_info（同样有大圆）的区别
    就在这第二道中圈上，两者在界面上不挨着，但也不能画得像。"""
    ring(d, 12, 12, 8.7, c, 1.9)
    ring(d, 12, 12, 4.5, c, 1.5)
    dot(d, 12, 12, 1.4, c)


def ic_house(d, c):
    stroke(d, [(2.9, 11.5), (12, 3.7), (21.1, 11.5)], c, 2.4)
    stroke(d, [(4.9, 10.2), (4.9, 20.3), (19.1, 20.3), (19.1, 10.2)], c, 2.4)


def ic_user(d, c):
    ring(d, 12, 8.2, 3.9, c, 2.5)
    d.arc([_pt(4.7, 13.4), _pt(19.3, 27.8)], start=180, end=360, fill=c, width=_w(2.5))
    dot(d, 4.7, 20.6, 1.25, c)
    dot(d, 19.3, 20.6, 1.25, c)


def ic_person(d, c):
    """昵称：细描边版人形。

    ⚠️ 不能直接复用 ic_user：那个是给 tabBar 用的，描边 2.5 是为小尺寸下更好辨认；
       同一套线条放到 36rpx 的菜单图标上会比旁边的细线图标明显重一档。
    """
    ring(d, 12, 7.4, 3.6, c, 2.1)
    d.arc([_pt(5.1, 12.9), _pt(18.9, 26.4)], start=180, end=360, fill=c, width=_w(2.1))
    dot(d, 5.1, 19.65, 1.05, c)
    dot(d, 18.9, 19.65, 1.05, c)


def ic_grid(d, c):
    rrect(d, 3.9, 3.9, 10.7, 10.7, 1.9, c, 2.0)
    rrect(d, 13.3, 3.9, 20.1, 10.7, 1.9, c, 2.0)
    rrect(d, 3.9, 13.3, 10.7, 20.1, 1.9, c, 2.0)
    rrect(d, 13.3, 13.3, 20.1, 20.1, 1.9, c, 2.0)


def ic_trash(d, c):
    stroke(d, [(3.7, 6.5), (20.3, 6.5)], c, 2.2)
    stroke(d, [(9.5, 6.5), (9.5, 3.9), (14.5, 3.9), (14.5, 6.5)], c, 1.9)
    stroke(d, [(5.7, 6.5), (6.9, 20.4), (17.1, 20.4), (18.3, 6.5)], c, 1.9)
    stroke(d, [(10.0, 10.2), (10.3, 17.3)], c, 1.5)
    stroke(d, [(14.0, 10.2), (13.7, 17.3)], c, 1.5)


def ic_sliders(d, c):
    stroke(d, [(3.4, 6.6), (11.5, 6.6)], c, 2.1)
    stroke(d, [(17.5, 6.6), (20.6, 6.6)], c, 2.1)
    ring(d, 14.5, 6.6, 2.7, c, 2.1)

    stroke(d, [(3.4, 12.0), (6.0, 12.0)], c, 2.1)
    stroke(d, [(12.0, 12.0), (20.6, 12.0)], c, 2.1)
    ring(d, 9.0, 12.0, 2.7, c, 2.1)

    stroke(d, [(3.4, 17.4), (13.0, 17.4)], c, 2.1)
    stroke(d, [(19.0, 17.4), (20.6, 17.4)], c, 2.1)
    ring(d, 16.0, 17.4, 2.7, c, 2.1)


def ic_info(d, c):
    ring(d, 12, 12, 8.6, c, 2.1)
    dot(d, 12, 7.9, 1.35, c)
    stroke(d, [(12, 11.2), (12, 16.8)], c, 2.1)


def ic_heart(d, c):
    """爱心：赞赏/感谢。

    经典心形画法：两个圆各只取**上半段弧**（左弧从左下扫过顶部到正中凹点，
    右弧镜像），再从弧的末端用两条斜线汇到底部尖点。
    圆的下半段不画 —— 露出来就会变成「oo + V」。
    """
    # 左耳：圆心(8.2, 8.0) r=3.8，弧从 135°（左下）顺时针扫到 360°（正右 = 顶部凹点）
    d.arc([_pt(4.4, 4.2), _pt(12.0, 11.8)], start=135, end=360, fill=c, width=_w(2.0))
    # 右耳：圆心(15.8, 8.0) r=3.8，弧从 180°（左端 = 凹点）扫到 405°（=45°，右下）
    d.arc([_pt(12.0, 4.2), _pt(19.6, 11.8)], start=180, end=405, fill=c, width=_w(2.0))
    # 斜线从弧的末端（θ=135° / 45° 处，3.8×0.7071≈2.69）汇到底尖
    stroke(d, [(5.51, 10.69), (12.0, 20.0)], c, 2.0)
    stroke(d, [(18.49, 10.69), (12.0, 20.0)], c, 2.0)


def ic_bookmark(d, c):
    """书签：常记的（可复用的快捷账单）。顶部平、底部 V 形缺口。"""
    stroke(d, [(7.2, 3.8), (7.2, 20.4), (12, 16.0), (16.8, 20.4), (16.8, 3.8)], c, 2.0, close=True)


def ic_inbox(d, c):
    """空状态：文件箱"""
    stroke(d, [(3.2, 13.4), (3.2, 18.0), (20.8, 18.0), (20.8, 13.4)], c, 1.9)
    stroke(d, [(3.2, 13.4), (7.2, 13.4), (8.8, 16.0), (15.2, 16.0), (16.8, 13.4), (20.8, 13.4)], c, 1.9)
    stroke(d, [(6.4, 8.6), (12, 3.4), (17.6, 8.6)], c, 1.9)


# ---------------------------------------------------------------- 从 utils/theme.js 取主题

def read_themes(js_path):
    """
    解析 utils/theme.js 里的主题清单，返回 [(id, (r, g, b, 255)), ...]。
    只认形如 { id: 'green', name: '微信绿', brand: '#07C160' }, 的行，
    所以 THEMES 里务必一行一个主题。
    """
    with open(js_path, 'r', encoding='utf-8') as f:
        src = f.read()

    pairs = re.findall(r"id:\s*'([A-Za-z0-9_]+)'[^\n]*?brand:\s*'(#[0-9A-Fa-f]{6})'", src)
    if not pairs:
        raise SystemExit('未能从 utils/theme.js 解析出主题，请检查 THEMES 的写法')

    themes = []
    for tid, hexcolor in pairs:
        r = int(hexcolor[1:3], 16)
        g = int(hexcolor[3:5], 16)
        b = int(hexcolor[5:7], 16)
        themes.append((tid, (r, g, b, 255), hexcolor))

    m = re.search(r"TAB_INACTIVE\s*=\s*'(#[0-9A-Fa-f]{6})'", src)
    inactive_hex = m.group(1) if m else '#8A94A6'
    inactive = (int(inactive_hex[1:3], 16), int(inactive_hex[3:5], 16), int(inactive_hex[5:7], 16), 255)

    return themes, inactive, inactive_hex


# ---------------------------------------------------------------- 输出

def render(draw_fn, color, size, out_path):
    img, d = new_canvas()
    draw_fn(d, color)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(out_path, 'PNG', optimize=True)
    return os.path.getsize(out_path)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(here)

    theme_js = os.path.join(root, 'utils', 'theme.js')
    outdir = os.path.join(root, 'assets', 'icons')
    os.makedirs(outdir, exist_ok=True)

    themes, inactive, inactive_hex = read_themes(theme_js)
    print('主题 %d 套（来自 utils/theme.js）：%s'
          % (len(themes), ', '.join('%s%s' % (t[0], t[2]) for t in themes)))
    print('tabBar 未选中色：%s\n' % inactive_hex)

    ICONS = globals()

    GREEN = (14, 159, 110, 255)
    ORANGE = (232, 104, 58, 255)
    PURPLE = (109, 74, 224, 255)
    AMBER = (217, 138, 11, 255)
    RED = (229, 72, 77, 255)
    SLATE = (90, 100, 120, 255)
    TEAL = (13, 148, 136, 255)
    BLUE = (43, 92, 230, 255)
    MUTED = (195, 204, 218, 255)
    WHITE = (255, 255, 255, 255)
    # 赞赏爱心的暖红：与「收入/危险」的 RED(229,72,77) 区分开，
    # 用更柔和、更"暖"的珊瑚红，避免和「删除/危险」撞语义
    ROSE = (233, 84, 118, 255)
    # 常记的书签用靛蓝：与 import 的深蓝(BLUE)区分开，且没被别的菜单项占用
    INDIGO = (79, 70, 229, 255)

    jobs = []

    # ---- tabBar：未选中（全主题共用）+ 选中（每主题一套）----
    for shape, fn_name in TAB_SHAPES:
        jobs.append(('%s.png' % shape, ICONS[fn_name], inactive, TAB_SIZE))
    for tid, color, _hex in themes:
        for shape, fn_name in TAB_SHAPES:
            jobs.append(('%s-active-%s.png' % (shape, tid), ICONS[fn_name], color, TAB_SIZE))

    # ---- 首页快捷入口（三种颜色是设计上的区分，不跟主题走）----
    # 底色在中 WXSS 里与图标同色系：act-import/act-add/act-budget
    jobs += [
        ('qa-import.png', ic_download, BLUE, FX_SIZE),
        ('qa-add.png', ic_plus, ORANGE, FX_SIZE),
        ('qa-budget.png', ic_target, TEAL, FX_SIZE),
    ]

    # ---- 个人中心菜单 ----
    jobs += [
        ('mi-import.png', ic_download, BLUE, FX_SIZE),
        ('mi-export.png', ic_upload, GREEN, FX_SIZE),
        ('mi-grid.png', ic_grid, AMBER, FX_SIZE),
        ('mi-trash.png', ic_trash, RED, FX_SIZE),
        ('mi-sliders.png', ic_sliders, PURPLE, FX_SIZE),
        ('mi-info.png', ic_info, SLATE, FX_SIZE),
        # 昵称用独立的青色：下面那组菜单图标已经用掉了蓝/绿/橙/红/紫/灰，
        # 再复用其中一个会和别的功能撞色
        ('mi-user.png', ic_person, TEAL, FX_SIZE),
        # 会员中心：琥珀金皇冠 —— 与「分类识别」的 AMBER 同色但图标不同，
        # 菜单里一处金一处金不冲突（都是"值得注意/尊贵"的语义）
        ('mi-vip.png', ic_crown, AMBER, FX_SIZE),
        # 赞赏支持：爱心。用暖红（RED 是"收入/危险"语义，这里另用一个偏暖的红
        # 以区分，见下方 ROSE）
        ('mi-reward.png', ic_heart, ROSE, FX_SIZE),
        # 常记的：靛蓝书签
        ('mi-pick.png', ic_bookmark, INDIGO, FX_SIZE),
    ]

    # ---- 深底上的白色标记（hero 卡里用，不跟主题走）----
    jobs.append(('app-mark.png', ic_bars, WHITE, FX_SIZE))
    # AI 页 hero 里的星芒徽标：深底上必须是白色版，不能拿 tabBar 那套主题色图标顶替
    jobs.append(('ai-mark.png', ic_spark, WHITE, FX_SIZE))

    # ---- 空状态插画（中性灰，任何主题下都不突兀）----
    jobs += [
        ('empty-inbox.png', ic_inbox, MUTED, EMPTY_SIZE),
        ('empty-bill.png', ic_list, MUTED, EMPTY_SIZE),
        ('empty-chart.png', ic_bars, MUTED, EMPTY_SIZE),
    ]

    total = 0
    for name, fn, color, size in jobs:
        sz = render(fn, color, size, os.path.join(outdir, name))
        total += sz
        print('  %-28s %sx%-3s %6d B' % (name, size, size, sz))

    print('\n共 %d 个图标，合计 %.1f KB' % (len(jobs), total / 1024.0))

    # ---- 赞赏码占位图（⚠️ 仅当文件不存在时才生成）----
    # 这里放的是 assets/reward-qr.png，作者拿到微信「赞赏码」后直接用真图覆盖这个路径；
    # 占位逻辑故意做成"存在即跳过"，重跑本脚本不会把真二维码冲掉。
    qr_path = os.path.join(outdir, 'reward-qr.png')
    if not os.path.exists(qr_path):
        img = Image.new('RGBA', (480, 480), (255, 255, 255, 255))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle([10, 10, 469, 469], radius=40,
                            outline=(224, 229, 237, 255), width=6)
        # 三个「回」字定位角，一眼能看出是二维码占位
        for (x, y) in [(46, 46), (398, 46), (46, 398)]:
            d.rounded_rectangle([x, y, x + 74, y + 74], radius=16,
                                outline=(209, 215, 226, 255), width=9)
            d.rounded_rectangle([x + 24, y + 24, x + 50, y + 50], radius=7,
                                fill=(209, 215, 226, 255))
        # 中央爱心（复用 ic_heart，在 24 坐标系画完再缩放贴入）
        heart = Image.new('RGBA', (BASE, BASE), (0, 0, 0, 0))
        ic_heart(ImageDraw.Draw(heart), ROSE)
        heart = heart.resize((150, 150), Image.LANCZOS)
        img.paste(heart, (165, 165), heart)
        img.save(qr_path, 'PNG', optimize=True)
        print('\n已生成赞赏码占位图 reward-qr.png（拿到真赞赏码后直接覆盖它）')

    # ---- 分享封面（同样仅当文件不存在时生成）----
    # 账单页 / 我的页等隐私页面分享时用这张固定封面：
    # 默认分享是当前页面截图，会把交易明细截走，所以这些页面必须指定 imageUrl。
    cover_path = os.path.join(outdir, 'share-cover.png')
    if not os.path.exists(cover_path):
        # 品牌色渐变（取默认主题的 brand，深一档收尾）+ 放大的 app 标记
        brand = themes[0][2].lstrip('#')
        top = tuple(int(brand[i:i + 2], 16) for i in (0, 2, 4))
        bottom = tuple(max(0, int(c * 0.62)) for c in top)
        W, H = 500, 400
        img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        # 竖向三段渐变（横向均匀即可，视觉上足够）
        steps = 24
        for i in range(steps):
            r = int(top[0] + (bottom[0] - top[0]) * i / (steps - 1))
            g = int(top[1] + (bottom[1] - top[1]) * i / (steps - 1))
            b = int(top[2] + (bottom[2] - top[2]) * i / (steps - 1))
            y0 = H * i // steps
            y1 = H * (i + 1) // steps + 1
            d.rectangle([0, y0, W, y1], fill=(r, g, b, 255))
        # 装饰圆点（左上/右下两簇，纯装饰）
        for (cx, cy, cr, a) in [(64, 74, 30, 40), (452, 330, 44, 34), (418, 66, 16, 46)]:
            d.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=(255, 255, 255, a))
        # 中央：白色 app 标记（复用 ic_bars 的绘制，在 24 坐标系画完缩放贴入）
        mark = Image.new('RGBA', (BASE, BASE), (0, 0, 0, 0))
        ic_bars(ImageDraw.Draw(mark), WHITE)
        mark = mark.resize((132, 132), Image.LANCZOS)
        img.paste(mark, (W // 2 - 66, H // 2 - 92), mark)
        # 底部一条浅色圆角条，模拟"文字行"（不依赖系统字体，避免换机器缺字体）
        d.rounded_rectangle([W // 2 - 84, H // 2 + 58, W // 2 + 84, H // 2 + 74],
                            radius=8, fill=(255, 255, 255, 70))
        img = img.resize((W, H), Image.LANCZOS)
        img.save(cover_path, 'PNG', optimize=True)
        print('已生成分享封面 share-cover.png（不含任何用户数据，隐私页分享用）')


if __name__ == '__main__':
    main()
