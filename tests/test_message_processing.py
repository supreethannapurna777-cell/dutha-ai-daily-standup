from contextlib import closing, redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
import io
import sqlite3
import unittest

import app.process_message as process_module
import app.receive_message as receive_module


class MessageProcessingTests(unittest.TestCase):

    def setUp(self):
        self.temp_directory = TemporaryDirectory()
        self.database_path = (
            Path(self.temp_directory.name) / "standup_test.db"
        )

        self.original_receive_path = receive_module.DATABASE_PATH
        self.original_process_path = process_module.DATABASE_PATH

        receive_module.DATABASE_PATH = self.database_path
        process_module.DATABASE_PATH = self.database_path

    def tearDown(self):
        receive_module.DATABASE_PATH = self.original_receive_path
        process_module.DATABASE_PATH = self.original_process_path
        self.temp_directory.cleanup()

    def test_message_is_saved_and_processed(self):
        message_id = receive_module.save_message(
            sender_name="Test User",
            sender_phone="910000000000",
            original_reply=(
                "1. Deploy the application\n"
                "2. No blockers or dependencies\n"
                "3. Kiran\n"
                "4. 9 PM"
            ),
        )

        with redirect_stdout(io.StringIO()):
            result = process_module.process_message(message_id)

        self.assertTrue(result)

        with closing(
            sqlite3.connect(self.database_path)
        ) as connection:
            incoming = connection.execute(
                """
                SELECT sender_name, processing_status
                FROM incoming_messages
                WHERE id = ?
                """,
                (message_id,),
            ).fetchone()

            processed = connection.execute(
                """
                SELECT tasks, blockers, expected_completion
                FROM processed_updates
                WHERE message_id = ?
                """,
                (message_id,),
            ).fetchone()

        self.assertIsNotNone(incoming)
        self.assertIsNotNone(processed)
        self.assertEqual(incoming[0], "Test User")
        self.assertEqual(incoming[1], "processed locally")
        self.assertEqual(processed[0], "Deploy the application")
        self.assertEqual(processed[1], "None mentioned")
        self.assertEqual(processed[2], "9 PM")

    def test_message_is_not_processed_twice(self):
        message_id = receive_module.save_message(
            sender_name="Test User",
            sender_phone="910000000000",
            original_reply=(
                "1. Test duplicate protection\n"
                "2. No blockers\n"
                "3. Kiran\n"
                "4. Today"
            ),
        )

        with redirect_stdout(io.StringIO()):
            first_result = process_module.process_message(message_id)
            second_result = process_module.process_message(message_id)

        self.assertTrue(first_result)
        self.assertFalse(second_result)

        with closing(
            sqlite3.connect(self.database_path)
        ) as connection:
            count = connection.execute(
                """
                SELECT COUNT(*)
                FROM processed_updates
                WHERE message_id = ?
                """,
                (message_id,),
            ).fetchone()[0]

        self.assertEqual(count, 1)


if __name__ == "__main__":
    unittest.main()