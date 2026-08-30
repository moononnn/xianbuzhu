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
import shutil
import threading
import urllib.request
import urllib.error
import urllib.parse

try:
    import winsound
except ImportError:
    winsound = None

try:
    import fengling_dsp
except ImportError:
    fengling_dsp = None

from PyQt6.QtCore import Qt, QTimer, QPoint, QPointF, QUrl, pyqtSignal, QPropertyAnimation
from PyQt6.QtGui import (
    QPixmap, QPainter, QPainterPath, QPen, QColor,
    QFont, QFontMetrics, QCursor, QLinearGradient,
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
# 本地代理随机鉴权 token：由 Hana 侧生成并随环境变量注入，请求时带 Authorization: Bearer
API_TOKEN = os.environ.get("XIANBUZHU_TOKEN", "")
HANA_HOME = os.environ.get("HANA_HOME", os.path.join(os.path.expanduser("~"), ".hanako"))
STATE_PATH = os.path.join(HANA_HOME, "data", "work-visit", "fengling-state.json")
AUDIO_CACHE_DIR = os.path.join(HANA_HOME, "data", "work-visit", "fengling-audio-cache")
HERE = os.path.dirname(os.path.abspath(__file__))
# 风铃进程 PID 文件：闲不住侧以「这个文件里存活的 PID」作为风铃是否在跑的事实源，
# 避免 Hana 重启/插件重载后插件丢句柄、却不知道球还飘在桌面上的失忆状态。
PID_PATH = os.path.join(HANA_HOME, "data", "work-visit", "fengling.pid")
# 失联自愈计数器：代理连续失联到阈值后自动退出，不留孤儿球。
_liveness_misses = 0
_LIVENESS_MAX_MISSES = 12   # 约 60 秒（配合 5s 轮询）内全部请求失败即视为失联

# 碰撞音色池只生成一次，所有风铃实例共享（wav bytes 不可变，安全）。
_CHIME_POOL_CACHE = None

BALL_SIZE = 108          # 悬浮球显示尺寸：比旧版更小巧
SVG_SIZE = 400           # SVG viewBox 尺寸
RENDER_SCALE = 3         # 高清渲染倍率，缩放后保留瓷面细节
BELL_PIVOT = (200 * RENDER_SCALE, 36 * RENDER_SCALE)
PAPER_PIVOT = (200 * RENDER_SCALE, 246 * RENDER_SCALE)
LINK_TOP = (200 * RENDER_SCALE, 112 * RENDER_SCALE)
CLAPPER_LENGTH = 74 * RENDER_SCALE   # 铃舌中心停在铃口平面附近：上半在铃内碰壁、下半只探出一点（跟以前一致，不露肚皮）
CLAPPER_RX = 16                      # 黄色铃舌略放大，最终尺寸下仍只露一小截
CLAPPER_RY = 13
CLAPPER_DRAW_DROP = 0.0   # 绘制回到物理挂点：黄色铃舌只从铃口露出一点，物理碰撞点不变
CLICK_CLAPPER_KICK = 64.0  # 鼠标轻点给铃舌一个短促冲量，确保点击也能听到一声
PAPER_LINE_LENGTH = 60 * RENDER_SCALE
CLAPPER_LIMIT = 11.0     # 放大后的铃舌更早接触铃口，碰壁频率随几何同步提高
# 拖动物理只吃窗口真实位移，不直接吃鼠标坐标；这样面板联合限位或贴边后不会继续凭空加速。
DRAG_MAX_SPEED = 2400.0
DRAG_FILTER_TAU = 0.035
DRAG_STALE_AFTER = 0.055
DRAG_DECAY_TAU = 0.20   # 拖速衰减更慢：松手后惯性多留一瞬，甩出去有荡回来的余势
# 拖动风感：短册和铃舌看到的是与窗口运动相反的相对风（全矢量）。
# 风大小随拖速平滑增强：慢拖近乎跟手（没有风就不该被吹走），快拖把悬挂件
# 压向反方向；斜拖/竖拖的垂直分量折算进风速，并让纸片被上升气流吹起。
# 松手后风目标随拖速衰减，悬挂件靠阻尼自然回摆，形成「被风吹过又荡回来」的余势。
TANZAKU_AIR_FULL_SPEED = 480.0  # 达到此速度视为完整强风（更早顶格，中速就猛）
TANZAKU_AIR_MAX_ANGLE = 55.0    # 快拖时短册被压到大偏角（配合限位放开，能看见明显飞起）
TANZAKU_AIR_RESPONSE_SPEED = 75.0
TANZAKU_AIR_OFFSET_MIN = 10.0   # 慢拖几乎不偏：没有风就不该被吹走
TANZAKU_AIR_OFFSET_MAX = 210.0  # 快拖时约 57px 屏幕位移，绳弧明显拉开
TANZAKU_AIR_LIFT_MAX = 90.0     # 向下拖时纸片被上升相对气流吹起（SVG 像素）
TANZAKU_AIR_LIFT_SPEED = 340.0  # 达到此竖直拖速视为完整上浮
CLAPPER_AIR_FULL_SPEED = 560.0
CLAPPER_AIR_MAX_ANGLE = 13.0    # 快拖时铃舌被风压向铃口一侧（贴壁但不越壁狂响）
CLAPPER_AIR_RESPONSE_SPEED = 90.0
CLAPPER_SPIN_DAMP = 2.2
CLAPPER_SPIN_CENTER = 3.0   # 铃舌轻微回正即可，不硬拽
PAPER_SPIN_DAMP = 0.9
PAPER_SPIN_CENTER = 2.0
EDGE_INSET = 16          # 贴边仍留出可见余量，兼容远程缩放与 DPI 变化
MIN_WIND_STRENGTH = 0.62 # 慢慢靠近时仍有清楚但克制的风
MAX_WIND_STRENGTH = 1.45 # 快速掠过时增强阵风，避免无限放大
FULL_GUST_SPEED = 1200.0 # px/s；达到此速度视为完整强风
CHIME_UPPER_ZONE = (36, 22, 72, 58)   # 单铃铃身与挂绳的可见范围
CHIME_LOWER_ZONE = (40, 50, 70, 92)   # 铃舌与摆动短册的可见范围
HOVER_EXIT_MARGIN = 8                # 离开判定略宽于进入区，保留滞回
HOVER_LEAVE_DELAY = 0.24             # 光标明确离开一小会儿后才散风
CLAPPER_SPRING = 7.5  # 铃舌牵引放软：更重更滞后，追不上短册，形成被风拖着的飘
CLAPPER_DAMP = 2.8    # 铃舌阻尼稍强：快拖后有明显回摆余势，不抖不飘忽
CHIME_MIN_IMPACT = 7.0  # 铃舌向外撞壁的速度阈值（度/秒），轻碰也响
CHIME_COOLDOWN = 0.10    # 两次响铃最小间隔：防同一次反弹连击，允许更高响应密度
DRAG_CHIME_WINDOW_S = 1.0    # 拖动结束后的余势响铃窗口：期内非悬停撞壁也出声，画面声音同步
HOVERLESS_CHIME_VOLUME = 0.7 # 非悬停响铃音量倍率：悬停/送达为 1.0，余势轻轻一点
# 送达响铃：给铃舌的真实晃动冲量（度/秒）。从静止施加后必然越过铃口限位撞壁，
# 由撞击触发 _play_chime，音量随撞击力度走（因动而声），不再单独播 WAV。
# 三次交替 kick 对应三声，力度逐次衰减模拟风铃被风吹动的自然收势。
DELIVERY_KICK = 200.0
DELIVERY_RING_WINDOW_S = 2.0  # 送达响铃窗口：期内允许非悬停撞壁发声，其他时间维持原规则
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

# ── 弹出窗垂直锚点（铃铛中心位于弹出窗高度中的比例，0.5=居中） ──
PANEL_ANCHOR_RATIO = 0.38   # 左键动作面板：主体在铃铛下方（悬浮球偏好规范）
MENU_ANCHOR_RATIO = 0.33    # 右键菜单：主体在铃铛下方，与面板视觉呼应
TARGET_SESSION_LIMIT = 5    # 手动选择只展示最近 5 个对话，避免面板过长

# ── 弹窗鼠标离开自动半透明（与解语花悬浮球同款节奏） ──
FADE_OUT_OPACITY = 0.60      # 半透明下限：留存在感，鼠标也找得到窗口
FADE_OUT_DELAY_MS = 450      # 鼠标离开后的宽限，防止快速穿越边缘抖动
FADE_SHOW_GRACE_MS = 900     # 刚弹出时的缓冲：光标不在窗内也先全显
FADE_OUT_DURATION_MS = 420   # 淡出渐变时长（慢慢隐退）
FADE_IN_DURATION_MS = 180    # 恢复渐变时长（回来要快）

# 新心意到达时只发出送达提示音；是否查看心意由用户点击风铃决定。


def popup_anchor_y(anchor_rect, popup_height, bounds, anchor_ratio):
    """垂直锚点：anchor_ratio 是锚点中心在弹出窗高度中的位置（0~1），
    0.5=垂直居中，>0.5 偏上，<0.5 偏下。返回 clamped 后的 y。"""
    ay, ah = anchor_rect[1], anchor_rect[3]
    _, top, _, bottom = bounds
    y = ay + ah // 2 - int(popup_height * anchor_ratio)
    return max(top, min(y, bottom - popup_height))


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


def sample_drag_velocity(
    previous_x,
    previous_y,
    previous_ts,
    previous_vx,
    previous_vy,
    current_x,
    current_y,
    current_ts,
):
    """从窗口真实位移估算平滑拖速，并给出本帧速度变化量。

    速度做矢量限幅，避免系统偶发合并鼠标事件时把一个大跳点放大成抽搐；
    首帧提高跟手权重，后续再用短时间常数滤掉事件间隔抖动。
    """
    elapsed = max(float(current_ts) - float(previous_ts), 1.0 / 240.0)
    raw_vx = (float(current_x) - float(previous_x)) / elapsed
    raw_vy = (float(current_y) - float(previous_y)) / elapsed
    raw_speed = math.hypot(raw_vx, raw_vy)
    if raw_speed > DRAG_MAX_SPEED:
        scale = DRAG_MAX_SPEED / raw_speed
        raw_vx *= scale
        raw_vy *= scale
    alpha = 1.0 - math.exp(-min(elapsed, 0.12) / DRAG_FILTER_TAU)
    if math.hypot(float(previous_vx), float(previous_vy)) < 1.0:
        alpha = max(alpha, 0.62)
    vx = float(previous_vx) + (raw_vx - float(previous_vx)) * alpha
    vy = float(previous_vy) + (raw_vy - float(previous_vy)) * alpha
    return vx, vy, vx - float(previous_vx), vy - float(previous_vy), math.hypot(vx, vy)


def _reverse_airflow_value(
    velocity_x, velocity_y, full_speed, max_value, min_value=0.0
):
    """全矢量相对风：风速大小决定风力（平滑平方），水平方向决定吹向哪边。

    垂直分量按 0.6 折算进风速感受：斜拖/竖拖风力更大，但纯垂直拖动
    （vx≈0）不会把纸片吹横，只走上浮通道（tanzaku_airflow_lift）。
    """
    vx = float(velocity_x)
    speed = math.hypot(vx, float(velocity_y) * 0.6)
    if speed < 1e-6 or abs(vx) < 1e-6:
        return 0.0
    ratio = max(0.0, min(speed / float(full_speed), 1.0))
    strength = ratio * ratio * (3.0 - 2.0 * ratio)
    value = float(min_value) + (float(max_value) - float(min_value)) * strength
    return -math.copysign(value, vx)


def _reverse_airflow_target(velocity_x, velocity_y, full_speed, max_angle):
    return _reverse_airflow_value(velocity_x, velocity_y, full_speed, max_angle)


def _airflow_influence(velocity_x, velocity_y, response_speed):
    speed = math.hypot(float(velocity_x), float(velocity_y) * 0.6)
    return max(0.0, min(speed / float(response_speed), 1.0))


def _paper_airflow_target(velocity_x, velocity_y, full_speed, max_angle):
    """纸片倾斜风角，符号与结点位移方向相反。

    几何勾稽（PyQt6 实测）：painter.rotate(+θ) 是视觉逆时针，纸片底部
    （局部 y 正方向）会向左倾。右拖（vx>0）时相对风向向左，纸片应向左倾 →
    需要正角 → +copysign。结点位移（tanzaku_airflow_offset 的 -copysign）
    让结点向左，两者方向一致，才是整体被风吹向反方向。
    """
    vx = float(velocity_x)
    speed = math.hypot(vx, float(velocity_y) * 0.6)
    if speed < 1e-6 or abs(vx) < 1e-6:
        return 0.0
    ratio = max(0.0, min(speed / float(full_speed), 1.0))
    strength = ratio * ratio * (3.0 - 2.0 * ratio)
    value = float(max_angle) * strength
    return math.copysign(value, vx)


def tanzaku_airflow_target(velocity_x, velocity_y=0.0):
    """把拖动速度换成短册的反向相对风倾斜角；短册是最明显的迎风面。"""
    return _paper_airflow_target(
        velocity_x, velocity_y, TANZAKU_AIR_FULL_SPEED, TANZAKU_AIR_MAX_ANGLE
    )


def tanzaku_airflow_influence(velocity_x, velocity_y=0.0):
    """让短册在普通拖速下就开始持续偏向拖动反方向。"""
    return _airflow_influence(velocity_x, velocity_y, TANZAKU_AIR_RESPONSE_SPEED)


def tanzaku_airflow_offset(velocity_x, velocity_y=0.0):
    """给短册结点一个可见的反向风偏移，避免只靠小角度旋转看不出被吹走。"""
    return _reverse_airflow_value(
        velocity_x,
        velocity_y,
        TANZAKU_AIR_FULL_SPEED,
        TANZAKU_AIR_OFFSET_MAX,
        TANZAKU_AIR_OFFSET_MIN,
    )


def tanzaku_airflow_lift(velocity_y):
    """向下拖动时纸片被上升相对气流吹起（返回负值=上浮）；向上拖不压下。

    风是相对运动产生的：窗口向下移，纸片看到的风从下方来，把它往上托。
    向上的相对风被重力抵消，不专门做下沉。
    """
    vy = float(velocity_y)
    if vy <= 1e-6:
        return 0.0
    ratio = max(0.0, min(vy / TANZAKU_AIR_LIFT_SPEED, 1.0))
    strength = ratio * ratio * (3.0 - 2.0 * ratio)
    return -TANZAKU_AIR_LIFT_MAX * strength


def clapper_airflow_target(velocity_x, velocity_y=0.0):
    """把拖动速度换成铃舌的反向相对风目标角。"""
    return _reverse_airflow_target(
        velocity_x, velocity_y, CLAPPER_AIR_FULL_SPEED, CLAPPER_AIR_MAX_ANGLE
    )


def clapper_airflow_influence(velocity_x, velocity_y=0.0):
    """让铃舌的反向风感在普通拖速下就接近完整，不等铃身高速才出现。"""
    return _airflow_influence(velocity_x, velocity_y, CLAPPER_AIR_RESPONSE_SPEED)


def wind_chime_drag_targets(velocity_x, velocity_y):
    """把拖动速度翻译成悬挂件目标：铃身轻微逆风，短册和铃舌吃全矢量反向相对风。"""
    vx = float(velocity_x)
    vy = float(velocity_y)
    bell = max(-10.5, min(-vx * 0.011, 10.5))
    paper = tanzaku_airflow_target(vx, vy)
    clapper = clapper_airflow_target(vx, vy)
    spin_drive = max(-105.0, min(vx * 0.036 + vy * 0.044, 105.0))
    return bell, paper, clapper, spin_drive


def wind_chime_drag_impulses(delta_vx, delta_vy):
    """加速、急停与反向时的瞬时惯性；符号与窗口运动相反，释放后会越过重心。"""
    dvx = float(delta_vx)
    dvy = float(delta_vy)
    return (
        max(-26.0, min(-dvx * 0.034, 26.0)),
        max(-52.0, min(-dvx * 0.066, 52.0)),
        max(-48.0, min(-dvx * 0.050 + dvy * 0.022, 48.0)),
        max(-120.0, min(dvx * 0.13 + dvy * 0.10, 120.0)),
    )


def advance_clapper_spin(angle, velocity, drive, dt):
    """铃舌绕悬线的扭转：有惯性、弱回正，可被下一次拖动连续打断。"""
    dt = max(0.0, min(float(dt), 0.05))
    acceleration = (
        float(drive) * 1.18
        - float(velocity) * CLAPPER_SPIN_DAMP
        - math.sin(math.radians(float(angle))) * CLAPPER_SPIN_CENTER
    )
    velocity = float(velocity) + acceleration * dt
    angle = float(angle) + velocity * dt
    angle = (angle + 180.0) % 360.0 - 180.0
    if abs(angle) < 0.01 and abs(velocity) < 0.02 and abs(float(drive)) < 0.02:
        return 0.0, 0.0
    return angle, velocity


def clapper_disc_projection(spin_angle):
    """把绕竖轴自转投影到二维：正面最宽，侧面收窄，亮边随朝向换侧。"""
    radians = math.radians(float(spin_angle))
    facing = math.cos(radians)
    width_scale = 0.72 + 0.28 * abs(facing)
    roll = math.sin(radians) * 6.0    # 铃舌保持圆润，只轻微侧倾不压扁
    highlight = -0.58 * facing        # 高光随朝向扫过，读得出"自己在转"
    return width_scale, roll, highlight


def advance_paper_spin(angle, velocity, drive, dt):
    """纸片绕悬线的飘转：惯性小，被风带起后能连续翻转一整圈（360°），
    弱回正（停止驱动后慢慢飘回正面）。"""
    dt = max(0.0, min(float(dt), 0.05))
    acceleration = (
        float(drive) * 1.0
        - float(velocity) * PAPER_SPIN_DAMP
        - math.sin(math.radians(float(angle))) * PAPER_SPIN_CENTER
    )
    velocity = float(velocity) + acceleration * dt
    angle = float(angle) + velocity * dt
    angle = (angle + 180.0) % 360.0 - 180.0
    if abs(angle) < 0.01 and abs(velocity) < 0.02 and abs(float(drive)) < 0.02:
        return 0.0, 0.0
    return angle, velocity


def paper_twist_projection(twist_angle):
    """把纸片绕竖轴偏转投影成二维：正面全宽，转侧面时收窄并侧倾（可读翻转）。"""
    radians = math.radians(float(twist_angle))
    facing = math.cos(radians)
    width_scale = 0.20 + 0.80 * abs(facing)
    roll = math.sin(radians) * 6.0
    return width_scale, roll


def draw_tanzaku_paper(painter, spin_angle, scale=RENDER_SCALE,
                       front=None, back=None):
    """程序化绘制短册（铃舌/红色竖条）：正面亮粉、背面淡紫，两面都明亮，
    靠色相+花纹区分；纸片带一点「拧」——下段比上段慢半拍，转起来有麻花扭转感，
    侧面画 S 形弧线像纸片弯面的剖面。front/back 为
    (渐变顶色, 渐变底色, 描边色, 纹路色, 折痕色) 元组，不传用默认。
    挂点（knot 珠下缘）为原点。原版与融合版共用。"""
    if front is None:
        front = ("#f9c7d2", "#e895aa", "#c9788f", "#d88198", "#e88aa3")
    if back is None:
        back = ("#e3d5f5", "#cfb4e8", "#b59cd4", "#bda5d8", "#c4aede")
    front_top, front_bot, front_edge, front_mark, front_crease = front
    back_top, back_bot, back_edge, back_mark, back_crease = back

    TWIST_LAG = 26.0          # 底部相对顶部滞后的拧角（麻花感的来源）
    radians = math.radians(float(spin_angle))
    top_facing = math.cos(radians)
    bot_facing = math.cos(math.radians(float(spin_angle) - TWIST_LAG))
    top_back = top_facing < 0.0
    bot_back = bot_facing < 0.0
    fade = 0.66 + 0.34 * abs(top_facing)
    near_side = abs(top_facing) < 0.15     # 真·正侧面才画 S 弧；拧的过渡留给渐变体

    half_w = 14.0 * scale           # 顶部半宽（整体稍收，不矮胖）
    # 拧的宽度差：下段按底部朝向的相对投影宽度，翻面中途下段宽一点点（不靠分色表达拧）
    main_ws = 0.20 + 0.80 * abs(top_facing)
    bot_ws = 0.20 + 0.80 * abs(bot_facing)
    w_ratio = max(0.55, min(bot_ws / max(main_ws, 0.001), 1.35))
    half_w_bot = half_w * w_ratio   # 底部半宽（随拧动态，上窄下宽有收束感）
    mid_w = (half_w + half_w_bot) * 0.5
    top_y = 4.5 * scale             # 紧贴 knot 珠下缘，消除断开缝隙
    body_h = 60.0 * scale           # 拉长：主体到 60
    v_deep = 70.0 * scale           # V 剪口底
    v_mid = 63.0 * scale            # V 剪口中凹
    mid_y = (top_y + body_h) * 0.5

    painter.save()
    painter.setOpacity(fade)

    if near_side:
        # 正侧面：S 形双弧线（上段弯向一侧、下段弯回），麻花拧的剖面，弧度大且够粗
        painter.setOpacity(0.82)
        arc_bend = math.sin(radians) * 6.0 * scale
        arc_col = back_edge if top_back else front_edge
        pen = QPen(QColor(arc_col), 6.5 * scale)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        arc = QPainterPath(QPointF(0.0, top_y))
        arc.quadTo(
            QPointF(arc_bend, (top_y + v_mid) * 0.33),
            QPointF(arc_bend * 0.62, (top_y + v_mid) * 0.5),
        )
        arc.quadTo(
            QPointF(-arc_bend * 0.45, (top_y + v_mid) * 0.74),
            QPointF(0.0, v_mid),
        )
        painter.drawPath(arc)
        painter.restore()
        return

    # 主体形状：顶部半宽 half_w → 底部半宽 half_w_bot，侧边微鼓（拉长后的瘦长轮廓）
    path = QPainterPath()
    path.moveTo(-half_w * 0.94, top_y)
    path.quadTo(0.0, top_y - 3.0 * scale, half_w * 0.94, top_y)
    path.quadTo(mid_w * 1.05, mid_y, half_w_bot * 0.96, body_h)
    path.lineTo(half_w_bot * 0.5, v_deep)
    path.lineTo(0.0, v_mid)
    path.lineTo(-half_w_bot * 0.5, v_deep)
    path.lineTo(-half_w_bot * 0.96, body_h)
    path.quadTo(-mid_w * 1.05, mid_y, -half_w * 0.94, top_y)
    path.closeSubpath()

    # 整片按主朝向配色：正面整片粉、背面整片淡紫，不做上下分色（小尺寸下分色像渲染 bug）
    top_col = (back_top, back_bot) if top_back else (front_top, front_bot)
    grad = QLinearGradient(0.0, top_y, 0.0, v_deep)
    grad.setColorAt(0.0, QColor(top_col[0]))
    grad.setColorAt(1.0, QColor(top_col[1]))

    pen = QPen(QColor(back_edge if top_back else front_edge), 1.6 * scale)
    pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
    painter.setPen(pen)
    painter.setBrush(grad)
    painter.drawPath(path)

    # 折痕中线：随拧的方向斜着走（麻花中线）
    crease_x = (bot_facing - top_facing) * half_w * 0.30
    crease_pen = QPen(QColor(back_crease if top_back else front_crease), 0.8 * scale)
    crease_pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    painter.setPen(crease_pen)
    crease = QPainterPath(QPointF(0.0, top_y + 7.0 * scale))
    crease.quadTo(
        QPointF(crease_x * 0.5, mid_y),
        QPointF(crease_x, body_h - 5.0 * scale),
    )
    painter.drawPath(crease)

    # 高光斜线：顶部高光在 A 侧、底部随拧移到另一侧（螺旋光）
    hl_x1 = -top_facing * half_w * 0.42
    hl_x2 = -bot_facing * half_w * 0.42
    hl_pen = QPen(QColor(255, 245, 247, 190), (1.9 if not top_back else 1.2) * scale)
    hl_pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    painter.setPen(hl_pen)
    hl = QPainterPath(QPointF(hl_x1, top_y + 4.0 * scale))
    hl.quadTo(
        QPointF((hl_x1 + hl_x2) * 0.5 * 1.1, mid_y),
        QPointF(hl_x2 * 0.92, body_h - 8.0 * scale),
    )
    painter.drawPath(hl)

    # 花纹：正面两条波浪、背面两条横纹（位置随拉长下移）
    if top_back:
        painter.setPen(QPen(QColor(back_mark), 1.0 * scale))
        painter.drawLine(
            QPointF(-3.5 * scale, 26.0 * scale),
            QPointF(3.5 * scale, 26.0 * scale),
        )
        painter.drawLine(
            QPointF(-3.0 * scale, 34.0 * scale),
            QPointF(3.0 * scale, 34.0 * scale),
        )
    else:
        painter.setPen(QPen(QColor(front_mark), 1.0 * scale))
        wave = QPainterPath(QPointF(-4.0 * scale, 21.0 * scale))
        wave.quadTo(QPointF(0.0, 18.0 * scale), QPointF(4.0 * scale, 21.0 * scale))
        wave.moveTo(-5.0 * scale, 30.0 * scale)
        wave.quadTo(QPointF(0.0, 27.0 * scale), QPointF(5.0 * scale, 30.0 * scale))
        painter.drawPath(wave)

    # 顶部小绳结：衔接上方 knot 白珠，堵住断开缝隙
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(QColor("#fff3d9"))
    painter.drawEllipse(QPointF(0.0, top_y - 1.5 * scale), 1.35 * scale, 1.35 * scale)

    painter.restore()


def draw_clapper_disc(painter, center, spin_angle, scale=RENDER_SCALE):
    """绘制带外沿、内面与移动高光的薄片铃舌；原版与融合版共用。
    中心相对物理点下移 CLAPPER_DRAW_DROP，让 cream 从铃口探出更多、绳头接进片内。"""
    width_scale, roll, highlight = clapper_disc_projection(spin_angle)
    rx = max(2.4 * scale, CLAPPER_RX * scale * width_scale)
    ry = CLAPPER_RY * scale
    painter.save()
    painter.translate(center)
    painter.translate(0.0, CLAPPER_DRAW_DROP * scale)
    painter.rotate(roll)

    shadow = QColor(69, 117, 104, 48)
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(shadow)
    painter.drawEllipse(QPointF(0.7 * scale, 1.3 * scale), rx, ry)

    rim_pen = QPen(QColor("#6cae9b"), 1.45 * scale)
    rim_pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
    painter.setPen(rim_pen)
    painter.setBrush(QColor("#f7e7b7"))
    painter.drawEllipse(QPointF(0.0, 0.0), rx, ry)

    inner_pen = QPen(QColor("#fffaf0"), 0.75 * scale)
    painter.setPen(inner_pen)
    painter.setBrush(QColor("#fff3cf"))
    painter.drawEllipse(QPointF(0.0, -0.35 * scale), rx * 0.72, ry * 0.68)

    highlight_x = rx * highlight
    shine_pen = QPen(QColor(255, 255, 255, 205), 0.95 * scale)
    shine_pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    painter.setPen(shine_pen)
    painter.drawLine(
        QPointF(highlight_x, -ry * 0.48),
        QPointF(highlight_x * 0.72, ry * 0.28),
    )
    # 反侧保留一枚薄荷色方向纹：小尺寸下它比纯亮斑更能让人读出“自己在转”。
    marker_x = -highlight_x * 0.82
    marker_pen = QPen(QColor("#4f8f7d"), 2.8 * scale)
    marker_pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    painter.setPen(marker_pen)
    painter.drawLine(
        QPointF(marker_x, -ry * 0.20),
        QPointF(marker_x * 0.78, ry * 0.36),
    )
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(QColor("#d99a4e"))
    painter.drawEllipse(QPointF(0.0, 0.0), 1.35 * scale, 1.35 * scale)
    painter.restore()


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


def resolve_chime_eligibility(hovered, in_delivery_window, dragging, drag_chime_until, now=None):
    """合并响铃资格：悬停气流、送达窗口、拖动中或刚松手的余势摆动，任一即可。

    返回 (允许响铃, 音量倍率)：非悬停且非送达的余势响铃音量压低，
    让"你正逗它"的悬停时刻更突出，同时画面与声音保持同步。
    """
    now = time.monotonic if now is None else now
    in_drag_window = dragging or now() < drag_chime_until
    allowed = hovered or in_delivery_window or in_drag_window
    volume_scale = 1.0 if (hovered or in_delivery_window) else HOVERLESS_CHIME_VOLUME
    return allowed, volume_scale


def chime_volume_from_impact(impact, base, min_impact=CHIME_MIN_IMPACT):
    """撞击越重越响：刚过门槛时约 55% 主音量，40 度/秒以上顶满。"""
    if impact <= min_impact:
        return base * 0.55
    strength = min(1.0, (impact - min_impact) / (40.0 - min_impact))
    return base * (0.55 + 0.45 * strength)


def linkage_points(
    clapper_angle, paper_angle, paper_offset_x=0.0, paper_offset_y=0.0
):
    """计算铃内挂点、铃舌和短册结点；角度单位为度，坐标为高清 SVG 像素。

    paper_offset_x 是反向风的水平偏移，paper_offset_y 是上升气流的上浮偏移。
    """
    top = QPointF(*LINK_TOP)
    clapper_rad = math.radians(clapper_angle)
    clapper = QPointF(
        top.x() + math.sin(clapper_rad) * CLAPPER_LENGTH,
        top.y() + math.cos(clapper_rad) * CLAPPER_LENGTH,
    )
    paper_rad = math.radians(paper_angle)
    knot = QPointF(
        clapper.x() + math.sin(paper_rad) * PAPER_LINE_LENGTH + float(paper_offset_x),
        clapper.y() + math.cos(paper_rad) * PAPER_LINE_LENGTH + float(paper_offset_y),
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


def normalize_sound_state(state):
    """把旧开关/缺省值物化成唯一的四档音量状态，便于其他悬浮球复用。"""
    volume = resolve_saved_volume(state)
    enabled = volume > 0
    changed = (
        state.get("soundVolume") != volume
        or state.get("soundEnabled") != enabled
    )
    state["soundVolume"] = volume
    state["soundEnabled"] = enabled
    return volume, changed


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
def _liveness_error(e):
    """判断一次请求失败是否属于『结构失联』：token 失效 / 代理没起来 / 连不上。
    业务错误（409 没找到目标、500 内部错误等）不算，不触发自愈。"""
    if isinstance(e, urllib.error.HTTPError):
        return e.code in (401, 403, 404)
    if isinstance(e, (urllib.error.URLError, OSError, TimeoutError)):
        return True
    return False


def _mark_liveness(ok):
    global _liveness_misses
    _liveness_misses = 0 if ok else _liveness_misses + 1


def _headers():
    h = {"Content-Type": "application/json"}
    if API_TOKEN:
        h["Authorization"] = "Bearer " + API_TOKEN
    return h


def api_get(path, timeout=5):
    req = urllib.request.Request(API_BASE + path, headers=_headers(), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
        _mark_liveness(True)
        return data
    except Exception as error:
        if _liveness_error(error):
            _mark_liveness(False)
        raise


def api_post(path, payload, timeout=12):
    req = urllib.request.Request(
        API_BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers=_headers(),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
        _mark_liveness(True)
        return data
    except Exception as error:
        if _liveness_error(error):
            _mark_liveness(False)
        raise


# ─────────────────────────────
#  PID 文件（给闲不住侧做状态探测的握手）
# ─────────────────────────────
def write_pid_file():
    """启动时写下自己的 PID；闲不住插件靠它认领/探测风铃是否在跑。"""
    try:
        os.makedirs(os.path.dirname(PID_PATH), exist_ok=True)
        with open(PID_PATH, "w", encoding="ascii") as f:
            f.write(str(os.getpid()))
        return True
    except Exception as error:
        print(f"[风铃] 写 PID 失败: {error}", file=sys.stderr)
        return False


def clear_pid_file():
    """退出时清理 PID 文件，避免残留让闲不住误判。仅当文件确实是自己的 PID 才删。"""
    try:
        cur = str(os.getpid())
        with open(PID_PATH, "r", encoding="ascii") as f:
            if f.read().strip() != cur:
                return
        os.remove(PID_PATH)
    except Exception:
        pass


def start_liveness_watchdog(interval_ms=5000):
    """代理完全失联约 60 秒后自动退出，不让坏球一直飘在桌面上。"""
    def check():
        if _liveness_misses >= _LIVENESS_MAX_MISSES:
            print(f"[风铃] 与闲不住本地代理失去联系 {_liveness_misses} 次，自动退出", file=sys.stderr)
            QApplication.instance().quit()
    timer = QTimer()
    timer.timeout.connect(check)
    timer.start(interval_ms)
    timer.setParent(QApplication.instance())
    return timer


def load_state():
    """读取状态；主文件异常时回退到最近一次成功写入的备份。"""
    last_error = None
    for candidate in (STATE_PATH, STATE_PATH + ".tmp", STATE_PATH + ".bak"):
        try:
            with open(candidate, "r", encoding="utf-8") as f:
                state = json.load(f)
            if not isinstance(state, dict):
                raise ValueError("状态文件不是对象")
            return state
        except FileNotFoundError:
            continue
        except Exception as error:
            last_error = error
    if last_error is not None:
        print(f"[风铃] 读取状态失败，使用空状态: {last_error}", file=sys.stderr)
    return {}


def save_state(state):
    """原子保存风铃状态，并保留上一份成功状态供重启回退。"""
    temp_path = STATE_PATH + ".tmp"
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        if os.path.exists(STATE_PATH):
            try:
                shutil.copyfile(STATE_PATH, STATE_PATH + ".bak")
            except Exception:
                pass
        os.replace(temp_path, STATE_PATH)
        return True
    except Exception as error:
        print(f"[风铃] 保存状态失败: {error}", file=sys.stderr)
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except Exception:
            pass
        return False


def pending_heart_items(hearts, dismissed_ids=None):
    """返回仍应由风铃保留的未读心意，顺序沿用代理返回的最新→最旧。"""
    dismissed = {str(item) for item in (dismissed_ids or set())}
    pending = []
    for item in hearts or []:
        heart_id = str(item.get("id") or "")
        if not heart_id or heart_id in dismissed:
            continue
        if str(item.get("status") or "").lower() != "unread":
            continue
        if item.get("bellDismissedAt"):
            continue
        pending.append(item)
    return pending


def resolve_heart_poll(seen_ids, hearts, seeded):
    """把轮询结果折成：本轮新送达、应确认 ID、更新后的进程去重集合。"""
    seen = set(seen_ids or set())
    items = [item for item in (hearts or []) if item.get("id")]
    ids = [str(item["id"]) for item in items]
    eligible = pending_heart_items(items)
    if not seeded:
        # 首次启动只为尚未送达的未读心意响铃；已送达但未读的仍留给手动面板查看。
        fresh = [item for item in eligible if not item.get("deliveredAt")]
        seen.update(ids)
        fresh_ids = [str(item["id"]) for item in fresh]
        return seen, fresh, fresh_ids, True
    unseen = [item for item in eligible if str(item["id"]) not in seen]
    # 已送达但仍未读的心意进入待查看队列，不重复播放送达提示。
    fresh = [item for item in unseen if not item.get("deliveredAt")]
    seen.update(str(item["id"]) for item in items if item.get("id"))
    fresh_ids = [str(item["id"]) for item in fresh]
    return seen, fresh, fresh_ids, True


def heart_popup_title(heart):
    """把心意折成风铃弹窗里的一句短提示。"""
    partner = str(heart.get("partnerName") or "有人")
    gift = heart.get("gift") or {}
    name = str(gift.get("name") or "一份小礼物")
    action = "留了" if heart.get("eventType") == "scene" else "送了"
    return f"{partner}给你{action}{name}"


def resolve_current_heart(current_heart, hearts, clear_if_missing=True):
    """主页面确认后，风铃下一次同步时清掉对应的心意卡。"""
    if not current_heart:
        return None
    current_id = str(current_heart.get("id") or "")
    if not current_id:
        return None
    for item in hearts or []:
        if str(item.get("id") or "") != current_id:
            continue
        if str(item.get("status") or "").lower() == "read":
            return None
        return item
    # 菜单打开时的并行快照可能早于心意入库，不能让旧快照误删刚弹出的卡片。
    return None if clear_if_missing else current_heart


# ─────────────────────────────
#  悬浮球本体
# ─────────────────────────────
class FenglingBall(QWidget):
    heart_ready = pyqtSignal(object)

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
        self.target = None           # 当前目标会话
        self.target_mode = "auto"    # auto=跟随最近 / pinned=固定某段对话
        self.pinned_target = None    # {agentId, sessionPath, title} 或 None
        self.current_heart = None    # 待用户点击查看的当前心意
        self.heart_queue = []        # 服务端未读且未收起的心意，最新在前
        self._heart_dismissed_ids = set()  # 请求落盘前的本进程乐观抑制

        # 动画：两个有重量的摆。铃身先受风，短册受牵引后再追上。
        self.t = 0.0
        self.angle_bell = 0.0
        self.angle_taz = 0.0
        self.angle_clapper = 0.0
        self.angle_clapper_spin = 0.0
        self.velocity_bell = 0.0
        self.velocity_taz = 0.0
        self.velocity_clapper = 0.0
        self.velocity_clapper_spin = 0.0
        self.angle_paper_spin = 0.0
        self.velocity_paper_spin = 0.0
        self.hovered = False
        self.hover_wind = 0.0
        self.hover_strength = 1.0
        self.gust = 0.0
        self.gust_direction = 1.0
        self.sound_volume, sound_state_changed = normalize_sound_state(self.state)
        if sound_state_changed:
            save_state(self.state)
        self._sound_cooldown = 0.0
        self._delivery_ring_until = 0.0  # 送达响铃窗口截止（monotonic 秒）；期内撞壁允许非悬停发声
        self._drag_chime_until = 0.0  # 拖动余势响铃窗口截止；期内非悬停撞壁也出声
        self._chime_pool = []
        self._last_chime_idx = -1
        self._sound_voices = []
        self._sound_voice_paths = []
        self._sound_voice_index = 0
        self._init_chime_pool()
        self._init_sound_voices()
        self.menu = None
        self._heart_poll_elapsed = 5.0
        self._heart_polling = False
        self._heart_seeded = False
        self._heart_seen_ids = set()
        self.heart_ready.connect(self._apply_heart_poll)

        self._last_ts = time.monotonic()
        self._drag = None
        self._press_global = None
        self._moved = False
        self._drag_motion_active = False
        self._drag_sample_x = 0.0
        self._drag_sample_y = 0.0
        self._drag_sample_ts = self._last_ts
        self._drag_velocity_x = 0.0
        self._drag_velocity_y = 0.0
        self._drag_motion_last_ts = self._last_ts
        self._drag_menu_was_visible = False
        self._screen_check_elapsed = 0.0
        self._hover_exit_elapsed = 0.0

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
        paper_offset_x = tanzaku_airflow_offset(
            self._drag_velocity_x, self._drag_velocity_y
        )
        paper_offset_y = tanzaku_airflow_lift(self._drag_velocity_y)
        top, clapper, knot = linkage_points(
            clapper_angle, paper_angle, paper_offset_x, paper_offset_y
        )
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

        draw_clapper_disc(
            painter,
            clapper,
            self.angle_clapper_spin,
            RENDER_SCALE,
        )
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor("#fff9ea"))
        painter.drawEllipse(knot, 4.5 * RENDER_SCALE, 4.5 * RENDER_SCALE)

    def _draw_paper(self, painter, clapper_angle, paper_angle):
        paper_offset_x = tanzaku_airflow_offset(
            self._drag_velocity_x, self._drag_velocity_y
        )
        paper_offset_y = tanzaku_airflow_lift(self._drag_velocity_y)
        _top, _clapper, knot = linkage_points(
            clapper_angle, paper_angle, paper_offset_x, paper_offset_y
        )
        wx, roll = paper_twist_projection(self.angle_paper_spin)
        painter.save()
        painter.translate(knot.x(), knot.y())
        painter.rotate(paper_angle)
        painter.scale(wx, 1.0)
        painter.rotate(roll)
        draw_tanzaku_paper(painter, self.angle_paper_spin, RENDER_SCALE)
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

    def _reset_drag_motion(self, now=None):
        """一次拖动只从当前窗口位置采样，旧拖速不能串进下一次手势。"""
        now = time.monotonic() if now is None else float(now)
        pos = self.pos()
        self._drag_sample_x = float(pos.x())
        self._drag_sample_y = float(pos.y())
        self._drag_sample_ts = now
        self._drag_velocity_x = 0.0
        self._drag_velocity_y = 0.0
        self._drag_motion_last_ts = now
        self._drag_motion_active = False

    def _apply_drag_impulses(self, delta_vx, delta_vy):
        bell, paper, clapper, spin = wind_chime_drag_impulses(delta_vx, delta_vy)
        self.velocity_bell += bell
        self.velocity_taz += paper
        self.velocity_clapper += clapper
        self.velocity_clapper_spin += spin

    def _record_drag_motion(self, position=None, now=None):
        """记录实际窗口位移；联合面板触边限位后速度自然归零。"""
        now = time.monotonic() if now is None else float(now)
        position = self.pos() if position is None else position
        vx, vy, dvx, dvy, _speed = sample_drag_velocity(
            self._drag_sample_x,
            self._drag_sample_y,
            self._drag_sample_ts,
            self._drag_velocity_x,
            self._drag_velocity_y,
            position.x(),
            position.y(),
            now,
        )
        self._drag_sample_x = float(position.x())
        self._drag_sample_y = float(position.y())
        self._drag_sample_ts = now
        self._drag_velocity_x = vx
        self._drag_velocity_y = vy
        self._drag_motion_last_ts = now
        self._drag_motion_active = True
        self._apply_drag_impulses(dvx, dvy)

    def _release_drag_motion(self):
        """鼠标急停等价于锚点速度骤降到零，让悬挂件凭惯性越过重心。"""
        if self._drag_motion_active:
            # 急停冲量小于起步冲量：极短 flick 即使没等到下一帧，也会先保留滞后再回弹，不能正负相消成静止。
            self._apply_drag_impulses(
                -self._drag_velocity_x * 0.38,
                -self._drag_velocity_y * 0.38,
            )
        self._drag_velocity_x *= 0.25
        self._drag_velocity_y *= 0.25
        self._drag_motion_active = False
        self._drag_motion_last_ts = time.monotonic()

    def _decay_drag_motion(self, now, dt):
        fresh = (
            self._drag_motion_active
            and now - self._drag_motion_last_ts <= DRAG_STALE_AFTER
        )
        if fresh:
            return
        decay = math.exp(-dt / DRAG_DECAY_TAU)
        self._drag_velocity_x *= decay
        self._drag_velocity_y *= decay
        if math.hypot(self._drag_velocity_x, self._drag_velocity_y) < 0.5:
            self._drag_velocity_x = 0.0
            self._drag_velocity_y = 0.0

    # ── 动画帧：阻尼摆 + 非等速微风 ──
    def _tick(self):
        now = time.monotonic()
        frame_elapsed = max(now - self._last_ts, 0.0)
        dt = min(frame_elapsed, 0.05)
        self._last_ts = now
        self.t += dt
        self._decay_drag_motion(now, dt)
        dragging = bool(
            self._drag_motion_active
            and now - self._drag_motion_last_ts <= 0.18
        )
        drag_speed = math.hypot(self._drag_velocity_x, self._drag_velocity_y)
        drag_influence = min(1.0, drag_speed / 130.0)
        (
            drag_bell_target,
            drag_taz_target,
            drag_clapper_target,
            drag_spin_drive,
        ) = wind_chime_drag_targets(
            self._drag_velocity_x,
            self._drag_velocity_y,
        )
        tanzaku_air_influence = tanzaku_airflow_influence(
            self._drag_velocity_x, self._drag_velocity_y
        )
        clapper_air_influence = clapper_airflow_influence(
            self._drag_velocity_x, self._drag_velocity_y
        )

        # 分辨率、DPI 或远程显示模式变化后，自动把旧坐标拉回当前屏幕。
        self._screen_check_elapsed += dt
        if self._screen_check_elapsed >= 1.0:
            self._screen_check_elapsed = 0.0
            self._ensure_visible(save=True)

        # 主动心意只轮询信箱，不在风铃里做回复；新心意到达时四下短摆并叮三声。
        self._heart_poll_elapsed += dt
        if self._heart_poll_elapsed >= 5.0:
            self._heart_poll_elapsed = 0.0
            self._poll_hearts_async()

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
        if cursor_hovered and not self.hovered and not dragging:
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
        target_hover_wind = 0.16 if dragging else 1.0 if self.hovered else 0.0
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
        hover_mix = self.hover_wind * (0.12 if dragging else 1.0)
        acc_bell = (
            normal_acc_bell * (1.0 - hover_mix)
            + strong_acc_bell * hover_mix
        )
        acc_bell += (
            drag_bell_target - self.angle_bell
        ) * 22.0 * drag_influence
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
            normal_acc_taz * (1.0 - hover_mix)
            + strong_acc_taz * hover_mix
        )
        acc_taz += (
            drag_taz_target - self.angle_taz
        ) * 42.0 * tanzaku_air_influence
        self.velocity_taz += acc_taz * dt
        self.angle_taz += self.velocity_taz * dt

        self.angle_bell = max(-12.0, min(12.0, self.angle_bell))
        self.angle_taz = max(-60.0, min(60.0, self.angle_taz))

        # 铃舌由短册牵引，但有自己的重量和滞后；真正碰壁时反弹并触发一声。
        clapper_target = (
            self.angle_taz * 1.04
            - self.angle_bell * 0.16
            + drag_clapper_target * clapper_air_influence
        )
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
        if impact > 0.0:
            side = 1.0 if self.angle_clapper >= 0.0 else -1.0
            self.velocity_clapper_spin += side * min(impact * 0.62, 34.0)
        wind_twist = wind * 1.4 * (0.6 + 0.4 * math.sin(self.t * 3.3))
        spin_drive = (
            (self.velocity_taz - self.velocity_clapper) * 1.15
            + wind_twist
            + drag_spin_drive * max(drag_influence, 0.18 if dragging else 0.0)
        )
        self.angle_clapper_spin, self.velocity_clapper_spin = advance_clapper_spin(
            self.angle_clapper_spin,
            self.velocity_clapper_spin,
            spin_drive,
            dt,
        )
        # 纸片绕悬线飘转：纸轻，风一吹就绕绳打转，不跟铃舌硬绑，这是"纸片自身扭动"的来源。
        paper_spin_drive = max(-110.0, min(
            wind * 100.0
            + (self.velocity_taz - self.velocity_clapper) * 0.5
            + drag_spin_drive * drag_influence * 1.0,
            110.0,
        ))
        self.angle_paper_spin, self.velocity_paper_spin = advance_paper_spin(
            self.angle_paper_spin,
            self.velocity_paper_spin,
            paper_spin_drive,
            dt,
        )
        self._sound_cooldown = max(0.0, self._sound_cooldown - dt)
        # 响铃资格：悬停气流、送达窗口、拖动中或刚松手的余势摆动，任一即可；
        # 拖动轨迹以外的非悬停普通摆动维持原规则：悬停气流才响。
        in_delivery_window = time.monotonic() < self._delivery_ring_until
        chime_allowed, volume_scale = resolve_chime_eligibility(
            self.hovered, in_delivery_window, self._drag is not None, self._drag_chime_until
        )
        if should_attempt_chime(impact, chime_allowed, self._sound_cooldown):
            self._play_chime(impact, volume_scale=volume_scale)
        self.update()

    def _poll_hearts_async(self):
        if self._heart_polling:
            return
        self._heart_polling = True

        def worker():
            payload = {"ok": False, "hearts": [], "new_hearts": [], "ack_ids": [], "seen_ids": [], "seeded": self._heart_seeded}
            try:
                data = api_get("/hearts", timeout=3)
                if data.get("ok"):
                    hearts = data.get("hearts") or []
                    seen, fresh, ack_ids, seeded = resolve_heart_poll(
                        self._heart_seen_ids,
                        hearts,
                        self._heart_seeded,
                    )
                    payload["hearts"] = hearts
                    payload["new_hearts"] = fresh
                    payload["ack_ids"] = ack_ids
                    payload["seen_ids"] = list(seen)
                    payload["seeded"] = seeded
                    payload["ok"] = True
            except Exception:
                pass
            try:
                self.heart_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="fengling-hearts").start()

    def _apply_heart_poll(self, payload):
        self._heart_polling = False
        if not payload.get("ok"):
            return
        self._heart_seen_ids = set(payload.get("seen_ids") or self._heart_seen_ids)
        self._heart_seeded = bool(payload.get("seeded", self._heart_seeded))

        menu_visible = bool(self.menu and self.menu.isVisible())
        if "hearts" in payload:
            hearts = payload.get("hearts") or []
            self.heart_queue = pending_heart_items(hearts, self._heart_dismissed_ids)
            current_id = str(self.current_heart.get("id") or "") if self.current_heart else ""
            current = next(
                (item for item in self.heart_queue if str(item.get("id") or "") == current_id),
                None,
            )
            if current is not None:
                self.current_heart = current
            elif current_id:
                self.current_heart = None

            # 面板未打开时始终准备最新一份；面板已打开且用户刚点过“先收着”时，
            # 不把队列里的下一份立刻打回脸上，保持非打断式语义。
            if self.heart_queue and not self.current_heart and not (
                menu_visible and self.menu._heart_card_dismissed
            ):
                self.current_heart = self.heart_queue[0]
            elif self.heart_queue and not menu_visible:
                self.current_heart = self.heart_queue[0]

            if menu_visible:
                self.menu._update_heart_card()
                self.menu.keep_current_position(full_height=True)

        ack_ids = payload.get("ack_ids") or []
        fresh = payload.get("new_hearts") or []
        if not fresh:
            # 已送达但仍未读的心意留在 heart_queue，等用户手动打开查看；不重复响铃。
            if ack_ids:
                self._ack_hearts_async(ack_ids)
            return

        # 一轮可能收到多份新心意：只播放一次送达提示，队列全部保留，面板优先展示最新一份。
        self.current_heart = self.heart_queue[0] if self.heart_queue else fresh[0]
        if menu_visible:
            self.menu._heart_card_dismissed = False
            self.menu._update_heart_card()
            self.menu.keep_current_position(full_height=True)
        if ack_ids:
            self._ack_hearts_async(ack_ids)
        self._swing_for_delivery()


    def _ack_hearts_async(self, ids):
        if not ids:
            return

        def worker():
            try:
                api_post("/hearts/ack", {"ids": ids}, timeout=3)
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True, name="fengling-heart-ack").start()

    def _dismiss_hearts_async(self, ids):
        if not ids:
            return

        def worker():
            try:
                api_post("/hearts/dismiss", {"ids": ids}, timeout=3)
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True, name="fengling-heart-dismiss").start()

    def _swing_for_delivery(self):
        """心意到达：给铃舌真实的晃动冲量，让它撞壁自然发声（因动而声）。

        三次交替 kick 对应三声，力度逐次略减模拟风被吹动的自然收势；
        撞击本身触发 _play_chime，音量随撞击力度走，不再单独播 WAV。
        静音档位下仍会晃（视觉反馈在），只是不发声。
        """
        self._delivery_ring_until = time.monotonic() + DELIVERY_RING_WINDOW_S
        kicks = (DELIVERY_KICK, -DELIVERY_KICK * 0.82, DELIVERY_KICK * 0.66)
        for delay, strength in zip((0, 260, 520), kicks):
            QTimer.singleShot(delay, lambda s=strength: self._delivery_kick(s))

    def _delivery_kick(self, strength):
        # 清冷却保证本次撞击一定发声；冲量直接作用在铃舌速度上，由物理撞壁触发声音。
        self._sound_cooldown = 0.0
        self.velocity_clapper += strength
        self.velocity_clapper_spin += strength * 0.22
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
            self._reset_drag_motion()
            # 触碰像给悬绳一个很轻的拨动，随后完全由阻尼自然回摆。
            direction = 1.0 if self.angle_bell <= 0 else -1.0
            self.velocity_bell += 5.5 * direction
            self.velocity_taz -= 11.0 * direction
            clapper_direction = 1.0 if self.angle_clapper <= 0 else -1.0
            self.velocity_clapper += CLICK_CLAPPER_KICK * clapper_direction
            self.velocity_clapper_spin += CLICK_CLAPPER_KICK * 0.22 * clapper_direction
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
            self._ensure_visible()
            self._sync_dragged_menu()
            self._record_drag_motion()
        e.accept()

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._moved:
                self._release_drag_motion()
                self._snap()
                self._save_pos()
                self._sync_dragged_menu()
            elif self._drag_menu_was_visible and self.menu and self.menu.isVisible():
                self.menu.close_menu()
            else:
                self._toggle_menu()
            if not self._moved:
                self._drag_motion_active = False
            self._drag = None
            self._drag_chime_until = time.monotonic() + DRAG_CHIME_WINDOW_S  # 松开后余势摆动仍可响
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
        """预加载多个独立播放位置，避免碰撞时才换音频源导致仍在 Loading。"""
        self._sound_voice_paths = []
        if QSoundEffect is None or not self._chime_pool:
            return
        try:
            for index in range(CHIME_VOICE_COUNT):
                voice = QSoundEffect(self)
                source_path = prepare_sound_file(
                    self._chime_pool[index % len(self._chime_pool)], 1.0
                )
                voice.setSource(QUrl.fromLocalFile(source_path))
                voice.setVolume(1.0)
                self._sound_voices.append(voice)
                self._sound_voice_paths.append(source_path)
        except Exception as error:
            self._sound_voices = []
            self._sound_voice_paths = []
            print(f"[风铃] 初始化重叠播放失败，改用系统播放: {error}", file=sys.stderr)

    def _play_chime(self, impact, volume_scale=1.0):
        """碰撞触发：优先播放已预加载变体，音量随撞击力度走；非悬停余势可整体压低。"""
        if self.sound_volume <= 0 or self._sound_cooldown > 0:
            return
        if not self._chime_pool:
            return
        volume = chime_volume_from_impact(impact, self.sound_volume) * volume_scale
        idx = random.randint(0, len(self._chime_pool) - 1)
        if len(self._chime_pool) > 1:
            while idx == self._last_chime_idx:
                idx = random.randint(0, len(self._chime_pool) - 1)
        self._last_chime_idx = idx
        data = self._chime_pool[idx]
        self._sound_cooldown = CHIME_COOLDOWN
        try:
            if self._sound_voices:
                idle = next((voice for voice in self._sound_voices if not voice.isPlaying()), None)
                if idle is None:
                    idle = self._sound_voices[self._sound_voice_index % len(self._sound_voices)]
                self._sound_voice_index = (self._sound_voices.index(idle) + 1) % len(self._sound_voices)
                if (
                    QSoundEffect is None
                    or not isinstance(idle, QSoundEffect)
                    or idle.status() == QSoundEffect.Status.Ready
                ):
                    idle.setVolume(volume)
                    idle.play()
                    return
                # QSoundEffect 仍在 Loading/Error 时不能静默吞掉这一下，落到 winsound 文件播放。
            if winsound is None:
                return
            sound_path = prepare_sound_file(data, volume)
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
        menu = FenglingContextMenu(self)
        menu.setStyleSheet(f"""
            QMenu {{
                background: {C_BG}; color: {C_INK};
                border: 1px solid {C_BORDER}; border-radius: 10px;
                padding: 5px;
            }}
            QMenu::item {{ padding: 7px 18px; border-radius: 7px; }}
            QMenu::item:selected {{ background: #f1e3c8; }}
        """)
        volume_menu = FenglingContextMenu(menu)
        volume_menu.setTitle("声音大小")
        menu.addMenu(volume_menu)
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
        # 位置锚定：右侧优先放不下翻左，垂直按铃铛中心 33% 锚定（主体在铃铛下方）
        menu_size = menu.sizeHint()
        screen = self.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        x = self.x() + self.width() + 8
        if x + menu_size.width() > geo.right():
            x = self.x() - menu_size.width() - 8
        y = popup_anchor_y(
            (self.x(), self.y(), self.width(), self.height()),
            menu_size.height(),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            MENU_ANCHOR_RATIO,
        )
        menu.exec(QPoint(x, y))

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
        already_visible = self.menu.isVisible()
        if already_visible:
            # 新心意到达时只更新卡片，不重置用户已经拖好的面板位置和当前分页。
            self.menu._heart_card_dismissed = False
            self.menu._update_heart_card()
            self.menu.keep_current_position(full_height=True)
        else:
            self.menu.prepare_for_show()
            self.menu.move_to_ball()
            self.menu.show()
            self.menu.activateWindow()
        self.menu.raise_()
        self.menu.refresh_async()

    def _do_visit(self, vtype, item_id):
        # 动作只提交物品；目标选择器先通过 /pin 固定目标，代理再在点击瞬间
        # 读取当前 auto/pinned 目标并校验 sessionPath，避免客户端自行伪造助手路径。
        # 恶作剧包含模型生成与会话忙碌重试，给它更完整的等待窗口，避免服务端已执行却被前端误报失败。
        timeout = 55 if vtype == "prank" else 20
        return api_post("/visit", {"type": vtype, "itemId": item_id}, timeout=timeout)


