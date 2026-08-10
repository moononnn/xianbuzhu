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

from PyQt6.QtCore import QPoint, Qt
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

    def test_right_click_menu_exposes_four_named_volume_levels(self):
        self.ball.sound_volume = 0.65
        with patch.object(QMenu, "exec", return_value=None):
            self.ball._open_context_menu(QPoint(10, 10))
        menus = self.ball.findChildren(QMenu)
        volume_menu = next(menu for menu in menus if menu.title() == "声音大小")
        actions = volume_menu.actions()
        self.assertEqual([action.text() for action in actions], ["静音", "轻声", "适中", "清亮"])
        self.assertEqual([action.isChecked() for action in actions], [False, False, True, False])

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
