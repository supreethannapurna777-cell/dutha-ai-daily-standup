PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        reporting_language TEXT NOT NULL DEFAULT 'en'
                CHECK (reporting_language IN ('en', 'hi', 'te', 'ta')),
        timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO tenants (id, slug, name)
VALUES (1, 'aurowise', 'Aurowise');

CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        project_key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
        UNIQUE (tenant_id, project_key)
);

INSERT OR IGNORE INTO projects (id, tenant_id, project_key, name)
VALUES (1, 1, 'DUTHA', 'Dutha WorkOps Pilot');

CREATE TABLE IF NOT EXISTS management_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        external_subject TEXT NOT NULL,
        display_name TEXT NOT NULL,
        email TEXT,
        tenant_role TEXT NOT NULL DEFAULT 'project_manager'
                CHECK (tenant_role IN ('admin', 'portfolio_leader', 'project_manager')),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        UNIQUE (tenant_id, external_subject)
);

INSERT OR IGNORE INTO management_users (
        id, tenant_id, external_subject, display_name, tenant_role
) VALUES (1, 1, 'legacy-dashboard-admin', 'Dutha Administrator', 'admin');

CREATE TABLE IF NOT EXISTS project_memberships (
        project_id INTEGER NOT NULL,
        management_user_id INTEGER NOT NULL,
        project_role TEXT NOT NULL DEFAULT 'manager'
                CHECK (project_role IN ('manager', 'viewer')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_id, management_user_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (management_user_id) REFERENCES management_users(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO project_memberships (
        project_id, management_user_id, project_role
) VALUES (1, 1, 'manager');

CREATE TABLE IF NOT EXISTS team_member_projects (
        project_id INTEGER NOT NULL,
        team_member_id INTEGER NOT NULL,
        member_role TEXT NOT NULL DEFAULT 'member'
                CHECK (member_role IN ('member', 'lead')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_id, team_member_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO team_member_projects (project_id, team_member_id)
SELECT 1, id FROM team_members;

ALTER TABLE team_members ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE team_members ADD COLUMN primary_project_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE incoming_messages ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE incoming_messages ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE processed_updates ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE processed_updates ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sent_messages ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE coordination_cases ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE coordination_cases ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE voice_updates ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE voice_updates ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_projects_tenant_active
ON projects (tenant_id, active, name);

CREATE INDEX IF NOT EXISTS idx_management_users_tenant_role
ON management_users (tenant_id, tenant_role, active);

CREATE INDEX IF NOT EXISTS idx_project_memberships_user
ON project_memberships (management_user_id, project_id);

CREATE INDEX IF NOT EXISTS idx_team_member_projects_member
ON team_member_projects (team_member_id, project_id);

CREATE INDEX IF NOT EXISTS idx_team_members_tenant_project
ON team_members (tenant_id, primary_project_id, active);

CREATE INDEX IF NOT EXISTS idx_incoming_tenant_project_received
ON incoming_messages (tenant_id, project_id, received_at);

CREATE INDEX IF NOT EXISTS idx_processed_tenant_project
ON processed_updates (tenant_id, project_id, message_id);

CREATE INDEX IF NOT EXISTS idx_cases_tenant_project_status
ON coordination_cases (tenant_id, project_id, status, requested_at);

CREATE INDEX IF NOT EXISTS idx_voice_tenant_project_status
ON voice_updates (tenant_id, project_id, status, received_at);
