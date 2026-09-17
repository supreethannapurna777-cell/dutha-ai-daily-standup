PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS integration_operation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER,
        project_id INTEGER,
        integration TEXT NOT NULL CHECK (integration IN ('jira', 'whatsapp', 'teams')),
        event_type TEXT NOT NULL CHECK (event_type IN ('recovered', 'retry_failed', 'retry_exhausted')),
        event_key TEXT NOT NULL UNIQUE,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_integration_events_created
ON integration_operation_events (integration, created_at);
