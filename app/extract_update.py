from pathlib import Path
import re
import sqlite3


DATABASE_PATH = Path("data/standup.db")


def get_latest_message():
    """Read the newest preserved incoming message."""

    with sqlite3.connect(DATABASE_PATH) as connection:
        row = connection.execute(
            """
            SELECT sender_name, original_reply
            FROM incoming_messages
            ORDER BY id DESC
            LIMIT 1
            """
        ).fetchone()

    return row


def extract_update(original_reply):
    """Extract basic fields using free local text rules."""

    text = original_reply.strip()
    lower_text = text.lower()

    task = "Not specified"
    people = "Not specified"
    blockers = "Not specified"
    dependencies = "Not specified"
    expected_completion = "Not specified"

    task_match = re.search(
        r"today\s+i\s+will\s+(.+?)(?:,\s*needs|\.\s*needs|$)",
        lower_text,
    )

    if task_match:
        task = task_match.group(1).strip()

    people_match = re.search(
        r"(?:with|coordinate with)\s+([a-zA-Z]+)",
        lower_text,
    )

    if people_match:
        people = people_match.group(1).strip()

    dependency_match = re.search(
        r"to get\s+(.+?)(?:\.|$)",
        lower_text,
    )

    if dependency_match:
        dependencies = dependency_match.group(1).strip()

    if "no blocker" in lower_text or "no blockers" in lower_text:
        blockers = "None mentioned"

    if "today" in lower_text:
        expected_completion = "Work mentioned for today"

    return {
        "tasks": task,
        "people_to_connect": people,
        "blockers": blockers,
        "dependencies": dependencies,
        "expected_completion": expected_completion,
        "original_reply": text,
    }


def display_extraction(sender_name, update):
    """Display the extracted information."""

    print("\n--- FREE LOCAL EXTRACTION ---")
    print(f"Sender: {sender_name}")
    print(f"Tasks: {update['tasks']}")
    print(f"People to connect with: {update['people_to_connect']}")
    print(f"Blockers: {update['blockers']}")
    print(f"Dependencies: {update['dependencies']}")
    print(f"Expected completion: {update['expected_completion']}")
    print(f"Original reply: {update['original_reply']}")


if __name__ == "__main__":
    latest_message = get_latest_message()

    if latest_message is None:
        print("No incoming messages found.")
    else:
        sender_name, original_reply = latest_message
        extracted_update = extract_update(original_reply)
        display_extraction(sender_name, extracted_update)