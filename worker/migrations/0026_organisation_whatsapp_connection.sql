-- Per-tenant WhatsApp Cloud API sender credentials. Access tokens are stored
-- encrypted by the Worker; Meta app signature/verification secrets remain
-- shared Worker secrets for the single subscribed webhook app.
CREATE TABLE IF NOT EXISTS organisation_whatsapp_connections (
        tenant_id INTEGER PRIMARY KEY,
        phone_number_id TEXT NOT NULL,
        access_token_ciphertext TEXT NOT NULL,
        access_token_iv TEXT NOT NULL,
        connection_status TEXT NOT NULL DEFAULT 'connected'
                CHECK (connection_status IN ('connected', 'disconnected')),
        last_verified_at TEXT NOT NULL,
        configured_by_management_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (configured_by_management_user_id)
                REFERENCES management_users(id) ON DELETE SET NULL
);
