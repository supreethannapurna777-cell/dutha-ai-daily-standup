PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS case_time_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        case_id INTEGER NOT NULL,

        starts_at TEXT NOT NULL,

        duration_minutes INTEGER NOT NULL
                DEFAULT 15
                CHECK (
                        duration_minutes IN (
                                15,
                                20,
                                30,
                                45,
                                60
                        )
                ),

        status TEXT NOT NULL
                DEFAULT 'proposed'
                CHECK (
                        status IN (
                                'proposed',
                                'matched',
                                'selected',
                                'expired',
                                'cancelled'
                        )
                ),

        created_by TEXT NOT NULL
                DEFAULT 'system'
                CHECK (
                        created_by IN (
                                'system',
                                'manager'
                        )
                ),

        created_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (case_id)
                REFERENCES coordination_cases(id)
                ON DELETE CASCADE,

        UNIQUE (
                case_id,
                starts_at
        )
);

CREATE INDEX IF NOT EXISTS
idx_case_time_options_case
ON case_time_options (
        case_id,
        status,
        starts_at
);

CREATE INDEX IF NOT EXISTS
idx_case_availability_matching
ON case_availability (
        case_id,
        available_at,
        member_id
);