import json
from pathlib import Path

from message_templates import initial_request_message, reminder_message


ROSTER_PATH = Path("data/team_members.json")


def load_team_members():
    with ROSTER_PATH.open("r", encoding="utf-8") as file:
        return json.load(file)


def preview_roster_messages():
    team_members = load_team_members()

    print("--- ROSTER MESSAGE PREVIEW ---")

    for member in team_members:
        name = member["name"]
        phone = member["phone"]

        print("\n" + "=" * 50)
        print(f"Recipient: {name}")
        print(f"Phone: {phone or 'Not provided'}")
        print("\nInitial request:")
        print(initial_request_message(name))

        print("\n3 PM reminder:")
        print(reminder_message(name, 1))

        print("\n6 PM reminder:")
        print(reminder_message(name, 2))

    print("\n" + "=" * 50)
    print("Preview completed. No real messages were sent.")


if __name__ == "__main__":
    preview_roster_messages()