from datetime import datetime
from pathlib import Path
import sqlite3


DATABASE_PATH = Path("data/standup.db")


def initialise_message_table():
    """Create a table for original incoming messages."""

    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS incoming_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                received_at TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                sender_phone TEXT,
                original_reply TEXT NOT NULL,
                processing_status TEXT NOT NULL
            )
            """
        )


def receive_message():
    """Simulate receiving one WhatsApp-style message."""

    print("\nINCOMING MESSAGE SIMULATOR\n")

    sender_name = input("Sender name: ")
    sender_phone = input("Sender phone number: ")
    original_reply = input("Paste the complete message: ")

    received_at = datetime.now().isoformat(timespec="seconds")

    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            INSERT INTO incoming_messages (
                received_at,
                sender_name,
                sender_phone,
                original_reply,
                processing_status
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                received_at,
                sender_name,
                sender_phone,
                original_reply,
                "received - not processed",
            ),
        )

    print("\nMessage received and preserved.")
    print(f"Received at: {received_at}")
    print(f"Status: received - not processed")


if __name__ == "__main__":
    initialise_message_table()
    receive_message()