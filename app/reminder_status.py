from contextlib import closing
from datetime import datetime
import json
from pathlib import Path
import sqlite3


DATABASE_PATH = Path("data/standup.db")
TEAM_MEMBERS_PATH = Path("data/team_members.json")

THREE_PM = "15:00:00"
SIX_PM = "18:00:00"


def normalise_phone(phone):
    """Return a phone number containing digits only."""

    return "".join(character for character in str(phone) if character.isdigit())


def load_team_members():
    """Load team members from the JSON roster."""

    with TEAM_MEMBERS_PATH.open("r", encoding="utf-8") as file:
        return json.load(file)


def get_response_times():
    """Return today's earliest reply time for each sender phone."""

    today = datetime.now().strftime("%Y-%m-%d")

    if not DATABASE_PATH.exists():
        return {}

    try:
        with closing(sqlite3.connect(DATABASE_PATH)) as connection:
            rows = connection.execute(
                """
                SELECT sender_phone, MIN(received_at)
                FROM incoming_messages
                WHERE substr(received_at, 1, 10) = ?
                GROUP BY sender_phone
                """,
                (today,),
            ).fetchall()
    except sqlite3.OperationalError:
        return {}

    response_times = {}

    for sender_phone, received_at in rows:
        if not sender_phone or not received_at:
            continue

        phone = normalise_phone(sender_phone)
        response_time = received_at.split("T", maxsplit=1)[-1]
        response_times[phone] = response_time

    return response_times


def calculate_reminder_status(response_time):
    """Describe which scheduled messages were required."""

    if response_time is None:
        return {
            "12 PM request": "YES",
            "3 PM reminder": "YES",
            "6 PM reminder": "YES",
        }

    if response_time <= THREE_PM:
        return {
            "12 PM request": "YES",
            "3 PM reminder": "NO",
            "6 PM reminder": "NO",
        }

    if response_time <= SIX_PM:
        return {
            "12 PM request": "YES",
            "3 PM reminder": "YES",
            "6 PM reminder": "NO",
        }

    return {
        "12 PM request": "YES",
        "3 PM reminder": "YES",
        "6 PM reminder": "YES",
    }


def needs_reminder(response_time, reminder_number):
    """Return whether a member needs the selected reminder."""

    if response_time is None:
        return True

    if reminder_number == 1:
        return response_time > THREE_PM

    if reminder_number == 2:
        return response_time > SIX_PM

    raise ValueError("reminder_number must be 1 or 2")


def get_pending_members(reminder_number):
    """Return roster members requiring the selected reminder."""

    team_members = load_team_members()
    response_times = get_response_times()
    pending_members = []

    for member in team_members:
        phone = normalise_phone(member.get("phone", ""))
        response_time = response_times.get(phone)

        if needs_reminder(response_time, reminder_number):
            pending_members.append(member)

    return pending_members


def display_status():
    """Display today's reminder decisions for every roster member."""

    team_members = load_team_members()
    response_times = get_response_times()

    print("\n--- REMINDER STATUS ---\n")

    for member in team_members:
        name = member["name"]
        department = member.get("department", "Not specified")
        phone = normalise_phone(member.get("phone", ""))
        response_time = response_times.get(phone)
        status = calculate_reminder_status(response_time)

        print(f"Team member: {name}")
        print(f"Department: {department}")
        print(f"Response time: {response_time or 'No response'}")

        for action, decision in status.items():
            print(f"{action}: {decision}")

        print("-" * 35)


if __name__ == "__main__":
    display_status()