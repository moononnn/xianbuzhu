# -*- coding: utf-8 -*-
"""
融合球 · 风铃 × 解语花
======================

一根紧凑的樱花树枝挂住风铃，视觉构图按参考图重排；两边原版的
局部物理和交互演出保留：

- 风铃：来风方向、铃身/短册错拍、铃舌弹簧碰壁、柔线弧垂、真实碰撞音
- 解语花：枝条微风、光标掠过、按压蓄力与松手回弹、碎瓣粒子
- 融合球：透明无边框置顶窗，拖拽、左键面板、右键全局菜单

这个文件由闲不住融合协调器拉起：业务按钮通过两个插件的本地代理工作；
左键面板直接复用两个正式版布局，朗读窗口由两页共用同一个实例。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request

# 让原版风铃音频积木可以直接复用，不把它复制成第二份。
PLUGINS = os.environ.get(
    "HANA_PLUGINS_DIR",
    os.path.join(os.path.expanduser("~"), ".hanako", "plugins"),
)
ZHUJIAN_DIR = os.path.join(PLUGINS, "jiegehua", "python")
FENGLING_DIR = os.path.join(PLUGINS, "work-visit", "python")
if FENGLING_DIR not in sys.path:
    sys.path.insert(0, FENGLING_DIR)

FENGLING_API = os.environ.get("FUSION_FENGLING_API", "http://127.0.0.1:18902")
FENGLING_TOKEN = os.environ.get("FUSION_FENGLING_TOKEN", "")
JIEGEHUA_API = os.environ.get("FUSION_JIEGEHUA_API", "http://127.0.0.1:18903")
JIEGEHUA_TOKEN = os.environ.get("FUSION_JIEGEHUA_TOKEN", "")
COORDINATOR_API = os.environ.get("FUSION_COORDINATOR_API", FENGLING_API)
COORDINATOR_TOKEN = os.environ.get("FUSION_COORDINATOR_TOKEN", FENGLING_TOKEN)
INHERITED_PANEL = os.environ.get("FUSION_INHERITED_PANEL", "none")

# 复用两边正式版的面板布局和朗读窗口；业务请求仍走各自本地代理。
os.environ.setdefault("XIANBUZHU_API", FENGLING_API)
os.environ.setdefault("XIANBUZHU_TOKEN", FENGLING_TOKEN)
os.environ.setdefault("JIEGEHUA_API", JIEGEHUA_API)
os.environ.setdefault("JIEGEHUA_API_TOKEN", JIEGEHUA_TOKEN)


def _load_local_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载融合面板模块：{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_ORIGINAL_FENGLING = _load_local_module(
    "fusion_original_fengling_app", os.path.join(FENGLING_DIR, "fengling_app.py")
)
_ORIGINAL_ZHUJIAN = _load_local_module(
    "fusion_original_zhujian_app", os.path.join(ZHUJIAN_DIR, "zhujian_app.py")
)
OriginalFenglingMenu = _ORIGINAL_FENGLING.FenglingMenu
OriginalZhujianMenu = _ORIGINAL_ZHUJIAN.ZhujianMenu
OriginalReadPanel = _ORIGINAL_ZHUJIAN.ReadPanel

try:
    import winsound
except ImportError:  # pragma: no cover - 非 Windows 运行时兜底
    winsound = None

try:
    import fengling_dsp
except ImportError:  # pragma: no cover - 只影响声音，不影响视觉
    fengling_dsp = None

from PyQt6.QtCore import (
    Qt,
    QEvent,
    QPoint,
    QPointF,
    QRectF,
    QPropertyAnimation,
    QTimer,
    QUrl,
    pyqtSignal,
)
from PyQt6.QtGui import (
    QActionGroup,
    QColor,
    QCursor,
    QImage,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
)
from PyQt6.QtSvg import QSvgRenderer
from PyQt6.QtWidgets import (
    QApplication,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMenu,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

try:
    from PyQt6.QtMultimedia import QSoundEffect
except Exception:  # pragma: no cover - 只影响声音，不影响视觉
    QSoundEffect = None


# ─────────────────────────────────────────────────────────────
# 构图：按参考图收紧，不再用 v8 那种过大的画布和多余爱心。
# 融合球保持轻巧，但比原版解语花略放大一档；绘制内容在旧设计坐标中
# 统一缩放后放进这个窗口，避免协调器仍拉起一个显眼的大球。
DESIGN_BALL_W = 170
DESIGN_BALL_H = 145
BALL_W = 88
BALL_H = 88
# 内容放大取景：窗口保持 88×88，把 170×145 设计稿里的内容放大 CONTENT_ZOOM 倍，
# 并以内容中心 (CONTENT_CX, CONTENT_CY) 对齐窗口中心。
# 树枝两端会自然裁出窗口，形成主枝横穿的满铺感（同解语花主枝横穿被裁的手法）。
CONTENT_ZOOM = 1.30
CONTENT_CX, CONTENT_CY = 85.0, 76.0
SCENE_SCALE = min(BALL_W / DESIGN_BALL_W, BALL_H / DESIGN_BALL_H) * CONTENT_ZOOM
SCENE_OFFSET_X = BALL_W / 2.0 - CONTENT_CX * SCENE_SCALE
SCENE_OFFSET_Y = BALL_H / 2.0 - CONTENT_CY * SCENE_SCALE
SVG_SIZE = 400
RENDER_SCALE = 3
RENDER_SIZE = SVG_SIZE * RENDER_SCALE

# 花枝素材的主枝横向压缩到一个小挂件里；右下细枝自然接到花朵。
BRANCH_SIZE = 150.0
BRANCH_CX, BRANCH_CY = 85.0, 76.0
BRANCH_PIVOT = (15.0, 55.0)
BRANCH_BASE_ANGLE = -2.0  # 参考图的轻微上扬，动态角度再叠加在此基础上
FLOWER_SIZE = 30.0
FLOWER_ANGLE = 0.0
LEAF_SIZE = 52.0
LEAF_CX, LEAF_CY = 43.0, 38.0


def svg_to_canvas(sx: float, sy: float) -> tuple[float, float]:
    scale = BRANCH_SIZE / SVG_SIZE
    return (
        BRANCH_CX + (float(sx) - 200.0) * scale,
        BRANCH_CY + (float(sy) - 200.0) * scale,
    )


FLOWER_CX, FLOWER_CY = svg_to_canvas(256.0, 231.0)

# 风铃挂点压在主枝左段，完整铃串向下垂，不再把铃身塞进枝条中间。
HOOK_CX, HOOK_CY = 51.0, 49.0
BELL_H = 90.0
BELL_VIEW_HEIGHT = 279.0  # bell.svg 从 y=37 到短册底部约 316
BELL_PIVOT = (200 * RENDER_SCALE, 36 * RENDER_SCALE)
PAPER_PIVOT = (200 * RENDER_SCALE, 246 * RENDER_SCALE)
LINK_TOP = (200 * RENDER_SCALE, 112 * RENDER_SCALE)
CLAPPER_LENGTH = 74 * RENDER_SCALE
PAPER_LINE_LENGTH = 60 * RENDER_SCALE
CLAPPER_RX = 14
CLAPPER_RY = 11

# 风铃原版参数
MIN_WIND_STRENGTH = 0.62
MAX_WIND_STRENGTH = 1.45
FULL_GUST_SPEED = 1200.0
CLAPPER_LIMIT = 12.0
CLAPPER_SPRING = 20.0
CLAPPER_DAMP = 3.2
CHIME_MIN_IMPACT = 7.0
CHIME_COOLDOWN = 0.10
# 送达响铃：给铃舌的真实晃动冲量（度/秒），由物理撞壁触发 _play_chime（因动而声）。
DELIVERY_KICK = 200.0
DELIVERY_RING_WINDOW_S = 2.0  # 送达响铃窗口：期内允许非悬停撞壁发声
CHIME_VOICE_COUNT = 6
CHIME_SLICE_POOL_SIZE = 12
VOLUME_DEFAULT = 0.65
# 新心意到达时只发出送达提示音；是否查看心意由用户点击融合球决定。

# 融合窗口内的可见命中区：只命中枝、叶、花、铃串，不吃透明四角。
HOVER_ENTER_MARGIN = 4.0
HOVER_EXIT_MARGIN = 12.0
HOVER_LEAVE_DELAY = 0.24

# 解语花原版参数
HOVER_PETAL_INTERVAL = (0.26, 0.52)
PRESS_PETAL_COUNT = 11
RELEASE_PETAL_COUNT = 16
SWEEP_FADE_START = 24.0
SWEEP_MIN_SPEED = 45.0
SWEEP_PETAL_SPEED = 210.0
MAX_PETAL_PARTICLES = 48

# 手帐风面板颜色，控制面板不喧宾夺主。
C_BG = "#fffdf8"
C_BORDER = "#e5cba0"
C_MINT = "#b9dfd0"
C_MINT_DEEP = "#6d9f8d"
C_PINK = "#f2a0b5"
C_INK = "#6e5a40"
C_SUB = "#a08a68"


# ─────────────────────────────────────────────────────────────
# 通用运动与命中函数：直接沿用两边原版的物理语义
# ─────────────────────────────────────────────────────────────
def clamp_position(x, y, width, height, left, top, right, bottom, inset=16):
    min_x = left + inset
    min_y = top + inset
    max_x = max(min_x, right - width - inset + 1)
    max_y = max(min_y, bottom - height - inset + 1)
    return (
        max(min_x, min(int(x), max_x)),
        max(min_y, min(int(y), max_y)),
    )


def wind_strength_from_speed(speed):
    ratio = max(0.0, min(float(speed) / FULL_GUST_SPEED, 1.0))
    smooth = ratio * ratio * (3.0 - 2.0 * ratio)
    return MIN_WIND_STRENGTH + (MAX_WIND_STRENGTH - MIN_WIND_STRENGTH) * smooth


def calculate_entry_wind_bell(previous_x, previous_y, current_x, current_y, elapsed, center_x):
    dx = float(current_x) - float(previous_x)
    dy = float(current_y) - float(previous_y)
    seconds = max(float(elapsed), 1.0 / 240.0)
    speed = math.hypot(dx, dy) / seconds
    if float(previous_x) < float(center_x) - 2.0:
        direction = -1.0
    elif float(previous_x) > float(center_x) + 2.0:
        direction = 1.0
    elif abs(dx) >= 2.0:
        direction = -1.0 if dx > 0 else 1.0
    else:
        direction = -1.0 if float(current_x) <= float(center_x) else 1.0
    return direction, speed, wind_strength_from_speed(speed)


def sweep_strength_from_speed(speed):
    speed = max(0.0, float(speed))
    if speed <= SWEEP_FADE_START:
        return 0.0
    fade_ratio = max(0.0, min((speed - SWEEP_FADE_START) / (SWEEP_MIN_SPEED * 2.0), 1.0))
    fade = fade_ratio * fade_ratio * (3.0 - 2.0 * fade_ratio)
    return wind_strength_from_speed(speed) * fade


def calculate_entry_wind_flower(previous_x, previous_y, current_x, current_y, elapsed, center_x):
    dx = float(current_x) - float(previous_x)
    dy = float(current_y) - float(previous_y)
    seconds = max(float(elapsed), 1.0 / 240.0)
    speed = math.hypot(dx, dy) / seconds
    if abs(dx) >= abs(dy) * 0.42 and abs(dx) >= 0.55:
        direction = -1.0 if dx > 0.0 else 1.0
    elif abs(dy) >= 0.55:
        direction = -1.0 if dy > 0.0 else 1.0
    else:
        direction = -1.0 if float(current_x) <= float(center_x) else 1.0
    return direction, sweep_strength_from_speed(speed)


def calculate_cursor_sweep(previous_x, previous_y, current_x, current_y, elapsed):
    dx = float(current_x) - float(previous_x)
    dy = float(current_y) - float(previous_y)
    distance = math.hypot(dx, dy)
    seconds = max(float(elapsed), 1.0 / 240.0)
    speed = distance / seconds
    if speed < SWEEP_FADE_START or distance < 0.55:
        return 0.0, 0.0, speed, 0.0, 0.0
    if abs(dx) >= abs(dy) * 0.42:
        direction = -1.0 if dx > 0.0 else 1.0
    else:
        direction = -1.0 if dy > 0.0 else 1.0
    strength = sweep_strength_from_speed(speed)
    return direction, strength, speed, dx / seconds, dy / seconds


def scene_to_widget(x, y):
    return (
        SCENE_OFFSET_X + float(x) * SCENE_SCALE,
        SCENE_OFFSET_Y + float(y) * SCENE_SCALE,
    )


def widget_to_scene(x, y):
    return (
        (float(x) - SCENE_OFFSET_X) / SCENE_SCALE,
        (float(y) - SCENE_OFFSET_Y) / SCENE_SCALE,
    )


def point_in_bell_zone(x, y, margin=0.0):
    x = float(x)
    y = float(y)
    m = max(0.0, float(margin))
    zones = (
        (HOOK_CX - 19.0, HOOK_CY - 11.0, HOOK_CX + 19.0, HOOK_CY + 28.0),
        (HOOK_CX - 17.0, HOOK_CY + 18.0, HOOK_CX + 17.0, HOOK_CY + BELL_H - 5.0),
    )
    return any(left - m <= x <= right + m and top - m <= y <= bottom + m for left, top, right, bottom in zones)


def point_in_flower_zone(x, y, margin=0.0):
    x = float(x)
    y = float(y)
    m = max(0.0, float(margin))
    # 主枝的实际可见区域是从左上向右上抬的带状区域；细枝也算花枝的一部分。
    on_main_branch = -m <= x <= DESIGN_BALL_W + m and 26.0 - m <= y <= 59.0 + m
    on_side_branch = (
        ((x - 94.0) / (30.0 + m)) ** 2
        + ((y - 70.0) / (37.0 + m)) ** 2
        <= 1.0
    )
    flower_rx = 15.5 + m
    flower_ry = 14.0 + m
    on_flower = (
        ((x - FLOWER_CX) / flower_rx) ** 2
        + ((y - FLOWER_CY) / flower_ry) ** 2
        <= 1.0
    )
    leaf_rx = 18.0 + m
    leaf_ry = 14.0 + m
    on_leaf = (
        ((x - LEAF_CX) / leaf_rx) ** 2
        + ((y - LEAF_CY) / leaf_ry) ** 2
        <= 1.0
    )
    return on_main_branch or on_side_branch or on_flower or on_leaf


def point_in_visual_zone(x, y, margin=0.0):
    return point_in_bell_zone(x, y, margin) or point_in_flower_zone(x, y, margin)


def point_in_flower_interaction_zone(x, y, margin=0.0):
    """铃环压在主枝上时优先归风铃，避免点铃也触发花瓣按压。"""
    return point_in_flower_zone(x, y, margin) and not point_in_bell_zone(x, y, margin)


def segment_crosses_visual_zone(x1, y1, x2, y2, margin=0.0):
    distance = math.hypot(float(x2) - float(x1), float(y2) - float(y1))
    steps = max(1, min(int(math.ceil(distance / 3.0)), 64))
    for index in range(steps + 1):
        ratio = index / steps
        x = float(x1) + (float(x2) - float(x1)) * ratio
        y = float(y1) + (float(y2) - float(y1)) * ratio
        if point_in_visual_zone(x, y, margin):
            return True
    return False


def resolve_hover_state(hovered, x, y, outside_elapsed, frame_elapsed):
    margin = HOVER_EXIT_MARGIN if hovered else HOVER_ENTER_MARGIN
    if point_in_visual_zone(x, y, margin):
        return True, 0.0
    if not hovered:
        return False, 0.0
    outside_elapsed += max(float(frame_elapsed), 0.0)
    if outside_elapsed >= HOVER_LEAVE_DELAY:
        return False, 0.0
    return True, outside_elapsed


def resolve_clapper_collision(angle, velocity, limit=CLAPPER_LIMIT, restitution=0.34):
    if abs(angle) <= limit:
        return angle, velocity, 0.0
    side = 1.0 if angle > 0 else -1.0
    outward = velocity * side > 0
    impact = abs(velocity) if outward else 0.0
    bounced = -velocity * restitution if outward else velocity
    return side * limit, bounced, impact


def should_attempt_chime(impact, hovered, cooldown=0.0, min_impact=CHIME_MIN_IMPACT):
    return bool(hovered and cooldown <= 0.0 and impact >= min_impact)


def chime_volume_from_impact(impact, base, min_impact=CHIME_MIN_IMPACT):
    if impact <= min_impact:
        return base * 0.55
    strength = min(1.0, (impact - min_impact) / (40.0 - min_impact))
    return base * (0.55 + 0.45 * strength)


def linkage_points(clapper_angle, paper_angle):
    top = QPointF(*LINK_TOP)
    clapper_rad = math.radians(float(clapper_angle))
    clapper = QPointF(
        top.x() + math.sin(clapper_rad) * CLAPPER_LENGTH,
        top.y() + math.cos(clapper_rad) * CLAPPER_LENGTH,
    )
    paper_rad = math.radians(float(paper_angle))
    knot = QPointF(
        clapper.x() + math.sin(paper_rad) * PAPER_LINE_LENGTH,
        clapper.y() + math.cos(paper_rad) * PAPER_LINE_LENGTH,
    )
    return top, clapper, knot


def linkage_curve_controls(top, clapper, knot, bend=0.0):
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


def cursor_wind_components(velocity_x, velocity_y, strength, direction):
    velocity_x = float(velocity_x)
    velocity_y = float(velocity_y)
    axis_total = max(abs(velocity_x) + abs(velocity_y), 1.0)
    horizontal = float(direction) * float(strength) * abs(velocity_x) / axis_total
    vertical_sign = 1.0 if velocity_y > 0.0 else -1.0 if velocity_y < 0.0 else 0.0
    vertical = vertical_sign * float(strength) * abs(velocity_y) / axis_total
    return horizontal, vertical


def component_motion(t, bloom, gust, direction, rebound_pulse=0.0):
    bloom = max(0.0, min(float(bloom), 1.0))
    gust = max(0.0, float(gust))
    direction = -1.0 if float(direction) < 0.0 else 1.0
    rebound_pulse = max(0.0, min(float(rebound_pulse), 1.0))
    branch = direction * gust * 1.15 + bloom * 0.45 * math.sin(float(t) * 3.1)
    flower = direction * gust * 0.72 + bloom * 0.78 * math.sin(float(t) * 3.8 + 0.48)
    leaf = direction * gust * 4.8 + bloom * 3.2 * math.sin(float(t) * 4.15 + 1.18)
    flower += direction * rebound_pulse * 1.25
    leaf += direction * rebound_pulse * 7.5
    return branch, flower, leaf


def advance_press_spring(amount, velocity, pressed, dt):
    dt = max(0.0, min(float(dt), 0.05))
    target = 1.0 if pressed else 0.0
    stiffness = 82.0 if pressed else 118.0
    damping = 16.0 if pressed else 10.5
    acceleration = (target - float(amount)) * stiffness - float(velocity) * damping
    velocity = float(velocity) + acceleration * dt
    amount = float(amount) + velocity * dt
    amount = max(-0.34, min(amount, 1.08))
    return amount, velocity


def rotate_point_around(x, y, pivot_x, pivot_y, angle_degrees):
    radians = math.radians(float(angle_degrees))
    dx = float(x) - float(pivot_x)
    dy = float(y) - float(pivot_y)
    cosine = math.cos(radians)
    sine = math.sin(radians)
    return (
        float(pivot_x) + dx * cosine - dy * sine,
        float(pivot_y) + dx * sine + dy * cosine,
    )


def petal_count_from_sweep_speed(speed):
    speed = max(0.0, float(speed))
    if speed < SWEEP_PETAL_SPEED:
        return 0
    if speed < 560.0:
        return 3
    if speed < 920.0:
        return 5
    if speed < 1500.0:
        return 7
    return 9


def proxy_request(base_url, token, route, method="GET", payload=None, timeout=5):
    """融合球只通过两个插件公开的本地代理取业务，不碰 Hana 内部源码。"""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
        headers["X-Jiegehua-Token"] = token
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        str(base_url).rstrip("/") + route,
        data=data,
        headers=headers,
        method=method,
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def prepare_sound_file(data, volume, cache_dir=None):
    """复用风铃原版的文件播放方式，避免 winsound 内存异步播放失效。"""
    if fengling_dsp is not None:
        data = fengling_dsp.scale_wav_volume(data, volume)
    cache_dir = cache_dir or os.path.join(
        os.path.expanduser("~"), ".hanako", "data", "fusion-ball", "audio-cache"
    )
    digest = hashlib.sha1(data).hexdigest()[:20]
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, f"{digest}.wav")
    if not os.path.exists(path):
        temp_path = path + ".tmp"
        with open(temp_path, "wb") as sound_file:
            sound_file.write(data)
        os.replace(temp_path, path)
    return path


def resolve_fusion_sound_volume(state=None):
    """融合球优先读取风铃的持久化档位，环境变量只作旧启动链兜底。"""
    state = _ORIGINAL_FENGLING.load_state() if state is None else state
    if isinstance(state, dict) and (
        "soundVolume" in state or "soundEnabled" in state
    ):
        return _ORIGINAL_FENGLING.resolve_saved_volume(state)
    raw = os.environ.get("FUSION_SOUND_VOLUME")
    if raw is None:
        return 0.0
    return _ORIGINAL_FENGLING.resolve_saved_volume({"soundVolume": raw})


def persist_fusion_sound_volume(volume):
    """把融合球的开关动作写回风铃同一份状态文件。"""
    state = _ORIGINAL_FENGLING.load_state()
    normalized = _ORIGINAL_FENGLING.resolve_saved_volume({"soundVolume": volume})
    state["soundVolume"] = normalized
    state["soundEnabled"] = normalized > 0
    _ORIGINAL_FENGLING.save_state(state)
    return normalized


def menu_tree_contains_global(menu, global_pos):
    """判断主菜单或任意可见二级 QMenu 是否命中全局坐标。"""
    if menu is None or not menu.isVisible():
        return False
    candidates = (menu, *menu.findChildren(QMenu))
    return any(
        candidate.isVisible()
        and candidate.rect().contains(candidate.mapFromGlobal(global_pos))
        for candidate in candidates
    )


# ─────────────────────────────────────────────────────────────
# 融合球主体
# ─────────────────────────────────────────────────────────────
class FusionBall(QWidget):
    """融合球：一根树枝，两套原版动效，共用正式版弹窗能力。"""

    ask_ready = pyqtSignal(object)
    heart_ready = pyqtSignal(object)

    def __init__(self):
        super().__init__(None)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setFixedSize(BALL_W, BALL_H)

        self.pix_branch = self._render_svg(os.path.join(ZHUJIAN_DIR, "yinghua-branch.svg"))
        self.pix_flower = self._render_svg(os.path.join(ZHUJIAN_DIR, "yinghua-ball.svg"))
        self.pix_leaf = self._render_svg(os.path.join(ZHUJIAN_DIR, "yinghua-leaf.svg"))
        self.pix_bell = self._render_svg(os.path.join(FENGLING_DIR, "fengling-bell.svg"))
        self.pix_taz = self._render_svg(os.path.join(FENGLING_DIR, "fengling-tanzaku.svg"))

        self.t = 0.0
        self._last_ts = time.monotonic()
        cursor = QCursor.pos()
        self._cursor_sample = (cursor.x(), cursor.y(), self._last_ts)

        # 风铃物理：铃身、短册、铃舌三套不同重量。
        self.angle_bell = 0.0
        self.angle_taz = 0.0
        self.angle_clapper = 0.0
        self.velocity_bell = 0.0
        self.velocity_taz = 0.0
        self.velocity_clapper = 0.0
        self._sound_cooldown = 0.0
        self._delivery_ring_until = 0.0  # 送达响铃窗口截止；期内撞壁允许非悬停发声
        self.sound_volume = resolve_fusion_sound_volume()
        self._chime_pool = []
        self._last_chime_idx = -1
        self._sound_voices = []
        self._sound_voice_index = 0
        self._init_chime_pool()
        self._init_sound_voices()

        # 解语花物理：枝、花、叶相位错开；按压另有弹簧状态。
        self.angle = 0.0
        self.angular_velocity = 0.0
        self.hover_wind = 0.0
        self.gust = 0.0
        self.gust_direction = 1.0
        self.hover_strength = 1.0
        self.cursor_wind = 0.0
        self.cursor_lift = 0.0
        self.cursor_velocity = (0.0, 0.0)
        self.bloom = 0.0
        self.pressed = False
        self.press_amount = 0.0
        self.press_velocity = 0.0
        self.petal_particles = []
        self._petal_rng = random.Random()
        self._hover_petal_timer = self._petal_rng.uniform(*HOVER_PETAL_INTERVAL)
        self._sweep_petal_cooldown = 0.0
        self.flower_hovered = False
        # 解语花提问挂起时的持续提示演出，等真实面板接入后由 set_ask_emitting() 驱动。
        self.ask_emitting = False
        self._ask_petal_timer = 0.0
        self._ask_bounce_timer = 0.0

        # 正式版面板适配所需的共享业务状态；融合进程只复用 UI，业务仍走代理。
        self.state = _ORIGINAL_ZHUJIAN.load_state()
        # 融合态沿用原版默认的左侧面板；靠近屏幕左缘时由原版定位逻辑翻到右侧。
        self.state["panel_side"] = "left"
        self.state["fusionPanel"] = "none"
        _ORIGINAL_ZHUJIAN.save_state(self.state)
        self.action = self.state.get("action") or "copy"
        self.cached = None
        self.catalog = None
        self.target = None
        self.current_heart = None
        self.heart_queue = []
        self._heart_dismissed_ids = set()
        self._heart_poll_elapsed = 5.0
        self._heart_polling = False
        self._heart_seeded = False
        self._heart_seen_ids = set()
        self.target_name = ""
        self.target_title = ""
        self.target_mode = "auto"
        self.pinned_target = None
        self.theme_mode = _ORIGINAL_ZHUJIAN.read_hana_theme_mode()
        self.read_panel = None

        # 交互状态
        self.hovered = False
        self._hover_exit_elapsed = 0.0
        self._drag = None
        self._press_global = None
        self._moved = False
        self._press_flower = False
        self._drag_menu_was_visible = False
        self._drag_read_was_visible = False
        self._drag_menu_start = None
        self._drag_read_start = None
        self._drag_ball_start = None
        self.menu = None
        self.context_menu = None
        self._event_filter_installed = False
        self._closing = False
        app = QApplication.instance()
        if app is not None:
            app.installEventFilter(self)
            self._event_filter_installed = True
        self._ask_poll_inflight = False
        self.ask_ready.connect(self._apply_ask_payload)
        self.heart_ready.connect(self._apply_heart_poll)

        self.ask_poll_timer = QTimer(self)
        self.ask_poll_timer.timeout.connect(self._poll_ask_async)
        self.ask_poll_timer.start(_ORIGINAL_ZHUJIAN.ASK_POLL_INTERVAL_MS)

        timer = QTimer(self)
        timer.timeout.connect(self._tick)
        timer.start(16)

    # ── 资源 ──
    @staticmethod
    def _render_svg(path):
        pix = QPixmap(RENDER_SIZE, RENDER_SIZE)
        pix.fill(Qt.GlobalColor.transparent)
        try:
            renderer = QSvgRenderer(path)
            if not renderer.isValid():
                print(f"[融合球] SVG 无效: {path}", file=sys.stderr)
                return QPixmap()
            painter = QPainter(pix)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing)
            painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
            # 不传 QRect，避开 PyQt6 QSvgRenderer.render(QRect) 的崩溃坑。
            renderer.render(painter)
            painter.end()
        except Exception as error:
            print(f"[融合球] SVG 渲染失败: {path}: {error}", file=sys.stderr)
            return QPixmap()
        return pix

    # ── 动画帧 ──
    def _tick(self):
        now = time.monotonic()
        frame_elapsed = max(now - self._last_ts, 0.0)
        dt = min(frame_elapsed, 0.05)
        self._last_ts = now
        self.t += dt

        # 融合态继续沿用风铃的心意信箱轮询；新心意只播放提示音，用户点击融合球后查看。
        self._heart_poll_elapsed += dt
        if self._heart_poll_elapsed >= 5.0:
            self._heart_poll_elapsed = 0.0
            self._poll_hearts_async()

        cursor_global = QCursor.pos()
        cursor_widget = self.mapFromGlobal(cursor_global)
        cursor_x, cursor_y = widget_to_scene(cursor_widget.x(), cursor_widget.y())
        px, py, previous_ts = self._cursor_sample
        previous_widget = self.mapFromGlobal(QPoint(int(px), int(py)))
        previous_x, previous_y = widget_to_scene(previous_widget.x(), previous_widget.y())
        cursor_hovered, self._hover_exit_elapsed = resolve_hover_state(
            self.hovered,
            cursor_x,
            cursor_y,
            self._hover_exit_elapsed,
            frame_elapsed,
        )
        crossed_visible = segment_crosses_visual_zone(
            previous_x, previous_y, cursor_x, cursor_y, HOVER_ENTER_MARGIN
        )
        if crossed_visible:
            cursor_hovered = True
            self._hover_exit_elapsed = 0.0

        flower_now = point_in_flower_interaction_zone(
            cursor_x,
            cursor_y,
            HOVER_EXIT_MARGIN if self.flower_hovered else HOVER_ENTER_MARGIN,
        )
        flower_crossed = segment_crosses_visual_zone(
            previous_x, previous_y, cursor_x, cursor_y, HOVER_ENTER_MARGIN
        ) and point_in_flower_interaction_zone(cursor_x, cursor_y, HOVER_EXIT_MARGIN)
        self.flower_hovered = bool(flower_now or flower_crossed)

        sample_elapsed = now - previous_ts
        sweep_direction, sweep_strength, sweep_speed, sweep_vx, sweep_vy = calculate_cursor_sweep(
            px, py, cursor_global.x(), cursor_global.y(), sample_elapsed
        )
        entered_now = cursor_hovered and not self.hovered
        if entered_now and not self.pressed and self._drag is None:
            bell_direction, _speed, bell_strength = calculate_entry_wind_bell(
                px,
                py,
                cursor_global.x(),
                cursor_global.y(),
                sample_elapsed,
                self.mapToGlobal(QPoint(*map(int, scene_to_widget(HOOK_CX, HOOK_CY)))).x(),
            )
            flower_direction, flower_strength = calculate_entry_wind_flower(
                px,
                py,
                cursor_global.x(),
                cursor_global.y(),
                sample_elapsed,
                self.mapToGlobal(QPoint(*map(int, scene_to_widget(FLOWER_CX, FLOWER_CY)))).x(),            )
            self.gust_direction = bell_direction if abs(bell_strength) >= abs(flower_strength) else flower_direction
            self.hover_strength = max(MIN_WIND_STRENGTH, bell_strength, flower_strength)
            self.gust = self.hover_strength
            self.velocity_bell += 11.0 * self.gust_direction * self.hover_strength
            self.velocity_taz -= 23.0 * self.gust_direction * self.hover_strength
            self.angular_velocity += 14.0 * self.gust_direction * self.hover_strength
            entry_petals = petal_count_from_sweep_speed(sweep_speed)
            entry_petals = 3 if entry_petals <= 0 else min(entry_petals, 7)
            if self.flower_hovered:
                self._spawn_petals(entry_petals, burst=False, wind=(sweep_vx, sweep_vy))
            self._sweep_petal_cooldown = 0.22

        allow_sweep = bool(self.flower_hovered and not self.pressed and self._drag is None)
        if allow_sweep and sweep_strength > 0.0:
            self.cursor_velocity = (sweep_vx, sweep_vy)
            target_cursor_wind, target_cursor_lift = cursor_wind_components(
                sweep_vx, sweep_vy, sweep_strength, sweep_direction
            )
            blend = 1.0 - math.exp(-dt / 0.055)
            self.cursor_wind += (target_cursor_wind - self.cursor_wind) * blend
            self.cursor_lift += (target_cursor_lift - self.cursor_lift) * blend
            self.hover_strength += (sweep_strength - self.hover_strength) * blend
            if abs(self.cursor_wind) >= 0.08:
                self.gust_direction = -1.0 if self.cursor_wind < 0.0 else 1.0
            self.gust = max(self.gust, sweep_strength * 0.58)
            petal_count = petal_count_from_sweep_speed(sweep_speed)
            if petal_count > 0 and self._sweep_petal_cooldown <= 0.0:
                self._spawn_petals(petal_count, burst=False, wind=(sweep_vx, sweep_vy))
                self._sweep_petal_cooldown = 0.24
        else:
            self.cursor_wind *= math.exp(-dt / 0.16)
            self.cursor_lift *= math.exp(-dt / 0.16)
            self.cursor_velocity = (0.0, 0.0)
            resting_strength = 0.24 if self.flower_hovered and not self.pressed else 0.0
            self.hover_strength += (resting_strength - self.hover_strength) * (1.0 - math.exp(-dt / 0.30))

        self.hovered = cursor_hovered
        self._cursor_sample = (cursor_global.x(), cursor_global.y(), now)
        self._sweep_petal_cooldown = max(0.0, self._sweep_petal_cooldown - dt)

        # 共同来风的进出节奏：两套原版都保留自己的目标角与阻尼。
        wind_target = 1.0 if self.hovered else 0.0
        wind_tau = 0.14 if self.hovered else 1.10
        self.hover_wind += (wind_target - self.hover_wind) * (1.0 - math.exp(-dt / wind_tau))
        self.gust *= math.exp(-dt / 0.68)
        self.bloom += (self.hover_wind - self.bloom) * (1.0 - math.exp(-dt / 0.22))

        # ── 风铃原版：铃身先动，短册追随，铃舌碰壁发声 ──
        base_wind = (
            math.sin(self.t * 0.96)
            + 0.34 * math.sin(self.t * 1.92 + 0.8)
            + 0.12 * math.sin(self.t * 3.9 + 2.1)
        )
        wind = base_wind + self.gust_direction * 3.2 * self.gust
        normal_acc_bell = wind * 6.0 - self.angle_bell * 4.8 - self.velocity_bell * 1.7
        strong_bell_target = self.gust_direction * (
            2.0
            + self.hover_strength * 8.0 * math.sin(self.t * 4.6 + 0.4)
            + self.hover_strength * 2.2 * math.sin(self.t * 7.3 + 1.2)
        ) + base_wind * 1.2
        strong_acc_bell = (strong_bell_target - self.angle_bell) * 24.0 - self.velocity_bell * 5.0
        acc_bell = normal_acc_bell * (1.0 - self.hover_wind) + strong_acc_bell * self.hover_wind
        self.velocity_bell += acc_bell * dt
        self.angle_bell += self.velocity_bell * dt

        normal_acc_taz = (
            wind * 18.0
            - self.angle_taz * 8.0
            - self.velocity_taz * 1.25
            - acc_bell * 1.8
        )
        strong_taz_target = self.gust_direction * (
            3.0
            + self.hover_strength * 19.0 * math.sin(self.t * 6.3 + 1.1)
            + self.hover_strength * 4.0 * math.sin(self.t * 9.2 + 0.3)
        ) + base_wind * 2.0
        strong_acc_taz = (strong_taz_target - self.angle_taz) * 40.0 - self.velocity_taz * 5.8 - acc_bell * 0.8
        acc_taz = normal_acc_taz * (1.0 - self.hover_wind) + strong_acc_taz * self.hover_wind
        self.velocity_taz += acc_taz * dt
        self.angle_taz += self.velocity_taz * dt
        self.angle_bell = max(-12.0, min(12.0, self.angle_bell))
        self.angle_taz = max(-26.0, min(26.0, self.angle_taz))

        clapper_target = self.angle_taz * 1.04 - self.angle_bell * 0.16
        acc_clapper = (
            (clapper_target - self.angle_clapper) * CLAPPER_SPRING
            - self.velocity_clapper * CLAPPER_DAMP
            - acc_bell * 0.18
        )
        self.velocity_clapper += acc_clapper * dt
        self.angle_clapper += self.velocity_clapper * dt
        self.angle_clapper, self.velocity_clapper, impact = resolve_clapper_collision(
            self.angle_clapper, self.velocity_clapper
        )
        self._sound_cooldown = max(0.0, self._sound_cooldown - dt)
        # 送达响铃窗口内允许非悬停撞壁发声（铃舌由真实冲量驱动）；窗口外维持原规则。
        chime_hovered = self.hovered
        if time.monotonic() < self._delivery_ring_until:
            chime_hovered = True
        if should_attempt_chime(impact, chime_hovered, self._sound_cooldown):
            self._play_chime(impact)

        # ── 解语花原版：枝条微风、按压弹簧、悬停碎瓣 ──
        flower_base_wind = (
            math.sin(self.t * 0.82)
            + 0.36 * math.sin(self.t * 1.67 + 0.9)
            + 0.14 * math.sin(self.t * 3.15 + 2.2)
        )
        hover_target = self.gust_direction * (
            0.65
            + self.hover_strength * 2.4 * math.sin(self.t * 4.2 + 0.35)
            + self.hover_strength * 0.62 * math.sin(self.t * 7.1 + 1.4)
        )
        target_angle = flower_base_wind * 3.6 * (1.0 - self.hover_wind) + hover_target * self.hover_wind
        target_angle += self.gust_direction * 3.2 * self.gust + self.cursor_wind * 5.4 + self.cursor_lift * 3.6
        if self.pressed:
            target_angle *= 0.18
        acceleration = (target_angle - self.angle) * 19.0 - self.angular_velocity * 6.2
        self.angular_velocity += acceleration * dt
        self.angle += self.angular_velocity * dt
        self.angle = max(-11.0, min(11.0, self.angle))

        self.press_amount, self.press_velocity = advance_press_spring(
            self.press_amount, self.press_velocity, self.pressed, dt
        )
        if not self.pressed and abs(self.press_amount) < 0.002 and abs(self.press_velocity) < 0.03:
            self.press_amount = 0.0
            self.press_velocity = 0.0

        if self.flower_hovered and not self.pressed:
            self._hover_petal_timer -= dt
            if self._hover_petal_timer <= 0.0:
                self._spawn_petals(self._petal_rng.randint(1, 2), burst=False, wind=self.cursor_velocity)
                self._hover_petal_timer = self._petal_rng.uniform(*HOVER_PETAL_INTERVAL)
        else:
            self._hover_petal_timer = min(self._hover_petal_timer, HOVER_PETAL_INTERVAL[0])

        # 原版提问挂起演出：持续散瓣，并周期性拨动枝条；内容由面板承载。
        if self.ask_emitting:
            self._ask_petal_timer -= dt
            if self._ask_petal_timer <= 0.0:
                self._spawn_petals(self._petal_rng.randint(4, 6), burst=True, size_scale=1.8)
                self._ask_petal_timer = self._petal_rng.uniform(0.22, 0.38)
            if not self.pressed:
                self._ask_bounce_timer -= dt
                if self._ask_bounce_timer <= 0.0:
                    self.press_amount = max(self.press_amount, 0.6)
                    self.press_velocity = max(self.press_velocity, 2.2)
                    self._spawn_petals(self._petal_rng.randint(2, 3), burst=True, size_scale=1.4)
                    self._ask_bounce_timer = self._petal_rng.uniform(0.6, 1.1)

        self._update_petals(dt)
        self.update()

    # ── 风铃绘制：保留原 bell.svg 原样，用程序绘制会动的连接件 ──
    def _draw_linkage(self, painter, clapper_angle, paper_angle):
        top, clapper, knot = linkage_points(clapper_angle, paper_angle)
        rope_bend = (self.velocity_clapper - self.velocity_taz) * 0.42
        upper_control, lower_control = linkage_curve_controls(top, clapper, knot, rope_bend)
        pen = QPen(QColor("#8bbcac"), 1.7 * RENDER_SCALE)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        path = QPainterPath(top)
        path.quadTo(upper_control, clapper)
        path.quadTo(lower_control, knot)
        painter.drawPath(path)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor("#fff4d4"))
        painter.drawEllipse(clapper, CLAPPER_RX * RENDER_SCALE, CLAPPER_RY * RENDER_SCALE)
        painter.setBrush(QColor("#fff9ea"))
        painter.drawEllipse(knot, 4.5 * RENDER_SCALE, 4.5 * RENDER_SCALE)

    def _draw_paper(self, painter, paper_angle, clapper_angle):
        _top, _clapper, knot = linkage_points(clapper_angle, paper_angle)
        px, py = PAPER_PIVOT
        painter.save()
        painter.translate(knot.x() - px, knot.y() - py)
        painter.translate(px, py)
        painter.rotate(paper_angle)
        painter.translate(-px, -py)
        painter.drawPixmap(0, 0, self.pix_taz)
        painter.restore()

    @property
    def _ask_emitting(self):
        return self.ask_emitting

    @_ask_emitting.setter
    def _ask_emitting(self, active):
        self.set_ask_emitting(active)

    def set_ask_emitting(self, active):
        """让正式版 Ask 面板接管提问挂起时的花瓣/回弹演出。"""
        self.ask_emitting = bool(active)
        if self.ask_emitting:
            self._ask_petal_timer = 0.0
            self._ask_bounce_timer = 0.0

    def _draw_bell(self, painter):
        if self.pix_bell.isNull():
            return
        unit = BELL_H / BELL_VIEW_HEIGHT
        hook_x, hook_y = rotate_point_around(
            HOOK_CX,
            HOOK_CY,
            BRANCH_PIVOT[0],
            BRANCH_PIVOT[1],
            self._scene_branch_angle(),
        )
        painter.save()
        painter.translate(hook_x, hook_y)
        painter.rotate(self.angle_bell)
        painter.scale(unit / RENDER_SCALE, unit / RENDER_SCALE)
        painter.translate(-BELL_PIVOT[0], -BELL_PIVOT[1])
        self._draw_linkage(painter, self.angle_clapper, self.angle_taz)
        self._draw_paper(painter, self.angle_taz, self.angle_clapper)
        painter.drawPixmap(0, 0, self.pix_bell)
        painter.restore()

    # ── 解语花绘制：整枝、跟随叶、花朵分层，位置结构照原版 ──
    def _branch_angle(self):
        rebound = max(0.0, -self.press_amount)
        motion_scale = 0.18 if self.pressed else 1.0
        effective_gust = max(self.gust, abs(self.cursor_wind) * 0.9) * motion_scale
        effective_direction = (
            -1.0
            if self.cursor_wind < -0.03
            else 1.0
            if self.cursor_wind > 0.03
            else self.gust_direction
        )
        branch_offset, _flower_offset, _leaf_offset = component_motion(
            self.t, self.bloom, effective_gust, effective_direction, rebound
        )
        return self.angle * 0.42 + branch_offset * 0.55 + self.press_amount * 4.8

    def _scene_branch_angle(self):
        return BRANCH_BASE_ANGLE + self._branch_angle()

    def _flower_origin(self):
        return rotate_point_around(
            FLOWER_CX, FLOWER_CY,
            BRANCH_PIVOT[0], BRANCH_PIVOT[1], self._scene_branch_angle()
        )

    def _draw_flower_scene(self, painter):
        rebound = max(0.0, -self.press_amount)
        motion_scale = 0.18 if self.pressed else 1.0
        effective_gust = max(self.gust, abs(self.cursor_wind) * 0.9) * motion_scale
        effective_direction = (
            -1.0
            if self.cursor_wind < -0.03
            else 1.0
            if self.cursor_wind > 0.03
            else self.gust_direction
        )
        _branch_offset, flower_offset, leaf_offset = component_motion(
            self.t, self.bloom, effective_gust, effective_direction, rebound
        )
        vertical_offset = self.cursor_lift * 2.8 * motion_scale
        lift = -0.45 * math.sin(self.t * 1.05)
        branch_angle = self._scene_branch_angle()

        painter.save()
        painter.translate(BRANCH_PIVOT[0], BRANCH_PIVOT[1])
        painter.rotate(branch_angle)
        painter.translate(-BRANCH_PIVOT[0], -BRANCH_PIVOT[1])
        self._draw_layer(painter, self.pix_branch, BRANCH_SIZE, BRANCH_CX, BRANCH_CY)
        self._draw_layer(
            painter,
            self.pix_leaf,
            LEAF_SIZE,
            LEAF_CX,
            LEAF_CY + lift * 0.35 + vertical_offset * 0.45,
            leaf_offset,
        )
        if self.pix_flower.isNull():
            self._draw_fallback_flower(
                painter,
                FLOWER_CX,
                FLOWER_CY + lift + vertical_offset,
                FLOWER_SIZE / 47.0,
                FLOWER_ANGLE + flower_offset,
            )
        else:
            self._draw_layer(
                painter,
                self.pix_flower,
                FLOWER_SIZE,
                FLOWER_CX,
                FLOWER_CY + lift + vertical_offset,
                FLOWER_ANGLE + flower_offset,
            )
        painter.restore()

    @staticmethod
    def _draw_layer(painter, pix, target_size, cx, cy, angle=0.0):
        if pix is None or pix.isNull() or pix.width() <= 0:
            return
        scale = float(target_size) / pix.width()
        half = pix.width() / 2.0
        painter.save()
        painter.translate(float(cx), float(cy))
        painter.rotate(float(angle))
        painter.scale(scale, scale)
        painter.translate(-half, -half)
        painter.drawPixmap(0, 0, pix)
        painter.restore()

    def _draw_petals(self, painter):
        painter.save()
        painter.setPen(Qt.PenStyle.NoPen)
        for petal in self.petal_particles:
            progress = petal["age"] / max(petal["life"], 0.001)
            alpha = int(205 * max(0.0, 1.0 - progress) ** 0.72)
            color = QColor(petal["color"])
            color.setAlpha(max(0, min(alpha, 205)))
            painter.setBrush(color)
            painter.save()
            painter.translate(petal["x"], petal["y"])
            painter.rotate(petal["angle"])
            painter.drawEllipse(QPointF(0.0, 0.0), petal["size"] * 0.62, petal["size"])
            painter.restore()
        painter.restore()

    @staticmethod
    def _draw_fallback_flower(painter, cx, cy, flower_scale, angle=0.0):
        painter.save()
        painter.translate(cx, cy)
        painter.rotate(angle)
        painter.scale(flower_scale, flower_scale)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor("#efb3c3"))
        for _ in range(5):
            painter.drawEllipse(QPointF(0.0, -10.5), 7.8, 12.5)
            painter.rotate(72.0)
        painter.setBrush(QColor("#edc46f"))
        painter.drawEllipse(QPointF(0.0, 0.0), 5.2, 5.2)
        painter.restore()

    # ── 花瓣粒子：照原版的悬停、掠风、按压三种密度 ──
    def _spawn_petals(self, count, burst, wind=(0.0, 0.0), size_scale=1.0):
        cx, cy = self._flower_origin()
        wind_x, wind_y = float(wind[0]), float(wind[1])
        source_wind_speed = math.hypot(wind_x, wind_y)
        swept = not burst and source_wind_speed > 0.0
        if swept:
            wind_scale = min(source_wind_speed * 0.024, 32.0) / source_wind_speed
            wind_x *= wind_scale
            wind_y *= wind_scale
        for _ in range(max(0, int(count))):
            size = self._petal_rng.uniform(0.82, 1.62 if burst else 1.28) * size_scale
            direction = self._petal_rng.uniform(0.0, math.tau)
            if burst:
                radius = self._petal_rng.uniform(10.0, 17.0)
                speed = self._petal_rng.uniform(15.0, 31.0)
                x = cx + math.cos(direction) * radius
                y = cy + math.sin(direction) * radius * 0.72
                vx = math.cos(direction) * speed
                vy = math.sin(direction) * speed * 0.68 - 2.0
                gravity = 15.0
                sway = 1.5
                life = self._petal_rng.uniform(0.82, 1.35)
                spin_limit = 150.0
            else:
                radius = self._petal_rng.uniform(11.0, 17.0)
                x = cx + math.cos(direction) * radius
                y = cy + math.sin(direction) * radius * 0.78
                vx = self._petal_rng.uniform(-5.0, 5.0) + wind_x
                vy = self._petal_rng.uniform(4.0, 8.5) + wind_y * 0.8
                gravity = 22.0 if swept else 15.0
                sway = 1.5 + min(source_wind_speed / 600.0, 2.4) if swept else 1.5
                life = self._petal_rng.uniform(1.35, 1.95) if swept else self._petal_rng.uniform(0.82, 1.12)
                spin_limit = min(150.0 + source_wind_speed * 0.08, 300.0) if swept else 150.0
            self.petal_particles.append({
                "x": x,
                "y": y,
                "vx": vx,
                "vy": vy,
                "size": size,
                "angle": self._petal_rng.uniform(0.0, 360.0),
                "spin": self._petal_rng.uniform(-spin_limit, spin_limit),
                "phase": self._petal_rng.uniform(0.0, math.tau),
                "gravity": gravity,
                "sway": sway,
                "age": 0.0,
                "life": life,
                "color": self._petal_rng.choice(("#f2b8c7", "#f7cfda", "#e9a3b8")),
            })
        if len(self.petal_particles) > MAX_PETAL_PARTICLES:
            self.petal_particles = self.petal_particles[-MAX_PETAL_PARTICLES:]

    def _update_petals(self, dt):
        alive = []
        for petal in self.petal_particles:
            petal["age"] += dt
            if petal["age"] >= petal["life"]:
                continue
            petal["vx"] *= math.exp(-dt * 0.72)
            petal["vy"] += petal.get("gravity", 15.0) * dt
            petal["x"] += petal["vx"] * dt + math.sin(
                petal["age"] * 8.0 + petal["phase"]
            ) * petal.get("sway", 1.5) * dt
            petal["y"] += petal["vy"] * dt
            petal["angle"] += petal["spin"] * dt
            if petal["y"] <= DESIGN_BALL_H + 8:
                alive.append(petal)
        self.petal_particles = alive

    # ── 绘制入口 ──
    def paintEvent(self, _event):
        painter = QPainter(self)
        painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_Source)
        painter.fillRect(self.rect(), Qt.GlobalColor.transparent)
        painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_SourceOver)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        painter.save()
        painter.translate(SCENE_OFFSET_X, SCENE_OFFSET_Y)
        painter.scale(SCENE_SCALE, SCENE_SCALE)

        # 风铃先画，树枝后来盖住挂环与绳子的上段，产生“挂在枝上”的受力关系。
        self._draw_bell(painter)
        self._draw_flower_scene(painter)
        self._draw_petals(painter)
        painter.restore()
        painter.end()

    # ── 鼠标交互：两边原版按压/拖拽/点击语义合并 ──
    def _begin_press_effect(self):
        self.pressed = True
        self.press_amount = max(self.press_amount, 0.18)
        self.press_velocity = max(self.press_velocity, 2.6)
        self._spawn_petals(PRESS_PETAL_COUNT, burst=True)
        direction = 1.0 if self.angle_bell <= 0 else -1.0
        self.velocity_bell += 5.5 * direction
        self.velocity_taz -= 11.0 * direction

    def _end_press_effect(self):
        if not self.pressed:
            return
        self.pressed = False
        self.press_velocity = min(self.press_velocity, -8.4)
        self._spawn_petals(RELEASE_PETAL_COUNT, burst=True)

    def mousePressEvent(self, event):
        local = event.position()
        scene_x, scene_y = widget_to_scene(local.x(), local.y())
        if not point_in_visual_zone(scene_x, scene_y, HOVER_EXIT_MARGIN):
            event.ignore()
            return
        if event.button() == Qt.MouseButton.LeftButton:
            self._press_global = event.globalPosition().toPoint()
            self._drag = self._press_global - self.pos()
            self._drag_ball_start = self.pos()
            self._moved = False
            self._press_flower = point_in_flower_interaction_zone(
                scene_x, scene_y, HOVER_EXIT_MARGIN
            )
            self._drag_read_was_visible = bool(self.read_panel and self.read_panel.isVisible())
            self._drag_read_start = self.read_panel.pos() if self._drag_read_was_visible else None
            # FusionMenu.isVisible() also includes ReadPanel；朗读窗打开时不能把它当普通页面重新锚定。
            self._drag_menu_was_visible = bool(
                self.menu and self.menu.isVisible() and not self._drag_read_was_visible
            )
            self._drag_menu_start = None
            if self._drag_menu_was_visible and self.menu is not None:
                page = self.menu.active_page
                self._drag_menu_start = page.pos() if page.isVisible() else None
            if self._press_flower:
                self._begin_press_effect()
            else:
                direction = 1.0 if self.angle_bell <= 0 else -1.0
                self.velocity_bell += 5.5 * direction
                self.velocity_taz -= 11.0 * direction
        event.accept()

    def mouseMoveEvent(self, event):
        if self._drag is not None and (event.buttons() & Qt.MouseButton.LeftButton):
            current = event.globalPosition().toPoint()
            if not self._moved:
                if (current - self._press_global).manhattanLength() < QApplication.startDragDistance():
                    event.accept()
                    return
                self._moved = True
            delta = current - self._press_global
            if self._drag_read_was_visible and self.read_panel is not None:
                self._sync_dragged_read_panel(delta)
            else:
                self.move(current - self._drag)
                if self._drag_menu_was_visible and self.menu is not None:
                    self.menu.move_to_ball()
            if self.context_menu is not None and self.context_menu.isVisible():
                self.context_menu.move_to_ball()
        event.accept()

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            if self._press_flower:
                self._end_press_effect()
            if self._moved:
                self._snap()
                if self._drag_read_was_visible and self.read_panel is not None:
                    self._sync_dragged_read_panel()
                elif self._drag_menu_was_visible and self.menu is not None:
                    self.menu.move_to_ball()
                if self.context_menu is not None and self.context_menu.isVisible():
                    self.context_menu.move_to_ball()
            elif self._drag_read_was_visible and self.read_panel is not None and self.read_panel.isVisible():
                self.read_panel.close()
            elif self._drag_menu_was_visible and self.menu is not None and self.menu.isVisible():
                self.menu.close_once()
            else:
                self._toggle_menu()
            self._drag = None
            self._press_global = None
            self._press_flower = False
            self._drag_menu_was_visible = False
            self._drag_read_was_visible = False
            self._drag_menu_start = None
            self._drag_read_start = None
            self._drag_ball_start = None
        elif event.button() == Qt.MouseButton.RightButton:
            self._open_context(event.globalPosition().toPoint())
        event.accept()

    def _sync_dragged_read_panel(self, desired_delta=None):
        """朗读窗被用户拖到自定义位置后，融合球拖动仍保持当前相对偏移。"""
        if self.read_panel is None or self._drag_ball_start is None or self._drag_read_start is None:
            return
        delta = desired_delta if desired_delta is not None else self.pos() - self._drag_ball_start
        screen = self.screen() or QApplication.primaryScreen()
        if screen is None:
            return
        geo = screen.availableGeometry()
        dx, dy = _ORIGINAL_ZHUJIAN.clamp_pair_drag(
            delta.x(), delta.y(),
            (self._drag_ball_start.x(), self._drag_ball_start.y(), self.width(), self.height()),
            (self._drag_read_start.x(), self._drag_read_start.y(), self.read_panel.width(), self.read_panel.height()),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
        )
        self.move(self._drag_ball_start + QPoint(dx, dy))
        self.read_panel.move(self._drag_read_start + QPoint(dx, dy))
        if not self.read_panel.isVisible():
            self.read_panel.show()
            self.read_panel.raise_()

    def _snap(self):
        screen = self.screen() or QApplication.primaryScreen()
        if screen is None:
            return
        geo = screen.availableGeometry()
        x, y = clamp_position(
            self.x(), self.y(), self.width(), self.height(),
            geo.left(), geo.top(), geo.right(), geo.bottom(),
        )
        self.move(x, y)

    # ── 风铃音频：复用原版音色池与多声道播放 ──
    def _init_chime_pool(self):
        if fengling_dsp is None:
            return
        path = os.path.join(FENGLING_DIR, "fengling-chime-cluster.wav")
        if not os.path.exists(path):
            return
        try:
            self._chime_pool = fengling_dsp.build_chime_pool(path, count=CHIME_SLICE_POOL_SIZE)
        except Exception as error:
            print(f"[融合球] 生成碰撞音色失败: {error}", file=sys.stderr)

    def _init_sound_voices(self):
        if QSoundEffect is None:
            return
        try:
            self._sound_voices = [QSoundEffect(self) for _ in range(CHIME_VOICE_COUNT)]
        except Exception as error:
            self._sound_voices = []
            print(f"[融合球] 初始化重叠播放失败: {error}", file=sys.stderr)

    def _play_chime(self, impact):
        if self.sound_volume <= 0 or self._sound_cooldown > 0 or not self._chime_pool:
            return
        volume = chime_volume_from_impact(impact, self.sound_volume)
        index = random.randint(0, len(self._chime_pool) - 1)
        if len(self._chime_pool) > 1:
            while index == self._last_chime_idx:
                index = random.randint(0, len(self._chime_pool) - 1)
        self._last_chime_idx = index
        self._sound_cooldown = CHIME_COOLDOWN
        try:
            path = prepare_sound_file(self._chime_pool[index], volume)
            if self._sound_voices:
                voice = next((item for item in self._sound_voices if not item.isPlaying()), None)
                if voice is None:
                    voice = self._sound_voices[self._sound_voice_index % len(self._sound_voices)]
                self._sound_voice_index = (self._sound_voice_index + 1) % len(self._sound_voices)
                voice.setSource(QUrl.fromLocalFile(path))
                voice.setVolume(1.0)
                voice.play()
                return
            if winsound is not None:
                winsound.PlaySound(
                    path,
                    winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT,
                )
        except Exception as error:
            print(f"[融合球] 播放声音失败: {error}", file=sys.stderr)

    def _swing_for_delivery(self):
        """心意到达：给铃舌真实的晃动冲量，让它撞壁自然发声（因动而声）。"""
        self._delivery_ring_until = time.monotonic() + DELIVERY_RING_WINDOW_S
        kicks = (DELIVERY_KICK, -DELIVERY_KICK * 0.82, DELIVERY_KICK * 0.66)
        for delay, strength in zip((0, 260, 520), kicks):
            QTimer.singleShot(delay, lambda s=strength: self._delivery_kick(s))

    def _delivery_kick(self, strength):
        self._sound_cooldown = 0.0
        self.velocity_clapper += strength

    def _poll_hearts_async(self):
        if self._heart_polling:
            return
        self._heart_polling = True
        seen_ids = set(self._heart_seen_ids)
        seeded = self._heart_seeded

        def worker():
            payload = {
                "ok": False,
                "hearts": [],
                "new_hearts": [],
                "ack_ids": [],
                "seen_ids": [],
                "seeded": seeded,
            }
            try:
                data = self._call_fengling("/hearts", timeout=3)
                if data.get("ok"):
                    hearts = data.get("hearts") or []
                    seen, fresh, ack_ids, seeded_now = _ORIGINAL_FENGLING.resolve_heart_poll(
                        seen_ids,
                        hearts,
                        seeded,
                    )
                    payload["hearts"] = hearts
                    payload["new_hearts"] = fresh
                    payload["ack_ids"] = ack_ids
                    payload["seen_ids"] = list(seen)
                    payload["seeded"] = seeded_now
                    payload["ok"] = True
            except Exception:
                pass
            try:
                self.heart_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="fusion-hearts").start()

    def _apply_heart_poll(self, payload):
        self._heart_polling = False
        if not payload.get("ok"):
            return
        self._heart_seen_ids = set(payload.get("seen_ids") or self._heart_seen_ids)
        self._heart_seeded = bool(payload.get("seeded", self._heart_seeded))

        page = self.menu.fengling_page if self.menu is not None else None
        page_visible = bool(page is not None and page.isVisible())
        if "hearts" in payload:
            hearts = payload.get("hearts") or []
            self.heart_queue = _ORIGINAL_FENGLING.pending_heart_items(
                hearts,
                self._heart_dismissed_ids,
            )
            current_id = str(self.current_heart.get("id") or "") if self.current_heart else ""
            current = next(
                (item for item in self.heart_queue if str(item.get("id") or "") == current_id),
                None,
            )
            if current is not None:
                self.current_heart = current
            elif current_id:
                self.current_heart = None
            if self.heart_queue and not self.current_heart and not (
                page_visible and page._heart_card_dismissed
            ):
                self.current_heart = self.heart_queue[0]
            elif self.heart_queue and not page_visible:
                self.current_heart = self.heart_queue[0]
            if page_visible:
                page._update_heart_card()
                page.keep_current_position(full_height=True)

        ack_ids = payload.get("ack_ids") or []
        fresh = payload.get("new_hearts") or []
        if not fresh:
            # 已送达但仍未读的心意留在 heart_queue，等用户手动打开查看；不重复响铃。
            if ack_ids:
                self._ack_hearts_async(ack_ids)
            return

        # 一轮可能收到多份新心意：只播放一次送达提示，队列全部保留，面板优先展示最新一份。
        self.current_heart = self.heart_queue[0] if self.heart_queue else fresh[0]
        if page_visible:
            page._heart_card_dismissed = False
            page._update_heart_card()
            page.keep_current_position(full_height=True)
        if ack_ids:
            self._ack_hearts_async(ack_ids)
        self._swing_for_delivery()

    def _ack_hearts_async(self, ids):
        if not ids:
            return

        def worker():
            try:
                self._call_fengling("/hearts/ack", "POST", {"ids": ids}, timeout=3)
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True, name="fusion-heart-ack").start()

    def _dismiss_hearts_async(self, ids):
        if not ids:
            return

        def worker():
            try:
                self._call_fengling("/hearts/dismiss", "POST", {"ids": ids}, timeout=3)
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True, name="fusion-heart-dismiss").start()

    # ── 解语花 Ask 轮询：融合球也必须独立接住后台新提问 ──
    def _poll_ask_async(self):
        if self._closing or self._ask_poll_inflight:
            return
        self._ask_poll_inflight = True

        def worker():
            payload = {"ok": False, "pending": []}
            try:
                data = self._call_jiegehua("/ask/pending", timeout=4)
                if data.get("ok"):
                    payload = {"ok": True, "pending": data.get("pending") or []}
            except Exception:
                pass
            if self._closing:
                return
            try:
                self.ask_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="fusion-ask-poll").start()

    def _apply_ask_payload(self, payload):
        self._ask_poll_inflight = False
        if self._closing or not isinstance(payload, dict) or not payload.get("ok"):
            return

        ask = _ORIGINAL_ZHUJIAN.latest_ask_pending(payload.get("pending"))
        page = self.menu.jiegehua_page if self.menu is not None else None
        if ask is not None:
            if self.menu is None:
                self.menu = FusionMenu(self)
                page = self.menu.jiegehua_page

            # 用户主动收起同一道题时，轮询只保留题目，不自动打回脸上；
            # 手动点融合球切回解语花页时再解除这个抑制。
            if (
                page.is_ask_open()
                and page._ask_user_hidden
                and ask.get("askId") == page._ask_entry.get("askId")
            ):
                return

            # Ask 与右键菜单/朗读窗互斥；融合版要先切到解语花页，再让正式面板接管提问态。
            if self.context_menu is not None:
                self.context_menu.close_once()
            if self.read_panel is not None and self.read_panel.isVisible():
                self.read_panel.close()
            if self.menu.current != FusionMenu.PAGE_ZHUJIAN or not page.isVisible():
                self.menu.switch_page(FusionMenu.PAGE_ZHUJIAN, show=True)
            else:
                page.move_to_ball()
                page.show()
            page.show_ask(ask)
            page.raise_()
            self._set_fusion_panel_state("ask")
            return

        # 提问已作答、被主对话隐式跳过或过期：沿用原版语义，收起而不是恢复推荐页。
        if page is not None and page.is_ask_open():
            page.finish_ask_and_collapse()

    def _set_volume(self, volume):
        self.sound_volume = persist_fusion_sound_volume(volume)
        for voice in self._sound_voices:
            voice.setVolume(1.0)

    def _set_sound(self, enabled):
        # 兼容旧调用方；右键菜单现在直接走四档音量选择。
        self._set_volume(VOLUME_DEFAULT if enabled else 0.0)
        print(f"[融合球] 声音{'开' if enabled else '关'}")

    # ── 正式版面板适配：只借布局/交互，业务仍走两个本地代理 ──
    def _set_fusion_panel_state(self, panel):
        panel = panel if panel in {"none", "menu", "ask", "read"} else "none"
        if self.state.get("fusionPanel") == panel:
            return
        self.state["fusionPanel"] = panel
        _ORIGINAL_ZHUJIAN.save_state(self.state)

    def _set_action(self, action):
        self.action = action if action in {"send", "copy"} else "copy"
        self.state["action"] = self.action
        _ORIGINAL_ZHUJIAN.save_state(self.state)
        def sync_proxy():
            try:
                self._call_jiegehua("/action", "POST", {"action": self.action}, timeout=5)
            except Exception:
                pass

        threading.Thread(target=sync_proxy, daemon=True, name="fusion-action-sync").start()
        if self.menu is not None:
            self.menu.update_hint()

    def _close_menu(self):
        if self.menu is not None:
            self.menu.close_once()
        self._set_fusion_panel_state("none")

    def _save_pos(self):
        # 融合球位置只属于本次融合；拆回必须使用融合前的两球快照。
        return None

    def open_branch_window(self, _branch):
        # 分支窗口仍属于解语花独立球；融合面板不复制第三套顶层窗口。
        if self.menu is not None:
            self.menu.jiegehua_page._flash("分支窗口请在解语花悬浮球中打开")

    def _do_visit(self, vtype, item_id):
        timeout = 55 if vtype == "prank" else 20
        return self._call_fengling(
            "/visit", "POST", {"type": vtype, "itemId": item_id}, timeout=timeout
        )

    def _sync_theme(self):
        mode = _ORIGINAL_ZHUJIAN.read_hana_theme_mode()
        if mode == self.theme_mode:
            return
        self.theme_mode = mode
        if self.menu is not None:
            self.menu.apply_theme()
        if self.read_panel is not None:
            self.read_panel.apply_theme()

    # ── 面板与全局控制 ──
    def _toggle_menu(self):
        if self.read_panel is not None and self.read_panel.isVisible():
            self.read_panel.close()
            return
        if self.context_menu is not None and self.context_menu.isVisible():
            self.context_menu.close_once()
            return
        if self.menu is not None and self.menu.isVisible():
            self.menu.close_once()
        else:
            self._open_menu()

    def _open_menu(self):
        if self.context_menu is not None and self.context_menu.isVisible():
            self.context_menu.close_once()
        if self.menu is None:
            self.menu = FusionMenu(self)
        self.menu.popup_near(self)

    def open_inherited_panel(self):
        """融合启动时接住旧解语花的 Ask/朗读入口，使用同一份正式版面板能力。"""
        if INHERITED_PANEL not in {"ask", "read"}:
            return
        if self.menu is None:
            self.menu = FusionMenu(self)
        self.menu.switch_page(FusionMenu.PAGE_ZHUJIAN, show=True)
        if INHERITED_PANEL == "read":
            self.menu.open_read_panel()
        else:
            self._request_inherited_ask()

    def _request_inherited_ask(self):
        # 启动时继承旧解语花 Ask 与常驻轮询共用同一条展示链，避免两套状态机漂移。
        self._poll_ask_async()

    def _open_context(self, _global_pos):
        if self.context_menu is not None and self.context_menu.isVisible():
            self.context_menu.close_once()
            return
        self._close_menu()
        if self.read_panel is not None and self.read_panel.isVisible():
            self.read_panel.close()
        if self.context_menu is None:
            self.context_menu = FusionContextMenu(self)
        self.context_menu.popup_near(self)

    def eventFilter(self, _obj, event):
        if event.type() == QEvent.Type.MouseButtonPress:
            pos = event.globalPosition().toPoint()
            ball_contains = self.geometry().contains(pos)
            context = self.context_menu
            context_contains = menu_tree_contains_global(context, pos)
            read = self.read_panel
            read_contains = bool(read and read.isVisible() and read.geometry().contains(pos))

            if context is not None and context.isVisible() and not context_contains and not ball_contains:
                context.close_once()
            if read is not None and read.isVisible() and not read_contains and not ball_contains:
                read.close()

            for page in getattr(self.menu, "pages", ()):
                if page.isVisible() and not page.geometry().contains(pos) and not ball_contains:
                    if not context_contains and not read_contains:
                        self.menu.close_once()
                    break
        return super().eventFilter(_obj, event)

    def confirm_split(self):
        """兼容旧调用方；右键菜单不再暴露拆分入口。"""
        try:
            proxy_request(
                COORDINATOR_API,
                COORDINATOR_TOKEN,
                "/fusion/split",
                method="POST",
                payload={"reason": "user"},
                timeout=3,
            )
        except Exception as error:
            print(f"[融合球] 拆回请求失败: {error}", file=sys.stderr)
        self.close()

    def closeEvent(self, event):
        self._closing = True
        if self.ask_poll_timer is not None:
            self.ask_poll_timer.stop()
        if self.menu is not None:
            self.menu.close_once()
        if self.context_menu is not None:
            self.context_menu.close_once()
        if self.read_panel is not None:
            self.read_panel.close()
        if self._event_filter_installed and QApplication.instance() is not None:
            QApplication.instance().removeEventFilter(self)
        super().closeEvent(event)

    def _call_fengling(self, route, method="GET", payload=None, timeout=8):
        return proxy_request(FENGLING_API, FENGLING_TOKEN, route, method, payload, timeout)

    def _call_jiegehua(self, route, method="GET", payload=None, timeout=8):
        return proxy_request(JIEGEHUA_API, JIEGEHUA_TOKEN, route, method, payload, timeout)


class FadeMixin:
    """小面板沿用原版的离开淡出节奏，不给透明悬浮球加硬外框。"""

    def _setup_fade(self):
        self._fade_timer = QTimer(self)
        self._fade_timer.setSingleShot(True)
        self._fade_timer.timeout.connect(self._fade_out)
        self._fade_animation = QPropertyAnimation(self, b"windowOpacity", self)

    def showEvent(self, event):
        super().showEvent(event)
        self.setWindowOpacity(1.0)
        self._fade_timer.stop()

    def enterEvent(self, event):
        super().enterEvent(event)
        self._fade_timer.stop()
        self._fade_to(1.0, 180)

    def leaveEvent(self, event):
        super().leaveEvent(event)
        self._fade_timer.start(450)

    def _fade_out(self):
        self._fade_to(0.60, 420)

    def _fade_to(self, target, duration):
        self._fade_animation.stop()
        self._fade_animation.setStartValue(self.windowOpacity())
        self._fade_animation.setEndValue(target)
        self._fade_animation.setDuration(duration)
        self._fade_animation.start()


class _LegacyFusionMenu(FadeMixin, QFrame):
    PAGE_FENGLING = 0
    PAGE_ZHUJIAN = 1
    result_ready = pyqtSignal(object)

    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.Tool
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setObjectName("fusionPanel")
        self.setFixedWidth(300)
        self.current = self.PAGE_FENGLING
        self._request_seq = 0
        self._build()
        self.result_ready.connect(self._apply_result)
        self._setup_fade()

    def _build(self):
        self.setStyleSheet(f"""
            #fusionPanel {{ background:{C_BG}; border:1px solid {C_BORDER}; border-radius:18px; }}
            QLabel {{ color:{C_INK}; background:transparent; }}
            QPushButton {{ color:{C_INK}; background:#fffaf0; border:1px solid #ead9bb; border-radius:9px; padding:7px 10px; font-size:12px; text-align:left; }}
            QPushButton:hover {{ background:#f3eadb; border-color:{C_MINT_DEEP}; }}
            QPushButton#switch {{ background:{C_MINT}; border-color:{C_MINT_DEEP}; text-align:center; }}
        """)
        root = QVBoxLayout(self)
        root.setContentsMargins(13, 12, 13, 12)
        root.setSpacing(8)
        head = QHBoxLayout()
        self.title = QLabel()
        self.title.setStyleSheet("font-weight:600; font-size:13px;")
        head.addWidget(self.title, 1)
        self.switch_btn = QPushButton()
        self.switch_btn.setObjectName("switch")
        self.switch_btn.clicked.connect(self._toggle_page)
        head.addWidget(self.switch_btn)
        root.addLayout(head)
        self.body = QVBoxLayout()
        self.body.setSpacing(6)
        root.addLayout(self.body)
        self._render_page()

    def _toggle_page(self):
        self.current = 1 - self.current
        self._render_page()

    def _clear_body(self):
        while self.body.count():
            item = self.body.takeAt(0)
            widget = item.widget()
            if widget:
                widget.deleteLater()

    def _add_button(self, text, callback):
        button = QPushButton(str(text))
        button.clicked.connect(callback)
        self.body.addWidget(button)
        return button

    def _add_text(self, text, emphasis=False):
        label = QLabel(str(text))
        label.setWordWrap(True)
        if emphasis:
            label.setStyleSheet(f"font-weight:600; color:{C_MINT_DEEP};")
        self.body.addWidget(label)
        return label

    def _render_page(self):
        self._clear_body()
        if self.current == self.PAGE_FENGLING:
            self.title.setText("风铃 · 互动")
            self.switch_btn.setText("切到解语花")
            actions = (("查看心意", "hearts"), ("送礼 / 互动", "catalog"), ("恶作剧", "catalog"))
        else:
            self.title.setText("解语花 · 会话")
            self.switch_btn.setText("切到风铃")
            actions = (("推荐回复", "suggest"), ("提问面板", "ask"), ("朗读素材", "read"))
        for label, action in actions:
            self._add_button(label, lambda _checked=False, action=action: self._start_request(action))
        self.adjustSize()

    def _show_loading(self):
        self._clear_body()
        self._add_text("正在读取…")
        self.adjustSize()

    def _start_request(self, action, payload=None):
        self._request_seq += 1
        seq = self._request_seq
        self._show_loading()

        def worker():
            try:
                if action == "hearts":
                    data = self.ball._call_fengling("/hearts", timeout=5)
                elif action == "catalog":
                    data = self.ball._call_fengling("/catalog", timeout=5)
                elif action == "visit":
                    data = self.ball._call_fengling("/visit", "POST", payload, timeout=25)
                elif action == "suggest":
                    data = self.ball._call_jiegehua("/suggest", timeout=35)
                elif action == "apply":
                    data = self.ball._call_jiegehua("/apply", "POST", payload, timeout=20)
                elif action == "ask":
                    data = self.ball._call_jiegehua("/ask/pending", timeout=5)
                elif action == "respond":
                    data = self.ball._call_jiegehua("/ask/respond", "POST", payload, timeout=20)
                elif action == "read":
                    data = self.ball._call_jiegehua("/tts/replies", timeout=8)
                elif action == "speak":
                    data = self.ball._call_jiegehua("/tts/speak", "POST", payload, timeout=45)
                else:
                    data = {"ok": False, "error": "未知融合动作"}
            except Exception as error:
                data = {"ok": False, "error": str(error)}
            try:
                self.result_ready.emit({"seq": seq, "action": action, "payload": payload, "data": data or {}})
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="fusion-menu-request").start()

    def _submit_custom_ask(self, ask_id, input_box):
        choice = input_box.text().strip()
        if not choice:
            self._add_text("请先填写回答", emphasis=True)
            self.adjustSize()
            return
        self._start_request("respond", {"askId": ask_id, "mode": "custom", "choice": choice})

    def _apply_result(self, result):
        if result.get("seq") != self._request_seq:
            return
        action = result.get("action")
        data = result.get("data") or {}
        self._clear_body()
        if not data.get("ok"):
            print(f"[融合球] {action} 请求失败: {data.get('error') or 'unknown'}", file=sys.stderr)
            if action in {"hearts", "catalog", "visit"}:
                message = "风铃暂时没有响应"
            elif action in {"suggest", "apply", "ask", "respond", "read"}:
                message = "解语花暂时没有响应"
            elif action == "speak":
                message = "朗读素材生成失败，再试一次"
            else:
                message = "融合桥暂时不可用"
            self._add_text(message)
            self._add_button("重试", lambda: self._start_request(action, result.get("payload")))
            self._add_button("返回", lambda: self._render_page())
            self.adjustSize()
            return
        if action == "hearts":
            hearts = data.get("hearts") or []
            self._add_text("暂时没有新的心意" if not hearts else "收到的心意", emphasis=True)
            for heart in hearts[:6]:
                gift = heart.get("giftName") or heart.get("gift") or "一份小心意"
                message = heart.get("message") or heart.get("text") or ""
                self._add_text(f"{gift}\n{message}".strip())
        elif action == "catalog":
            self._add_text("选一个动作", emphasis=True)
            for item in (data.get("interacts") or []) + (data.get("gifts") or []) + (data.get("pranks") or []):
                item_id = item.get("id")
                if not item_id:
                    continue
                label = f"{item.get('icon') or '·'} {item.get('name') or item_id}"
                self._add_button(
                    label,
                    lambda _checked=False, item=item: self._start_request(
                        "visit", {"type": item.get("type"), "itemId": item.get("id")}
                    ),
                )
        elif action == "visit":
            self._add_text(data.get("message") or data.get("error") or "已送达", emphasis=True)
        elif action == "suggest":
            items = data.get("items") or []
            self._add_text("点一句接上话", emphasis=True)
            for index, item in enumerate(items):
                text = item.get("text") or ""
                if not text:
                    continue
                self._add_button(
                    text,
                    lambda _checked=False, index=index, rid=data.get("rid") or "": self._start_request(
                        "apply", {"rid": rid, "index": index}
                    ),
                )
        elif action == "apply":
            self._add_text(data.get("message") or "已发送", emphasis=True)
        elif action == "ask":
            pending = data.get("pending") or []
            ask = pending[-1] if pending else None
            if not ask:
                self._add_text("当前没有待回答的问题")
            else:
                self._add_text(ask.get("question") or "请你拍板", emphasis=True)
                for option in ask.get("options") or []:
                    label = option.get("label") if isinstance(option, dict) else str(option)
                    if not label:
                        continue
                    self._add_button(
                        label,
                        lambda _checked=False, ask_id=ask.get("askId"), label=label: self._start_request(
                            "respond", {"askId": ask_id, "mode": "option", "choice": label}
                        ),
                    )
                input_box = QLineEdit()
                input_box.setMaxLength(200)
                input_box.setPlaceholderText("也可以写自己的回答")
                self.body.addWidget(input_box)
                self._add_button(
                    "发送自定义回答",
                    lambda _checked=False, ask_id=ask.get("askId"), input_box=input_box: self._submit_custom_ask(
                        ask_id, input_box
                    ),
                )
                self._add_button(
                    "跳过这道题",
                    lambda _checked=False, ask_id=ask.get("askId"): self._start_request(
                        "respond", {"askId": ask_id, "mode": "skip", "choice": ""}
                    ),
                )
        elif action == "respond":
            self._add_text(data.get("message") or "已回传选择", emphasis=True)
        elif action == "read":
            replies = data.get("replies") or []
            session_path = data.get("sessionPath") or ""
            self._add_text("选择一条回复生成朗读", emphasis=True)
            for index, reply in enumerate(replies[:6]):
                preview = reply.get("preview") or reply.get("text") or "回复"
                self._add_button(
                    preview,
                    lambda _checked=False, index=index, session_path=session_path: self._start_request(
                        "speak", {"replyIndex": index, "sessionPath": session_path}
                    ),
                )
        elif action == "speak":
            self._add_text(data.get("text") or data.get("message") or "朗读素材已生成；融合球播放窗仍在接入中", emphasis=True)
        self._add_button("返回", lambda: self._render_page())
        self.adjustSize()

    def popup_near(self, ball):
        self.adjustSize()
        screen = ball.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry() if screen is not None else None
        x = ball.x() + ball.width() + 8
        if geo is not None and x + self.width() > geo.right():
            x = ball.x() - self.width() - 8
        y = ball.y() + 10
        if geo is not None:
            x = max(geo.left(), min(x, geo.right() - self.width() + 1))
            y = max(geo.top(), min(y, geo.bottom() - self.height() + 1))
        self.move(x, y)
        self.show()
        self.raise_()

    def move_to_ball(self):
        if self.isVisible():
            self.popup_near(self.ball)

    def close_once(self):
        self.hide()


class _LegacyContextMenu(FadeMixin, QFrame):
    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.Tool
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setObjectName("fusionContext")
        self.setFixedWidth(210)
        self._build()
        self._setup_fade()

    def _build(self):
        self.setStyleSheet(f"""
            #fusionContext {{ background:{C_BG}; border:1px solid {C_BORDER}; border-radius:16px; }}
            QLabel {{ color:{C_INK}; background:transparent; }}
            QPushButton {{ color:{C_INK}; background:#fffaf0; border:1px solid #ead9bb; border-radius:9px; padding:7px 10px; font-size:12px; text-align:left; }}
            QPushButton:hover {{ background:#f3eadb; }}
            QPushButton#danger {{ background:#fdf0ef; border-color:#edced5; color:#a5651f; }}
        """)
        root = QVBoxLayout(self)
        root.setContentsMargins(11, 10, 11, 10)
        root.setSpacing(6)
        title = QLabel("融合球 · 控制")
        title.setStyleSheet("font-weight:600; font-size:12px;")
        root.addWidget(title)
        self.sound_button = QPushButton()
        self.sound_button.clicked.connect(self._toggle_sound)
        root.addWidget(self.sound_button)
        self._refresh_sound_button()
        split = QPushButton("解除融合，拆回两球")
        split.clicked.connect(lambda: (self.close_once(), self.ball.confirm_split()))
        root.addWidget(split)
        close = QPushButton("收起融合球并恢复两球")
        close.setObjectName("danger")
        close.clicked.connect(lambda: (self.close_once(), self.ball.close()))
        root.addWidget(close)

    def _refresh_sound_button(self):
        self.sound_button.setText("声音：开" if self.ball.sound_volume > 0 else "声音：关")

    def _toggle_sound(self):
        self.ball._set_sound(self.ball.sound_volume <= 0)
        self._refresh_sound_button()

    def popup_near_global(self, global_pos):
        self.adjustSize()
        screen = QApplication.screenAt(global_pos) or QApplication.primaryScreen()
        geo = screen.availableGeometry() if screen is not None else None
        x, y = global_pos.x(), global_pos.y()
        if geo is not None:
            x = max(geo.left(), min(x, geo.right() - self.width() + 1))
            y = max(geo.top(), min(y, geo.bottom() - self.height() + 1))
        self.move(x, y)
        self.show()
        self.raise_()

    def close_once(self):
        self.hide()


class FusionFenglingMenu(OriginalFenglingMenu):
    """正式风铃面板的融合适配：保留布局，只把动作请求移到线程。"""

    action_ready = pyqtSignal(object)

    def __init__(self, ball):
        super().__init__(ball)
        self._fusion_action_seq = 0
        self.action_ready.connect(self._apply_fusion_action)

    def prepare_for_show(self):
        # 原版风铃球每次打开面板都会立刻 refresh_async，融合球打开风铃页时
        # 也要立即刷一次：否则首开面板只渲染融合球启动时的空缓存，互动/送礼
        # 选项和当前对话要干等 10 秒的 target_timer 才有内容，看起来像读不了。
        super().prepare_for_show()
        self.refresh_async()

    def _do_action(self, vtype, item_id):
        self._fusion_action_seq += 1
        seq = self._fusion_action_seq
        self._set_busy(True)
        self._flash("正在送出…")
        self.lbl_feedback.repaint()

        def worker():
            result = None
            try:
                result = self.ball._do_visit(vtype, item_id)
            except urllib.error.HTTPError as error:
                try:
                    body = json.loads(error.read().decode("utf-8"))
                    result = {"success": False, "error": body.get("error", f"出错了 ({error.code})")}
                except Exception:
                    result = {"success": False, "error": f"出错了 ({error.code})"}
            except TimeoutError:
                result = {"success": False, "error": "处理得有点久，可能已经送达，先别重复点"}
            except Exception:
                result = {"success": False, "error": "连不上闲不住，看看它开着没"}

            catalog = None
            if result and (result.get("success") or result.get("ok")):
                try:
                    catalog = _ORIGINAL_FENGLING.api_get("/catalog", timeout=4)
                except Exception:
                    pass
            try:
                self.action_ready.emit({"seq": seq, "result": result or {}, "catalog": catalog})
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="fusion-fengling-action").start()

    def _apply_fusion_action(self, payload):
        if payload.get("seq") != self._fusion_action_seq:
            return
        self._set_busy(False)
        result = payload.get("result") or {}
        catalog = payload.get("catalog")
        if catalog and catalog.get("ok"):
            self.ball.catalog = catalog
            self._update_jar()
        if result.get("success") or result.get("ok"):
            if result.get("target"):
                target = result.get("target")
                self.ball.target = target
                self.ball.target_mode = "pinned" if target.get("mode") == "pinned" else "auto"
                self.ball.pinned_target = target.get("pinned")
                self._update_target_label()
            self._flash("送达了")
        else:
            self._flash(result.get("error", "发送失败"))


def _move_fusion_panel_left(panel):
    """融合面板沿用原版左侧锚点，只有左缘没有空间时才翻到右侧。"""
    sync_size = getattr(panel, "_sync_size", None)
    if callable(sync_size):
        sync_size()
    ball = panel.ball
    screen = ball.screen() or QApplication.primaryScreen()
    if screen is None:
        return
    geo = screen.availableGeometry()
    bw, bh = ball.width(), ball.height()
    x = ball.x() - panel.width() - 8
    if x < geo.left():
        x = ball.x() + bw + 8
    x = max(geo.left(), min(x, geo.right() - panel.width() + 1))
    y = _ORIGINAL_ZHUJIAN.popup_anchor_y(
        (ball.x(), ball.y(), bw, bh),
        panel.height(),
        (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
        _ORIGINAL_ZHUJIAN.PANEL_ANCHOR_RATIO,
    )
    panel.move(x, y)


class FusionZhujianMenu(OriginalZhujianMenu):
    """正式解语花面板，只替换融合态的默认锚向。"""

    def _open_read_panel(self):
        # 原版按钮默认直接 new ReadPanel；融合态必须交给 FusionMenu，
        # 才能拿到融合专用的淡出/锚定适配，避免入口分叉成两种朗读窗。
        owner = getattr(self.ball, "menu", None)
        if owner is not None and hasattr(owner, "open_read_panel"):
            owner.open_read_panel()
            return
        super()._open_read_panel()

    def move_to_ball(self):
        _move_fusion_panel_left(self)


class FusionReadPanel(FadeMixin, OriginalReadPanel):
    """正式朗读面板 + 原版同款离开淡出 + 融合态左侧锚点。"""

    def __init__(self, ball):
        super().__init__(ball)
        self._setup_fade()

    def open_for(self, *args, **kwargs):
        self._fade_to(1.0, 0)
        return super().open_for(*args, **kwargs)

    def move_to_ball(self):
        _move_fusion_panel_left(self)


# ─────────────────────────────────────────────────────────────
# 正式版左键面板适配
# 旧的轻量原型类保留在上方作历史参考；这里用正式版类作为实际实现，
# 两页只共用一个 FusionBall 和一个 ReadPanel 实例。
# ─────────────────────────────────────────────────────────────
class FusionMenu:
    PAGE_FENGLING = 0
    PAGE_ZHUJIAN = 1

    def __init__(self, ball):
        self.ball = ball
        self.current = self.PAGE_FENGLING
        self.fengling_page = FusionFenglingMenu(ball)
        self.jiegehua_page = FusionZhujianMenu(ball)
        self.pages = (self.fengling_page, self.jiegehua_page)
        self._switch_buttons = []
        self._install_switchers()
        self.apply_theme()
        for page in self.pages:
            page.hide()

    @property
    def active_page(self):
        return self.pages[self.current]

    def _install_switchers(self):
        for page in self.pages:
            row = QHBoxLayout()
            row.setContentsMargins(0, 0, 0, 2)
            row.setSpacing(6)
            buttons = []
            for index, label in (
                (self.PAGE_FENGLING, "风铃"),
                (self.PAGE_ZHUJIAN, "解语花"),
            ):
                button = QPushButton(label)
                button.setCursor(Qt.CursorShape.PointingHandCursor)
                button.clicked.connect(
                    lambda _checked=False, index=index: self.switch_page(index, show=True)
                )
                row.addWidget(button)
                buttons.append(button)
            page.layout().insertLayout(0, row)
            self._switch_buttons.append(buttons)

    def _style_switchers(self):
        for page_index, buttons in enumerate(self._switch_buttons):
            for index, button in enumerate(buttons):
                active = index == self.current
                button.setStyleSheet(
                    f"QPushButton {{ color:{C_INK}; background:{C_MINT if active else '#fffdf8'}; "
                    f"border:1px solid {C_MINT_DEEP if active else '#e7d2ac'}; "
                    "border-radius:9px; padding:6px 0; font-size:11px; font-weight:"
                    f"{'600' if active else '400'}; }}"
                    f"QPushButton:hover {{ background:{C_MINT}; }}"
                )

    def apply_theme(self):
        # 解语花原版负责自己的完整颜色体系；风铃原版是固定暖色，保持原样。
        self.jiegehua_page.apply_theme()
        self._style_switchers()

    def update_hint(self):
        updater = getattr(self.jiegehua_page, "_update_hint", None)
        if updater is not None:
            updater()

    def isVisible(self):
        return any(page.isVisible() for page in self.pages) or bool(
            self.ball.read_panel is not None and self.ball.read_panel.isVisible()
        )

    def _show_page(self, page):
        if page is self.jiegehua_page:
            if page.is_ask_open():
                page._ask_user_hidden = False
            else:
                page.prepare_for_show()
        else:
            page.prepare_for_show()
        page.move_to_ball()
        page.show()
        page.raise_()
        page.activateWindow()
        is_ask = page is self.jiegehua_page and page.is_ask_open()
        self.ball._set_fusion_panel_state("ask" if is_ask else "menu")

    def switch_page(self, page_index, show=True):
        page_index = self.PAGE_ZHUJIAN if int(page_index) == self.PAGE_ZHUJIAN else self.PAGE_FENGLING
        if page_index != self.current:
            if self.ball.read_panel is not None and self.ball.read_panel.isVisible():
                self.ball.read_panel.close()
            # 手动切页就是把当前页暂时收起；Ask 页要保留题目但标记为用户主动隐藏，
            # 防止下一轮后台轮询立刻把同一道题抢回来。
            current_page = self.active_page
            if current_page.isVisible():
                current_page.close_menu()
        for page in self.pages:
            if page.isVisible():
                page.hide()
        self.current = page_index
        self._style_switchers()
        if show:
            self._show_page(self.active_page)

    def popup_near(self, _ball=None):
        self._show_page(self.active_page)

    def move_to_ball(self):
        for page in self.pages:
            if page.isVisible():
                page.move_to_ball()
        if self.ball.read_panel is not None and self.ball.read_panel.isVisible():
            self.ball.read_panel.move_to_ball()

    def close_once(self):
        for page in self.pages:
            if page.isVisible():
                page.close_menu()
        if self.ball.read_panel is not None and self.ball.read_panel.isVisible():
            self.ball.read_panel.close()
        self.ball._set_fusion_panel_state("none")

    def open_read_panel(self):
        self.close_once()
        if self.ball.read_panel is None:
            self.ball.read_panel = FusionReadPanel(self.ball)
        self.ball.read_panel.open_for(self.ball.target_name, start=False)
        self.ball._set_fusion_panel_state("read")

    def open_inherited_ask(self, payload):
        pending = payload.get("pending") if isinstance(payload, dict) else []
        ask = None
        for item in pending or []:
            if not isinstance(item, dict) or not item.get("askId"):
                continue
            if ask is None or int(item.get("ts") or 0) >= int(ask.get("ts") or 0):
                ask = item
        if ask is not None:
            self.jiegehua_page.show_ask(ask)
            self.jiegehua_page.show()
            self.jiegehua_page.raise_()

    # 兼容旧测试/旧启动路径：页面内容现在由正式版面板自己渲染。
    def _render_page(self):
        self.switch_page(self.current, show=self.isVisible())


class FusionContextMenu(_ORIGINAL_FENGLING.FenglingContextMenu):
    """融合球右键菜单：原版二级声音档位菜单 + 解语花发送方式二选一。"""

    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.setStyleSheet(f"""
            QMenu {{
                background: {C_BG}; color: {C_INK};
                border: 1px solid {C_BORDER}; border-radius: 10px;
                padding: 5px;
            }}
            QMenu::item {{ padding: 7px 18px; border-radius: 7px; }}
            QMenu::item:selected {{ background: #f1e3c8; }}
        """)
        volume_menu = _ORIGINAL_FENGLING.FenglingContextMenu(self)
        volume_menu.setTitle("声音大小")
        self.addMenu(volume_menu)
        volume_group = QActionGroup(volume_menu)
        volume_group.setExclusive(True)
        for label, volume in _ORIGINAL_FENGLING.VOLUME_LEVELS:
            action = volume_menu.addAction(label)
            action.setCheckable(True)
            action.setChecked(self.ball.sound_volume == volume)
            volume_group.addAction(action)
            action.triggered.connect(
                lambda _checked=False, selected=volume: self.ball._set_volume(selected)
            )
        # 解语花 · 发送方式：对齐原版解语花右键浮签的「直接发出 / 复制」二选一。
        # 标题标明这是解语花的选项；选中态与落盘状态/解语花代理同步（ball._set_action）。
        send_menu = QMenu("解语花 · 发送方式", self)
        self.addMenu(send_menu)
        send_group = QActionGroup(send_menu)
        send_group.setExclusive(True)
        for label, mode in (("直接发出", "send"), ("复制", "copy")):
            choice = send_menu.addAction(label)
            choice.setCheckable(True)
            choice.setChecked(self.ball.action == mode)
            send_group.addAction(choice)
            choice.triggered.connect(
                lambda _checked=False, mode=mode: self.ball._set_action(mode)
            )
        self.addSeparator()
        close_action = self.addAction("关闭悬浮球")
        close_action.triggered.connect(self._close_ball)

    def _close_ball(self):
        self.close_once()
        self.ball.close()

    def popup_near(self, ball):
        menu_size = self.sizeHint()
        screen = ball.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry() if screen is not None else None
        x = ball.x() + ball.width() + 8
        if geo is not None and x + menu_size.width() > geo.right():
            x = ball.x() - menu_size.width() - 8
        if geo is not None:
            y = _ORIGINAL_ZHUJIAN.popup_anchor_y(
                (ball.x(), ball.y(), ball.width(), ball.height()),
                menu_size.height(),
                (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
                0.33,
            )
            x = max(geo.left(), min(x, geo.right() - menu_size.width() + 1))
        else:
            y = ball.y() + 10
        self.exec(QPoint(x, y))

    def move_to_ball(self):
        # QMenu.exec 自己负责定位和子菜单事件循环；保留旧调用方接口。
        return None

    def close_once(self):
        self.close()


def main():
    app = QApplication(sys.argv)
    ball = FusionBall()
    try:
        start_x = int(os.environ.get("FUSION_START_X", "500"))
        start_y = int(os.environ.get("FUSION_START_Y", "300"))
    except ValueError:
        start_x, start_y = 500, 300
    screen = QApplication.screenAt(QPoint(start_x, start_y)) or QApplication.primaryScreen()
    if screen is not None:
        geo = screen.availableGeometry()
        start_x, start_y = clamp_position(
            start_x,
            start_y,
            BALL_W,
            BALL_H,
            geo.left(),
            geo.top(),
            geo.right(),
            geo.bottom(),
        )
    ball.move(start_x, start_y)
    ball.show()
    if INHERITED_PANEL in {"ask", "read"}:
        QTimer.singleShot(120, ball.open_inherited_panel)
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
