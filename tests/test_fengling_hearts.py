# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ["HANA_HOME"] = tempfile.mkdtemp(prefix="wv-fengling-hearts-")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import fengling_app


class FenglingHeartPollTests(unittest.TestCase):
    def test_first_poll_seeds_existing_hearts_without_chiming(self):
        seen, fresh, ack, seeded = fengling_app.resolve_heart_poll(
            set(), [{"id": "heart-old"}], False
        )
        self.assertEqual(seen, {"heart-old"})
        self.assertEqual(fresh, [])
        self.assertEqual(ack, [])
        self.assertTrue(seeded)

    def test_first_poll_surfaces_unread_heart_but_not_read_history(self):
        seen, fresh, ack, seeded = fengling_app.resolve_heart_poll(
            set(),
            [
                {"id": "heart-read", "status": "read"},
                {"id": "heart-unread", "status": "unread"},
            ],
            False,
        )
        self.assertEqual(seen, {"heart-read", "heart-unread"})
        self.assertEqual([item["id"] for item in fresh], ["heart-unread"])
        self.assertEqual(ack, ["heart-unread"])
        self.assertTrue(seeded)

    def test_later_poll_only_emits_unseen_hearts_once(self):
        seen, fresh, ack, seeded = fengling_app.resolve_heart_poll(
            {"heart-old"},
            [
                {"id": "heart-old", "status": "unread", "deliveredAt": "old"},
                {"id": "heart-new", "status": "unread"},
            ],
            True,
        )
        self.assertEqual([item["id"] for item in fresh], ["heart-new"])
        self.assertEqual(ack, ["heart-new"])
        self.assertEqual(seen, {"heart-old", "heart-new"})
        self.assertTrue(seeded)

        seen2, fresh2, ack2, _ = fengling_app.resolve_heart_poll(
            seen, [{"id": "heart-new"}], True
        )
        self.assertEqual(seen2, seen)
        self.assertEqual(fresh2, [])
        self.assertEqual(ack2, [])

    def test_missing_ids_are_ignored(self):
        seen, fresh, ack, _ = fengling_app.resolve_heart_poll(
            set(), [{"message": "bad"}, {"id": "heart-1", "status": "unread"}], True
        )
        self.assertEqual([item["id"] for item in fresh], ["heart-1"])
        self.assertEqual(ack, ["heart-1"])
        self.assertEqual(seen, {"heart-1"})

    def test_delivered_unread_heart_stays_pending_without_repeating_delivery(self):
        hearts = [{"id": "heart-delivered", "status": "unread", "deliveredAt": "already"}]
        seen, fresh, ack, seeded = fengling_app.resolve_heart_poll(set(), hearts, False)
        self.assertEqual(fresh, [])
        self.assertEqual(ack, [])
        self.assertTrue(seeded)
        self.assertEqual(
            [item["id"] for item in fengling_app.pending_heart_items(hearts)],
            ["heart-delivered"],
        )

    def test_bell_dismissed_heart_leaves_queue_and_does_not_trigger_delivery(self):
        heart = {
            "id": "heart-dismissed",
            "status": "unread",
            "bellDismissedAt": "already",
        }
        seen, fresh, ack, _ = fengling_app.resolve_heart_poll(set(), [heart], False)
        self.assertEqual(seen, {"heart-dismissed"})
        self.assertEqual(fresh, [])
        self.assertEqual(ack, [])
        self.assertEqual(fengling_app.pending_heart_items([heart]), [])

    def test_already_confirmed_heart_is_seen_without_triggering_delivery(self):
        seen, fresh, ack, _ = fengling_app.resolve_heart_poll(
            set(), [{"id": "heart-read", "status": "read"}], True
        )
        self.assertEqual(seen, {"heart-read"})
        self.assertEqual(fresh, [])
        self.assertEqual(ack, [])

    def test_current_heart_disappears_after_main_page_confirmation(self):
        current = {"id": "heart-1", "partnerName": "伙伴B"}
        self.assertIsNone(
            fengling_app.resolve_current_heart(
                current, [{"id": "heart-1", "status": "read"}]
            )
        )
        still_active = fengling_app.resolve_current_heart(
            current, [{"id": "heart-1", "status": "unread", "message": "还在"}]
        )
        self.assertEqual(still_active["message"], "还在")
        self.assertIs(
            fengling_app.resolve_current_heart(current, [], clear_if_missing=False),
            current,
        )

    def test_heart_popup_title_mentions_sender_and_event(self):
        self.assertEqual(
            fengling_app.heart_popup_title({
                "partnerName": "伙伴B",
                "gift": {"name": "星星灯"},
            }),
            "伙伴B给你送了星星灯",
        )
        self.assertEqual(
            fengling_app.heart_popup_title({
                "partnerName": "伙伴B",
                "eventType": "scene",
                "gift": {"name": "一张便签"},
            }),
            "伙伴B给你留了一张便签",
        )


if __name__ == "__main__":
    unittest.main()
