# Dutha AI Daily Stand-Up

A Python-based asynchronous daily stand-up assistant that collects team updates through WhatsApp, preserves the original replies, extracts structured information, stores results in SQLite, and generates an HTML dashboard.

## Problem

Daily stand-up meetings can consume significant team time. This project allows team members to submit updates asynchronously through four simple questions:

1. What will you work on today?
2. Any blockers or dependencies?
3. Who do you need to coordinate with?
4. Expected completion time?

## Current Features

- Sends stand-up requests through WhatsApp Cloud API
- Receives WhatsApp webhook events
- Preserves original replies in SQLite
- Extracts tasks, blockers, dependencies, coordination and completion time
- Prevents duplicate processing of database messages
- Generates a local HTML dashboard
- Supports CSV and Excel exports
- Calculates reminder status
- Includes scheduled request and reminder modules
- Keeps credentials and private team data outside Git

## Project Flow

WhatsApp reply → Meta webhook → Cloudflare tunnel → Flask application → SQLite database → Local extraction → HTML dashboard

## Project Structure

- `app/whatsapp_api.py` — sends WhatsApp messages
- `app/webhook.py` — receives Meta webhook events
- `app/receive_message.py` — preserves original messages
- `app/process_message.py` — processes database messages
- `app/extract_update.py` — extracts structured stand-up fields
- `app/dashboard.py` — generates the HTML dashboard
- `app/export_updates.py` — exports processed updates
- `app/scheduler.py` — schedules requests and reminders
- `tests/` — automated tests
- `data/` — private local data excluded from Git

## Local Setup

### 1. Create and activate a virtual environment

```powershell
python -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\.venv\Scripts\Activate.ps1