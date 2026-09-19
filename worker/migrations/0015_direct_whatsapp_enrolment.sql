PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS direct_whatsapp_invites (
        team_member_id INTEGER PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_direct_whatsapp_invites_expiry
ON direct_whatsapp_invites (tenant_id, project_id, expires_at);
