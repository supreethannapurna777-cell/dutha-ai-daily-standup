ALTER TABLE team_members ADD COLUMN pre_enrolment_messaging_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (pre_enrolment_messaging_enabled IN (0, 1));
