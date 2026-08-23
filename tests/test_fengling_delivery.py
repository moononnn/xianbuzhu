# -*- coding: utf-8 -*-
"""送达响铃物理：铃舌由真实冲量驱动、撞击发声（因动而声）的回归测试。

覆盖：三次交替 kick 稳定产生三声、单次 kick 从静止必响、
送达响铃窗口内允许非悬停发声、窗口外维持原规则（悬停才响）。
"""
import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import fengling_app as app

DT = 1.0 / 60.0
DELIVERY_KICKS = (
    app.DELIVERY_KICK,
    -app.DELIVERY_KICK * 0.82,
    app.DELIVERY_KICK * 0.66,
)


def _integrate(kick_strength, max_frames=600):
    """从静止（angle=0, velocity=0）施加一次 kick，积分物理直到撞击或衰减静止。

    返回 (是否产生有效撞击, 撞击力度, 撞击发生帧)。
    """
    angle, velocity = 0.0, kick_strength
    sound_cooldown = 0.0
    for frame in range(max_frames):
        target = 0.0  # 静止环境：taz=bell=0
        acc = (target - angle) * app.CLAPPER_SPRING - velocity * app.CLAPPER_DAMP
        velocity += acc * DT
        angle += velocity * DT
        angle, velocity, impact = app.resolve_clapper_collision(angle, velocity)
        sound_cooldown = max(0.0, sound_cooldown - DT)
        if impact >= app.CHIME_MIN_IMPACT and sound_cooldown <= 0:
            return True, impact, frame
        if abs(velocity) < 0.5 and abs(angle) < 1.0 and frame > 30:
            return False, 0.0, frame
    return False, 0.0, max_frames


class FenglingDeliveryPhysicsTests(unittest.TestCase):
    def test_single_kick_from_rest_always_rings(self):
        """送达 kick 从静止必响：力度足够越过铃口限位撞壁，且撞击力度过门槛。"""
        for kick in (140, 180, app.DELIVERY_KICK, 260, 300):
            ok, impact, frame = _integrate(kick)
            self.assertTrue(ok, f"kick={kick} 应产生撞击")
            self.assertGreaterEqual(impact, app.CHIME_MIN_IMPACT)
            self.assertLess(frame, 30, "应在半秒内撞壁")

    def test_three_kicks_produce_three_chimes(self):
        """三次交替 kick（0/260/520ms）按送达间隔稳定产生三声，力度自然衰减。"""
        angle, velocity = 0.0, 0.0
        sound_cooldown = 0.0
        ring_count = 0
        sim_time = 0.0
        kick_idx = 0
        next_kick_at = (0.0, 0.26, 0.52)
        ring_impacts = []
        for frame in range(1200):
            t = frame * DT
            if kick_idx < 3 and t >= next_kick_at[kick_idx]:
                velocity += DELIVERY_KICKS[kick_idx]
                sound_cooldown = 0.0  # 与 _delivery_kick 一致：清冷却保证本次撞击发声
                kick_idx += 1
            acc = (0.0 - angle) * app.CLAPPER_SPRING - velocity * app.CLAPPER_DAMP
            velocity += acc * DT
            angle += velocity * DT
            angle, velocity, impact = app.resolve_clapper_collision(angle, velocity)
            sound_cooldown = max(0.0, sound_cooldown - DT)
            if impact >= app.CHIME_MIN_IMPACT and sound_cooldown <= 0:
                ring_count += 1
                ring_impacts.append(impact)
                sound_cooldown = app.CHIME_COOLDOWN
        self.assertEqual(ring_count, 3, f"三次 kick 应响三声，实际 {ring_count}")
        # 力度逐次衰减：末声不应高于首声（撞击后反弹 + 阻尼的自然收势）
        self.assertLessEqual(ring_impacts[2], ring_impacts[0])

    def test_ring_window_allows_unhovered_ring(self):
        """送达响铃窗口语义：撞壁力度够时，窗口覆盖让非悬停也能响。"""
        # 窗口外：非悬停不响（原规则）
        self.assertFalse(app.should_attempt_chime(30.0, False, 0.0))
        # 窗口覆盖等价于把 hovered 视为 True（_tick 里的 chime_hovered 覆盖）
        self.assertTrue(app.should_attempt_chime(30.0, True, 0.0))
        # 力度不够仍不响（门槛不变）
        self.assertFalse(app.should_attempt_chime(5.0, True, 0.0))

    def test_cooldown_does_not_swallow_second_kick(self):
        """三次 kick 间隔 260ms 大于 CHIME_COOLDOWN，不会被冷却吞掉。"""
        self.assertGreater(0.26, app.CHIME_COOLDOWN)


if __name__ == "__main__":
    unittest.main()
