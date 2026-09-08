import unittest

from app.extract_update import extract_update


class ExtractUpdateTests(unittest.TestCase):

    def test_numbered_four_answer_reply(self):
        reply = (
            "1. Configure the WhatsApp webhook\n"
            "2. No blockers or dependencies\n"
            "3. Kiran\n"
            "4. 9 PM"
        )

        result = extract_update(reply)

        self.assertEqual(
            result["tasks"],
            "Configure the WhatsApp webhook",
        )
        self.assertEqual(result["people_to_connect"], "Kiran")
        self.assertEqual(result["blockers"], "None mentioned")
        self.assertEqual(result["dependencies"], "None mentioned")
        self.assertEqual(result["expected_completion"], "9 PM")
        self.assertEqual(result["original_reply"], reply)

    def test_numbered_reply_with_blocker(self):
        reply = (
            "1. Deploy the application\n"
            "2. Waiting for database access\n"
            "3. Bhavani\n"
            "4. Tomorrow morning"
        )

        result = extract_update(reply)

        self.assertEqual(result["tasks"], "Deploy the application")
        self.assertEqual(result["people_to_connect"], "Bhavani")
        self.assertEqual(
            result["blockers"],
            "Waiting for database access",
        )
        self.assertEqual(
            result["dependencies"],
            "Waiting for database access",
        )
        self.assertEqual(
            result["expected_completion"],
            "Tomorrow morning",
        )

    def test_unstructured_reply_preserves_original_text(self):
        reply = "Working on documentation."

        result = extract_update(reply)

        self.assertEqual(result["original_reply"], reply)
        self.assertEqual(result["tasks"], "Not specified")


if __name__ == "__main__":
    unittest.main()