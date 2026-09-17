PRAGMA foreign_keys = ON;

ALTER TABLE jira_case_links ADD COLUMN last_webhook_at TEXT;
ALTER TABLE jira_case_links ADD COLUMN external_status TEXT;
ALTER TABLE jira_case_links ADD COLUMN external_assignee_id TEXT;
ALTER TABLE jira_case_links ADD COLUMN external_assignee_name TEXT;

CREATE TABLE IF NOT EXISTS jira_webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        external_issue_id TEXT,
        external_issue_key TEXT,
        case_id INTEGER,
        processing_status TEXT NOT NULL CHECK (processing_status IN ('processed', 'ignored', 'failed')),
        details TEXT,
        received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (case_id) REFERENCES coordination_cases(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS channel_notification_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        case_id INTEGER NOT NULL,
        team_member_id INTEGER NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'teams')),
        notification_type TEXT NOT NULL,
        deduplication_key TEXT NOT NULL UNIQUE,
        message TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sending', 'sent', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        sent_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (case_id) REFERENCES coordination_cases(id) ON DELETE CASCADE,
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jira_webhook_issue ON jira_webhook_events (external_issue_id, received_at);
CREATE INDEX IF NOT EXISTS idx_channel_notification_delivery ON channel_notification_outbox (delivery_status, channel, created_at);
