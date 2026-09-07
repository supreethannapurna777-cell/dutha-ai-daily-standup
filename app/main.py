from datetime import datetime
from pathlib import Path
import sqlite3


DATABASE_PATH = Path("data/standup.db")


def initialise_database():
    """Create the database table if it does not already exist."""

    DATABASE_PATH.parent.mkdir(exist_ok=True)

    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS daily_updates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                team_member TEXT NOT NULL,
                team TEXT,
                tasks TEXT,
                people_to_connect TEXT,
                blockers TEXT,
                dependencies TEXT,
                expected_completion TEXT,
                response_time TEXT NOT NULL,
                original_reply TEXT
            )
            """
        )


def collect_update():
    """Collect one employee's daily update."""

    print("\nAI DAILY STAND-UP")
    print("Please enter today's work information.\n")

    response_time = datetime.now().isoformat(timespec="seconds")

    return {
        "date": response_time[:10],
        "team_member": input("Team member name: "),
        "team": input("Team or department: "),
        "tasks": input("What will you work on today? "),
        "people_to_connect": input("Who will you connect with? "),
        "blockers": input("What blockers do you have? "),
        "dependencies": input("What dependencies do you have? "),
        "expected_completion": input("Expected completion: "),
        "response_time": response_time,
        "original_reply": input("Paste the complete original reply: "),
    }


def save_update(update):
    """Save one update into SQLite."""

    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            INSERT INTO daily_updates (
                date,
                team_member,
                team,
                tasks,
                people_to_connect,
                blockers,
                dependencies,
                expected_completion,
                response_time,
                original_reply
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                update["date"],
                update["team_member"],
                update["team"],
                update["tasks"],
                update["people_to_connect"],
                update["blockers"],
                update["dependencies"],
                update["expected_completion"],
                update["response_time"],
                update["original_reply"],
            ),
        )


def display_update(update):
    """Display the saved update clearly."""

    print("\n--- UPDATE SAVED ---")

    for field, value in update.items():
        readable_field = field.replace("_", " ").title()
        print(f"{readable_field}: {value or 'Not specified'}")


if __name__ == "__main__":
    initialise_database()
    daily_update = collect_update()
    save_update(daily_update)
    display_update(daily_update)