import unittest

from app.reminder_status import calculate_reminder_status


class ReminderStatusTests(unittest.TestCase):

    def test_no_response_gets_all_messages(self):
        status = calculate_reminder_status(None)

        self.assertEqual(status["12 PM request"], "YES")
        self.assertEqual(status["3 PM reminder"], "YES")
        self.assertEqual(status["6 PM reminder"], "YES")

    def test_response_before_3_pm_gets_no_reminders(self):
        status = calculate_reminder_status("14:00:00")

        self.assertEqual(status["12 PM request"], "YES")
        self.assertEqual(status["3 PM reminder"], "NO")
        self.assertEqual(status["6 PM reminder"], "NO")

    def test_response_between_3_and_6_gets_final_reminder_only(self):
        status = calculate_reminder_status("16:00:00")

        self.assertEqual(status["12 PM request"], "YES")
        self.assertEqual(status["3 PM reminder"], "YES")
        self.assertEqual(status["6 PM reminder"], "NO")

    def test_response_after_6_pm_gets_both_reminders(self):
        status = calculate_reminder_status("20:00:00")

        self.assertEqual(status["12 PM request"], "YES")
        self.assertEqual(status["3 PM reminder"], "YES")
        self.assertEqual(status["6 PM reminder"], "YES")


if __name__ == "__main__":
    unittest.main()
    