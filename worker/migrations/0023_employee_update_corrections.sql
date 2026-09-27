-- Employee corrections preserve the original processed update and require
-- an authorised manager decision before any corrected value is published.
CREATE TABLE IF NOT EXISTS employee_update_corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        team_member_id INTEGER NOT NULL,
        processed_update_id INTEGER NOT NULL,
        correction_text TEXT NOT NULL CHECK (length(correction_text) BETWEEN 12 AND 1000),
        status TEXT NOT NULL DEFAULT 'pending_review'
                CHECK (status IN ('pending_review', 'approved', 'rejected', 'cancelled')),
        manager_notes TEXT,
        reviewed_by_management_user_id INTEGER,
        reviewed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE,
        FOREIGN KEY (processed_update_id) REFERENCES processed_updates(id) ON DELETE CASCADE,
        FOREIGN KEY (reviewed_by_management_user_id) REFERENCES management_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_employee_update_corrections_scope
ON employee_update_corrections (tenant_id, project_id, team_member_id, status, created_at DESC);
