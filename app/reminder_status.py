from datetime import datetime
import json
from pathlib import Path
import sqlite3


DATABASE_PATH = Path("data/standup.db")
TEAM_MEMBERS_PATH = Path("data/team_members.json")

THREE_PM = "15:00:00"
SIX_PM = "18:00:00"


def load_team_members():
    """Load team members from the JSON roster."""

    with TEAM_MEMBERS_PATH.open("r", encoding="utf-8") as file:
        return json.load(file)


def get_response_times():
    """Read today's response times."""

    today = datetime.now().strftime("%Y-%m-%d")

    with sqlite3.connect(DATABASE_PATH) as connection:
        rows = connection.execute(
            """
            SELECT team_member, response_time
            FROM daily_updates
            WHERE date = ?
            """,
            (today,),
        ).fetchall()

    response_times = {}

    for team_member, response_time in rows:
        response_times[team_member.lower()] = response_time.split(
            "T",
            maxsplit=1,
        )[1]

    return response_times


def calculate_reminder_status(response_time):
    """Decide which reminders are required."""

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


def display_status():
    """Display reminder decisions for every roster member."""

    team_members = load_team_members()
    response_times = get_response_times()

    print("\n--- REMINDER STATUS ---\n")

    for member in team_members:
        name = member["name"]
        department = member["department"]
        response_time = response_times.get(name.lower())
        status = calculate_reminder_status(response_time)

        print(f"Team member: {name}")
        print(f"Department: {department}")
        print(f"Response time: {response_time or 'No response'}")

        for action, decision in status.items():
            print(f"{action}: {decision}")

        print("-" * 35)


if __name__ == "__main__":
    display_status()