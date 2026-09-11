import os
import sys

import requests
from dotenv import load_dotenv

try:
    from .message_templates import initial_request_message, reminder_message
except ImportError:
    from message_templates import initial_request_message, reminder_message


load_dotenv()

ACCESS_TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN")
PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID")
DEFAULT_RECIPIENT = os.getenv("WHATSAPP_RECIPIENT")
API_VERSION = os.getenv("WHATSAPP_API_VERSION", "v23.0")


def normalise_phone(phone):
    """Return a phone number containing digits only."""

    return "".join(character for character in str(phone) if character.isdigit())


def validate_configuration(recipient):
    """Validate credentials and the selected recipient."""

    required_values = {
        "WHATSAPP_ACCESS_TOKEN": ACCESS_TOKEN,
        "WHATSAPP_PHONE_NUMBER_ID": PHONE_NUMBER_ID,
        "recipient phone number": recipient,
    }

    missing = [
        name
        for name, value in required_values.items()
        if not value
    ]

    if missing:
        raise RuntimeError(
            "Missing configuration: " + ", ".join(missing)
        )


def send_request(payload):
    """Send one request through the WhatsApp Cloud API."""

    recipient = payload.get("to")
    validate_configuration(recipient)

    url = (
        f"https://graph.facebook.com/"
        f"{API_VERSION}/{PHONE_NUMBER_ID}/messages"
    )

    headers = {
        "Authorization": f"Bearer {ACCESS_TOKEN}",
        "Content-Type": "application/json",
    }

    response = requests.post(
        url,
        headers=headers,
        json=payload,
        timeout=30,
    )

    if response.ok:
        result = response.json()
        messages = result.get("messages", [])
        message_id = (
            messages[0].get("id", "Not returned")
            if messages
            else "Not returned"
        )

        print("WhatsApp message sent successfully.")
        print(f"Message ID: {message_id}")
        return True

    print(f"WhatsApp API request failed: HTTP {response.status_code}")

    try:
        error = response.json().get("error", {})
        print(f"Error type: {error.get('type', 'Unknown')}")
        print(f"Error code: {error.get('code', 'Unknown')}")
        print(f"Message: {error.get('message', 'Unknown error')}")
    except ValueError:
        print("Meta returned a non-JSON error response.")

    return False


def send_text_message(recipient, message):
    """Send a free-text message during an open conversation window."""

    recipient = normalise_phone(recipient)

    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": recipient,
        "type": "text",
        "text": {
            "preview_url": False,
            "body": message,
        },
    }

    return send_request(payload)


def send_test_template(recipient=None):
    """Send Meta's approved hello_world test template."""

    recipient = normalise_phone(recipient or DEFAULT_RECIPIENT)

    payload = {
        "messaging_product": "whatsapp",
        "to": recipient,
        "type": "template",
        "template": {
            "name": "hello_world",
            "language": {
                "code": "en_US",
            },
        },
    }

    return send_request(payload)


def send_standup_request(name, recipient=None):
    """Send a stand-up request to one selected recipient."""

    recipient = recipient or DEFAULT_RECIPIENT
    return send_text_message(
        recipient,
        initial_request_message(name),
    )


def send_reminder(name, recipient, reminder_number):
    """Send a 3 PM or 6 PM reminder to one recipient."""

    return send_text_message(
        recipient,
        reminder_message(name, reminder_number),
    )


if __name__ == "__main__":
    if "--standup" in sys.argv:
        send_standup_request("Supreeth")
    else:
        send_test_template()