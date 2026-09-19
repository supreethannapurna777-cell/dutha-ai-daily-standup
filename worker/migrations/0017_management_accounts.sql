PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS management_accounts (
        management_user_id INTEGER PRIMARY KEY,
        password_hash TEXT,
        password_salt TEXT,
        activated_at TEXT,
        last_login_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (management_user_id) REFERENCES management_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS management_activation_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        management_user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (management_user_id) REFERENCES management_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_management_activation_active
ON management_activation_tokens (management_user_id, expires_at, used_at, revoked_at);
