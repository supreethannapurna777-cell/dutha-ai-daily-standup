ALTER TABLE team_members
ADD COLUMN timezone TEXT NOT NULL
DEFAULT 'Asia/Kolkata';

ALTER TABLE team_members
ADD COLUMN working_days TEXT NOT NULL
DEFAULT 'MON,TUE,WED,THU,FRI';

ALTER TABLE team_members
ADD COLUMN initial_time TEXT NOT NULL
DEFAULT '12:00';

ALTER TABLE team_members
ADD COLUMN reminder_1_time TEXT NOT NULL
DEFAULT '15:00';

ALTER TABLE team_members
ADD COLUMN reminder_2_time TEXT NOT NULL
DEFAULT '18:00';

ALTER TABLE team_members
ADD COLUMN scheduling_enabled INTEGER NOT NULL
DEFAULT 1
CHECK (scheduling_enabled IN (0, 1));

CREATE INDEX IF NOT EXISTS
idx_incoming_sender_phone_received_at
ON incoming_messages (
        sender_phone,
        received_at
);

CREATE INDEX IF NOT EXISTS
idx_team_members_scheduling
ON team_members (
        active,
        scheduling_enabled,
        timezone
);

CREATE UNIQUE INDEX IF NOT EXISTS
idx_unique_successful_scheduled_send
ON sent_messages (
        team_member_id,
        message_type,
        scheduled_for
)
WHERE
        team_member_id IS NOT NULL
        AND status = 'sent';