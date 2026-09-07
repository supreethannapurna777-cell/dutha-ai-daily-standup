import sys
import time

from apscheduler.schedulers.blocking import BlockingScheduler

from reminder_status import display_status


def send_initial_request():
    """Placeholder for the 12 PM WhatsApp request."""

    print("\n[12 PM] Initial daily update request should be sent.")
    print("WhatsApp sending will be connected later.")


def send_three_pm_reminder():
    """Check who needs the 3 PM reminder."""

    print("\n[3 PM] Checking reminder status.")
    display_status()


def send_six_pm_reminder():
    """Check who needs the final reminder."""

    print("\n[6 PM] Checking final reminder status.")
    display_status()


def run_demo():
    """Run every scheduled action once for testing."""

    print("--- SCHEDULER DEMO ---")
    send_initial_request()
    send_three_pm_reminder()
    send_six_pm_reminder()
    print("\nScheduler demo completed.")


def run_scheduler():
    """Run the real daily schedule."""

    scheduler = BlockingScheduler()

    scheduler.add_job(
        send_initial_request,
        "cron",
        hour=12,
        minute=0,
    )

    scheduler.add_job(
        send_three_pm_reminder,
        "cron",
        hour=15,
        minute=0,
    )

    scheduler.add_job(
        send_six_pm_reminder,
        "cron",
        hour=18,
        minute=0,
    )

    print("Daily scheduler is running.")
    print("12:00 — Initial request")
    print("15:00 — First reminder check")
    print("18:00 — Final reminder check")
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