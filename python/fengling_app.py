#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
闲不住 · 风铃悬浮球
====================
桌面悬浮小球：樱粉短册风铃，风吹会晃，戳一下弹出动作菜单。
动作（送礼/互动/恶作剧）全部转发给闲不住插件的本地代理端口，
由插件进程执行真正的业务（光粒扣减 + 推送到助手对话框）。

启动: python fengling_app.py
环境变量:
  XIANBUZHU_API  闲不住本地代理地址（默认 http://127.0.0.1:18902）
  HANA_HOME      Hana 数据目录（存状态文件用）
"""

import sys
import os
import json
import math
import time
import random
import hashlib
import threading
import urllib.request
import urllib.error

try:
    import winsound
except ImportError:
    winsound = None

try:
    import fengling_dsp
except ImportError:
    fengling_dsp = None

from PyQt6.QtCore import Qt, QTimer, QPoint, QPointF, QUrl, pyqtSignal
from PyQt6.QtGui import (
    QPixmap, QPainter, QPainterPath, QPen, QColor,
    QFont, QFontMetrics, QCursor,
)
from PyQt6.QtSvg import QSvgRenderer
from PyQt6.QtWidgets import (
    QApplication, QWidget, QPushButton, QLabel, QFrame, QMenu,
    QVBoxLayout, QHBoxLayout, QGridLayout, QSizePolicy,
)

try:
    from PyQt6.QtMultimedia import QSoundEffect
except ImportError:
    QSoundEffect = None

API_BASE = os.environ.get("XIANBUZHU_API", "http://127.0.0.1:18902")
HANA_HOME = os.environ.get("HANA_HOME", os.path.join(os.path.expanduser("~"), ".hanako"))
STATE_PATH = os.path.join(HANA_HOME, "data", "work-visit", "fengling-state.json")
AUDIO_CACHE_DIR = os.path.join(HANA_HOME, "data", "work-visit", "fengling-audio-cache")
HERE = os.path.dirname(os.path.abspath(__file__))

# 碰撞音色池只生成一次，所有风铃实例共享（wav bytes 不可变，安全）。
_CHIME_POOL_CACHE = None

BALL_SIZE = 108          # 悬浮球显示尺寸：比旧版更小巧
SVG_SIZE = 400           # SVG viewBox 尺寸
RENDER_SCALE = 3         # 高清渲染倍率，缩放后保留瓷面细节
BELL_PIVOT = (200 * RENDER_SCALE, 36 * RENDER_SCALE)
PAPER_PIVOT = (200 * RENDER_SCALE, 246 * RENDER_SCALE)
LINK_TOP = (200 * RENDER_SCALE, 112 * RENDER_SCALE)
CLAPPER_LENGTH = 74 * RENDER_SCALE   # 铃舌中心停在铃口平面附近：上部在铃内碰壁、下部探出可见
CLAPPER_RX = 14                      # 铃舌椭圆半径（SVG 坐标），约为铃口宽度一半，小尺寸下仍明显
CLAPPER_RY = 11
PAPER_LINE_LENGTH = 60 * RENDER_SCALE
CLAPPER_LIMIT = 12.0     # 铃舌椭圆边缘碰到铃口内沿时的相对角度（随铃舌尺寸标定）
EDGE_INSET = 16          # 贴边仍留出可见余量，兼容远程缩放与 DPI 变化
MIN_WIND_STRENGTH = 0.62 # 慢慢靠近时仍有清楚但克制的风
MAX_WIND_STRENGTH = 1.45 # 快速掠过时增强阵风，避免无限放大
FULL_GUST_SPEED = 1200.0 # px/s；达到此速度视为完整强风
CHIME_UPPER_ZONE = (36, 22, 72, 58)   # 单铃铃身与挂绳的可见范围
CHIME_LOWER_ZONE = (40, 50, 70, 92)   # 铃舌与摆动短册的可见范围
HOVER_EXIT_MARGIN = 8                # 离开判定略宽于进入区，保留滞回
HOVER_LEAVE_DELAY = 0.24             # 光标明确离开一小会儿后才散风
CLAPPER_SPRING = 20.0  # 铃舌牵引强度：悬停强风下高频撞壁，触发率跟上切片时长避免断点
CLAPPER_DAMP = 3.2     # 铃舌阻尼：更低，摆动更活跃；冷却+能量门槛仍防噪音化连击
CHIME_MIN_IMPACT = 7.0  # 铃舌向外撞壁的速度阈值（度/秒），轻碰也响
CHIME_COOLDOWN = 0.10    # 两次响铃最小间隔：防同一次反弹连击，允许更高响应密度
CHIME_VOICE_COUNT = 6    # 六个播放位置，高密度触发下长切片尾音也不被截断
CHIME_SLICE_POOL_SIZE = 12  # 启动时从多铃实录切出的碰撞音色数
VOLUME_LEVELS = (
    ("静音", 0.0),
    ("轻声", 0.35),
    ("适中", 0.65),
    ("清亮", 1.0),
)

# ── 手帐风配色 ──
C_BG = "#fdf8ee"        # 面板米白
C_BORDER = "#e5cba0"    # 暖金描边
C_GOLD = "#d99a4e"
C_GOLD_DEEP = "#a5651f"
C_MINT = "#9fd8c8"
C_MINT_DEEP = "#7cbfae"
C_PINK = "#f2a0b5"
C_INK = "#6e5a40"       # 深棕字
C_SUB = "#a08a68"       # 浅棕字


def clamp_position(x, y, width, height, left, top, right, bottom, inset=EDGE_INSET):
    """把窗口左上角收进指定屏幕的可见区域；right/bottom 为包含边界。"""
    min_x = left + inset
    min_y = top + inset
    max_x = max(min_x, right - width - inset + 1)
    max_y = max(min_y, bottom - height - inset + 1)
    return (
        max(min_x, min(int(x), max_x)),
        max(min_y, min(int(y), max_y)),
    )


def wind_strength_from_speed(speed):
    """把光标速度平滑映射成有限风力，慢风和快风之间不跳档。"""
    ratio = max(0.0, min(float(speed) / FULL_GUST_SPEED, 1.0))
    smooth = ratio * ratio * (3.0 - 2.0 * ratio)
    return MIN_WIND_STRENGTH + (MAX_WIND_STRENGTH - MIN_WIND_STRENGTH) * smooth


def calculate_entry_wind(previous_x, previous_y, current_x, current_y, elapsed, center_x):
    """根据进入前最后一段轨迹返回来风侧（左=-1/右=1）、速度和风力。"""
    dx = float(current_x) - float(previous_x)
    dy = float(current_y) - float(previous_y)
    seconds = max(float(elapsed), 1.0 / 240.0)
    speed = math.hypot(dx, dy) / seconds

    # 先相信进入前位于铃的哪一侧；恰好贴近中线时再用横向轨迹兜底。
    if float(previous_x) < float(center_x) - 2.0:
        source_direction = -1.0
    elif float(previous_x) > float(center_x) + 2.0:
        source_direction = 1.0
    elif abs(dx) >= 2.0:
        source_direction = -1.0 if dx > 0 else 1.0
    else:
        source_direction = -1.0 if float(current_x) <= float(center_x) else 1.0
    return source_direction, speed, wind_strength_from_speed(speed)


def point_in_chime_zone(x, y, margin=0):
    """命中三铃上半部或铃舌短册下半部，忽略透明窗口四角。"""
    for left, top, right, bottom in (CHIME_UPPER_ZONE, CHIME_LOWER_ZONE):
        if left - margin <= x <= right + margin and top - margin <= y <= bottom + margin:
            return True
    return False


def resolve_hover_state(hovered, x, y, outside_elapsed, frame_elapsed):
    """沿可见铃串轮廓做进出滞回和离开宽限，避免透明区误触发。"""
    inside_enter = point_in_chime_zone(x, y)
    if not hovered:
        return inside_enter, 0.0

    inside_stay = point_in_chime_zone(x, y, HOVER_EXIT_MARGIN)
    if inside_stay:
        return True, 0.0

    outside_elapsed += max(float(frame_elapsed), 0.0)
    return outside_elapsed < HOVER_LEAVE_DELAY, outside_elapsed


def resolve_clapper_collision(angle, velocity, limit=CLAPPER_LIMIT, restitution=0.34):
    """铃舌越过内壁时钳回并反弹；返回角度、速度和本次撞击速度。"""
    if abs(angle) <= limit:
        return angle, velocity, 0.0
    side = 1.0 if angle > 0 else -1.0
    outward = velocity * side > 0
    impact = abs(velocity) if outward else 0.0
    bounced = -velocity * restitution if outward else velocity
    return side * limit, bounced, impact


def should_attempt_chime(impact, hovered, cooldown=0.0, min_impact=CHIME_MIN_IMPACT):
    """铃舌向外撞穿铃壁、力度足够、且不在冷却内，才允许响一声。

    与旧版"一次悬停只响一次"不同：悬停期间每次有效碰撞都响，
    频率由物理参数 + 冷却 + 能量门槛自然压住，听感像真的风铃。
    """
    return bool(hovered and cooldown <= 0.0 and impact >= min_impact)


def chime_volume_from_impact(impact, base, min_impact=CHIME_MIN_IMPACT):
    """撞击越重越响：刚过门槛时约 55% 主音量，40 度/秒以上顶满。"""
    if impact <= min_impact:
        return base * 0.55
    strength = min(1.0, (impact - min_impact) / (40.0 - min_impact))
    return base * (0.55 + 0.45 * strength)


def linkage_points(clapper_angle, paper_angle):
    """计算铃内挂点、铃舌和短册结点；角度单位为度，坐标为高清 SVG 像素。"""
    top = QPointF(*LINK_TOP)
    clapper_rad = math.radians(clapper_angle)
    clapper = QPointF(
        top.x() + math.sin(clapper_rad) * CLAPPER_LENGTH,
        top.y() + math.cos(clapper_rad) * CLAPPER_LENGTH,
    )
    paper_rad = math.radians(paper_angle)
    knot = QPointF(
        clapper.x() + math.sin(paper_rad) * PAPER_LINE_LENGTH,
        clapper.y() + math.cos(paper_rad) * PAPER_LINE_LENGTH,
    )
    return top, clapper, knot


def linkage_curve_controls(top, clapper, knot, bend=0.0):
    """生成肉眼可见的绳弧；bend 随两段摆速差改变，让绳形每帧都会变。"""
    bend = max(-16.0, min(float(bend), 16.0)) * RENDER_SCALE
    upper = QPointF(
        (top.x() + clapper.x()) / 2 + bend,
        (top.y() + clapper.y()) / 2 + 24 * RENDER_SCALE,
    )
    lower = QPointF(
        clapper.x() + (knot.x() - clapper.x()) * 0.44 - bend * 0.72,
        clapper.y() + (knot.y() - clapper.y()) * 0.48 + 20 * RENDER_SCALE,
    )
    return upper, lower


def resolve_saved_volume(state):
    """读取新音量档位，并兼容旧版只有 soundEnabled 的状态文件。"""
    raw = state.get("soundVolume")
    if raw is None:
        return 0.65 if state.get("soundEnabled") else 0.0
    try:
        value = max(0.0, min(float(raw), 1.0))
    except (TypeError, ValueError):
        return 0.0
    return min((level for _label, level in VOLUME_LEVELS), key=lambda level: abs(level - value))


def prepare_sound_file(data, volume, cache_dir=AUDIO_CACHE_DIR):
    """把内存 wav 按音量落成缓存文件，供 winsound 真正异步播放。"""
    if fengling_dsp is not None:
        data = fengling_dsp.scale_wav_volume(data, volume)
    digest = hashlib.sha1(data).hexdigest()[:20]
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, f"{digest}.wav")
    if not os.path.exists(path):
        temp_path = path + ".tmp"
        with open(temp_path, "wb") as f:
            f.write(data)
        os.replace(temp_path, path)
    return path


# ─────────────────────────────
#  HTTP 客户端（标准库，零额外依赖）
# ─────────────────────────────
def api_get(path, timeout=5):
    with urllib.request.urlopen(API_BASE + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def api_post(path, payload, timeout=12):
    req = urllib.request.Request(
        API_BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def load_state():
    try:
        if os.path.exists(STATE_PATH):
            with open(STATE_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def save_state(state):
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
    except Exception:
        pass


# ─────────────────────────────
#  悬浮球本体
# ─────────────────────────────
class FenglingBall(QWidget):
    def __init__(self):
        super().__init__(None)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setFixedSize(BALL_SIZE, BALL_SIZE)

        self._render_pixmaps()

        # 状态
        self.state = load_state()
        self.catalog = None          # 礼物/互动/恶作剧清单 + 光粒
        self.target = None           # 当前最活跃的 Hana 会话目标

        # 动画：两个有重量的摆。铃身先受风，短册受牵引后再追上。
        self.t = 0.0
        self.angle_bell = 0.0
        self.angle_taz = 0.0
        self.angle_clapper = 0.0
        self.velocity_bell = 0.0
        self.velocity_taz = 0.0
        self.velocity_clapper = 0.0
        self.hovered = False
        self.hover_wind = 0.0
        self.hover_strength = 1.0
        self.gust = 0.0
        self.gust_direction = 1.0
        self.sound_volume = resolve_saved_volume(self.state)
        self._sound_cooldown = 0.0
        self._chime_pool = []
        self._last_chime_idx = -1
        self._sound_voices = []
        self._sound_voice_index = 0
        self._init_chime_pool()
        self._init_sound_voices()
        self.menu = None

        self._drag = None
        self._press_global = None
        self._moved = False
        self._drag_menu_was_visible = False
        self._screen_check_elapsed = 0.0
        self._hover_exit_elapsed = 0.0

        self._last_ts = time.monotonic()
        cursor = QCursor.pos()
        self._cursor_sample = (cursor.x(), cursor.y(), self._last_ts)
        timer = QTimer(self)
        timer.timeout.connect(self._tick)
        timer.start(16)

        self._place_from_state()

    # ── 渲染两个部件（高清） ──
    def _render_pixmaps(self):
        size = SVG_SIZE * RENDER_SCALE
        self.pix_bell = self._render_svg("fengling-bell.svg", size)
        self.pix_taz = self._render_svg("fengling-tanzaku.svg", size)

    def _draw_linkage(self, painter, clapper_angle, paper_angle):
        top, clapper, knot = linkage_points(clapper_angle, paper_angle)
        rope_bend = (self.velocity_clapper - self.velocity_taz) * 0.42
        upper_control, lower_control = linkage_curve_controls(
            top, clapper, knot, rope_bend
        )
        pen = QPen(QColor("#8bbcac"), 1.7 * RENDER_SCALE)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)

        path = QPainterPath(top)
        path.quadTo(upper_control, clapper)
        path.quadTo(lower_control, knot)
        painter.drawPath(path)

        painter.setBrush(QColor("#fff4d4"))
        painter.drawEllipse(
            clapper,
            CLAPPER_RX * RENDER_SCALE,
            CLAPPER_RY * RENDER_SCALE,
        )
        painter.setBrush(QColor("#fff9ea"))
        painter.drawEllipse(knot, 4.5 * RENDER_SCALE, 4.5 * RENDER_SCALE)

    def _draw_paper(self, painter, clapper_angle, paper_angle):
        _top, _clapper, knot = linkage_points(clapper_angle, paper_angle)
        px, py = PAPER_PIVOT
        painter.save()
        painter.translate(knot.x() - px, knot.y() - py)
        painter.translate(px, py)
        painter.rotate(paper_angle)
        painter.translate(-px, -py)
        painter.drawPixmap(0, 0, self.pix_taz)
        painter.restore()

    def _render_svg(self, name, size):
        path = os.path.join(HERE, name)
        pix = QPixmap(size, size)
        pix.fill(Qt.GlobalColor.transparent)
        try:
            renderer = QSvgRenderer(path)
            painter = QPainter(pix)
            renderer.render(painter)
            painter.end()
        except Exception:
            pass
        return pix

    # ── 位置恢复：旧坐标在缩放/分辨率变化后可能落到屏幕外 ──
    def _place_from_state(self):
        x = self.state.get("x")
        y = self.state.get("y")
        if x is not None and y is not None:
            self.move(int(x), int(y))
        self._ensure_visible(save=True)

    def _ensure_visible(self, save=False):
        center = QPoint(self.x() + self.width() // 2, self.y() + self.height() // 2)
        screen = QApplication.screenAt(center) or QApplication.primaryScreen()
        if screen is None:
            return
        geo = screen.availableGeometry()
        x, y = clamp_position(
            self.x(), self.y(), self.width(), self.height(),
            geo.left(), geo.top(), geo.right(), geo.bottom(),
        )
        if x != self.x() or y != self.y():
            self.move(x, y)
            if save:
                self._save_pos()

    def _save_pos(self):
        pos = self.pos()
        self.state["x"] = pos.x()
        self.state["y"] = pos.y()
        save_state(self.state)

    # ── 动画帧：阻尼摆 + 非等速微风 ──
    def _tick(self):
        now = time.monotonic()
        frame_elapsed = max(now - self._last_ts, 0.0)
        dt = min(frame_elapsed, 0.05)
        self._last_ts = now
        self.t += dt

        # 分辨率、DPI 或远程显示模式变化后，自动把旧坐标拉回当前屏幕。
        self._screen_check_elapsed += dt
        if self._screen_check_elapsed >= 1.0:
            self._screen_check_elapsed = 0.0
            self._ensure_visible(save=True)

        # 透明异形窗口在 Windows 下可能漏掉 enter/leave 事件。
        # 每帧读取全局光标，按稳定的宽松区域判定，保证悬停一定能触发。
        cursor_global = QCursor.pos()
        cursor = self.mapFromGlobal(cursor_global)
        cursor_hovered, self._hover_exit_elapsed = resolve_hover_state(
            self.hovered,
            cursor.x(),
            cursor.y(),
            self._hover_exit_elapsed,
            frame_elapsed,
        )
        entry_direction = self.gust_direction
        entry_strength = self.hover_strength
        if cursor_hovered and not self.hovered:
            previous_x, previous_y, previous_ts = self._cursor_sample
            entry_direction, _speed, entry_strength = calculate_entry_wind(
                previous_x,
                previous_y,
                cursor_global.x(),
                cursor_global.y(),
                now - previous_ts,
                self.x() + self.width() / 2,
            )
        self._set_hovered(cursor_hovered, entry_direction, entry_strength)
        self._cursor_sample = (cursor_global.x(), cursor_global.y(), now)

        # 悬停时风势迅速升高，移开后缓慢散去，避免生硬切档。
        target_hover_wind = 1.0 if self.hovered else 0.0
        wind_tau = 0.16 if self.hovered else 1.45
        wind_blend = 1.0 - math.exp(-dt / wind_tau)
        self.hover_wind += (target_hover_wind - self.hover_wind) * wind_blend
        self.gust *= math.exp(-dt / 0.72)

        # 三段不同周期的微风，加上一阵有方向的入场风。
        base_wind = (
            math.sin(self.t * 0.96)
            + 0.34 * math.sin(self.t * 1.92 + 0.8)
            + 0.12 * math.sin(self.t * 3.9 + 2.1)
        )
        wind = base_wind + self.gust_direction * 3.2 * self.gust

        # 微风走自由阻尼摆；悬停强风持续追逐更快的不规则目标角。
        normal_acc_bell = (
            wind * 6.0
            - self.angle_bell * 4.8
            - self.velocity_bell * 1.7
        )
        strong_bell_target = (
            self.gust_direction * (
                2.0
                + self.hover_strength * 8.0 * math.sin(self.t * 4.6 + 0.4)
                + self.hover_strength * 2.2 * math.sin(self.t * 7.3 + 1.2)
            )
            + base_wind * 1.2
        )
        strong_acc_bell = (
            (strong_bell_target - self.angle_bell) * 24.0
            - self.velocity_bell * 5.0
        )
        acc_bell = (
            normal_acc_bell * (1.0 - self.hover_wind)
            + strong_acc_bell * self.hover_wind
        )
        self.velocity_bell += acc_bell * dt
        self.angle_bell += self.velocity_bell * dt

        # 短册在强风里频率更高、摆幅更碎，并保留铃身牵引。
        normal_acc_taz = (
            wind * 18.0
            - self.angle_taz * 8.0
            - self.velocity_taz * 1.25
            - acc_bell * 1.8
        )
        strong_taz_target = (
            self.gust_direction * (
                3.0
                + self.hover_strength * 19.0 * math.sin(self.t * 6.3 + 1.1)
                + self.hover_strength * 4.0 * math.sin(self.t * 9.2 + 0.3)
            )
            + base_wind * 2.0
        )
        strong_acc_taz = (
            (strong_taz_target - self.angle_taz) * 40.0
            - self.velocity_taz * 5.8
            - acc_bell * 0.8
        )
        acc_taz = (
            normal_acc_taz * (1.0 - self.hover_wind)
            + strong_acc_taz * self.hover_wind
        )
        self.velocity_taz += acc_taz * dt
        self.angle_taz += self.velocity_taz * dt

        self.angle_bell = max(-12.0, min(12.0, self.angle_bell))
        self.angle_taz = max(-26.0, min(26.0, self.angle_taz))

        # 铃舌由短册牵引，但有自己的重量和滞后；真正碰壁时反弹并触发一声。
        clapper_target = self.angle_taz * 1.04 - self.angle_bell * 0.16
        acc_clapper = (
            (clapper_target - self.angle_clapper) * CLAPPER_SPRING
            - self.velocity_clapper * CLAPPER_DAMP
            - acc_bell * 0.18
        )
        self.velocity_clapper += acc_clapper * dt
        self.angle_clapper += self.velocity_clapper * dt
        self.angle_clapper, self.velocity_clapper, impact = resolve_clapper_collision(
            self.angle_clapper,
            self.velocity_clapper,
        )
        self._sound_cooldown = max(0.0, self._sound_cooldown - dt)
        if should_attempt_chime(impact, self.hovered, self._sound_cooldown):
            self._play_chime(impact)
        self.update()

    # ── 绘制（去圆底，仅铃 + 纸条；纸条画在铃身变换内，跟随铃口） ──
    def paintEvent(self, _e):
        p = QPainter(self)
        # 透明顶层窗在部分渲染后端不会自动擦掉上一帧；先清空，避免纸片留下折线残影。
        p.setCompositionMode(QPainter.CompositionMode.CompositionMode_Source)
        p.fillRect(self.rect(), Qt.GlobalColor.transparent)
        p.setCompositionMode(QPainter.CompositionMode.CompositionMode_SourceOver)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)

        scale = BALL_SIZE / (SVG_SIZE * RENDER_SCALE)
        p.scale(scale, scale)

        # 铃身绕挂点摆；柔线与纸片在铃身局部系里各自运动。
        bx, by = BELL_PIVOT
        p.save()
        p.translate(bx, by)
        p.rotate(self.angle_bell)
        p.translate(-bx, -by)

        # 先画内部铃舌、柔线和纸片，再让铃身盖住铃内部分。
        self._draw_linkage(p, self.angle_clapper, self.angle_taz)
        self._draw_paper(p, self.angle_clapper, self.angle_taz)
        p.drawPixmap(0, 0, self.pix_bell)
        p.restore()
        p.end()

    # ── 鼠标交互 ──
    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._press_global = e.globalPosition().toPoint()
            self._drag = self._press_global - self.pos()
            self._moved = False
            self._prepare_menu_drag()
            # 触碰像给悬绳一个很轻的拨动，随后完全由阻尼自然回摆。
            direction = 1.0 if self.angle_bell <= 0 else -1.0
            self.velocity_bell += 5.5 * direction
            self.velocity_taz -= 11.0 * direction
        e.accept()

    def mouseMoveEvent(self, e):
        if self._drag is not None and (e.buttons() & Qt.MouseButton.LeftButton):
            current = e.globalPosition().toPoint()
            if not self._moved:
                distance = (current - self._press_global).manhattanLength()
                if distance < QApplication.startDragDistance():
                    e.accept()
                    return
                self._moved = True
            self.move(current - self._drag)
            self._sync_dragged_menu()
        e.accept()

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._moved:
                self._snap()
                self._save_pos()
                self._sync_dragged_menu()
            elif self._drag_menu_was_visible and self.menu and self.menu.isVisible():
                self.menu.close_menu()
            else:
                self._toggle_menu()
            self._drag = None
            self._press_global = None
            self._drag_menu_was_visible = False
        elif e.button() == Qt.MouseButton.RightButton:
            self._open_context_menu(e.globalPosition().toPoint())
        e.accept()

    def _init_chime_pool(self):
        """启动时从多铃实录切出短促敲击变奏池，碰撞时随机取一个播放。

        这样每次碰壁都是"叮"的一声（保留实录的丰富泛音），
        而不是把 4.8 秒的录音整段放完。全进程只生成一次。
        """
        global _CHIME_POOL_CACHE
        self._chime_pool = []
        if _CHIME_POOL_CACHE is not None:
            self._chime_pool = _CHIME_POOL_CACHE
            return
        if fengling_dsp is None:
            return
        path = os.path.join(HERE, "fengling-chime-cluster.wav")
        if not os.path.exists(path):
            return
        try:
            _CHIME_POOL_CACHE = fengling_dsp.build_chime_pool(
                path, count=CHIME_SLICE_POOL_SIZE
            )
            self._chime_pool = _CHIME_POOL_CACHE
        except Exception as error:
            print(f"[风铃] 生成碰撞音色失败: {error}", file=sys.stderr)

    def _init_sound_voices(self):
        """准备三个独立播放位置，让新铃声不截断仍在消散的旧尾音。"""
        if QSoundEffect is None:
            return
        try:
            for _ in range(CHIME_VOICE_COUNT):
                voice = QSoundEffect(self)
                self._sound_voices.append(voice)
        except Exception as error:
            self._sound_voices = []
            print(f"[风铃] 初始化重叠播放失败，改用系统播放: {error}", file=sys.stderr)

    def _play_chime(self, impact):
        """碰撞触发：从切片池挑一个不重复的变体，音量随撞击力度走。"""
        if self.sound_volume <= 0 or self._sound_cooldown > 0:
            return
        if not self._chime_pool:
            return
        volume = chime_volume_from_impact(impact, self.sound_volume)
        idx = random.randint(0, len(self._chime_pool) - 1)
        if len(self._chime_pool) > 1:
            while idx == self._last_chime_idx:
                idx = random.randint(0, len(self._chime_pool) - 1)
        self._last_chime_idx = idx
        data = self._chime_pool[idx]
        self._sound_cooldown = CHIME_COOLDOWN
        try:
            sound_path = prepare_sound_file(data, volume)
            if self._sound_voices:
                idle = next((voice for voice in self._sound_voices if not voice.isPlaying()), None)
                if idle is None:
                    idle = self._sound_voices[self._sound_voice_index % len(self._sound_voices)]
                self._sound_voice_index = (self._sound_voices.index(idle) + 1) % len(self._sound_voices)
                idle.setSource(QUrl.fromLocalFile(sound_path))
                idle.setVolume(1.0)  # 音量已按撞击力度与主音量缩放进文件
                idle.play()
                return
            if winsound is None:
                return
            winsound.PlaySound(
                sound_path,
                winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT,
            )
        except Exception as error:
            print(f"[风铃] 播放声音失败: {error}", file=sys.stderr)

    def _set_volume(self, volume):
        self.sound_volume = min(
            (level for _label, level in VOLUME_LEVELS),
            key=lambda level: abs(level - float(volume)),
        )
        self.state["soundVolume"] = self.sound_volume
        self.state["soundEnabled"] = self.sound_volume > 0
        for voice in self._sound_voices:
            voice.setVolume(self.sound_volume)
        save_state(self.state)

    def _open_context_menu(self, global_pos):
        if self.menu and self.menu.isVisible():
            self.menu.close_menu()
        menu = QMenu(self)
        menu.setStyleSheet(f"""
            QMenu {{
                background: {C_BG}; color: {C_INK};
                border: 1px solid {C_BORDER}; border-radius: 10px;
                padding: 5px;
            }}
            QMenu::item {{ padding: 7px 18px; border-radius: 7px; }}
            QMenu::item:selected {{ background: #f1e3c8; }}
        """)
        volume_menu = menu.addMenu("声音大小")
        for label, volume in VOLUME_LEVELS:
            action = volume_menu.addAction(label)
            action.setCheckable(True)
            action.setChecked(self.sound_volume == volume)
            action.triggered.connect(
                lambda _checked=False, selected=volume: self._set_volume(selected)
            )
        menu.addSeparator()
        close_action = menu.addAction("关闭风铃")
        close_action.triggered.connect(QApplication.instance().quit)
        menu.exec(global_pos)

    def _set_hovered(self, value, direction=None, strength=None):
        value = bool(value)
        if value == self.hovered:
            return
        self.hovered = value
        if value:
            if direction in (-1.0, 1.0):
                self.gust_direction = direction
            if strength is not None:
                self.hover_strength = max(
                    MIN_WIND_STRENGTH,
                    min(float(strength), MAX_WIND_STRENGTH),
                )
            self.gust = self.hover_strength
            # Qt 屏幕坐标 Y 向下，正角让挂点下方的铃底向左；
            # 所以左来风用负角速度把铃推向右，右来风反之。速度越快，第一下越有力。
            self.velocity_bell += 11.0 * self.gust_direction * self.hover_strength
            self.velocity_taz -= 23.0 * self.gust_direction * self.hover_strength

    # ── 贴边吸附 ──
    def _snap(self):
        screen = self.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        margin = 26
        x, y = self.pos().x(), self.pos().y()
        w, h = self.width(), self.height()
        if x < geo.left() + margin:
            x = geo.left() + EDGE_INSET
        elif x + w > geo.right() - margin:
            x = geo.right() - w - EDGE_INSET + 1
        if y < geo.top() + margin:
            y = geo.top() + EDGE_INSET
        elif y + h > geo.bottom() - margin:
            y = geo.bottom() - h - EDGE_INSET + 1
        self.move(x, y)
        self._ensure_visible()

    # ── 菜单开关 ──
    def _prepare_menu_drag(self):
        """工具窗不抢风铃的鼠标；若面板已开，拖拽时把它一起带走。"""
        self._drag_menu_was_visible = bool(self.menu and self.menu.isVisible())
        return self._drag_menu_was_visible

    def _sync_dragged_menu(self):
        if not self._drag_menu_was_visible or self.menu is None:
            return
        self.menu.move_to_ball()
        if not self.menu.isVisible():
            self.menu.show()
            self.menu.raise_()

    def _toggle_menu(self):
        if self.menu and self.menu.isVisible():
            self.menu.close_menu()
            return
        self._open_menu()

    def _open_menu(self):
        if self.menu is None:
            self.menu = FenglingMenu(self)
        self.menu.prepare_for_show()
        self.menu.move_to_ball()
        self.menu.show()
        self.menu.raise_()
        self.menu.activateWindow()
        self.menu.refresh_async()

    def _do_visit(self, vtype, item_id):
        # 目标由插件端在点击瞬间重新判定，悬浮球不保存也不接受手动选择。
        # 恶作剧包含模型生成与会话忙碌重试，给它更完整的等待窗口，避免服务端已执行却被前端误报失败。
        timeout = 55 if vtype == "prank" else 20
        return api_post("/visit", {"type": vtype, "itemId": item_id}, timeout=timeout)


# ─────────────────────────────
#  动作菜单面板
# ─────────────────────────────
class FenglingMenu(QFrame):
    refresh_ready = pyqtSignal(object)

    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("panel")
        self.setFixedWidth(238)
        self.active_kind = "interact"
        self._actions_signature = None
        self._refreshing = False
        self.refresh_ready.connect(self._apply_async_refresh)
        self._build_ui()
        self.target_timer = QTimer(self)
        self.target_timer.setInterval(10000)
        self.target_timer.timeout.connect(self.refresh_async)
        QApplication.instance().applicationStateChanged.connect(
            self._on_app_state_changed
        )

    def _build_ui(self):
        self.setStyleSheet(f"""
            #panel {{
                background: transparent;
                border: none;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            QLabel {{ color: {C_INK}; background: transparent; }}
            QLabel#target {{
                color: {C_INK}; background: #f5ead5;
                border-radius: 10px; padding: 7px 10px;
                font-size: 13px; font-weight: 600;
            }}
            QLabel#sub {{ color: {C_SUB}; font-size: 12px; }}
            QLabel#feedback {{
                color: {C_INK}; font-size: 12px; font-weight: 600;
            }}
            QLabel#section {{
                color: {C_SUB}; font-size: 11px;
                padding: 5px 8px 2px 8px;
            }}
            QPushButton {{ color: {C_INK}; font-size: 13px; }}
            QPushButton#tab {{
                background: transparent; border: 1px solid #e7d2ac;
                border-radius: 10px; padding: 7px 0;
            }}
            QPushButton#tab:hover {{ background: #f4ead7; }}
            QPushButton#tab[active="true"] {{
                background: {C_MINT}; border-color: {C_MINT_DEEP};
                color: #46695f; font-weight: 600;
            }}
            QPushButton#action {{
                background: #fffdf8; border: 1px solid #ead9bb;
                text-align: left; padding: 7px 10px;
                border-radius: 10px;
            }}
            QPushButton#action:hover {{
                background: #f6ecd9; border-color: #dfbd86;
            }}
            QPushButton#action[prank="true"] {{
                background: #fff8f5; border-color: #edced5;
            }}
            QPushButton#action[prank="true"]:hover {{
                background: #f9e8eb; border-color: {C_PINK};
            }}
        """)

        root = QVBoxLayout(self)
        root.setContentsMargins(13, 12, 13, 11)
        root.setSpacing(8)

        # 目标只读展示；目标由插件端按当前最活跃会话自动刷新。
        self.lbl_target = QLabel("跟随当前对话 · 正在读取")
        self.lbl_target.setObjectName("target")
        root.addWidget(self.lbl_target)

        # 左键菜单只留两个直觉入口：互动、送礼。
        tabs = QHBoxLayout()
        tabs.setSpacing(6)
        self.btn_interact = QPushButton("互动")
        self.btn_gift = QPushButton("送礼")
        for button in (self.btn_interact, self.btn_gift):
            button.setObjectName("tab")
            button.setCursor(Qt.CursorShape.PointingHandCursor)
            tabs.addWidget(button)
        root.addLayout(tabs)

        self.actions_box = QVBoxLayout()
        self.actions_box.setSpacing(4)
        root.addLayout(self.actions_box)

        self.lbl_feedback = QLabel("")
        self.lbl_feedback.setObjectName("feedback")
        self.lbl_feedback.setWordWrap(True)
        root.addWidget(self.lbl_feedback)

        self.lbl_jar = QLabel("")
        self.lbl_jar.setObjectName("sub")
        self.lbl_jar.setAlignment(Qt.AlignmentFlag.AlignRight)
        root.addWidget(self.lbl_jar)

        self.btn_interact.clicked.connect(lambda: self._render_actions("interact"))
        self.btn_gift.clicked.connect(lambda: self._render_actions("gift"))

    # ── 先显示缓存，再后台刷新，打开面板不被网络请求卡住 ──
    def prepare_for_show(self):
        self._flash("")
        self._update_target_label()
        self._render_actions(self.active_kind)
        self._update_jar()

    def refresh_async(self):
        if self._refreshing:
            return
        self._refreshing = True

        def worker():
            payload = {"catalog": None, "targetLoaded": False, "target": None}
            try:
                data = api_get("/catalog", timeout=4)
                if data.get("ok"):
                    payload["catalog"] = data
            except Exception:
                pass
            try:
                data = api_get("/target", timeout=4)
                if data.get("ok"):
                    payload["targetLoaded"] = True
                    payload["target"] = data.get("target")
            except Exception:
                pass
            try:
                self.refresh_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="fengling-refresh").start()

    def _apply_async_refresh(self, payload):
        self._refreshing = False
        catalog = payload.get("catalog")
        if catalog is not None:
            self.ball.catalog = catalog
        if payload.get("targetLoaded"):
            self.ball.target = payload.get("target")
        self._update_target_label()
        self._render_actions(self.active_kind)
        self._update_jar()

    # 同步版本保留给自动测试和显式刷新路径。
    def refresh(self):
        self._flash("")
        try:
            data = api_get("/catalog", timeout=4)
            if data.get("ok"):
                self.ball.catalog = data
        except Exception:
            self.ball.catalog = None
        self._refresh_target()
        self._render_actions(self.active_kind)
        self._update_jar()

    def _refresh_target(self):
        try:
            data = api_get("/target", timeout=4)
            self.ball.target = data.get("target") if data.get("ok") else None
        except Exception:
            self.ball.target = None
        self._update_target_label()

    def _update_target_label(self):
        target = self.ball.target
        if not target:
            self.lbl_target.setText("跟随当前对话 · 暂未找到")
            return
        self.lbl_target.setText(
            f"跟随当前对话 · {target.get('name', target.get('id', '?'))}"
        )

    def _update_jar(self):
        cat = self.ball.catalog
        if cat and "jar" in cat:
            self.lbl_jar.setText(f"光粒 {cat.get('jar', 0)}")
        else:
            self.lbl_jar.setText("光粒 --")

    def _set_active_tab(self, kind):
        self.active_kind = kind
        for button, button_kind in (
            (self.btn_interact, "interact"),
            (self.btn_gift, "gift"),
        ):
            button.setProperty("active", button_kind == kind)
            button.style().unpolish(button)
            button.style().polish(button)

    # ── 渲染动作列表 ──
    def _render_actions(self, kind):
        cat = self.ball.catalog or {}
        if kind == "gift":
            sections = [(None, cat.get("gifts") or [], False)]
        else:
            sections = [
                ("日常互动", cat.get("interacts") or [], False),
                ("调皮一下", cat.get("pranks") or [], True),
            ]

        signature = (
            kind,
            tuple(
                (
                    title,
                    is_prank,
                    tuple(
                        (it.get("id"), it.get("name"), it.get("icon"), it.get("price"), it.get("type"))
                        for it in items
                    ),
                )
                for title, items, is_prank in sections
            ),
        )
        self._set_active_tab(kind)
        if signature == self._actions_signature:
            self._update_jar()
            return
        self._actions_signature = signature

        while self.actions_box.count():
            item = self.actions_box.takeAt(0)
            w = item.widget()
            if w:
                w.hide()
                w.deleteLater()

        has_items = False
        for title, items, is_prank in sections:
            if not items:
                continue
            has_items = True
            if title:
                section = QLabel(title)
                section.setObjectName("section")
                self.actions_box.addWidget(section)
            for it in items:
                price = it.get("price")
                label = it.get("name", "?")
                icon = it.get("icon", "")
                text = (f"{icon}  " if icon else "") + label
                if price:
                    text += f"  ·  {price} 光粒"
                btn = QPushButton(text)
                btn.setObjectName("action")
                btn.setProperty("prank", is_prank)
                btn.setCursor(Qt.CursorShape.PointingHandCursor)
                item_id = it.get("id")
                vtype = it.get("type", kind)
                btn.clicked.connect(
                    lambda _=False, vt=vtype, iid=item_id: self._do_action(vt, iid)
                )
                self.actions_box.addWidget(btn)

        if not has_items:
            hint = QLabel("还没拿到选项，稍后再点一次")
            hint.setObjectName("sub")
            self.actions_box.addWidget(hint)

        self._update_jar()
        if self.isVisible():
            self.keep_current_position()

    def _set_busy(self, busy):
        for button in self.findChildren(QPushButton):
            button.setEnabled(not busy)

    def _do_action(self, vtype, item_id):
        self._set_busy(True)
        self._flash("正在送出…")
        self.lbl_feedback.repaint()
        try:
            res = self.ball._do_visit(vtype, item_id)
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode("utf-8"))
                res = {"success": False, "error": body.get("error", f"出错了 ({e.code})")}
            except Exception:
                res = {"success": False, "error": f"出错了 ({e.code})"}
        except TimeoutError:
            res = {"success": False, "error": "处理得有点久，可能已经送达，先别重复点"}
        except Exception:
            res = {"success": False, "error": "连不上闲不住，看看它开着没"}
        finally:
            self._set_busy(False)

        if res.get("success") or res.get("ok"):
            if res.get("target"):
                self.ball.target = res.get("target")
                self._update_target_label()
            self._flash("送达了")
            self._refresh_jar()
        else:
            self._flash(res.get("error", "发送失败"))

    def _refresh_jar(self):
        try:
            data = api_get("/catalog", timeout=4)
            if data.get("ok"):
                self.ball.catalog = data
                self._update_jar()
        except Exception:
            pass

    def _flash(self, text):
        self.lbl_feedback.setText(text)

    # ── 面板定位（球旁边，空间不够翻边） ──
    def keep_current_position(self):
        """内容高度变化时守住当前左上角，只在越界时轻推回屏幕。"""
        self.adjustSize()
        screen = self.ball.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        x = max(geo.left(), min(self.x(), geo.right() - self.width() + 1))
        y = max(geo.top(), min(self.y(), geo.bottom() - self.height() + 1))
        self.move(x, y)

    def move_to_ball(self):
        self.adjustSize()
        b = self.ball
        screen = b.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        bw = b.width()
        x = b.x() - self.width() - 8
        if x < geo.left():
            x = b.x() + bw + 8
        y = b.y() + bw // 2 - self.height() // 2
        y = max(geo.top(), min(y, geo.bottom() - self.height()))
        self.move(x, y)

    def close_menu(self):
        self.hide()

    def showEvent(self, event):
        super().showEvent(event)
        self.target_timer.start()

    def hideEvent(self, event):
        self.target_timer.stop()
        super().hideEvent(event)

    def focusOutEvent(self, event):
        super().focusOutEvent(event)
        # 稍等同一次鼠标按下到达风铃，避免 Tool 焦点切换先一步闪关。
        QTimer.singleShot(30, self._hide_after_focus_loss)

    def _on_app_state_changed(self, state):
        if state != Qt.ApplicationState.ApplicationActive and self.isVisible():
            self.hide()

    def _hide_after_focus_loss(self):
        if not self.isVisible():
            return
        # 点击风铃准备拖拽时，焦点会离开面板，但面板应继续跟随。
        if self.ball._drag is not None:
            return
        self.hide()

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QColor(C_BORDER))
        painter.setBrush(QColor(C_BG))
        painter.drawRoundedRect(self.rect().adjusted(1, 1, -1, -1), 20, 20)
        painter.end()

    def mousePressEvent(self, e):
        # 面板内点击不关闭
        super().mousePressEvent(e)


# ─────────────────────────────
#  入口
# ─────────────────────────────
def main():
    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    ball = FenglingBall()
    ball.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
