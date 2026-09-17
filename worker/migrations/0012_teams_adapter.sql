PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams_conversation_references (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        team_member_id INTEGER NOT NULL UNIQUE,
        service_url TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tenant_external_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_teams_conversation_member
ON teams_conversation_references (tenant_id, team_member_id);
