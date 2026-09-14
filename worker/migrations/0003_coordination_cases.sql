PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS coordination_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        source_update_id INTEGER NOT NULL UNIQUE,

        requester_member_id INTEGER NOT NULL,

        responsible_member_id INTEGER,

        case_type TEXT NOT NULL
                CHECK (
                        case_type IN (
                                'blocker',
                                'dependency',
                                'coordination'
                        )
                ),

        issue_summary TEXT NOT NULL,

        status TEXT NOT NULL
                DEFAULT 'pending_approval'
                CHECK (
                        status IN (
                                'pending_assignment',
                                'pending_approval',
                                'approved',
                                'availability_requested',
                                'time_agreed',
                                'scheduled',
                                'in_progress',
                                'resolved',
                                'rejected',
                                'cancelled'
                        )
                ),

        priority TEXT NOT NULL
                DEFAULT 'normal'
                CHECK (
                        priority IN (
                                'low',
                                'normal',
                                'high',
                                'critical'
                        )
                ),

        meeting_duration_minutes INTEGER NOT NULL
                DEFAULT 15
                CHECK (
                        meeting_duration_minutes IN (
                                15,
                                20,
                                30,
                                45,
                                60
                        )
                ),

        proposed_time TEXT,

        meeting_link TEXT,

        manager_notes TEXT,

        requested_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

        approved_at TEXT,

        resolved_at TEXT,

        updated_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (source_update_id)
                REFERENCES processed_updates(id)
                ON DELETE CASCADE,

        FOREIGN KEY (requester_member_id)
                REFERENCES team_members(id)
                ON DELETE RESTRICT,

        FOREIGN KEY (responsible_member_id)
                REFERENCES team_members(id)
                ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS
idx_coordination_cases_status
ON coordination_cases (
        status,
        requested_at
);

CREATE INDEX IF NOT EXISTS
idx_coordination_cases_requester
ON coordination_cases (
        requester_member_id,
        status
);

CREATE INDEX IF NOT EXISTS
idx_coordination_cases_responsible
ON coordination_cases (
        responsible_member_id,
        status
);

CREATE TABLE IF NOT EXISTS case_availability (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        case_id INTEGER NOT NULL,

        member_id INTEGER NOT NULL,

        available_at TEXT NOT NULL,

        timezone TEXT NOT NULL,

        selected INTEGER NOT NULL
                DEFAULT 0
                CHECK (selected IN (0, 1)),

        created_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (case_id)
                REFERENCES coordination_cases(id)
                ON DELETE CASCADE,

        FOREIGN KEY (member_id)
                REFERENCES team_members(id)
                ON DELETE CASCADE,

        UNIQUE (
                case_id,
                member_id,
                available_at
        )
);

CREATE INDEX IF NOT EXISTS
idx_case_availability_case
ON case_availability (
        case_id,
        available_at
);

CREATE TABLE IF NOT EXISTS case_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        case_id INTEGER NOT NULL,

        event_type TEXT NOT NULL,

        actor_type TEXT NOT NULL
                CHECK (
                        actor_type IN (
                                'system',
                                'manager',
                                'member'
                        )
                ),

        actor_member_id INTEGER,

        details TEXT,

        created_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (case_id)
                REFERENCES coordination_cases(id)
                ON DELETE CASCADE,

        FOREIGN KEY (actor_member_id)
                REFERENCES team_members(id)
                ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS
idx_case_events_case
ON case_events (
        case_id,
        created_at
);