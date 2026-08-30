# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from PyQt6.QtCore import QEvent, QPoint, QPointF, Qt
from PyQt6.QtGui import QMouseEvent

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ["HANA_HOME"] = tempfile.mkdtemp(prefix="wv-fusion-sound-")

from PyQt6.QtWidgets import QApplication, QMenu

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import fusion_ball


class _FakeFusionBall:
    sound_volume = 0.65
    action = "copy"

    def _set_volume(self, volume):
        self.sound_volume = volume

    def _set_action(self, action):
        self.action = action

    def close(self):
        return None


class FenglingFusionSoundTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_fusion_fengling_menu_reuses_original_target_selector(self):
        self.assertTrue(
            issubclass(
                fusion_ball.FusionFenglingMenu,
                fusion_ball._ORIGINAL_FENGLING.FenglingMenu,
            )
        )
        self.assertTrue(hasattr(fusion_ball._ORIGINAL_FENGLING, "TargetMenu"))

    def test_fusion_action_does_not_restore_target_from_before_a_switch(self):
        menu = fusion_ball.FusionFenglingMenu.__new__(fusion_ball.FusionFenglingMenu)
        menu.ball = type("Ball", (), {
            "target_revision": 2,
            "target": {"id": "new", "title": "新目标"},
            "target_mode": "pinned",
            "pinned_target": {"sessionPath": "new.jsonl"},
        })()
        menu._fusion_action_seq = 1
        menu._set_busy = MagicMock()
        menu._flash = MagicMock()
        menu._update_target_label = MagicMock()
        menu._apply_fusion_action({
            "seq": 1,
            "target_revision": 1,
            "result": {
                "success": True,
                "target": {"id": "old", "mode": "auto", "pinned": None},
            },
            "catalog": None,
        })
        self.assertEqual(menu.ball.target["id"], "new")
        self.assertEqual(menu.ball.target_mode, "pinned")
        self.assertEqual(menu.ball.pinned_target["sessionPath"], "new.jsonl")
        menu._update_target_label.assert_not_called()

    def test_fusion_reads_the_persisted_volume_before_environment_fallback(self):
        self.assertEqual(
            fusion_ball.resolve_fusion_sound_volume({"soundVolume": 0.65}),
            0.65,
        )
        self.assertEqual(
            fusion_ball.resolve_fusion_sound_volume({"soundVolume": 0.0}),
            0.0,
        )
        with patch.dict(os.environ, {"FUSION_SOUND_VOLUME": "1.0"}, clear=False):
            self.assertEqual(fusion_ball.resolve_fusion_sound_volume({}), 1.0)
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(fusion_ball.resolve_fusion_sound_volume({}), 0.0)

    @unittest.skipIf(sys.platform != "win32", "winsound 回退仅 Windows 平台")
    def test_fusion_qsound_loading_falls_back_instead_of_silently_dropping_chime(self):
        class FakeVoice:
            class Status:
                Ready = object()

            def __init__(self):
                self.played = False

            def isPlaying(self):
                return False

            def status(self):
                return "loading"

            def setVolume(self, _volume):
                return None

            def play(self):
                self.played = True

        ball = fusion_ball.FusionBall.__new__(fusion_ball.FusionBall)
        ball.sound_volume = 1.0
        ball._sound_cooldown = 0.0
        with open(ROOT / "python" / "fengling-chime-cluster.wav", "rb") as sample_file:
            sample = sample_file.read()
        ball._chime_pool = [sample]
        ball._last_chime_idx = -1
        ball._sound_voice_index = 0
        voice = FakeVoice()
        ball._sound_voices = [voice]
        with (
            patch.object(fusion_ball, "QSoundEffect", FakeVoice),
            patch.object(fusion_ball.winsound, "PlaySound") as play,
        ):
            ball._play_chime(24.0)
        play.assert_called_once()
        self.assertFalse(voice.played)

    def test_fusion_drag_has_a_backward_compatible_flower_physics_fallback(self):
        with (
            patch.object(fusion_ball._ORIGINAL_ZHUJIAN, "flower_drag_targets", None, create=True),
            patch.object(fusion_ball._ORIGINAL_ZHUJIAN, "flower_drag_impulses", None, create=True),
            patch.object(fusion_ball._ORIGINAL_ZHUJIAN, "advance_motion_spring", None, create=True),
        ):
            targets = fusion_ball.shared_flower_drag_targets(1000.0, 600.0)
            impulses = fusion_ball.shared_flower_drag_impulses(800.0, 400.0)
            value, velocity = fusion_ball.advance_shared_drag_spring(
                0.0, 0.0, targets[0], 58.0, 12.5, 1 / 60, 7.5,
            )
        self.assertLess(targets[2], targets[1])
        self.assertLess(impulses[2], impulses[1])
        self.assertLess(value, 0.0)
        self.assertLess(velocity, 0.0)

    def test_fusion_drag_feeds_both_wind_chime_and_flower_weight_layers(self):
        ball = fusion_ball.FusionBall()
        try:
            ball.move(100, 100)
            ball._reset_drag_motion(now=1.0)
            ball.move(166, 128)
            ball._record_drag_motion(now=1.05)
            self.assertGreater(ball._drag_velocity_x, 0.0)
            self.assertLess(ball.velocity_bell, 0.0)
            self.assertNotEqual(ball.velocity_clapper_spin, 0.0)
            self.assertLess(ball.drag_branch_velocity, 0.0)
            self.assertLess(ball.drag_flower_velocity, ball.drag_branch_velocity)
            self.assertLess(ball.drag_leaf_velocity, ball.drag_flower_velocity)
            self.assertLess(ball.drag_vertical_velocity, 0.0)
        finally:
            ball.close()

    def test_fusion_context_menu_matches_original_nested_volume_menu(self):
        menu = fusion_ball.FusionContextMenu(_FakeFusionBall())
        try:
            volume_menu = next(
                child for child in menu.findChildren(QMenu)
                if child.title() == "声音大小"
            )
            self.assertEqual(
                [action.text() for action in volume_menu.actions()],
                ["静音", "轻声", "适中", "清亮"],
            )
            self.assertEqual(
                [action.isChecked() for action in volume_menu.actions()],
                [False, False, True, False],
            )
            volume_menu.actions()[1].trigger()
            self.assertEqual(
                [action.isChecked() for action in volume_menu.actions()],
                [False, True, False, False],
            )
            self.assertFalse(hasattr(menu, "sound_button"))
        finally:
            menu.close()

    def test_context_hit_test_includes_visible_volume_submenu(self):
        menu = fusion_ball.FusionContextMenu(_FakeFusionBall())
        volume_menu = next(
            child for child in menu.findChildren(QMenu)
            if child.title() == "声音大小"
        )
        menu.setGeometry(100, 100, 180, 80)
        menu.show()
        volume_menu.setGeometry(300, 100, 120, 100)
        volume_menu.show()
        self.app.processEvents()
        try:
            nested_point = volume_menu.mapToGlobal(QPoint(10, 10))
            self.assertTrue(
                fusion_ball.menu_tree_contains_global(menu, nested_point)
            )
            self.assertFalse(
                fusion_ball.menu_tree_contains_global(menu, QPoint(20, 20))
            )
        finally:
            volume_menu.close()
            menu.close()

    def test_fusion_context_menu_exposes_jiegehua_send_mode_submenu(self):
        ball = _FakeFusionBall()
        menu = fusion_ball.FusionContextMenu(ball)
        try:
            send_menu = next(
                child for child in menu.findChildren(QMenu)
                if child.title() == "解语花 · 发送方式"
            )
            self.assertEqual(
                [action.text() for action in send_menu.actions()],
                ["直接发出", "复制"],
            )
            # 默认 copy：复制选中
            self.assertEqual(
                [action.isChecked() for action in send_menu.actions()],
                [False, True],
            )
            send_menu.actions()[0].trigger()
            self.assertEqual(ball.action, "send")
            self.assertEqual(
                [action.isChecked() for action in send_menu.actions()],
                [True, False],
            )
            send_menu.actions()[1].trigger()
            self.assertEqual(ball.action, "copy")
            self.assertEqual(
                [action.isChecked() for action in send_menu.actions()],
                [False, True],
            )
        finally:
            menu.close()

    def test_fusion_volume_changes_round_trip_through_the_fengling_state(self):
        with tempfile.TemporaryDirectory() as temp:
            state_path = os.path.join(temp, "fengling-state.json")
            with patch.object(fusion_ball._ORIGINAL_FENGLING, "STATE_PATH", state_path):
                fusion_ball._ORIGINAL_FENGLING.save_state({"x": 12, "y": 34})
                self.assertEqual(fusion_ball.resolve_fusion_sound_volume(), 0.0)

                self.assertEqual(fusion_ball.persist_fusion_sound_volume(0.65), 0.65)
                self.assertEqual(fusion_ball.resolve_fusion_sound_volume(), 0.65)
                self.assertEqual(
                    fusion_ball._ORIGINAL_FENGLING.load_state()["soundEnabled"],
                    True,
                )

                self.assertEqual(fusion_ball.persist_fusion_sound_volume(0.0), 0.0)
                self.assertEqual(fusion_ball.resolve_fusion_sound_volume(), 0.0)
                self.assertEqual(
                    fusion_ball._ORIGINAL_FENGLING.load_state()["soundEnabled"],
                    False,
                )

    def test_fusion_new_heart_only_plays_sound_until_user_opens_panel(self):
        ball = fusion_ball.FusionBall.__new__(fusion_ball.FusionBall)
        ball._heart_polling = True
        ball._heart_seen_ids = set()
        ball._heart_seeded = True
        ball._heart_dismissed_ids = set()
        ball.heart_queue = []
        ball.current_heart = None
        ball.menu = None
        heart = {
            "id": "heart-new",
            "partnerName": "伙伴B",
            "gift": {"name": "星星灯", "icon": "🌟"},
            "message": "给你留了一盏小灯。",
        }
        ball._ack_hearts_async = MagicMock()
        ball._swing_for_delivery = MagicMock()

        fusion_ball.FusionBall._apply_heart_poll(ball, {
            "ok": True,
            "hearts": [heart],
            "new_hearts": [heart],
            "ack_ids": ["heart-new"],
            "seen_ids": ["heart-new"],
            "seeded": True,
        })

        self.assertIs(ball.current_heart, heart)
        self.assertIsNone(ball.menu)
        ball._ack_hearts_async.assert_called_once_with(["heart-new"])
        ball._swing_for_delivery.assert_called_once_with()
        self.assertFalse(ball._heart_polling)

    def test_fusion_user_click_opens_pending_heart_card_after_sound_only_delivery(self):
        ball = fusion_ball.FusionBall()
        try:
            ball.current_heart = {
                "id": "heart-new",
                "partnerName": "伙伴B",
                "gift": {"name": "星星灯", "icon": "🌟"},
                "message": "给你留了一盏小灯。",
            }
            with patch.object(fusion_ball.FusionFenglingMenu, "refresh_async"):
                ball._open_menu()
            self.app.processEvents()
            page = ball.menu.fengling_page
            self.assertTrue(page.isVisible())
            self.assertTrue(page.heart_card.isVisible())
            self.assertEqual(page.lbl_heart_title.text(), "伙伴B给你送了星星灯")
        finally:
            ball.close()

    def test_fusion_uses_the_same_keep_action_to_clear_current_heart(self):
        menu = fusion_ball.FusionFenglingMenu.__new__(fusion_ball.FusionFenglingMenu)
        menu.ball = type("Ball", (), {"current_heart": {"id": "heart-1"}})()
        menu._heart_card_dismissed = False
        menu._update_heart_card = MagicMock()
        menu.keep_current_position = MagicMock()

        fusion_ball.FusionFenglingMenu._hide_current_heart(menu)

        self.assertIsNone(menu.ball.current_heart)
        self.assertTrue(menu._heart_card_dismissed)
        menu._update_heart_card.assert_called_once_with()
        menu.keep_current_position.assert_called_once_with(full_height=True)

    def test_fusion_read_panel_uses_the_refreshed_reply_selector(self):
        ball = fusion_ball.FusionBall()
        try:
            ball.menu = fusion_ball.FusionMenu(ball)
            with patch.object(ball.menu, "open_read_panel") as delegated:
                ball.menu.jiegehua_page._open_read_panel()
            delegated.assert_called_once_with()
            with patch.object(fusion_ball.FusionReadPanel, "open_for") as open_for:
                ball.menu.open_read_panel()
            self.assertIsInstance(ball.read_panel, fusion_ball.FusionReadPanel)
            self.assertEqual(ball.read_panel.btn_refresh_replies.text(), "↻ 刷新")
            self.assertFalse(hasattr(ball.read_panel, "btn_sub_new"))
            open_for.assert_called_once_with(ball.target_name, start=False)
        finally:
            ball.close()

    def test_fusion_ball_drag_keeps_read_panel_with_current_offset(self):
        ball = fusion_ball.FusionBall()
        ball.move(300, 300)
        ball.show()
        self.app.processEvents()
        panel = fusion_ball.FusionReadPanel(ball)
        ball.read_panel = panel
        panel.show()
        panel.move(ball.x() - panel.width() - 8, ball.y() + 28)
        panel._user_dragged = True
        self.app.processEvents()
        before_ball = ball.pos()
        before_panel = panel.pos()
        center_x = ball.width() / 2
        center_y = ball.height() / 2
        press = QMouseEvent(
            QEvent.Type.MouseButtonPress,
            QPointF(center_x, center_y),
            QPointF(before_ball.x() + center_x, before_ball.y() + center_y),
            Qt.MouseButton.LeftButton,
            Qt.MouseButton.LeftButton,
            Qt.KeyboardModifier.NoModifier,
        )
        ball.mousePressEvent(press)
        move = QMouseEvent(
            QEvent.Type.MouseMove,
            QPointF(center_x, center_y),
            QPointF(before_ball.x() + center_x + 42, before_ball.y() + center_y + 27),
            Qt.MouseButton.LeftButton,
            Qt.MouseButton.LeftButton,
            Qt.KeyboardModifier.NoModifier,
        )
        ball.mouseMoveEvent(move)
        self.app.processEvents()
        self.assertTrue(ball._moved)
        self.assertEqual(panel.pos() - before_panel, ball.pos() - before_ball)
        panel.close()
        ball.close()
        self.app.processEvents()

    def test_fusion_read_panel_drag_also_feeds_both_physics_systems(self):
        ball = fusion_ball.FusionBall()
        ball.move(300, 300)
        ball.show()
        panel = fusion_ball.FusionReadPanel(ball)
        ball.read_panel = panel
        panel.move(100, 260)
        panel.show()
        self.app.processEvents()
        before_ball = ball.pos()
        before_panel = panel.pos()
        press = QMouseEvent(
            QEvent.Type.MouseButtonPress,
            QPointF(12, 12),
            QPointF(before_panel.x() + 12, before_panel.y() + 12),
            Qt.MouseButton.LeftButton,
            Qt.MouseButton.LeftButton,
            Qt.KeyboardModifier.NoModifier,
        )
        panel.mousePressEvent(press)
        move = QMouseEvent(
            QEvent.Type.MouseMove,
            QPointF(62, 42),
            QPointF(before_panel.x() + 62, before_panel.y() + 42),
            Qt.MouseButton.LeftButton,
            Qt.MouseButton.LeftButton,
            Qt.KeyboardModifier.NoModifier,
        )
        panel.mouseMoveEvent(move)
        self.app.processEvents()
        self.assertEqual(ball.pos() - before_ball, panel.pos() - before_panel)
        self.assertTrue(ball._drag_motion_active)
        self.assertNotEqual(ball.velocity_clapper_spin, 0.0)
        self.assertNotEqual(ball.drag_leaf_velocity, 0.0)
        release = QMouseEvent(
            QEvent.Type.MouseButtonRelease,
            QPointF(62, 42),
            QPointF(before_panel.x() + 62, before_panel.y() + 42),
            Qt.MouseButton.LeftButton,
            Qt.MouseButton.NoButton,
            Qt.KeyboardModifier.NoModifier,
        )
        panel.mouseReleaseEvent(release)
        self.assertFalse(ball._drag_motion_active)
        panel.close()
        ball.close()
        self.app.processEvents()

    def test_fusion_ball_has_a_live_ask_poll_timer(self):
        ball = fusion_ball.FusionBall()
        try:
            self.assertEqual(
                ball.ask_poll_timer.interval(),
                fusion_ball._ORIGINAL_ZHUJIAN.ASK_POLL_INTERVAL_MS,
            )
            self.assertTrue(ball.ask_poll_timer.isActive())
        finally:
            ball.close()

    def test_pending_ask_switches_fusion_to_the_jiegehua_page(self):
        ball = fusion_ball.FusionBall()
        try:
            fusion_ball.FusionBall._apply_ask_payload(ball, {
                "ok": True,
                "pending": [{
                    "askId": "ask-fusion-1",
                    "question": "要不要切到融合版？",
                    "options": [
                        {"label": "要得"},
                        {"label": "先等等"},
                    ],
                    "ts": 1,
                }],
            })
            page = ball.menu.jiegehua_page
            self.assertEqual(ball.menu.current, fusion_ball.FusionMenu.PAGE_ZHUJIAN)
            self.assertTrue(page.isVisible())
            self.assertTrue(page.is_ask_open())
            self.assertEqual(page._ask_entry["askId"], "ask-fusion-1")
            self.assertEqual(ball.state.get("fusionPanel"), "ask")
        finally:
            ball.close()

    def test_switching_away_from_ask_marks_it_hidden_until_manual_return(self):
        ball = fusion_ball.FusionBall()
        pending = {
            "ok": True,
            "pending": [{
                "askId": "ask-fusion-hidden",
                "question": "要不要暂时收起？",
                "options": [
                    {"label": "收起"},
                    {"label": "继续"},
                ],
                "ts": 1,
            }],
        }
        try:
            fusion_ball.FusionBall._apply_ask_payload(ball, pending)
            page = ball.menu.jiegehua_page
            ball.menu.switch_page(fusion_ball.FusionMenu.PAGE_FENGLING, show=True)
            self.assertTrue(page.is_ask_open())
            self.assertTrue(page._ask_user_hidden)

            fusion_ball.FusionBall._apply_ask_payload(ball, pending)
            self.assertEqual(ball.menu.current, fusion_ball.FusionMenu.PAGE_FENGLING)
            self.assertFalse(page.isVisible())

            ball.menu.switch_page(fusion_ball.FusionMenu.PAGE_ZHUJIAN, show=True)
            self.assertTrue(page.isVisible())
            self.assertFalse(page._ask_user_hidden)
            self.assertTrue(page.is_ask_open())
        finally:
            ball.close()

    def test_closing_fusion_ball_stops_ask_poll_and_ignores_late_payload(self):
        ball = fusion_ball.FusionBall()
        ball.close()
        self.assertTrue(ball._closing)
        self.assertFalse(ball.ask_poll_timer.isActive())
        fusion_ball.FusionBall._apply_ask_payload(ball, {
            "ok": True,
            "pending": [{
                "askId": "ask-after-close",
                "question": "关掉后不该复活",
                "options": [{"label": "好"}, {"label": "不好"}],
                "ts": 1,
            }],
        })
        self.assertIsNone(ball.menu)

    def test_fusion_fengling_page_refreshes_immediately_on_open(self):
        # 原版风铃球每次打开面板都会立刻 refresh_async；融合球打开风铃页时
        # 也要立即刷新，否则首开只有融合启动时的空缓存（互动/送礼选项和
        # 当前对话要干等 10 秒的 target_timer 才有内容）。
        menu = fusion_ball.FusionFenglingMenu.__new__(fusion_ball.FusionFenglingMenu)
        menu.ball = _FakeFusionBall()
        with (
            patch.object(fusion_ball._ORIGINAL_FENGLING.FenglingMenu, "prepare_for_show") as base,
            patch.object(fusion_ball.FusionFenglingMenu, "refresh_async") as refresh,
        ):
            fusion_ball.FusionFenglingMenu.prepare_for_show(menu)
            base.assert_called_once()
            refresh.assert_called_once()


if __name__ == "__main__":
    unittest.main()
