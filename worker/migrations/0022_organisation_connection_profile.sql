-- Company-owned connection details. Protected provider credentials remain
-- Cloudflare secrets and are deliberately not stored in D1.
CREATE TABLE IF NOT EXISTS organisation_connection_profiles (
        tenant_id INTEGER PRIMARY KEY,
        whatsapp_business_name TEXT,
        whatsapp_business_number TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
