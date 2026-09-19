PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employee_accounts (
        team_member_id INTEGER PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        password_hash TEXT,
        password_salt TEXT,
        activated_at TEXT,
        last_login_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS employee_activation_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_member_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS employee_channel_preferences (
        team_member_id INTEGER NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email', 'teams', 'slack')),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
        consented_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (team_member_id, channel),
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_employee_activation_active
ON employee_activation_tokens (team_member_id, expires_at, used_at, revoked_at);

