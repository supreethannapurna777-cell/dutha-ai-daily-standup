from datetime import datetime
from pathlib import Path
import sqlite3


DATABASE_PATH = Path("data/standup.db")


def initialise_message_table():
    """Create a table for original incoming messages."""

    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)

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


def save_message(sender_name, sender_phone, original_reply):
    """Preserve an incoming message and return its database ID."""

    initialise_message_table()
    received_at = datetime.now().isoformat(timespec="seconds")

    with sqlite3.connect(DATABASE_PATH) as connection:
        cursor = connection.execute(
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
        message_id = cursor.lastrowid

    return message_id


def receive_message():
    """Simulate receiving one WhatsApp-style message manually."""

    print("\nINCOMING MESSAGE SIMULATOR\n")

    sender_name = input("Sender name: ")
    sender_phone = input("Sender phone number: ")
    original_reply = input("Paste the complete message: ")

    message_id = save_message(
        sender_name,
        sender_phone,
        original_reply,
    )

    print("\nMessage received and preserved.")
    print(f"Message ID: {message_id}")
    print("Status: received - not processed")


if __name__ == "__main__":
    receive_message()