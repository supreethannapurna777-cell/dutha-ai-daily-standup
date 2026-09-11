import sys

from apscheduler.schedulers.blocking import BlockingScheduler

try:
    from .reminder_status import (
        display_status,
        get_pending_members,
        load_team_members,
    )
    from .whatsapp_api import send_reminder, send_standup_request
except ImportError:
    from reminder_status import (
        display_status,
        get_pending_members,
        load_team_members,
    )
    from whatsapp_api import send_reminder, send_standup_request


TIMEZONE = "Asia/Kolkata"


def valid_recipient(member):
    """Return whether a roster member has a phone number."""

    return bool(str(member.get("phone", "")).strip())


def send_initial_request():
    """Send the daily stand-up request to every roster member."""

    team_members = load_team_members()
    sent = 0
    failed = 0
    skipped = 0

    print("\n[12 PM] Sending initial daily stand-up requests.")

    for member in team_members:
        name = member["name"]
        phone = member.get("phone", "")

        if not valid_recipient(member):
            print(f"Skipped {name}: phone number is missing.")
            skipped += 1
            continue

        try:
            if send_standup_request(name, phone):
                sent += 1
            else:
                failed += 1
        except Exception as error:
            failed += 1
            print(f"Failed to send to {name}: {error}")

    print(
        f"Initial requests complete: "
        f"{sent} sent, {failed} failed, {skipped} skipped."
    )

    return {
        "sent": sent,
        "failed": failed,
        "skipped": skipped,
    }


def send_pending_reminders(reminder_number):
    """Send the selected reminder only to pending members."""

    pending_members = get_pending_members(reminder_number)
    sent = 0
    failed = 0
    skipped = 0

    timing = "3 PM" if reminder_number == 1 else "6 PM"
    print(f"\n[{timing}] Sending reminders to pending members.")

    for member in pending_members:
        name = member["name"]
        phone = member.get("phone", "")

        if not valid_recipient(member):
            print(f"Skipped {name}: phone number is missing.")
            skipped += 1
            continue

        try:
            if send_reminder(name, phone, reminder_number):
                sent += 1
            else:
                failed += 1
        except Exception as error:
            failed += 1
            print(f"Failed to send reminder to {name}: {error}")

    print(
        f"{timing} reminders complete: "
        f"{sent} sent, {failed} failed, {skipped} skipped."
    )

    return {
        "sent": sent,
        "failed": failed,
        "skipped": skipped,
    }


def send_three_pm_reminder():
    """Send the first reminder to members still pending."""

    return send_pending_reminders(1)


def send_six_pm_reminder():
    """Send the final reminder to members still pending."""

    return send_pending_reminders(2)


def run_demo():
    """Preview reminder status without sending any messages."""

    print("--- SAFE SCHEDULER DEMO ---")
    print("No WhatsApp messages will be sent.\n")
    display_status()
    print("\nScheduler demo completed.")


def run_scheduler():
    """Run the weekday schedule in Indian Standard Time."""

    scheduler = BlockingScheduler(timezone=TIMEZONE)

    scheduler.add_job(
        send_initial_request,
        "cron",
        day_of_week="mon-fri",
        hour=12,
        minute=0,
        id="initial_request",
        max_instances=1,
        coalesce=True,
    )

    scheduler.add_job(
        send_three_pm_reminder,
        "cron",
        day_of_week="mon-fri",
        hour=15,
        minute=0,
        id="three_pm_reminder",
        max_instances=1,
        coalesce=True,
    )

    scheduler.add_job(
        send_six_pm_reminder,
        "cron",
        day_of_week="mon-fri",
        hour=18,
        minute=0,
        id="six_pm_reminder",
        max_instances=1,
        coalesce=True,
    )

    print("Daily scheduler is running in Asia/Kolkata timezone.")
    print("Monday-Friday:")
    print("12:00 - Initial request")
    print("15:00 - First reminder")
    print("18:00 - Final reminder")
    print("Press Ctrl+C to stop.")

    try:
        scheduler.start()
    except KeyboardInterrupt:
        print("\nScheduler stopped.")


if __name__ == "__main__":
    if "--demo" in sys.argv:
        run_demo()
    else:
        run_scheduler()