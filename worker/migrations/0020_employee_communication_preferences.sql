PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employee_communication_preferences (
        team_member_id INTEGER PRIMARY KEY,
        language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi', 'te', 'ta')),
        content_mode TEXT NOT NULL DEFAULT 'either' CHECK (content_mode IN ('text', 'voice', 'either')),
        timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
        quiet_hours_start TEXT,
        quiet_hours_end TEXT,
        standup_enabled INTEGER NOT NULL DEFAULT 1 CHECK (standup_enabled IN (0, 1)),
        reminder_enabled INTEGER NOT NULL DEFAULT 1 CHECK (reminder_enabled IN (0, 1)),
        blocker_enabled INTEGER NOT NULL DEFAULT 1 CHECK (blocker_enabled IN (0, 1)),
        meeting_enabled INTEGER NOT NULL DEFAULT 1 CHECK (meeting_enabled IN (0, 1)),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        team_member_id INTEGER NOT NULL,
        notification_type TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email', 'teams', 'slack')),
        attempt_order INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'skipped')),
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notification_attempt_member
ON notification_delivery_attempts (team_member_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_attempt_status
ON notification_delivery_attempts (status, created_at);
