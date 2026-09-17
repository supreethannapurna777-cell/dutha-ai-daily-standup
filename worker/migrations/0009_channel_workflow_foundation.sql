PRAGMA foreign_keys = ON;

ALTER TABLE incoming_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp'
        CHECK (channel IN ('whatsapp', 'teams'));
ALTER TABLE incoming_messages ADD COLUMN external_message_id TEXT;
ALTER TABLE incoming_messages ADD COLUMN sender_external_id TEXT;
ALTER TABLE incoming_messages ADD COLUMN team_member_id INTEGER;

UPDATE incoming_messages
SET external_message_id = whatsapp_message_id,
        sender_external_id = sender_phone
WHERE external_message_id IS NULL;

UPDATE incoming_messages
SET team_member_id = (
        SELECT member.id FROM team_members AS member
        WHERE member.tenant_id = incoming_messages.tenant_id
                AND member.phone = incoming_messages.sender_phone
        LIMIT 1
)
WHERE team_member_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_incoming_channel_external_message
ON incoming_messages (channel, external_message_id)
WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_incoming_team_member
ON incoming_messages (tenant_id, project_id, team_member_id, received_at);
