import os
import sys

import requests
from dotenv import load_dotenv

from message_templates import initial_request_message


load_dotenv()

ACCESS_TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN")
PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID")
RECIPIENT = os.getenv("WHATSAPP_RECIPIENT")
API_VERSION = os.getenv("WHATSAPP_API_VERSION", "v23.0")


def validate_configuration():
    required_values = {
        "WHATSAPP_ACCESS_TOKEN": ACCESS_TOKEN,
        "WHATSAPP_PHONE_NUMBER_ID": PHONE_NUMBER_ID,
        "WHATSAPP_RECIPIENT": RECIPIENT,
    }

    missing = [
        name
        for name, value in required_values.items()
        if not value
    ]

    if missing:
        raise RuntimeError(
            "Missing environment variables: " + ", ".join(missing)
        )


def send_request(payload):
    """Send a request to the WhatsApp Cloud API."""

    validate_configuration()

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
        message_id = result["messages"][0]["id"]

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


def send_test_template():
    """Send Meta's approved hello_world test template."""

    payload = {
        "messaging_product": "whatsapp",
        "to": RECIPIENT,
        "type": "template",
        "template": {
            "name": "hello_world",
            "language": {
                "code": "en_US",
            },
        },
    }

    return send_request(payload)


def send_standup_request(name):
    """Send the custom stand-up request during an open conversation."""

    message = initial_request_message(name)

    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": RECIPIENT,
        "type": "text",
        "text": {
            "preview_url": False,
            "body": message,
        },
    }

    return send_request(payload)


if __name__ == "__main__":
    if "--standup" in sys.argv:
        send_standup_request("Supreeth")
    else:
        send_test_template()