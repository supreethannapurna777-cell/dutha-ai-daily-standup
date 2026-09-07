from html import escape
from pathlib import Path
import sqlite3
import webbrowser


DATABASE_PATH = Path("data/standup.db")
DASHBOARD_PATH = Path("data/dashboard.html")


def get_updates():
    """Read all processed updates from SQLite."""

    with sqlite3.connect(DATABASE_PATH) as connection:
        return connection.execute(
            """
            SELECT
                incoming_messages.received_at,
                processed_updates.sender_name,
                processed_updates.tasks,
                processed_updates.people_to_connect,
                processed_updates.blockers,
                processed_updates.dependencies,
                processed_updates.expected_completion,
                processed_updates.original_reply
            FROM processed_updates
            JOIN incoming_messages
                ON processed_updates.message_id = incoming_messages.id
            ORDER BY incoming_messages.received_at DESC
            """
        ).fetchall()


def create_dashboard(open_browser=True):
    """Generate a simple local HTML dashboard."""

    updates = get_updates()

    table_rows = ""

    for update in updates:
        table_rows += f"""
        <tr>
            <td>{escape(update[0])}</td>
            <td>{escape(update[1])}</td>
            <td>{escape(update[2])}</td>
            <td>{escape(update[3])}</td>
            <td>{escape(update[4])}</td>
            <td>{escape(update[5])}</td>
            <td>{escape(update[6])}</td>
            <td>{escape(update[7])}</td>
        </tr>
        """

    if not table_rows:
        table_rows = """
        <tr>
            <td colspan="8">No updates received yet.</td>
        </tr>
        """

    html = f"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>AI Daily Stand-Up Dashboard</title>
    <style>
        body {{
            font-family: Arial, sans-serif;
            margin: 32px;
            background: #f4f7fb;
            color: #1f2937;
        }}

        h1 {{
            color: #1f4e78;
        }}

        .summary {{
            background: white;
            padding: 18px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 8px #00000015;
        }}

        table {{
            width: 100%;
            border-collapse: collapse;
            background: white;
            box-shadow: 0 2px 8px #00000015;
        }}

        th {{
            background: #1f4e78;
            color: white;
            padding: 12px;
            text-align: left;
        }}

        td {{
            padding: 10px;
            border-bottom: 1px solid #d9e2ec;
            vertical-align: top;
            white-space: pre-wrap;
        }}

        tr:hover {{
            background: #eef5fb;
        }}
    </style>
</head>
<body>
    <h1>AI Daily Stand-Up Dashboard</h1>

    <div class="summary">
        <strong>Total processed updates:</strong> {len(updates)}
    </div>

    <table>
        <thead>
            <tr>
                <th>Received At</th>
                <th>Team Member</th>
                <th>Tasks</th>
                <th>People to Connect With</th>
                <th>Blockers</th>
                <th>Dependencies</th>
                <th>Expected Completion</th>
                <th>Original Reply</th>
            </tr>
        </thead>
        <tbody>
            {table_rows}
        </tbody>
    </table>
</body>
</html>
"""

    DASHBOARD_PATH.write_text(html, encoding="utf-8")
    print(f"Dashboard created: {DASHBOARD_PATH}")

    if open_browser:
        webbrowser.open(DASHBOARD_PATH.resolve().as_uri())


if __name__ == "__main__":
    create_dashboard()