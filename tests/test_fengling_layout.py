# -*- coding: utf-8 -*-
import io
import math
import os
import random
import sys
import tempfile
import unittest
import wave
from pathlib import Path

os.environ["HANA_HOME"] = tempfile.mkdtemp(prefix="wv-fengling-layout-")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import fengling_dsp as dsp
from fengling_app import (
    CHIME_COOLDOWN,
    CHIME_MIN_IMPACT,
    CHIME_SLICE_POOL_SIZE,
    CHIME_VOICE_COUNT,
    CLAPPER_DAMP,
    CLAPPER_LIMIT,
    CLAPPER_RX,
    CLAPPER_RY,
    CLAPPER_SPRING,
    MAX_WIND_STRENGTH,
    MENU_ANCHOR_RATIO,
    MIN_WIND_STRENGTH,
    PANEL_ANCHOR_RATIO,
    RENDER_SCALE,
    calculate_entry_wind,
    chime_volume_from_impact,
    clamp_position,
    linkage_curve_controls,
    linkage_points,
    point_in_chime_zone,
    popup_anchor_y,
    resolve_clapper_collision,
    resolve_hover_state,
    normalize_sound_state,
    resolve_saved_volume,
    should_attempt_chime,
    wind_strength_from_speed,
)


class FenglingLayoutTests(unittest.TestCase):
    def test_saved_position_is_pulled_back_after_display_scaling(self):
        self.assertEqual(
            clamp_position(1640, 584, 108, 108, 0, 0, 1706, 1066),
            (1583, 584),
        )

    def test_visible_position_is_kept(self):
        self.assertEqual(
            clamp_position(920, 480, 108, 108, 0, 0, 1706, 1066),
            (920, 480),
        )

    def test_top_left_position_keeps_visibility_inset(self):
        self.assertEqual(
            clamp_position(-50, -20, 108, 108, 0, 0, 1706, 1066),
            (16, 16),
        )

    def test_anchor_ratio_places_bell_above_panel_and_menu(self):
        # 左键面板：铃铛中心在面板高度 38% 处（面板主体在铃铛下方，悬浮球偏好规范）
        y = popup_anchor_y((100, 100, 108, 108), 300, (0, 0, 800, 600), PANEL_ANCHOR_RATIO)
        self.assertEqual(y, 100 + 54 - int(300 * 0.38))  # 154 - 114 = 40
        self.assertEqual(y, 40)
        # 右键菜单：铃铛中心在菜单高度 33% 处（菜单主体在铃铛下方）
        y = popup_anchor_y((100, 100, 108, 108), 300, (0, 0, 800, 600), MENU_ANCHOR_RATIO)
        self.assertEqual(y, 100 + 54 - int(300 * 0.33))  # 154 - 99 = 55
        self.assertEqual(y, 55)
        # 两个比例都应低于居中（主体在下方）
        self.assertLess(PANEL_ANCHOR_RATIO, 0.5)
        self.assertLess(MENU_ANCHOR_RATIO, 0.5)

    def test_popup_anchor_y_clamps_within_screen(self):
        y = popup_anchor_y((100, 0, 108, 108), 300, (0, 0, 800, 600), 0.9)
        self.assertEqual(y, 0)
        y = popup_anchor_y((100, 500, 108, 108), 300, (0, 0, 800, 600), 0.1)
        self.assertEqual(y, 300)

    def test_wind_strength_grows_smoothly_with_cursor_speed(self):
        slow = wind_strength_from_speed(80)
        medium = wind_strength_from_speed(600)
        fast = wind_strength_from_speed(1600)
        self.assertEqual(wind_strength_from_speed(0), MIN_WIND_STRENGTH)
        self.assertEqual(wind_strength_from_speed(-200), MIN_WIND_STRENGTH)
        self.assertGreater(medium, slow)
        self.assertGreater(fast, medium)
        self.assertGreaterEqual(slow, MIN_WIND_STRENGTH)
        self.assertEqual(fast, MAX_WIND_STRENGTH)

    def test_entry_from_left_and_right_produces_opposite_wind(self):
        left_direction, _, left_strength = calculate_entry_wind(
            80, 100, 120, 100, 0.05, 150
        )
        right_direction, _, right_strength = calculate_entry_wind(
            220, 100, 180, 100, 0.05, 150
        )
        self.assertEqual(left_direction, -1.0)
        self.assertEqual(right_direction, 1.0)
        self.assertEqual(left_strength, right_strength)

    def test_near_center_entry_uses_horizontal_motion_as_fallback(self):
        left_direction, _, _ = calculate_entry_wind(149.5, 60, 155, 100, 0.05, 150)
        right_direction, _, _ = calculate_entry_wind(150.5, 60, 145, 100, 0.05, 150)
        self.assertEqual(left_direction, -1.0)
        self.assertEqual(right_direction, 1.0)

    def test_still_center_entry_uses_current_side_as_last_fallback(self):
        left_direction, _, _ = calculate_entry_wind(149.5, 60, 149.9, 100, 0.05, 150)
        right_direction, _, _ = calculate_entry_wind(149.5, 60, 150.5, 100, 0.05, 150)
        self.assertEqual(left_direction, -1.0)
        self.assertEqual(right_direction, 1.0)

    def test_hover_entry_follows_visible_single_bell_and_ignores_transparent_corners(self):
        self.assertTrue(point_in_chime_zone(54, 30))
        self.assertTrue(point_in_chime_zone(54, 70))
        self.assertFalse(point_in_chime_zone(20, 30))
        self.assertFalse(point_in_chime_zone(100, 100))
        hovered, outside = resolve_hover_state(False, 54, 50, 0.0, 0.016)
        self.assertTrue(hovered)
        self.assertEqual(outside, 0.0)

    def test_hover_stays_on_while_cursor_brushes_the_visual_outer_edge(self):
        hovered, outside = resolve_hover_state(True, 30, 50, 0.0, 0.016)
        self.assertTrue(hovered)
        self.assertEqual(outside, 0.0)

    def test_hover_only_ends_after_clear_and_sustained_leave(self):
        hovered, outside = resolve_hover_state(True, 8, 54, 0.0, 0.10)
        self.assertTrue(hovered)
        hovered, outside = resolve_hover_state(hovered, 8, 54, outside, 0.15)
        self.assertFalse(hovered)
        hovered, outside = resolve_hover_state(True, 30, 54, 0.10, 0.02)
        self.assertTrue(hovered)
        self.assertEqual(outside, 0.0)

    def test_hover_leave_delay_boundary_is_not_extended(self):
        hovered, outside = resolve_hover_state(True, 8, 54, 0.20, 0.04)
        self.assertFalse(hovered)
        self.assertAlmostEqual(outside, 0.24)

    def test_chime_requires_energy_threshold_and_cooldown(self):
        """碰撞触发新语义：悬停期间每次有效碰撞都响，频率由物理+门槛+冷却压住。"""
        self.assertTrue(should_attempt_chime(7.0, hovered=True, cooldown=0.0))
        self.assertFalse(should_attempt_chime(6.9, hovered=True, cooldown=0.0))
        self.assertFalse(should_attempt_chime(20.0, hovered=False, cooldown=0.0))
        self.assertFalse(
            should_attempt_chime(20.0, hovered=True, cooldown=0.01),
            "冷却期间碰壁不能响",
        )
        self.assertTrue(
            should_attempt_chime(20.0, hovered=True, cooldown=0.0),
            "冷却结束后同次悬停仍可继续响铃",
        )
        self.assertLessEqual(CHIME_COOLDOWN, 0.5, "短冷却：间隔由物理决定，冷却只防连击")

    def test_density_parameters_keep_chime_rate_ahead_of_slice_duration(self):
        """断点防御：碰撞触发率必须跟得上切片时长，否则声音出现循环断点。

        悬停时若碰撞间隔大于切片播放时长，听感就是"响完→静默→再响"的
        循环断点。触发率由铃舌弹簧/阻尼/门槛/冷却共同决定，任一参数
        单方面调松都可能让触发率落后于切片时长，这里锁住参数平衡。
        """
        self.assertGreaterEqual(CLAPPER_SPRING, 18.0, "铃舌要够活跃，触发率才能覆盖长切片")
        self.assertLessEqual(CLAPPER_DAMP, 3.5, "阻尼过高会压低碰撞频率")
        self.assertLessEqual(CHIME_MIN_IMPACT, 8.0, "门槛太高会让轻碰不响，出现静默断点")
        self.assertLessEqual(CHIME_COOLDOWN, 0.12, "冷却过长会人为拉出断点")
        self.assertGreaterEqual(CHIME_VOICE_COUNT, 6, "高密度触发下播放位置不足会截断尾音")

    def test_chime_volume_grows_with_impact_and_scales_with_master_volume(self):
        quiet = chime_volume_from_impact(7.0, 1.0)
        mid = chime_volume_from_impact(26.0, 1.0)
        loud = chime_volume_from_impact(60.0, 1.0)
        self.assertAlmostEqual(quiet, 0.55)
        self.assertAlmostEqual(loud, 1.0)
        self.assertGreater(mid, quiet)
        self.assertGreater(loud, mid)
        self.assertAlmostEqual(chime_volume_from_impact(26.0, 0.35), mid * 0.35)

    def test_clapper_only_rings_when_moving_outward_through_the_wall(self):
        angle, velocity, impact = resolve_clapper_collision(19.5, 22.0)
        self.assertEqual(angle, CLAPPER_LIMIT)
        self.assertLess(velocity, 0.0)
        self.assertEqual(impact, 22.0)
        angle, velocity, impact = resolve_clapper_collision(19.5, -8.0)
        self.assertEqual(angle, CLAPPER_LIMIT)
        self.assertEqual(velocity, -8.0)
        self.assertEqual(impact, 0.0)

    def test_clapper_limit_matches_the_bell_mouth_contact_geometry(self):
        """限角处：铃舌右缘越过铃口右内沿，且铃舌仍跨在铃口平面（能碰到壁）。"""
        _top, clapper, _knot = linkage_points(CLAPPER_LIMIT, 0.0)
        clapper_right = clapper.x() + CLAPPER_RX * RENDER_SCALE
        clapper_bottom = clapper.y() + CLAPPER_RY * RENDER_SCALE
        clapper_top = clapper.y() - CLAPPER_RY * RENDER_SCALE
        self.assertGreaterEqual(clapper_right, 227 * RENDER_SCALE)
        self.assertGreaterEqual(clapper_bottom, 184 * RENDER_SCALE)
        self.assertLessEqual(clapper_top, 184 * RENDER_SCALE)

    def test_linkage_bends_between_clapper_and_paper_instead_of_one_rigid_pivot(self):
        top, clapper, knot = linkage_points(12.0, -18.0)
        self.assertGreater(clapper.x(), top.x())
        self.assertLess(knot.x(), clapper.x())
        self.assertGreater(knot.y(), clapper.y())

    def test_linkage_curve_controls_sag_below_straight_segments(self):
        top, clapper, knot = linkage_points(10.0, -16.0)
        upper, lower = linkage_curve_controls(top, clapper, knot)
        self.assertGreater(upper.y(), (top.y() + clapper.y()) / 2 + 20 * RENDER_SCALE)
        straight_lower_y = clapper.y() + (knot.y() - clapper.y()) * 0.48
        self.assertGreater(lower.y(), straight_lower_y + 16 * RENDER_SCALE)

    def test_linkage_curve_changes_shape_with_relative_swing_speed(self):
        top, clapper, knot = linkage_points(8.0, -12.0)
        upper_left, lower_left = linkage_curve_controls(top, clapper, knot, -12.0)
        upper_right, lower_right = linkage_curve_controls(top, clapper, knot, 12.0)
        self.assertLess(upper_left.x(), upper_right.x())
        self.assertGreater(lower_left.x(), lower_right.x())

    def test_saved_volume_migrates_old_switch_and_snaps_to_named_levels(self):
        self.assertEqual(resolve_saved_volume({}), 0.0)
        self.assertEqual(resolve_saved_volume({"soundEnabled": True}), 0.65)
        self.assertEqual(resolve_saved_volume({"soundVolume": 0.9}), 1.0)
        self.assertEqual(resolve_saved_volume({"soundVolume": "bad"}), 0.0)

    def test_sound_state_materializes_default_and_legacy_values(self):
        state = {}
        volume, changed = normalize_sound_state(state)
        self.assertEqual(volume, 0.0)
        self.assertTrue(changed)
        self.assertEqual(state, {"soundVolume": 0.0, "soundEnabled": False})

        state = {"soundEnabled": True}
        volume, changed = normalize_sound_state(state)
        self.assertEqual(volume, 0.65)
        self.assertTrue(changed)
        self.assertEqual(state, {"soundEnabled": True, "soundVolume": 0.65})

    def test_chime_pool_is_short_struck_samples_from_the_cluster_recording(self):
        """碰撞音是实录锚点切片出的敲击声，不是 4.8 秒整段录音。"""
        name = "fengling-chime-cluster.wav"
        with wave.open(str(ROOT / "python" / name), "rb") as wav:
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getsampwidth(), 2)
            self.assertEqual(wav.getframerate(), 44100)
            self.assertGreaterEqual(wav.getnframes() / wav.getframerate(), 4.7)
        pool = dsp.build_chime_pool(
            str(ROOT / "python" / name), count=6, rng=random.Random(9)
        )
        self.assertEqual(len(pool), 6)
        durations = []
        for data in pool:
            with wave.open(io.BytesIO(data), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 1)
                self.assertEqual(wav.getsampwidth(), 2)
                self.assertEqual(wav.getframerate(), 44100)
                durations.append(wav.getnframes() / wav.getframerate())
        self.assertLess(max(durations), 2.0, "每个碰撞音是短促敲击（余韵绵长但不是整段录音）")
        self.assertGreater(min(durations), 0.3)
        self.assertGreater(len(set(pool)), 3, "每次碰撞音色各不相同")
        self.assertGreaterEqual(CHIME_SLICE_POOL_SIZE, 12)

    def test_visual_asset_is_a_single_bell_without_side_bells(self):
        svg = (ROOT / "python" / "fengling-bell.svg").read_text(encoding="utf-8")
        self.assertEqual(svg.count('class="bell-body"'), 1)
        self.assertNotIn("sideBellGrad", svg)


if __name__ == "__main__":
    unittest.main()
