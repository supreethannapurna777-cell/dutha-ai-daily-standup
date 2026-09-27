-- A connected Meta business phone number must belong to one tenant only.
CREATE UNIQUE INDEX IF NOT EXISTS idx_organisation_whatsapp_connected_phone
ON organisation_whatsapp_connections (phone_number_id)
WHERE connection_status = 'connected';
