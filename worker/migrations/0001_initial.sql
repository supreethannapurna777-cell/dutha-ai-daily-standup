PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_members (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	phone TEXT NOT NULL UNIQUE,
	department TEXT NOT NULL DEFAULT 'Not specified',
	active INTEGER NOT NULL DEFAULT 1
		CHECK (active IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS incoming_messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	whatsapp_message_id TEXT NOT NULL UNIQUE,
	received_at TEXT NOT NULL,
	sender_name TEXT NOT NULL,
	sender_phone TEXT NOT NULL,
	original_reply TEXT NOT NULL,
	processing_status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incoming_received_at
	ON incoming_messages(received_at);

CREATE INDEX IF NOT EXISTS idx_incoming_sender_phone
	ON incoming_messages(sender_phone);

CREATE TABLE IF NOT EXISTS processed_updates (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	message_id INTEGER NOT NULL UNIQUE,
	sender_name TEXT NOT NULL,
	tasks TEXT,
	people_to_connect TEXT,
	blockers TEXT,
	dependencies TEXT,
	expected_completion TEXT,
	original_reply TEXT NOT NULL,
	processing_status TEXT NOT NULL,
	FOREIGN KEY (message_id)
		REFERENCES incoming_messages(id)
		ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sent_messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	team_member_id INTEGER,
	whatsapp_message_id TEXT,
	message_type TEXT NOT NULL,
	scheduled_for TEXT,
	sent_at TEXT NOT NULL,
	status TEXT NOT NULL,
	error_message TEXT,
	FOREIGN KEY (team_member_id)
		REFERENCES team_members(id)
		ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sent_messages_sent_at
	ON sent_messages(sent_at);
