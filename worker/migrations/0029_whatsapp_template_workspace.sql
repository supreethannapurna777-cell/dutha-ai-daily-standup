ALTER TABLE organisation_whatsapp_connections ADD COLUMN waba_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_organisation_whatsapp_connected_waba
ON organisation_whatsapp_connections (waba_id)
WHERE connection_status='connected' AND waba_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_message_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        project_id INTEGER,
        template_name TEXT NOT NULL,
        language_code TEXT NOT NULL DEFAULT 'en_US',
        category TEXT NOT NULL DEFAULT 'UTILITY' CHECK (category IN ('UTILITY','MARKETING')),
        body_text TEXT NOT NULL,
        workflow TEXT CHECK (workflow IN ('initial','reminder','availability','meeting')),
        meta_status TEXT NOT NULL DEFAULT 'DRAFT',
        meta_template_id TEXT,
        created_by_management_user_id INTEGER,
        submitted_by_management_user_id INTEGER,
        synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_management_user_id) REFERENCES management_users(id) ON DELETE SET NULL,
        FOREIGN KEY (submitted_by_management_user_id) REFERENCES management_users(id) ON DELETE SET NULL,
        UNIQUE (tenant_id, template_name, language_code)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_tenant_status
ON whatsapp_message_templates (tenant_id, meta_status, template_name);

CREATE TABLE IF NOT EXISTS project_whatsapp_template_mappings (
        tenant_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        workflow TEXT NOT NULL CHECK (workflow IN ('initial','reminder','availability','meeting')),
        template_id INTEGER NOT NULL,
        updated_by_management_user_id INTEGER,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, project_id, workflow),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (template_id) REFERENCES whatsapp_message_templates(id) ON DELETE CASCADE,
        FOREIGN KEY (updated_by_management_user_id) REFERENCES management_users(id) ON DELETE SET NULL
);
