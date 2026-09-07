from pathlib import Path
import sqlite3


DATABASE_PATH = Path("data/standup.db")


def show_messages():
    """Display all preserved incoming messages."""

    with sqlite3.connect(DATABASE_PATH) as connection:
        rows = connection.execute(
            """
            SELECT
                id,
                received_at,
                sender_name,
                sender_phone,
                original_reply,
                processing_status
            FROM incoming_messages
            ORDER BY id
            """
        ).fetchall()

    print(f"\nIncoming messages: {len(rows)}\n")

    for row in rows:
        print(f"ID: {row[0]}")
        print(f"Received at: {row[1]}")
        print(f"Sender: {row[2]}")
        print(f"Phone: {row[3]}")
        print(f"Original reply: {row[4]}")
        print(f"Status: {row[5]}")
        print("-" * 50)


if __name__ == "__main__":
    show_messages()