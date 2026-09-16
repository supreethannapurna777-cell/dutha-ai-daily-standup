PRAGMA foreign_keys = ON;

ALTER TABLE coordination_cases
ADD COLUMN resolution_state TEXT NOT NULL DEFAULT 'detected'
CHECK (resolution_state IN (
        'detected',
        'triaged',
        'in_coordination',
        'awaiting_verification',
        'resolved',
        'escalated'
));

ALTER TABLE coordination_cases ADD COLUMN sla_due_at TEXT;
ALTER TABLE coordination_cases ADD COLUMN resolution_summary TEXT;
ALTER TABLE coordination_cases ADD COLUMN resolution_proposed_at TEXT;
ALTER TABLE coordination_cases ADD COLUMN resolution_verified_at TEXT;
ALTER TABLE coordination_cases ADD COLUMN verified_by_type TEXT
CHECK (verified_by_type IN ('requester', 'manager', 'system'));

UPDATE coordination_cases
SET resolution_state = CASE
        WHEN status = 'resolved' THEN 'resolved'
        WHEN status IN ('rejected', 'cancelled') THEN 'resolved'
        WHEN status IN ('scheduled', 'in_progress', 'availability_requested', 'time_agreed')
                THEN 'in_coordination'
        WHEN status = 'approved' THEN 'triaged'
        ELSE 'detected'
END;

UPDATE coordination_cases
SET resolution_verified_at = COALESCE(resolved_at, updated_at),
        verified_by_type = 'manager'
WHERE resolution_state = 'resolved';

CREATE TABLE IF NOT EXISTS blocker_resolution_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        case_id INTEGER NOT NULL,
        evidence_type TEXT NOT NULL
                CHECK (evidence_type IN (
                        'manager_note',
                        'requester_confirmation',
                        'external_event',
                        'meeting_outcome',
                        'system_event'
                )),
        summary TEXT NOT NULL,
        external_url TEXT,
        created_by_type TEXT NOT NULL
                CHECK (created_by_type IN ('manager', 'member', 'system')),
        created_by_management_user_id INTEGER,
        created_by_member_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (case_id) REFERENCES coordination_cases(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_management_user_id)
                REFERENCES management_users(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by_member_id)
                REFERENCES team_members(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cases_resolution_state_sla
ON coordination_cases (tenant_id, project_id, resolution_state, sla_due_at);

CREATE INDEX IF NOT EXISTS idx_resolution_evidence_case
ON blocker_resolution_evidence (case_id, created_at);
