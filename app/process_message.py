from pathlib import Path
import sqlite3

from extract_update import extract_update


DATABASE_PATH = Path("data/standup.db")


def initialise_processed_table():
    """Create a table for structured interpretations."""

    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS processed_updates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL,
                sender_name TEXT NOT NULL,
                tasks TEXT,
                people_to_connect TEXT,
                blockers TEXT,
                dependencies TEXT,
                expected_completion TEXT,
                original_reply TEXT NOT NULL,
                processing_status TEXT NOT NULL
            )
            """
        )


def process_latest_message():
    """Extract and save the newest incoming message once."""

    with sqlite3.connect(DATABASE_PATH) as connection:
        message = connection.execute(
            """
            SELECT id, sender_name, original_reply
            FROM incoming_messages
            ORDER BY id DESC
            LIMIT 1
            """
        ).fetchone()

        if message is None:
            print("No incoming messages found.")
            return

        message_id, sender_name, original_reply = message

        already_processed = connection.execute(
            """
            SELECT id
            FROM processed_updates
            WHERE message_id = ?
            """,
            (message_id,),
        ).fetchone()

        if already_processed is not None:
            print(f"Message ID {message_id} was already processed.")
            print("No duplicate record was created.")
            return

        extracted = extract_update(original_reply)

        connection.execute(
            """
            INSERT INTO processed_updates (
                message_id,
                sender_name,
                tasks,
                people_to_connect,
                blockers,
                dependencies,
                expected_completion,
                original_reply,
                processing_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                message_id,
                sender_name,
                extracted["tasks"],
                extracted["people_to_connect"],
                extracted["blockers"],
                extracted["dependencies"],
                extracted["expected_completion"],
                extracted["original_reply"],
                "processed locally",
            ),
        )

    print("Message processed and structured result saved.")
    print(f"Message ID: {message_id}")
    print(f"Sender: {sender_name}")
    print(f"Task: {extracted['tasks']}")
    print(f"People: {extracted['people_to_connect']}")
    print(f"Blockers: {extracted['blockers']}")
    print(f"Dependencies: {extracted['dependencies']}")
    print(f"Expected completion: {extracted['expected_completion']}")
    print("Original reply preserved: Yes")


if __name__ == "__main__":
    initialise_processed_table()
    process_latest_message()