# ─────────────────────────────
#  弹窗鼠标离开自动半透明（左右菜单共用）
# ─────────────────────────────
class FadeOnLeaveMixin:
    def _setup_fade_on_leave(self):
        self._fade_out_timer = QTimer(self)
        self._fade_out_timer.setSingleShot(True)
        self._fade_out_timer.timeout.connect(self._begin_fade_out)
        self._fade_anim = QPropertyAnimation(self, b"windowOpacity", self)

    def _reset_fade_on_show(self):
        """显示时恢复实体；光标在窗外则给一小段缓冲后淡出。"""
        self.setWindowOpacity(1.0)
        self._fade_out_timer.stop()
        self._fade_anim.stop()
        if not self._cursor_inside():
            self._fade_out_timer.start(FADE_OUT_DELAY_MS + FADE_SHOW_GRACE_MS)

    def _on_fade_enter(self):
        self._fade_out_timer.stop()
        self._fade_to(1.0, FADE_IN_DURATION_MS)

    def _on_fade_leave(self):
        self._fade_out_timer.start(FADE_OUT_DELAY_MS)

    def _cancel_fade(self):
        self._fade_out_timer.stop()
        self._fade_anim.stop()

    def _cursor_inside(self):
        return self.rect().contains(self.mapFromGlobal(QCursor.pos()))

    def _begin_fade_out(self):
        self._fade_to(FADE_OUT_OPACITY, FADE_OUT_DURATION_MS)

    def _fade_to(self, target, duration_ms):
        self._fade_anim.stop()
        self._fade_anim.setStartValue(self.windowOpacity())
        self._fade_anim.setEndValue(target)
        self._fade_anim.setDuration(duration_ms)
        self._fade_anim.start()

    def showEvent(self, event):
        super().showEvent(event)
        self._reset_fade_on_show()

    def hideEvent(self, event):
        self._cancel_fade()
        super().hideEvent(event)

    def enterEvent(self, event):
        super().enterEvent(event)
        self._on_fade_enter()

    def leaveEvent(self, event):
        super().leaveEvent(event)
        self._on_fade_leave()


