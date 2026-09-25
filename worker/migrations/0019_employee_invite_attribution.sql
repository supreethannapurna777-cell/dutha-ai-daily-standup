-- Attribute employee-created enrolment invites to the employee, while
-- preserving the existing management-created invites and their identifiers.
CREATE TABLE enrolment_invites_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        created_by_management_user_id INTEGER,
        created_by_team_member_id INTEGER,
        code_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        max_uses INTEGER NOT NULL DEFAULT 100 CHECK (max_uses BETWEEN 1 AND 1000),
        use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK ((created_by_management_user_id IS NOT NULL) != (created_by_team_member_id IS NOT NULL)),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_management_user_id) REFERENCES management_users(id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by_team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
);

INSERT INTO enrolment_invites_new (
        id, tenant_id, project_id, created_by_management_user_id,
        code_hash, expires_at, max_uses, use_count, revoked_at, created_at
)
SELECT id, tenant_id, project_id, created_by_management_user_id,
        code_hash, expires_at, max_uses, use_count, revoked_at, created_at
FROM enrolment_invites;

DROP TABLE enrolment_invites;
ALTER TABLE enrolment_invites_new RENAME TO enrolment_invites;

CREATE INDEX idx_enrolment_invites_project_active
ON enrolment_invites (tenant_id, project_id, expires_at, revoked_at);
