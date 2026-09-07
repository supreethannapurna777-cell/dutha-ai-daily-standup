def initial_request_message(name):
    return (
        f"Hello {name},\n\n"
        "Please share your daily stand-up update:\n"
        "1. What will you work on today?\n"
        "2. Any blockers or dependencies?\n"
        "3. Who do you need to coordinate with?\n"
        "4. Expected completion time?"
    )


def reminder_message(name, reminder_number):
    if reminder_number == 1:
        timing = "This is your 3 PM reminder."
    else:
        timing = "This is your final 6 PM reminder."

    return (
        f"Hello {name},\n\n"
        f"{timing} Please send your daily stand-up update "
        "as soon as possible."
    )


if __name__ == "__main__":
    print("--- MESSAGE PREVIEW ---\n")

    print(initial_request_message("Kiran"))
    print("\n" + "-" * 40 + "\n")
    print(reminder_message("Kiran", 1))
    print("\n" + "-" * 40 + "\n")
    print(reminder_message("Kiran", 2))