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


def extract_numbered_answers(text):
    """Extract answers written as 1, 2, 3 and 4."""

    pattern = re.compile(
        r"(?ms)^\s*([1-4])[\.\)\-:]\s*(.+?)"
        r"(?=^\s*[1-4][\.\)\-:]|\Z)"
    )

    return {
        number: answer.strip()
        for number, answer in pattern.findall(text)
    }


def extract_update(original_reply):
    """Extract stand-up fields using free local text rules."""

    text = original_reply.strip()
    lower_text = text.lower()
    answers = extract_numbered_answers(text)

    task = "Not specified"
    people = "Not specified"
    blockers = "Not specified"
    dependencies = "Not specified"
    expected_completion = "Not specified"

    if answers:
        task = answers.get("1", task)
        blocker_answer = answers.get("2", "")
        people = answers.get("3", people)
        expected_completion = answers.get("4", expected_completion)

        if blocker_answer:
            blocker_lower = blocker_answer.lower()

            if (
                "no blocker" in blocker_lower
                or "no dependency" in blocker_lower
                or blocker_lower in {"none", "no", "nil"}
            ):
                blockers = "None mentioned"
                dependencies = "None mentioned"
            else:
                blockers = blocker_answer
                dependencies = blocker_answer

    else:
        task_match = re.search(
            r"(?:today\s+i\s+will|i\s+will\s+work\s+on)\s+"
            r"(.+?)(?:\.|\n|$)",
            text,
            re.IGNORECASE,
        )

        if task_match:
            task = task_match.group(1).strip()

        people_match = re.search(
            r"(?:coordinate\s+with|connect\s+with|with)\s+"
            r"([a-zA-Z][a-zA-Z ]+?)(?:\.|\n|$)",
            text,
            re.IGNORECASE,
        )

        if people_match:
            people = people_match.group(1).strip()

        if (
            "no blocker" in lower_text
            or "no dependency" in lower_text
        ):
            blockers = "None mentioned"
            dependencies = "None mentioned"

        completion_match = re.search(
            r"(?:expected\s+completion(?:\s+time)?|complete)"
            r"\s*(?:is|by|:)?\s*(.+?)(?:\.|\n|$)",
            text,
            re.IGNORECASE,
        )

        if completion_match:
            expected_completion = completion_match.group(1).strip()

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