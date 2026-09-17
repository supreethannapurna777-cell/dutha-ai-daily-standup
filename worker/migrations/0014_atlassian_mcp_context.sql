PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS atlassian_mcp_context (
 id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
 case_id INTEGER NOT NULL UNIQUE, status TEXT NOT NULL CHECK (status IN ('available','unavailable')),
 tool_name TEXT, context_summary TEXT, last_error TEXT, attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
 FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
 FOREIGN KEY (case_id) REFERENCES coordination_cases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_atlassian_mcp_context_status ON atlassian_mcp_context (status, updated_at);
