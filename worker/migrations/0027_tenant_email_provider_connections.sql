ALTER TABLE organisation_email_settings ADD COLUMN resend_api_key_ciphertext TEXT;
ALTER TABLE organisation_email_settings ADD COLUMN resend_api_key_iv TEXT;
ALTER TABLE organisation_email_settings ADD COLUMN email_connection_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (email_connection_status IN ('pending', 'connected', 'disconnected'));
ALTER TABLE organisation_email_settings ADD COLUMN email_last_verified_at TEXT;
