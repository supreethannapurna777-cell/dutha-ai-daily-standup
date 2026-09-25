-- Extend roles without rebuilding management_users: existing accounts and foreign
-- key references remain intact. Legacy tenant_role is retained for compatibility.
ALTER TABLE management_users ADD COLUMN workops_role TEXT
        CHECK (workops_role IS NULL OR workops_role IN ('ceo', 'team_lead'));

-- A Team Lead may lead one named team within each project. The application also
-- verifies that the project, user and team all belong to the same tenant.
CREATE TABLE IF NOT EXISTS team_lead_assignments (
        project_id INTEGER NOT NULL,
        management_user_id INTEGER NOT NULL,
        department TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_id, management_user_id),
        UNIQUE (project_id, department),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (management_user_id) REFERENCES management_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_team_lead_assignments_user
ON team_lead_assignments (management_user_id, project_id);
