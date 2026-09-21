import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/env";
import { deploymentPreflightResponse, evaluateDeploymentPreflight } from "../src/deployment-preflight";

const readyEnv = {
        ...env, AI: {} as Ai,
        DASHBOARD_USERNAME: "admin", DASHBOARD_PASSWORD: "password",
        DASHBOARD_SESSION_SECRET: "a-secure-session-secret-with-32-characters",
        WHATSAPP_ACCESS_TOKEN: "token", WHATSAPP_PHONE_NUMBER_ID: "phone",
        WHATSAPP_APP_SECRET: "app-secret", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify",
	WHATSAPP_TEMPLATE_LANGUAGE: "en_US",
	WHATSAPP_INITIAL_TEMPLATE_NAME: "daily_standup_request",
	WHATSAPP_REMINDER_TEMPLATE_NAME: "daily_standup_reminder",
	WHATSAPP_AVAILABILITY_TEMPLATE_NAME: "coordination_availability_request",
	WHATSAPP_MEETING_TEMPLATE_NAME: "coordination_meeting_scheduled",
        JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "jira@example.com",
        JIRA_API_TOKEN: "jira-token", JIRA_PROJECT_KEY: "DUTHA", JIRA_WEBHOOK_SECRET: "webhook",
        ATLASSIAN_MCP_EMAIL: "mcp@example.com", ATLASSIAN_MCP_API_TOKEN: "mcp-token",
        MICROSOFT_APP_ID: "app-id", MICROSOFT_APP_PASSWORD: "app-password",
        MICROSOFT_TENANT_ID: "tenant-id", TEAMS_RELEASE_ENABLED: "false",
} as WorkerEnv;

describe("deployment preflight", () => {
        it("returns READY only when every release binding and secret exists", async () => {
                const report = evaluateDeploymentPreflight(readyEnv);
                expect(report.ready).toBe(true);
                expect(report.missing).toEqual([]);
                const response = deploymentPreflightResponse(readyEnv);
                expect(response.status).toBe(200);
        });

        it("requires Teams credentials only when Teams is enabled for release", async () => {
                const enabled = {
                        ...readyEnv,
                        TEAMS_RELEASE_ENABLED: "true",
                        MICROSOFT_APP_ID: undefined,
                        MICROSOFT_APP_PASSWORD: undefined,
                        MICROSOFT_TENANT_ID: undefined,
                } as WorkerEnv;
                const report = evaluateDeploymentPreflight(enabled);
                expect(report.ready).toBe(false);
                expect(report.missing).toEqual([
                        "Microsoft app ID",
                        "Microsoft app password",
                        "Microsoft tenant ID",
                ]);
        });

        it("returns NOT READY without exposing secret values", async () => {
                const unsafe = { ...readyEnv, JIRA_API_TOKEN: undefined, DASHBOARD_SESSION_SECRET: "short" } as WorkerEnv;
                const response = deploymentPreflightResponse(unsafe);
                expect(response.status).toBe(503);
                const text = await response.text();
                expect(text).toContain("Jira API token");
                expect(text).toContain("Dashboard session secret");
                expect(text).not.toContain("jira-token");
                expect(text).not.toContain("app-password");
        });

        it("confirms migrations 0008 through 0014 produced the required schema", async () => {
                const expectedTables = [
                        "channel_identities", "enrolment_invites", "channel_identity_events",
                        "jira_case_links", "jira_webhook_events", "channel_notification_outbox",
                        "teams_conversation_references", "integration_operation_events",
                        "atlassian_mcp_context",
                ];
                const tables = (await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>()).results.map((row) => row.name);
                for (const table of expectedTables) expect(tables).toContain(table);
                const jiraColumns = (await env.DB.prepare(`PRAGMA table_info(jira_case_links)`).all<{ name: string }>()).results.map((row) => row.name);
                expect(jiraColumns).toEqual(expect.arrayContaining([
                        "external_issue_id", "external_issue_key", "sync_status", "attempt_count",
                        "last_webhook_at", "external_status", "external_assignee_id",
                ]));
        });
});