class FenglingContextMenu(FadeOnLeaveMixin, QMenu):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._setup_fade_on_leave()


# ─────────────────────────────
#  目标会话选择面板
# ─────────────────────────────
class TargetMenu(QFrame):
    """跟随最近 / 先按助手再选对话；固定结果写入插件数据。"""

    data_ready = pyqtSignal(object)

    def __init__(self, panel):
        super().__init__(panel)
        self.panel = panel
        self.ball = panel.ball
        self.view_mode = "auto"
        self.selected_agent_id = ""
        self.agents = []
        self.sessions = []
        self.loading = False
        self.error = ""
        self._request_seq = 0
        self.data_ready.connect(self._apply_data)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("targetMenu")
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._build()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(10, 9, 10, 9)
        root.setSpacing(6)

        title = QLabel("这次动作发到哪段对话？")
        title.setObjectName("targetMenuTitle")
        root.addWidget(title)

        mode_row = QHBoxLayout()
        mode_row.setSpacing(6)
        self.btn_auto = QPushButton("跟随最近")
        self.btn_auto.setObjectName("targetMode")
        self.btn_auto.clicked.connect(self._pick_auto)
        mode_row.addWidget(self.btn_auto)
        self.btn_manual = QPushButton("自己选择")
        self.btn_manual.setObjectName("targetMode")
        self.btn_manual.clicked.connect(self._show_manual)
        mode_row.addWidget(self.btn_manual)
        root.addLayout(mode_row)

        self.lbl_hint = QLabel("")
        self.lbl_hint.setObjectName("targetMenuHint")
        self.lbl_hint.setWordWrap(True)
        root.addWidget(self.lbl_hint)

        self.btn_back = QPushButton("← 换助手")
        self.btn_back.setObjectName("targetBack")
        self.btn_back.clicked.connect(self._show_agents)
        root.addWidget(self.btn_back)

        self.list_host = QWidget(self)
        self.list_box = QVBoxLayout(self.list_host)
        self.list_box.setContentsMargins(0, 0, 0, 0)
        self.list_box.setSpacing(5)
        root.addWidget(self.list_host)
        self.apply_theme()

    def apply_theme(self):
        self.setStyleSheet(f"""
            #targetMenu {{ background: #fffaf0; border: 1px solid #ead9bb; border-radius: 14px; }}
            QLabel {{ background: transparent; color: {C_INK}; }}
            QLabel#targetMenuTitle {{ color: {C_GOLD_DEEP}; font-size: 12px; font-weight: 700; }}
            QLabel#targetMenuHint {{ color: {C_SUB}; font-size: 10px; padding-bottom: 1px; }}
            QPushButton#targetMode, QPushButton#targetBack {{
                min-height: 28px; padding: 0 8px; color: {C_SUB}; background: #fffdf8;
                border: 1px solid #ead9bb; border-radius: 9px; font-size: 11px;
            }}
            QPushButton#targetMode:hover, QPushButton#targetBack:hover {{
                color: {C_GOLD_DEEP}; background: #f6ecd9; border-color: {C_GOLD};
            }}
            QPushButton#targetMode[active="true"] {{
                color: #46695f; background: {C_MINT}; border-color: {C_MINT_DEEP}; font-weight: 600;
            }}
            QPushButton#targetItem {{
                min-height: 30px; max-height: 30px; text-align: left; padding: 0 9px;
                color: {C_INK}; background: #fffdf8; border: 1px solid #ead9bb;
                border-radius: 9px; font-size: 11px;
            }}
            QPushButton#targetItem:hover {{ background: #f6ecd9; border-color: {C_GOLD}; }}
            QPushButton#targetItem[active="true"] {{ color: {C_GOLD_DEEP}; background: #f5ead5; border-color: {C_GOLD}; }}
        """)
        self._sync_ui()

    def _clear_list(self):
        while self.list_box.count():
            item = self.list_box.takeAt(0)
            widget = item.widget()
            if widget:
                widget.hide()
                widget.setParent(None)
                widget.deleteLater()

    def _set_active(self, button, active):
        button.setProperty("active", "true" if active else "false")
        button.style().unpolish(button)
        button.style().polish(button)

    def _sync_ui(self):
        manual = self.view_mode == "manual"
        self._set_active(self.btn_auto, not manual)
        self._set_active(self.btn_manual, manual)
        self.btn_back.setVisible(manual and bool(self.selected_agent_id))
        self._clear_list()

        if not manual:
            self.lbl_hint.setText("每次点击时跟随最近活跃的对话")
            return
        if self.selected_agent_id:
            agent_name = next(
                (item.get("name") for item in self.agents if item.get("id") == self.selected_agent_id),
                self.selected_agent_id,
            )
            self.lbl_hint.setText(f"选择 {agent_name} 最近的 {TARGET_SESSION_LIMIT} 个活跃对话")
        else:
            self.lbl_hint.setText("先选一位助手，再从她最近的对话里挑一段")

        if self.loading:
            self._add_hint("正在读取对话列表…")
            return
        if self.error:
            self._add_hint(self.error)
            retry = QPushButton("↻ 重新读取")
            retry.setObjectName("targetItem")
            retry.setCursor(Qt.CursorShape.PointingHandCursor)
            retry.clicked.connect(lambda _=False: self.refresh_async())
            self.list_box.addWidget(retry)
            return
        if not self.selected_agent_id:
            if not self.agents:
                self._add_hint("还没读取到可选助手")
                return
            for agent in self.agents:
                agent_id = agent.get("id") or ""
                if not agent_id:
                    continue
                button = QPushButton(agent.get("name") or agent_id)
                button.setObjectName("targetItem")
                button.setCursor(Qt.CursorShape.PointingHandCursor)
                button.clicked.connect(lambda _=False, aid=agent_id: self._pick_agent(aid))
                self.list_box.addWidget(button)
            return
        if not self.sessions:
            self._add_hint("还没读取到可选对话")
            return
        for session in self.sessions[:TARGET_SESSION_LIMIT]:
            title = (session.get("title") or "未命名对话").strip()
            agent_name = session.get("agentName") or session.get("agentId") or "未命名助手"
            stamp = session.get("lastUserTime") or 0
            when = time.strftime("%H:%M", time.localtime(stamp / 1000)) if stamp else ""
            meta = f"{agent_name} · {when}" if when else agent_name
            button = QPushButton()
            button.setObjectName("targetItem")
            button.setText(button.fontMetrics().elidedText(title, Qt.TextElideMode.ElideRight, 244))
            button.setToolTip(f"{title}\n{meta}")
            button.setCursor(Qt.CursorShape.PointingHandCursor)
            button.setProperty(
                "active",
                "true" if self.ball.pinned_target and self.ball.pinned_target.get("sessionPath") == session.get("sessionPath") else "false",
            )
            button.clicked.connect(lambda _=False, item=session: self._pick(item))
            self.list_box.addWidget(button)

    def _add_hint(self, text):
        label = QLabel(text)
        label.setObjectName("targetMenuHint")
        label.setWordWrap(True)
        self.list_box.addWidget(label)

    def invalidate_pending(self):
        """面板收起时使旧的后台列表回包失效，避免重开时串入旧状态。"""
        self._request_seq += 1

    def _show_manual(self):
        self._show_agents()

    def _show_agents(self):
        self.view_mode = "manual"
        self.selected_agent_id = ""
        self.agents = []
        self.sessions = []
        self._sync_ui()
        self.refresh_async()
        self.panel._resize_after_target_change()

    def _pick_agent(self, agent_id):
        self.selected_agent_id = agent_id
        self.sessions = []
        self.refresh_async()
        self.panel._resize_after_target_change()

    def _pick_auto(self):
        self._request_seq += 1
        self.panel.invalidate_target_sync()
        try:
            result = api_post("/pin", {}, timeout=5)
            if not result.get("ok"):
                raise RuntimeError(result.get("error") or "切换失败")
        except Exception:
            self.error = "切换失败，稍后再试"
            self._sync_ui()
            self.panel._flash("切换失败，原来的选择没有改变")
            return
        self.view_mode = "auto"
        self.ball.target_mode = "auto"
        self.ball.pinned_target = None
        self.panel._pinned_expires_in_ms = 0
        self.panel._sync_target_state()
        self.panel._flash("已改为跟随最近活跃的对话 ✓")
        self.panel._set_target_selector_visible(False)

    def _pick(self, session):
        self._request_seq += 1
        self.panel.invalidate_target_sync()
        try:
            result = api_post("/pin", {
                "sessionPath": session.get("sessionPath") or "",
                "agentId": session.get("agentId") or "",
                "title": session.get("title") or "",
            }, timeout=5)
            if not result.get("ok"):
                raise RuntimeError(result.get("error") or "固定失败")
        except Exception:
            self.error = "固定失败，原来的选择没有改变"
            self._sync_ui()
            self.panel._flash("固定失败，原来的选择没有改变")
            return
        self.view_mode = "manual"
        self.ball.target_mode = "pinned"
        self.ball.pinned_target = {
            "agentId": session.get("agentId") or "",
            "sessionPath": session.get("sessionPath") or "",
            "title": session.get("title") or "",
        }
        self.ball.target = {
            "id": session.get("agentId") or "",
            "agentId": session.get("agentId") or "",
            "name": session.get("agentName") or session.get("agentId") or "",
            "title": session.get("title") or "",
            "sessionPath": session.get("sessionPath") or "",
        }
        self.panel._pinned_expires_in_ms = int(result.get("pinnedExpiresInMs") or 0)
        self.panel._update_target_label()
        self.panel._flash("已固定这段对话 ✓")
        self.panel._set_target_selector_visible(False)

    def refresh_async(self):
        self._request_seq += 1
        request_seq = self._request_seq
        self.loading = True
        self.error = ""
        self._sync_ui()

        def worker():
            payload = {"seq": request_seq, "agents": [], "sessions": [], "error": "读取失败，可以重新读取"}
            try:
                if self.view_mode == "manual" and not self.selected_agent_id:
                    data = api_get("/agents", timeout=5)
                    if data.get("ok"):
                        payload = {"seq": request_seq, "agents": data.get("agents") or [], "sessions": [], "error": ""}
                else:
                    query = ""
                    if self.view_mode == "manual" and self.selected_agent_id:
                        query = "?agentId=" + urllib.parse.quote(self.selected_agent_id, safe="")
                    data = api_get("/sessions" + query, timeout=5)
                    if data.get("ok"):
                        payload = {"seq": request_seq, "agents": [], "sessions": data.get("sessions") or [], "error": ""}
            except Exception:
                pass
            try:
                self.data_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="fengling-target-list").start()

    def _apply_data(self, payload):
        if payload.get("seq") != self._request_seq:
            return
        self.loading = False
        self.error = payload.get("error") or ""
        if self.view_mode == "manual" and not self.selected_agent_id:
            self.agents = payload.get("agents") or []
        else:
            self.sessions = (payload.get("sessions") or [])[:TARGET_SESSION_LIMIT]
        self._sync_ui()
        self.panel._resize_after_target_change()


