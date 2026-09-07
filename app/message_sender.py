from message_templates import initial_request_message, reminder_message


def simulate_initial_request(name, phone):
    """Preview an initial request without sending it."""

    print("\n--- SIMULATED INITIAL REQUEST ---")
    print(f"To: {name}")
    print(f"Phone: {phone or 'Not provided'}")
    print(initial_request_message(name))


def simulate_reminder(name, phone, reminder_number):
    """Preview a reminder without sending it."""

    print("\n--- SIMULATED REMINDER ---")
    print(f"To: {name}")
    print(f"Phone: {phone or 'Not provided'}")
    print(reminder_message(name, reminder_number))


if __name__ == "__main__":
    simulate_initial_request("Kiran", "")
    simulate_reminder("Kiran", "", 1)
    simulate_reminder("Kiran", "", 2)

    print("\nNo real message was sent.")