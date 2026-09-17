PRAGMA foreign_keys = ON;

ALTER TABLE team_members ADD COLUMN email TEXT;
ALTER TABLE team_members ADD COLUMN enrolment_status TEXT NOT NULL DEFAULT 'enrolled'
        CHECK (enrolment_status IN ('invited', 'enrolled', 'suspended'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_tenant_email
ON team_members (tenant_id, email)
WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        team_member_id INTEGER NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'teams')),
        external_id TEXT NOT NULL,
        display_name TEXT,
        verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE,
        UNIQUE (channel, external_id),
        UNIQUE (team_member_id, channel)
);

INSERT OR IGNORE INTO channel_identities (
        tenant_id, team_member_id, channel, external_id, display_name
)
SELECT tenant_id, id, 'whatsapp', phone, name
FROM team_members
WHERE phone GLOB '[0-9]*' AND length(phone) BETWEEN 8 AND 15;

CREATE TABLE IF NOT EXISTS enrolment_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        created_by_management_user_id INTEGER NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        max_uses INTEGER NOT NULL DEFAULT 100 CHECK (max_uses BETWEEN 1 AND 1000),
        use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_management_user_id)
                REFERENCES management_users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS channel_identity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER,
        team_member_id INTEGER,
        channel TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (
                event_type IN (
                        'invite_created',
                        'identity_connected',
                        'identity_rejected',
                        'invite_revoked',
                        'members_imported'
                )
        ),
        external_message_id TEXT UNIQUE,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_channel_identities_tenant_member
ON channel_identities (tenant_id, team_member_id, channel);

CREATE INDEX IF NOT EXISTS idx_enrolment_invites_project_active
ON enrolment_invites (tenant_id, project_id, expires_at, revoked_at);
