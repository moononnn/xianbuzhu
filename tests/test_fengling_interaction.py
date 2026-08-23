# -*- coding: utf-8 -*-
import os
import sys
import time
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ["HANA_HOME"] = tempfile.mkdtemp(prefix="wv-fengling-ui-")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from PyQt6.QtCore import QAbstractAnimation, QPoint, Qt
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QLabel, QPushButton, QMenu

import fengling_app


CATALOG = {
    "ok": True,
    "jar": 42,
    "gifts": [{"id": "tea", "name": "热茶", "icon": "", "price": 8, "type": "gift"}],
    "interacts": [{"id": "quiet", "name": "安静陪着", "icon": "", "type": "interact"}],
    "pranks": [{"id": "unplug", "name": "按下关机键", "icon": "", "type": "prank"}],
}
TARGET = {"ok": True, "target": {"id": "hanako", "name": "小花"}}


def fake_get(path, timeout=5):
    if path == "/catalog":
        return CATALOG
    if path == "/target":
        return TARGET
    raise AssertionError("不应请求：" + path)


class FenglingInteractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.ball = fengling_app.FenglingBall()
        self.ball.show()
        self.app.processEvents()

    def tearDown(self):
        if self.ball.menu:
            self.ball.menu.close()
        self.ball.close()
        self.app.processEvents()

    def test_left_and_right_mouse_buttons_have_separate_jobs(self):
        center = QPoint(self.ball.width() // 2, self.ball.height() // 2)
        with patch.object(self.ball, "_toggle_menu") as toggle:
            QTest.mouseClick(self.ball, Qt.MouseButton.LeftButton, pos=center)
            toggle.assert_called_once_with()
        with patch.object(self.ball, "_open_context_menu") as context:
            QTest.mouseClick(self.ball, Qt.MouseButton.RightButton, pos=center)
            context.assert_called_once()

    def test_transparent_window_uses_full_hit_area_without_sampling_gaps(self):
        self.assertTrue(self.ball.mask().isEmpty())

    def test_hover_entry_uses_direction_and_speed_for_the_first_push(self):
        self.ball.velocity_bell = 0.0
        self.ball.velocity_taz = 0.0
        self.ball._set_hovered(True, direction=-1.0, strength=1.4)
        self.assertEqual(self.ball.gust_direction, -1.0)
        self.assertAlmostEqual(self.ball.hover_strength, 1.4)
        self.assertLess(self.ball.velocity_bell, 0.0)
        self.assertGreater(self.ball.velocity_taz, 0.0)

    def test_hover_strength_is_clamped_to_safe_bounds(self):
        self.ball._set_hovered(True, direction=-1.0, strength=0.1)
        self.assertEqual(self.ball.hover_strength, fengling_app.MIN_WIND_STRENGTH)
        self.ball._set_hovered(False)
        self.ball._set_hovered(True, direction=1.0, strength=9.0)
        self.assertEqual(self.ball.hover_strength, fengling_app.MAX_WIND_STRENGTH)

    def test_tool_panel_hides_on_focus_loss_but_not_while_dragging_ball(self):
        menu = fengling_app.FenglingMenu(self.ball)
        self.ball.menu = menu
        menu.show()
        self.app.processEvents()
        menu._hide_after_focus_loss()
        self.assertFalse(menu.isVisible())

        menu.show()
        self.ball._drag = QPoint(1, 1)
        menu._hide_after_focus_loss()
        self.assertTrue(menu.isVisible())
        self.ball._drag = None
        menu._on_app_state_changed(Qt.ApplicationState.ApplicationInactive)
        self.assertFalse(menu.isVisible())
        menu.close()

    def test_tool_panel_fades_after_mouse_leave_and_restores_on_enter(self):
        menu = fengling_app.FenglingMenu(self.ball)
        menu._cursor_inside = lambda: False
        menu._reset_fade_on_show()
        self.assertTrue(menu._fade_out_timer.isSingleShot())
        self.assertTrue(menu._fade_out_timer.isActive())

        menu._on_fade_leave()
        self.assertTrue(menu._fade_out_timer.isActive())
        menu._begin_fade_out()
        self.assertEqual(menu._fade_anim.state(), QAbstractAnimation.State.Running)
        self.assertEqual(menu._fade_anim.endValue(), fengling_app.FADE_OUT_OPACITY)
        menu._fade_anim.setCurrentTime(menu._fade_anim.duration())
        self.assertAlmostEqual(menu.windowOpacity(), fengling_app.FADE_OUT_OPACITY)

        menu._on_fade_enter()
        self.assertFalse(menu._fade_out_timer.isActive())
        self.assertEqual(menu._fade_anim.endValue(), 1.0)
        menu._fade_anim.setCurrentTime(menu._fade_anim.duration())
        self.assertAlmostEqual(menu.windowOpacity(), 1.0)
        menu.close()

    def test_tool_panel_clears_fade_state_when_hidden(self):
        menu = fengling_app.FenglingMenu(self.ball)
        menu.show()
        self.app.processEvents()
        menu._on_fade_leave()
        self.assertTrue(menu._fade_out_timer.isActive())
        menu.hide()
        self.app.processEvents()
        self.assertFalse(menu._fade_out_timer.isActive())
        self.assertEqual(menu._fade_anim.state(), QAbstractAnimation.State.Stopped)
        menu.close()

    def test_right_click_menu_uses_same_fade_behavior(self):
        menu = fengling_app.FenglingContextMenu(self.ball)
        menu._cursor_inside = lambda: False
        menu._reset_fade_on_show()
        self.assertTrue(menu._fade_out_timer.isSingleShot())
        self.assertTrue(menu._fade_out_timer.isActive())

        menu._on_fade_leave()
        menu._begin_fade_out()
        self.assertEqual(menu._fade_anim.endValue(), fengling_app.FADE_OUT_OPACITY)
        menu._fade_anim.setCurrentTime(menu._fade_anim.duration())
        self.assertAlmostEqual(menu.windowOpacity(), fengling_app.FADE_OUT_OPACITY)

        menu._on_fade_enter()
        self.assertFalse(menu._fade_out_timer.isActive())
        menu._fade_anim.setCurrentTime(menu._fade_anim.duration())
        self.assertAlmostEqual(menu.windowOpacity(), 1.0)
        menu.close()

    def test_left_menu_has_only_interaction_and_gift_tabs(self):
        with patch.object(fengling_app, "api_get", side_effect=fake_get):
            menu = fengling_app.FenglingMenu(self.ball)
            menu.refresh()
        self.assertIsInstance(menu.lbl_target, QLabel)
        self.assertEqual(menu.lbl_target.text(), "跟随当前对话 · 小花")
        self.assertTrue(hasattr(menu, "btn_interact"))
        self.assertTrue(hasattr(menu, "btn_gift"))
        self.assertFalse(hasattr(menu, "btn_prank"))
        self.assertFalse(hasattr(menu, "_next_partner"))
        self.assertEqual(menu.windowType(), Qt.WindowType.Tool)
        self.assertTrue(menu.windowFlags() & Qt.WindowType.NoDropShadowWindowHint)
        menu.show()
        self.app.processEvents()
        image = menu.grab().toImage()
        center = image.pixelColor(menu.width() // 2, menu.height() // 2)
        corner = image.pixelColor(0, 0)
        self.assertEqual(center.alpha(), 255, "菜单纸面背景不能透成桌面底色")
        self.assertEqual(corner.alpha(), 0, "圆角外侧必须保持透明，不能露出方形底框")
        menu.close()

    def test_target_selector_requires_agent_before_showing_top_five_sessions(self):
        menu = fengling_app.FenglingMenu(self.ball)
        target_menu = menu.target_menu
        self.assertTrue(hasattr(menu, "btn_target"))
        self.assertTrue(hasattr(target_menu, "btn_auto"))
        self.assertTrue(hasattr(target_menu, "btn_manual"))
        self.assertFalse(hasattr(target_menu, "btn_recent"))
        self.assertFalse(hasattr(target_menu, "btn_by_agent"))

        target_menu.view_mode = "manual"
        target_menu.agents = [
            {"id": "hanako", "name": "小花"},
            {"id": "helperB", "name": "绯月"},
        ]
        target_menu.sessions = [
            {
                "agentId": "helperB",
                "agentName": "绯月",
                "sessionPath": f"C:/sessions/{index}.jsonl",
                "title": f"对话 {index}",
                "lastUserTime": 1_000 + index,
            }
            for index in range(7)
        ]
        target_menu._sync_ui()
        agent_buttons = [
            button for button in target_menu.findChildren(QPushButton)
            if button.objectName() == "targetItem"
        ]
        self.assertEqual([button.text() for button in agent_buttons], ["小花", "绯月"])
        self.assertIn("先选一位助手", target_menu.lbl_hint.text())

        target_menu.selected_agent_id = "helperB"
        target_menu._sync_ui()
        self.app.processEvents()
        session_buttons = [
            button for button in target_menu.findChildren(QPushButton)
            if button.objectName() == "targetItem"
        ]
        self.assertEqual(len(session_buttons), 5)
        self.assertEqual(session_buttons[0].text(), "对话 0")
        self.assertIn("绯月", target_menu.lbl_hint.text())
        menu.close()

    def test_reopening_pinned_target_selector_refreshes_recent_sessions(self):
        menu = fengling_app.FenglingMenu(self.ball)
        self.ball.target_mode = "pinned"
        with patch.object(menu.target_menu, "refresh_async") as refresh:
            menu._toggle_target_menu()
        refresh.assert_called_once_with()
        menu.close()

    def test_target_selector_pins_the_chosen_session_for_original_panel(self):
        menu = fengling_app.FenglingMenu(self.ball)
        target_menu = menu.target_menu
        target_menu.view_mode = "manual"
        with patch.object(fengling_app, "api_post", return_value={"ok": True}), patch.object(
            menu, "_sync_target_state"
        ):
            target_menu._pick({
                "agentId": "helperB",
                "agentName": "绯月",
                "sessionPath": "C:/sessions/fixed.jsonl",
                "title": "绯月的对话",
            })
        self.assertEqual(self.ball.target_mode, "pinned")
        self.assertEqual(self.ball.pinned_target["sessionPath"], "C:/sessions/fixed.jsonl")
        self.assertIn("固定对话", menu.lbl_target.text())
        menu.close()

    def test_new_heart_only_plays_sound_until_user_opens_panel(self):
        heart = {
            "id": "heart-1",
            "partnerName": "伙伴B",
            "gift": {"name": "星星灯", "icon": "🌟"},
            "message": "给你留了一盏小灯。",
        }
        with patch.object(self.ball, "_open_menu") as open_menu, patch.object(
            self.ball, "_ack_hearts_async"
        ) as ack, patch.object(self.ball, "_swing_for_delivery") as swing:
            self.ball._apply_heart_poll({
                "ok": True,
                "new_hearts": [heart],
                "ack_ids": ["heart-1"],
                "seen_ids": ["heart-1"],
                "seeded": True,
            })
        self.assertEqual(self.ball.current_heart, heart)
        self.assertIsNone(self.ball.menu)
        open_menu.assert_not_called()
        ack.assert_called_once_with(["heart-1"])
        swing.assert_called_once_with()

    def test_user_click_opens_pending_heart_card_after_sound_only_delivery(self):
        heart = {
            "id": "heart-1",
            "partnerName": "伙伴B",
            "gift": {"name": "星星灯", "icon": "🌟"},
            "message": "给你留了一盏小灯。",
        }
        with patch.object(self.ball, "_ack_hearts_async"), patch.object(
            self.ball, "_swing_for_delivery"
        ):
            self.ball._apply_heart_poll({
                "ok": True,
                "new_hearts": [heart],
                "ack_ids": ["heart-1"],
                "seen_ids": ["heart-1"],
                "seeded": True,
            })
        with patch.object(fengling_app.FenglingMenu, "refresh_async"):
            self.ball._open_menu()
        self.app.processEvents()
        self.assertIsNotNone(self.ball.menu)
        self.assertTrue(self.ball.menu.isVisible())
        self.assertTrue(self.ball.menu.heart_card.isVisible())
        self.assertEqual(self.ball.menu.lbl_heart_title.text(), "伙伴B给你送了星星灯")
        self.ball.menu.close()

    def test_open_refresh_pulls_latest_pending_heart_without_waiting_for_poll_timer(self):
        menu = fengling_app.FenglingMenu(self.ball)
        self.ball.menu = menu
        heart = {
            "id": "heart-refresh",
            "status": "unread",
            "partnerName": "伙伴B",
            "gift": {"name": "星星灯", "icon": "🌟"},
            "message": "打开时直接补到的心意。",
        }
        menu._apply_async_refresh({
            "catalog": None,
            "targetLoaded": False,
            "target_seq": menu._target_seq,
            "hearts": [heart],
        })
        self.assertEqual(self.ball.current_heart["id"], "heart-refresh")
        self.assertEqual([item["id"] for item in self.ball.heart_queue], ["heart-refresh"])
        menu.close()

    def test_multiple_new_hearts_stay_in_queue_and_show_latest_first(self):
        hearts = [
            {
                "id": "heart-newest",
                "status": "unread",
                "partnerName": "伙伴B",
                "gift": {"name": "星星灯", "icon": "🌟"},
                "message": "最新的一份心意。",
            },
            {
                "id": "heart-older",
                "status": "unread",
                "partnerName": "伙伴B",
                "gift": {"name": "热茶", "icon": "🍵"},
                "message": "前一份心意。",
            },
        ]
        with patch.object(self.ball, "_ack_hearts_async") as ack, patch.object(
            self.ball, "_swing_for_delivery"
        ) as swing:
            self.ball._apply_heart_poll({
                "ok": True,
                "hearts": hearts,
                "new_hearts": hearts,
                "ack_ids": ["heart-newest", "heart-older"],
                "seen_ids": ["heart-newest", "heart-older"],
                "seeded": True,
            })
        self.assertEqual(
            [item["id"] for item in self.ball.heart_queue],
            ["heart-newest", "heart-older"],
        )
        self.assertEqual(self.ball.current_heart["id"], "heart-newest")
        ack.assert_called_once_with(["heart-newest", "heart-older"])
        swing.assert_called_once_with()

        menu = fengling_app.FenglingMenu(self.ball)
        self.ball.menu = menu
        menu.prepare_for_show()
        menu.show()
        self.app.processEvents()
        self.assertTrue(menu.heart_card.isVisible())
        self.assertIn("还有 1 份心意", menu.lbl_heart_hint.text())

        with patch.object(self.ball, "_dismiss_hearts_async") as dismiss:
            menu._hide_current_heart()
        dismiss.assert_called_once_with(["heart-newest"])
        menu.close_menu()
        menu.prepare_for_show()
        menu.show()
        self.app.processEvents()
        self.assertTrue(menu.heart_card.isVisible())
        self.assertEqual(menu.lbl_heart_title.text(), "伙伴B给你送了热茶")
        menu.close()

    def test_delivered_unread_heart_is_available_without_repeating_delivery_sound(self):
        heart = {
            "id": "heart-delivered",
            "status": "unread",
            "deliveredAt": "already",
            "partnerName": "伙伴B",
            "gift": {"name": "星星灯", "icon": "🌟"},
            "message": "已经送达过，但还没有看。",
        }
        with patch.object(self.ball, "_ack_hearts_async") as ack, patch.object(
            self.ball, "_swing_for_delivery"
        ) as swing:
            self.ball._apply_heart_poll({
                "ok": True,
                "hearts": [heart],
                "new_hearts": [],
                "ack_ids": [],
                "seen_ids": ["heart-delivered"],
                "seeded": True,
            })
        self.assertEqual(self.ball.current_heart["id"], "heart-delivered")
        self.assertEqual([item["id"] for item in self.ball.heart_queue], ["heart-delivered"])
        ack.assert_not_called()
        swing.assert_not_called()

    def test_delivery_swing_kicks_clapper_three_times(self):
        """送达改为物理响铃：三次交替 kick 直接作用于铃舌速度，由撞击发声（因动而声）。"""
        self.ball._delivery_ring_until = 0.0
        self.ball._sound_cooldown = 0.0
        self.ball.velocity_clapper = 0.0
        with patch.object(fengling_app.QTimer, "singleShot") as schedule:
            self.ball._swing_for_delivery()
        self.assertEqual(
            [call.args[0] for call in schedule.call_args_list],
            [0, 260, 520],
        )
        kicks = [call.args[1] for call in schedule.call_args_list]
        self.assertEqual(len(kicks), 3)
        # 触发三次 kick：每次清冷却、给铃舌加速度冲量（不直接播放任何声音）
        for kick in kicks:
            kick()
        self.assertNotEqual(self.ball.velocity_clapper, 0.0)
        # 送达窗口已打开：期内撞壁允许非悬停发声
        self.assertGreater(self.ball._delivery_ring_until, 0.0)

    def test_current_heart_is_rendered_with_a_light_continuation_hint(self):
        self.ball.catalog = CATALOG
        self.ball.target = TARGET["target"]
        self.ball.current_heart = {
            "id": "heart-1",
            "partnerName": "伙伴B",
            "gift": {"name": "星星灯", "icon": "🌟"},
            "message": "给你留了一盏小灯。",
        }
        menu = fengling_app.FenglingMenu(self.ball)
        menu.prepare_for_show()
        menu.show()
        self.app.processEvents()
        self.assertTrue(menu.heart_card.isVisible())
        self.assertEqual(menu.lbl_heart_title.text(), "伙伴B给你送了星星灯")
        self.assertEqual(menu.lbl_heart_gift.text(), "🌟  星星灯")
        self.assertEqual(menu.lbl_heart_message.text(), "给你留了一盏小灯。")
        self.assertIn("回应伙伴B", menu.lbl_heart_hint.text())
        self.assertIn("继续互动或送一份心意", menu.lbl_heart_hint.text())
        self.assertFalse(hasattr(menu, "btn_heart_return"))
        self.assertFalse(hasattr(menu, "_return_heart_id"))
        menu.close()

    def test_responded_heart_stops_inviting_another_return(self):
        self.ball.catalog = CATALOG
        self.ball.target = TARGET["target"]
        self.ball.current_heart = {
            "id": "heart-1",
            "partnerName": "伙伴B",
            "gift": {"name": "星星灯", "icon": "🌟"},
            "message": "给你留了一盏小灯。",
            "responded": True,
        }
        menu = fengling_app.FenglingMenu(self.ball)
        menu.prepare_for_show()
        menu.show()
        self.app.processEvents()
        self.assertEqual(menu.lbl_heart_hint.text(), "你已经回应过这份心意。")
        menu.close()

    def test_main_page_confirmation_clears_visible_heart_card(self):
        self.ball.current_heart = {
            "id": "heart-1",
            "partnerName": "伙伴B",
            "gift": {"name": "星星灯", "icon": "🌟"},
            "message": "给你留了一盏小灯。",
            "status": "unread",
        }
        menu = fengling_app.FenglingMenu(self.ball)
        self.ball.menu = menu
        menu.prepare_for_show()
        menu.show()
        self.app.processEvents()
        self.assertTrue(menu.heart_card.isVisible())

        self.ball._apply_heart_poll({
            "ok": True,
            "hearts": [{"id": "heart-1", "status": "read"}],
            "new_hearts": [],
            "ack_ids": [],
            "seen_ids": ["heart-1"],
            "seeded": True,
        })
        self.app.processEvents()
        self.assertIsNone(self.ball.current_heart)
        self.assertFalse(menu.heart_card.isVisible())
        menu.close()

    def test_keep_heart_dismisses_current_card_after_reopen(self):
        self.ball.current_heart = {
            "id": "heart-1",
            "partnerName": "伙伴B",
            "gift": {"name": "星星灯", "icon": "🌟"},
            "message": "给你留了一盏小灯。",
        }
        menu = fengling_app.FenglingMenu(self.ball)
        self.ball.menu = menu
        menu.prepare_for_show()
        menu.show()
        self.app.processEvents()
        self.assertTrue(menu.heart_card.isVisible())

        with patch.object(self.ball, "_dismiss_hearts_async") as dismiss:
            menu._hide_current_heart()
        self.assertIsNone(self.ball.current_heart)
        self.assertFalse(menu.heart_card.isVisible())
        dismiss.assert_called_once_with(["heart-1"])

        menu.close_menu()
        menu.prepare_for_show()
        menu.show()
        self.app.processEvents()
        self.assertFalse(menu.heart_card.isVisible())
        menu.close()

    def test_same_action_data_does_not_rebuild_buttons_or_jump_height(self):
        with patch.object(fengling_app, "api_get", side_effect=fake_get):
            menu = fengling_app.FenglingMenu(self.ball)
            menu.refresh()
        before = [id(button) for button in menu.findChildren(QPushButton)]
        menu._render_actions("interact")
        self.app.processEvents()
        after = [id(button) for button in menu.findChildren(QPushButton)]
        self.assertEqual(after, before)
        menu.close()

    def test_switching_tabs_keeps_the_popup_anchor_stable(self):
        with patch.object(fengling_app, "api_get", side_effect=fake_get):
            menu = fengling_app.FenglingMenu(self.ball)
            menu.refresh()
        menu.move(120, 120)
        menu.show()
        self.app.processEvents()
        original = menu.pos()
        menu._render_actions("gift")
        self.app.processEvents()
        self.assertEqual(menu.pos(), original)
        menu._render_actions("interact")
        self.app.processEvents()
        self.assertEqual(menu.pos(), original)
        menu.close()

    def test_open_tool_panel_follows_a_real_mouse_drag(self):
        # 本测试文件共用一个临时 HANA_HOME；前序用例可能把状态球存到屏幕边缘。
        # 先放回安全位置，避免贴边吸附把本次 30px 拖动抵消掉。
        self.ball.move(100, 100)
        self.app.processEvents()
        with patch.object(fengling_app, "api_get", side_effect=fake_get):
            menu = fengling_app.FenglingMenu(self.ball)
            menu.refresh()
        self.ball.menu = menu
        menu.move_to_ball()
        menu.show()
        self.app.processEvents()

        old_ball_pos = self.ball.pos()
        old_menu_pos = menu.pos()
        center = QPoint(self.ball.width() // 2, self.ball.height() // 2)
        QTest.mousePress(self.ball, Qt.MouseButton.LeftButton, pos=center)
        QTest.mouseMove(self.ball, center + QPoint(30, 20), delay=20)
        QTest.mouseRelease(
            self.ball,
            Qt.MouseButton.LeftButton,
            pos=center + QPoint(30, 20),
        )
        self.app.processEvents()
        self.assertNotEqual(self.ball.pos(), old_ball_pos)
        self.assertNotEqual(menu.pos(), old_menu_pos)
        self.assertTrue(menu.isVisible())
        menu.close()

    def test_open_menu_shows_cached_panel_before_async_refresh(self):
        menu = fengling_app.FenglingMenu(self.ball)
        self.ball.menu = menu
        with patch.object(menu, "refresh") as sync_refresh, patch.object(
            menu, "refresh_async"
        ) as async_refresh:
            self.ball._open_menu()
        self.assertTrue(menu.isVisible())
        sync_refresh.assert_not_called()
        async_refresh.assert_called_once_with()
        menu.close()

    def test_new_heart_keeps_visible_menu_position_and_page(self):
        with patch.object(fengling_app, "api_get", side_effect=fake_get):
            menu = fengling_app.FenglingMenu(self.ball)
            menu.refresh()
        self.ball.menu = menu
        menu.move(120, 120)
        menu._user_dragged = True
        menu.show()
        self.app.processEvents()
        self.ball.current_heart = {
            "id": "heart-1",
            "partnerName": "伙伴B",
            "gift": {"name": "星星灯", "icon": "🌟"},
            "message": "给你留了一盏小灯。",
        }
        original = menu.pos()
        with patch.object(menu, "refresh_async") as refresh:
            self.ball._open_menu()
        self.assertEqual(menu.pos(), original)
        self.assertTrue(menu._user_dragged)
        refresh.assert_called_once_with()
        menu.close()

    def test_right_click_menu_exposes_four_named_volume_levels(self):
        self.ball.sound_volume = 0.65
        with patch.object(QMenu, "exec", return_value=None):
            self.ball._open_context_menu(QPoint(10, 10))
        menus = self.ball.findChildren(QMenu)
        volume_menu = next(menu for menu in menus if menu.title() == "声音大小")
        self.assertIsInstance(volume_menu, fengling_app.FenglingContextMenu)
        actions = volume_menu.actions()
        self.assertEqual([action.text() for action in actions], ["静音", "轻声", "适中", "清亮"])
        self.assertEqual([action.isChecked() for action in actions], [False, False, True, False])

    def test_volume_choice_survives_state_round_trip_including_explicit_mute(self):
        with tempfile.TemporaryDirectory() as temp:
            state_path = os.path.join(temp, "fengling-state.json")
            with patch.object(fengling_app, "STATE_PATH", state_path):
                fengling_app.save_state({"soundVolume": 1.0, "soundEnabled": True})
                self.assertEqual(fengling_app.resolve_saved_volume(fengling_app.load_state()), 1.0)
                self.assertFalse(os.path.exists(state_path + ".tmp"))

                fengling_app.save_state({"soundVolume": 0.0, "soundEnabled": False})
                self.assertEqual(fengling_app.resolve_saved_volume(fengling_app.load_state()), 0.0)
                self.assertTrue(os.path.exists(state_path + ".bak"))
                with open(state_path, "w", encoding="utf-8") as f:
                    f.write("{broken")
                self.assertEqual(fengling_app.resolve_saved_volume(fengling_app.load_state()), 1.0)
                self.assertFalse(os.path.exists(state_path + ".tmp"))

    def test_volume_is_persisted_and_new_chimes_use_independent_voices(self):
        with patch.object(fengling_app, "save_state") as save:
            self.ball._set_volume(0.65)
        self.assertEqual(self.ball.sound_volume, 0.65)
        self.assertEqual(self.ball.state["soundVolume"], 0.65)
        self.assertTrue(self.ball.state["soundEnabled"])
        save.assert_called_once_with(self.ball.state)

        busy = MagicMock()
        busy.isPlaying.return_value = True
        first_idle = MagicMock()
        first_idle.isPlaying.return_value = False
        second_idle = MagicMock()
        second_idle.isPlaying.return_value = False
        self.ball._sound_voices = [busy, first_idle, second_idle]

        self.ball._play_chime(24.0)
        first_idle.play.assert_called_once_with()
        busy.stop.assert_not_called()
        first_idle.stop.assert_not_called()
        self.assertEqual(self.ball._sound_cooldown, fengling_app.CHIME_COOLDOWN)

        self.ball._play_chime(24.0)
        first_idle.play.assert_called_once_with()
        second_idle.play.assert_not_called()

        self.ball._sound_cooldown = 0.0
        first_idle.isPlaying.return_value = True
        self.ball._play_chime(50.0)
        second_idle.play.assert_called_once_with()
        first_idle.stop.assert_not_called()

        self.ball._set_volume(0.0)
        self.ball._sound_cooldown = 0.0
        self.ball._play_chime(50.0)
        self.assertEqual(second_idle.play.call_count, 1)

    @unittest.skipIf(sys.platform != "win32", "winsound 回退仅 Windows 平台")
    def test_winsound_fallback_still_uses_async_file_playback(self):
        self.ball.sound_volume = 0.65
        self.ball._sound_voices = []
        self.ball._sound_cooldown = 0.0
        with patch.object(fengling_app.winsound, "PlaySound") as play:
            self.ball._play_chime(24.0)
        play.assert_called_once()
        sound_path, flags = play.call_args.args
        self.assertIsInstance(sound_path, str)
        self.assertTrue(os.path.exists(sound_path))
        self.assertTrue(flags & fengling_app.winsound.SND_FILENAME)
        self.assertTrue(flags & fengling_app.winsound.SND_ASYNC)
        self.assertFalse(flags & fengling_app.winsound.SND_MEMORY)

    def test_real_async_refresh_delivers_catalog_and_target(self):
        menu = fengling_app.FenglingMenu(self.ball)
        with patch.object(fengling_app, "api_get", side_effect=fake_get):
            menu.refresh_async()
            deadline = time.monotonic() + 1.0
            while menu._refreshing and time.monotonic() < deadline:
                self.app.processEvents()
                time.sleep(0.005)
        self.assertFalse(menu._refreshing)
        self.assertEqual(self.ball.catalog, CATALOG)
        self.assertEqual(self.ball.target, TARGET["target"])
        menu.close()

    def test_interaction_tab_contains_daily_actions_and_pranks(self):
        with patch.object(fengling_app, "api_get", side_effect=fake_get):
            menu = fengling_app.FenglingMenu(self.ball)
            menu.refresh()
        action_texts = [
            button.text()
            for button in menu.findChildren(QPushButton)
            if button.objectName() == "action"
        ]
        self.assertEqual(action_texts, ["安静陪着", "按下关机键"])
        menu.close()

    def test_missing_target_has_a_clear_read_only_state(self):
        def fake_missing(path, timeout=5):
            return CATALOG if path == "/catalog" else {"ok": True, "target": None}

        with patch.object(fengling_app, "api_get", side_effect=fake_missing):
            menu = fengling_app.FenglingMenu(self.ball)
            menu.refresh()
        self.assertEqual(menu.lbl_target.text(), "跟随当前对话 · 暂未找到")
        menu.close()

    def test_success_reply_refreshes_displayed_target(self):
        with patch.object(fengling_app, "api_get", side_effect=fake_get):
            menu = fengling_app.FenglingMenu(self.ball)
            menu.refresh()
        def fake_visit(_vtype, _item_id):
            self.assertFalse(menu.btn_interact.isEnabled(), "请求期间按钮应禁用，防止重复点击")
            return {"success": True, "target": {"id": "helperB", "name": "伙伴B"}}

        with patch.object(self.ball, "_do_visit", side_effect=fake_visit), patch.object(
            menu, "_refresh_jar"
        ):
            menu._do_action("interact", "quiet")
        self.assertEqual(menu.lbl_target.text(), "跟随当前对话 · 伙伴B")
        self.assertEqual(menu.lbl_feedback.text(), "送达了")
        menu.close()

    def test_visit_payload_does_not_contain_an_assistant_selector(self):
        captured = {}

        def fake_post(path, payload, timeout=12):
            captured.update({"path": path, "payload": payload, "timeout": timeout})
            return {"success": True}

        with patch.object(fengling_app, "api_post", side_effect=fake_post):
            self.ball._do_visit("gift", "tea")
            self.assertEqual(captured["timeout"], 20)
            self.ball._do_visit("prank", "unplug")
            self.assertEqual(captured["timeout"], 55)
        self.assertEqual(captured["path"], "/visit")
        self.assertEqual(captured["payload"], {"type": "prank", "itemId": "unplug"})


if __name__ == "__main__":
    unittest.main()
