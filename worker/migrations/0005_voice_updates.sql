PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS voice_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        whatsapp_message_id TEXT NOT NULL UNIQUE,
        sender_name TEXT NOT NULL,
        sender_phone TEXT NOT NULL,
        received_at TEXT NOT NULL,
        media_id TEXT NOT NULL,
        mime_type TEXT,
        status TEXT NOT NULL
                CHECK (
                        status IN (
                                'received',
                                'processing',
                                'awaiting_confirmation',
                                'confirmed',
                                'failed'
                        )
                ),
        detected_language TEXT,
        original_transcript TEXT,
        reporting_transcript TEXT,
        tasks TEXT,
        people_to_connect TEXT,
        blockers TEXT,
        dependencies TEXT,
        expected_completion TEXT,
        confirmation_sent_at TEXT,
        confirmed_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_updates_sender_status
ON voice_updates (
        sender_phone,
        status,
        received_at
);

CREATE TABLE IF NOT EXISTS voice_update_events (
        whatsapp_message_id TEXT PRIMARY KEY,
        voice_update_id INTEGER NOT NULL,
        event_type TEXT NOT NULL
                CHECK (
                        event_type IN (
                                'audio_received',
                                'correction_received',
                                'confirmation_received'
                        )
                ),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (voice_update_id)
                REFERENCES voice_updates(id)
                ON DELETE CASCADE
);