# ─────────────────────────────
#  动作菜单面板
# ─────────────────────────────
class FenglingMenu(FadeOnLeaveMixin, QFrame):
    refresh_ready = pyqtSignal(object)
    target_state_ready = pyqtSignal(object)

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
        self.setFixedWidth(286)
        self.active_kind = "interact"
        self._heart_card_dismissed = False
        self._actions_signature = None
        self._refreshing = False
        self._target_seq = 0
        self._pinned_expires_in_ms = 0  # 固定目标的剩余寿命（来自 /target / /pin）
        self._needs_reanchor = False  # 本次打开后内容尚未以完整高度锚定过
        self._user_dragged = False    # 本次打开后用户是否手动拖过面板（拖过则尊重手动位置）
        self.refresh_ready.connect(self._apply_async_refresh)
        self.target_state_ready.connect(self._apply_target_state)
        self._build_ui()
        self._setup_fade_on_leave()
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
            QPushButton#targetButton {{
                color: {C_SUB}; background: #fffdf8; border: 1px solid #ead9bb;
                border-radius: 10px; padding: 7px 9px; font-size: 11px;
            }}
            QPushButton#targetButton:hover {{ background: #f6ecd9; border-color: {C_GOLD}; color: {C_GOLD_DEEP}; }}
            QFrame#heartCard {{
                background: #fff4f0; border: 1px solid #e9bdc4;
                border-radius: 12px;
            }}
            QLabel#heartTitle {{ color: {C_GOLD_DEEP}; font-size: 12px; font-weight: 600; }}
            QLabel#heartGift {{ color: {C_INK}; font-size: 14px; font-weight: 600; }}
            QLabel#heartMessage {{ color: {C_INK}; font-size: 12px; line-height: 1.4; }}
            QLabel#heartHint {{ color: {C_SUB}; font-size: 11px; line-height: 1.35; }}
            QPushButton#heartKeep {{
                background: #fffdf8; border: 1px solid #ead9bb;
                border-radius: 9px; padding: 6px 10px; color: {C_SUB};
            }}
            QPushButton#heartKeep:hover {{ background: #f6ecd9; }}
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

        # 当前心意直接放进普通风铃面板；不做历史列表，只展示这一份正在处理的心意。
        self.heart_card = QFrame()
        self.heart_card.setObjectName("heartCard")
        heart_root = QVBoxLayout(self.heart_card)
        heart_root.setContentsMargins(10, 9, 10, 9)
        heart_root.setSpacing(5)
        self.lbl_heart_title = QLabel("有人悄悄给你带了点东西")
        self.lbl_heart_title.setObjectName("heartTitle")
        self.lbl_heart_gift = QLabel("")
        self.lbl_heart_gift.setObjectName("heartGift")
        self.lbl_heart_gift.setTextFormat(Qt.TextFormat.PlainText)
        self.lbl_heart_message = QLabel("")
        self.lbl_heart_message.setObjectName("heartMessage")
        self.lbl_heart_message.setWordWrap(True)
        self.lbl_heart_message.setTextFormat(Qt.TextFormat.PlainText)
        self.lbl_heart_hint = QLabel("")
        self.lbl_heart_hint.setObjectName("heartHint")
        self.lbl_heart_hint.setWordWrap(True)
        self.lbl_heart_hint.setTextFormat(Qt.TextFormat.PlainText)
        heart_root.addWidget(self.lbl_heart_title)
        heart_root.addWidget(self.lbl_heart_gift)
        heart_root.addWidget(self.lbl_heart_message)
        heart_root.addWidget(self.lbl_heart_hint)
        heart_buttons = QHBoxLayout()
        heart_buttons.setSpacing(6)
        self.btn_heart_keep = QPushButton("先收着")
        self.btn_heart_keep.setObjectName("heartKeep")
        heart_buttons.addWidget(self.btn_heart_keep)
        heart_root.addLayout(heart_buttons)
        self.heart_card.hide()
        root.addWidget(self.heart_card)

        # 当前目标展示；点右侧按钮打开自动 / 手动选择面板。
        target_row = QHBoxLayout()
        target_row.setSpacing(6)
        self.lbl_target = QLabel("跟随最近活跃的对话 · 正在读取")
        self.lbl_target.setObjectName("target")
        target_row.addWidget(self.lbl_target, 1)
        self.btn_target = QPushButton("选择对话 ▾")
        self.btn_target.setObjectName("targetButton")
        self.btn_target.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_target.clicked.connect(self._toggle_target_menu)
        target_row.addWidget(self.btn_target)
        root.addLayout(target_row)

        self.target_menu = TargetMenu(self)
        self.target_menu.hide()
        root.addWidget(self.target_menu)

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
        self.btn_heart_keep.clicked.connect(self._hide_current_heart)

    # ── 先显示缓存，再后台刷新，打开面板不被网络请求卡住 ──
    def prepare_for_show(self):
        self._needs_reanchor = True
        self._user_dragged = False
        self._heart_card_dismissed = False
        self.active_kind = "interact"
        self.target_menu.invalidate_pending()
        self.target_menu.hide()
        self._flash("")
        if self.ball.current_heart is None and getattr(self.ball, "heart_queue", None):
            self.ball.current_heart = self.ball.heart_queue[0]
        self._update_heart_card()
        self._update_target_label()
        self._render_actions(self.active_kind)
        self._update_jar()
        self._reset_fade_on_show()

    def refresh_async(self):
        if self._refreshing:
            return
        self._refreshing = True

        def worker():
            target_seq = self._target_seq
            payload = {
                "catalog": None,
                "targetLoaded": False,
                "target": None,
                "target_mode": "auto",
                "pinned_target": None,
                "targetStateLoaded": False,
                "target_seq": target_seq,
                "hearts": None,
            }
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
                    payload["target_mode"] = data.get("mode") or "auto"
                    payload["pinned_target"] = data.get("pinned")
                    payload["targetStateLoaded"] = True
            except Exception:
                pass
            try:
                data = api_get("/hearts", timeout=4)
                if data.get("ok"):
                    payload["hearts"] = data.get("hearts") or []
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
        if payload.get("targetLoaded") and payload.get("target_seq") == self._target_seq:
            self.ball.target = payload.get("target")
            if payload.get("targetStateLoaded"):
                self.ball.target_mode = "pinned" if payload.get("target_mode") == "pinned" else "auto"
                self.ball.pinned_target = payload.get("pinned_target")
        if payload.get("hearts") is not None:
            hearts = payload.get("hearts") or []
            self.ball.heart_queue = pending_heart_items(
                hearts,
                getattr(self.ball, "_heart_dismissed_ids", set()),
            )
            current_id = str(self.ball.current_heart.get("id") or "") if self.ball.current_heart else ""
            current = next(
                (item for item in self.ball.heart_queue if str(item.get("id") or "") == current_id),
                None,
            )
            if current is not None:
                self.ball.current_heart = current
            elif current_id:
                self.ball.current_heart = None
            if not self.ball.current_heart and self.ball.heart_queue and not self._heart_card_dismissed:
                self.ball.current_heart = self.ball.heart_queue[0]
            self._update_heart_card()
            self.keep_current_position(full_height=True)
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
            if data.get("ok"):
                self.ball.target = data.get("target")
                self.ball.target_mode = "pinned" if data.get("mode") == "pinned" else "auto"
                self.ball.pinned_target = data.get("pinned")
            else:
                self.ball.target = None
        except Exception:
            self.ball.target = None
        self._update_target_label()

    def _toggle_target_menu(self):
        visible = not self.target_menu.isVisible()
        self._set_target_selector_visible(visible)
        if visible:
            self.target_menu.view_mode = "manual" if self.ball.target_mode == "pinned" else "auto"
            self.target_menu.selected_agent_id = ""
            self.target_menu.agents = []
            self.target_menu.sessions = []
            self.target_menu._sync_ui()
            if self.target_menu.view_mode == "manual":
                self.target_menu.refresh_async()

    def _set_target_selector_visible(self, visible):
        if not visible:
            self.target_menu.invalidate_pending()
        self.target_menu.setVisible(bool(visible))
        self._update_target_label()
        self._resize_after_target_change()

    def _resize_after_target_change(self):
        def settle():
            self.adjustSize()
            if self.isVisible() and not self._user_dragged:
                self.move_to_ball()
        QTimer.singleShot(0, lambda: QTimer.singleShot(0, settle))

    def invalidate_target_sync(self):
        self._target_seq += 1

    def _sync_target_state(self):
        self._target_seq += 1
        request_seq = self._target_seq

        def worker():
            payload = None
            try:
                data = api_get("/target", timeout=4)
                if data.get("ok"):
                    payload = {**data, "seq": request_seq}
            except Exception:
                pass
            if payload is not None:
                try:
                    self.target_state_ready.emit(payload)
                except RuntimeError:
                    pass

        threading.Thread(target=worker, daemon=True, name="fengling-target-state").start()

    def _apply_target_state(self, data):
        if data.get("seq") != self._target_seq:
            return
        self.ball.target = data.get("target")
        self.ball.target_mode = "pinned" if data.get("mode") == "pinned" else "auto"
        self.ball.pinned_target = data.get("pinned")
        self._pinned_expires_in_ms = int(data.get("pinnedExpiresInMs") or 0)
        self._update_target_label()

    def _update_heart_card(self):
        heart = self.ball.current_heart
        visible = bool(heart) and not self._heart_card_dismissed
        self.heart_card.setVisible(visible)
        if not visible:
            return
        partner = heart.get("partnerName") or "有人"
        gift = heart.get("gift") or {}
        icon = gift.get("icon") or "🎁"
        name = gift.get("name") or "一份小礼物"
        message = heart.get("message") or ""
        event_label = "悄悄替你留下一点动静" if heart.get("eventType") == "scene" else "悄悄放到你这里"
        self.lbl_heart_title.setText(heart_popup_title(heart))
        self.lbl_heart_gift.setText(f"{icon}  {name}")
        self.lbl_heart_message.setText(message)
        self.lbl_heart_message.setVisible(bool(message))
        pending_count = len(getattr(self.ball, "heart_queue", []) or [])
        queue_hint = ""
        if pending_count > 1:
            queue_hint = f" 还有 {pending_count - 1} 份心意，收起这张后下次再看。"
        if heart.get("responded"):
            self.lbl_heart_hint.setText("你已经回应过这份心意。" + queue_hint)
        else:
            self.lbl_heart_hint.setText(
                f"{event_label}。如果你也想回应{partner}，可以在下面继续互动或送一份心意。{queue_hint}"
            )

    def _hide_current_heart(self):
        # “先收着”只收起风铃里的送达提示，不删除信箱心意；
        # 只把当前这一份写成已收起，队列里的其他心意留给后续手动查看。
        heart = self.ball.current_heart
        heart_id = str(heart.get("id") or "") if heart else ""
        if heart_id:
            dismissed_ids = getattr(self.ball, "_heart_dismissed_ids", None)
            if dismissed_ids is not None:
                dismissed_ids.add(heart_id)
            queue = getattr(self.ball, "heart_queue", None)
            if queue is not None:
                self.ball.heart_queue = [
                    item for item in queue if str(item.get("id") or "") != heart_id
                ]
            dismiss = getattr(self.ball, "_dismiss_hearts_async", None)
            if callable(dismiss):
                dismiss([heart_id])
        self.ball.current_heart = None
        self._heart_card_dismissed = True
        self._update_heart_card()
        self.keep_current_position(full_height=True)

    def _update_target_label(self):
        target = self.ball.target
        if self.ball.target_mode == "pinned":
            self.btn_target.setText("已固定 ▴" if self.target_menu.isVisible() else "已固定 ▾")
            if not target:
                self.lbl_target.setText("固定对话 · 暂未找到")
                return
            name = target.get("name", target.get("id", "?"))
            title = str(target.get("title") or "").strip()
            remain = self._pinned_expires_in_ms
            base = f"固定对话 · {name}"
            if title:
                base += f" · {title[:20]}"
            if remain and remain > 0:
                base = f"已固定 · {name}"
                if title:
                    base += f" · {title[:20]}"
                base += f"（剩{remain / 3600000.0:.1f}小时）"
            self.lbl_target.setText(base)
            return
        self.btn_target.setText("选择对话 ▴" if self.target_menu.isVisible() else "选择对话 ▾")
        if not target:
            self.lbl_target.setText("跟随最近活跃的对话 · 暂未找到")
            return
        name = target.get("name", target.get("id", "?"))
        title = str(target.get("title") or "").strip()
        base = f"跟随最近活跃的对话 · {name}"
        if title:
            base += f" · {title[:20]}"
        self.lbl_target.setText(base)

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
        self.keep_current_position(full_height=has_items)

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
                target = res.get("target")
                self.ball.target = target
                self.ball.target_mode = "pinned" if target.get("mode") == "pinned" else "auto"
                self.ball.pinned_target = target.get("pinned")
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
    def _sync_size(self):
        """同步布局后 adjustSize：刚 addWidget 的内容在事件循环前 sizeHint 未生效，
        直接 adjustSize 会拿到旧高度导致锚定漂移（悬浮球偏好规范坑 54）。"""
        if self.layout() is not None:
            self.layout().activate()
        self.adjustSize()

    def keep_current_position(self, full_height=False):
        """
        保持/校正面板位置。full_height=True 表示本次渲染是完整内容高度
        （动作列表已就绪），此时若尚未正式锚定则按铃铛重新锚定，保证每次
        打开最终位置一致；内容未就绪时先贴近铃铛，避免闪现左上角。
        """
        if self._user_dragged:
            # 用户拖过面板：尊重手动位置，内容变化只保持
            self._needs_reanchor = False
        elif full_height and self._needs_reanchor:
            # 布局尺寸要在事件循环跑过两轮后才稳定（第一轮分配宽度，
            # 第二轮换行高度生效），延迟锚定保证用真实全高计算位置
            self._needs_reanchor = False
            QTimer.singleShot(0, lambda: QTimer.singleShot(0, self._reanchor_once))
            return
        elif self._needs_reanchor:
            # 内容未就绪（空/加载中）：先贴到铃铛旁边，等 full_height 时正式锚定
            self.move_to_ball()
            return
        self._sync_size()
        screen = self.ball.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        x = max(geo.left(), min(self.x(), geo.right() - self.width() + 1))
        y = max(geo.top(), min(self.y(), geo.bottom() - self.height() + 1))
        self.move(x, y)

    def _reanchor_once(self):
        """延迟锚定：等布局稳定后按铃铛重新定位（用于内容就绪后的首次锚定）。"""
        if not self.isVisible():
            return
        self.move_to_ball()

    def move_to_ball(self):
        self._sync_size()
        b = self.ball
        screen = b.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        bw = b.width()
        bh = b.height()
        x = b.x() - self.width() - 8
        if x < geo.left():
            x = b.x() + bw + 8
        y = popup_anchor_y(
            (b.x(), b.y(), bw, bh), self.height(),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            PANEL_ANCHOR_RATIO,
        )
        self.move(x, y)

    def close_menu(self):
        self.hide()

    def showEvent(self, event):
        super().showEvent(event)
        self.target_timer.start()

    def hideEvent(self, event):
        self.target_timer.stop()
        self.target_menu.invalidate_pending()
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
    write_pid_file()
    import atexit
    atexit.register(clear_pid_file)
    ball = FenglingBall()
    ball.show()
    start_liveness_watchdog()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
