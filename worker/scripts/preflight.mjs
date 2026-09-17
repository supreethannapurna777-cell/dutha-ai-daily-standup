import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const expectedMigrations = Array.from({ length: 14 }, (_, index) => String(index + 1).padStart(4, "0"));
const migrations = readdirSync(new URL("../migrations", import.meta.url))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const errors = [];

if (migrations.length !== expectedMigrations.length) {
        errors.push(`Expected 14 migrations, found ${migrations.length}.`);
}
for (const [index, prefix] of expectedMigrations.entries()) {
        if (!migrations[index]?.startsWith(`${prefix}_`)) errors.push(`Migration ${prefix} is missing or out of order.`);
}

const configText = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
for (const required of ['"main": "src/index.ts"', '"binding": "DB"', '"binding": "AI"', '"*/15 * * * *"']) {
        if (!configText.includes(required)) errors.push(`Wrangler configuration is missing ${required}.`);
}
const forbiddenSecrets = [
        "DASHBOARD_PASSWORD", "DASHBOARD_SESSION_SECRET", "WHATSAPP_ACCESS_TOKEN",
        "WHATSAPP_APP_SECRET", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "JIRA_API_TOKEN",
        "JIRA_WEBHOOK_SECRET", "MICROSOFT_APP_PASSWORD", "ATLASSIAN_MCP_API_TOKEN",
        "ATLASSIAN_MCP_SERVICE_TOKEN",
];
for (const secret of forbiddenSecrets) {
        if (configText.includes(`"${secret}"`)) errors.push(`${secret} must be stored as a Wrangler secret, not in wrangler.jsonc.`);
}

if (errors.length) {
        console.error("NOT READY");
        for (const error of errors) console.error(`- ${error}`);
        process.exit(1);
}

const commands = [
        [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), ["--noEmit"]],
        [fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)), ["--run"]],
];
for (const [script, args] of commands) {
        const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", shell: false });
        if (result.status !== 0) {
                const detail = result.error ? ` ${result.error.message}` : "";
                console.error(`NOT READY: ${script} ${args.join(" ")} failed.${detail}`);
                process.exit(result.status ?? 1);
        }
}
console.log(`READY: ${migrations.length} ordered migrations, bindings checked, secrets excluded from config, TypeScript and tests passed.`);
