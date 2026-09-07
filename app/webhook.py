import os

from dotenv import load_dotenv
from flask import Flask, request
from dashboard import create_dashboard

from process_message import process_message
from receive_message import save_message


load_dotenv()

app = Flask(__name__)
VERIFY_TOKEN = os.getenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN")


@app.get("/")
def health_check():
    return {
        "service": "AI Daily Standup WhatsApp Webhook",
        "status": "running",
    }, 200


@app.get("/webhook")
def verify_webhook():
    mode = request.args.get("hub.mode")
    token = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")

    if mode == "subscribe" and token == VERIFY_TOKEN and VERIFY_TOKEN:
        print("Webhook verification succeeded.")
        return challenge, 200

    print("Webhook verification failed.")
    return "Forbidden", 403


@app.post("/webhook")
def receive_webhook():
    payload = request.get_json(silent=True) or {}
    received_messages = 0

    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})

            contacts = value.get("contacts", [])
            contact_name = "WhatsApp User"

            if contacts:
                contact_name = (
                    contacts[0]
                    .get("profile", {})
                    .get("name", "WhatsApp User")
                )

            for message in value.get("messages", []):
                if message.get("type") != "text":
                    continue

                text = message.get("text", {}).get("body", "").strip()
                sender_phone = message.get("from", "")

                if not text:
                    continue

                message_id = save_message(
                    sender_name=contact_name,
                    sender_phone=sender_phone,
                    original_reply=text,
                )

                process_message(message_id)
                create_dashboard(open_browser=False)

                received_messages += 1
                print(f"WhatsApp reply received: {text}")
                print(f"Saved database message ID: {message_id}")

    print(f"Messages processed: {received_messages}")
    return "EVENT_RECEIVED", 200


if __name__ == "__main__":
    if not VERIFY_TOKEN:
        raise RuntimeError(
            "WHATSAPP_WEBHOOK_VERIFY_TOKEN is missing from .env"
        )

    app.run(
        host="127.0.0.1",
        port= 5000,
        debug=False,
    )