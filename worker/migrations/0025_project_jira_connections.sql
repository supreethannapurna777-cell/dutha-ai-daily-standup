CREATE TABLE IF NOT EXISTS project_jira_connections (
        tenant_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        base_url TEXT NOT NULL,
        account_email TEXT NOT NULL,
        api_token_ciphertext TEXT NOT NULL,
        api_token_iv TEXT NOT NULL,
        project_key TEXT NOT NULL,
        issue_type TEXT NOT NULL DEFAULT 'Task',
        connection_status TEXT NOT NULL DEFAULT 'connected'
                CHECK (connection_status IN ('connected', 'disabled')),
        configured_by_management_user_id INTEGER,
        last_verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, project_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (configured_by_management_user_id) REFERENCES management_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_project_jira_connections_status
ON project_jira_connections (tenant_id, connection_status, project_id);
