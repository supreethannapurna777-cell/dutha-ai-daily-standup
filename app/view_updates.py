from pathlib import Path
import sqlite3


DATABASE_PATH = Path("data/standup.db")


def show_saved_updates():
    """Display all updates stored in the database."""

    if not DATABASE_PATH.exists():
        print("No database exists yet.")
        return

    with sqlite3.connect(DATABASE_PATH) as connection:
        rows = connection.execute(
            """
            SELECT
                id,
                date,
                team_member,
                team,
                tasks,
                expected_completion,
                response_time
            FROM daily_updates
            ORDER BY id
            """
        ).fetchall()

    if not rows:
        print("No updates found.")
        return

    print(f"\nSaved updates: {len(rows)}\n")

    for row in rows:
        print(f"ID: {row[0]}")
        print(f"Date: {row[1]}")
        print(f"Team member: {row[2]}")
        print(f"Team: {row[3]}")
        print(f"Tasks: {row[4]}")
        print(f"Expected completion: {row[5]}")
        print(f"Response time: {row[6]}")
        print("-" * 40)


if __name__ == "__main__":
    show_saved_updates()