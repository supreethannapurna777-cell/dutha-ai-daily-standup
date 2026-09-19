PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organisation_email_settings (
        tenant_id INTEGER PRIMARY KEY,
        company_name TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        from_email TEXT NOT NULL,
        reply_to_email TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
