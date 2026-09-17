PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jira_case_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        case_id INTEGER NOT NULL UNIQUE,
        external_issue_id TEXT,
        external_issue_key TEXT,
        external_issue_url TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending'
                CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_attempted_at TEXT,
        synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (case_id) REFERENCES coordination_cases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jira_case_links_retry
ON jira_case_links (sync_status, last_attempted_at);
