import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "../src/env";
import { integrationReadiness, recoverIntegrationPipeline } from "../src/pipeline-reliability";

const fullEnv = {
        ...env,
        WHATSAPP_ACCESS_TOKEN: "wa-token", WHATSAPP_PHONE_NUMBER_ID: "phone-id", WHATSAPP_APP_SECRET: "wa-secret", WHATSAPP_API_VERSION: "v26.0",
        MICROSOFT_APP_ID: "teams-app", MICROSOFT_APP_PASSWORD: "teams-secret", MICROSOFT_TENANT_ID: "tenant",
        TEAMS_RELEASE_ENABLED: "true",
        JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "jira@example.com", JIRA_API_TOKEN: "jira-token", JIRA_PROJECT_KEY: "DUTHA", JIRA_WEBHOOK_SECRET: "webhook-secret",
} as WorkerEnv;

describe("integration pipeline reliability", () => {
        beforeEach(async () => {
                await env.DB.batch([
                        env.DB.prepare("DELETE FROM integration_operation_events"),
                        env.DB.prepare("DELETE FROM channel_notification_outbox"),
                        env.DB.prepare("DELETE FROM jira_case_links"),
                        env.DB.prepare("DELETE FROM teams_conversation_references"),
                        env.DB.prepare("DELETE FROM channel_identities"),
                        env.DB.prepare("DELETE FROM case_events"),
                        env.DB.prepare("DELETE FROM coordination_cases"),
                        env.DB.prepare("DELETE FROM processed_updates"),
                        env.DB.prepare("DELETE FROM incoming_messages"),
                        env.DB.prepare("DELETE FROM team_members"),
                ]);
        });

        it("reports configuration readiness without exposing credentials", async () => {
                expect(await integrationReadiness(fullEnv)).toEqual({
                        whatsapp: { configured: true, pending: 0, failed: 0 },
                        teams: { enabled: true, configured: true, pending: 0, failed: 0 },
                        jira: { configured: true, webhookConfigured: true, pending: 0, failed: 0 },
                });
        });

        it("marks Teams as planned when it is outside the current release", async () => {
                const readiness = await integrationReadiness({ ...fullEnv, TEAMS_RELEASE_ENABLED: "false" } as WorkerEnv);
                expect(readiness.teams).toEqual({ enabled: false, configured: false, pending: 0, failed: 0 });
        });

        it("recovers a stale notification lease and delivers it", async () => {
                const member = await env.DB.prepare(`INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id) VALUES ('Sreeja', '919100000010', 'AI', 1, 1) RETURNING id`).first<{ id: number }>();
                await env.DB.prepare(`INSERT INTO channel_identities (tenant_id, team_member_id, channel, external_id) VALUES (1, ?, 'whatsapp', '919100000010')`).bind(member!.id).run();
                const incoming = await env.DB.prepare(`INSERT INTO incoming_messages (whatsapp_message_id, received_at, sender_name, sender_phone, original_reply, processing_status, tenant_id, project_id, channel, external_message_id, sender_external_id, team_member_id) VALUES ('rel-1', '2026-09-17T00:00:00Z', 'Sreeja', '919100000010', 'blocked', 'processed', 1, 1, 'whatsapp', 'rel-1', '919100000010', ?) RETURNING id`).bind(member!.id).first<{ id: number }>();
                const processed = await env.DB.prepare(`INSERT INTO processed_updates (message_id, sender_name, blockers, original_reply, processing_status, tenant_id, project_id) VALUES (?, 'Sreeja', 'blocked', 'blocked', 'processed', 1, 1) RETURNING id`).bind(incoming!.id).first<{ id: number }>();
                const item = await env.DB.prepare(`INSERT INTO coordination_cases (source_update_id, requester_member_id, case_type, issue_summary, status, priority, tenant_id, project_id, resolution_state) VALUES (?, ?, 'blocker', 'blocked', 'approved', 'high', 1, 1, 'triaged') RETURNING id`).bind(processed!.id, member!.id).first<{ id: number }>();
                await env.DB.prepare(`INSERT INTO channel_notification_outbox (tenant_id, project_id, case_id, team_member_id, channel, notification_type, deduplication_key, message, delivery_status, updated_at) VALUES (1, 1, ?, ?, 'whatsapp', 'test', 'stale-test', 'Recovered message', 'sending', datetime('now', '-20 minutes'))`).bind(item!.id, member!.id).run();
                const fetcher = vi.fn().mockResolvedValue(Response.json({ messages: [{ id: "wamid.sent" }] }));
                const summary = await recoverIntegrationPipeline({ ...fullEnv, MICROSOFT_APP_ID: undefined, MICROSOFT_APP_PASSWORD: undefined, JIRA_BASE_URL: undefined } as WorkerEnv, fetcher);
                expect(summary.recoveredNotifications).toBe(1);
                expect(summary.whatsappSent).toBe(1);
                expect(await env.DB.prepare("SELECT delivery_status, attempt_count FROM channel_notification_outbox WHERE deduplication_key = 'stale-test'").first()).toEqual({ delivery_status: "sent", attempt_count: 1 });
        });

        it("records exhausted notifications only once", async () => {
                const member = await env.DB.prepare(`INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id) VALUES ('Sreeja', '919100000010', 'AI', 1, 1) RETURNING id`).first<{ id: number }>();
                const incoming = await env.DB.prepare(`INSERT INTO incoming_messages (whatsapp_message_id, received_at, sender_name, sender_phone, original_reply, processing_status, tenant_id, project_id) VALUES ('rel-2', '2026-09-17T00:00:00Z', 'Sreeja', '919100000010', 'blocked', 'processed', 1, 1) RETURNING id`).first<{ id: number }>();
                const processed = await env.DB.prepare(`INSERT INTO processed_updates (message_id, sender_name, blockers, original_reply, processing_status, tenant_id, project_id) VALUES (?, 'Sreeja', 'blocked', 'blocked', 'processed', 1, 1) RETURNING id`).bind(incoming!.id).first<{ id: number }>();
                const item = await env.DB.prepare(`INSERT INTO coordination_cases (source_update_id, requester_member_id, case_type, issue_summary, status, priority, tenant_id, project_id, resolution_state) VALUES (?, ?, 'blocker', 'blocked', 'approved', 'high', 1, 1, 'triaged') RETURNING id`).bind(processed!.id, member!.id).first<{ id: number }>();
                await env.DB.prepare(`INSERT INTO channel_notification_outbox (tenant_id, project_id, case_id, team_member_id, channel, notification_type, deduplication_key, message, delivery_status, attempt_count, last_error) VALUES (1, 1, ?, ?, 'whatsapp', 'test', 'exhausted-test', 'Failed', 'failed', 5, 'API outage')`).bind(item!.id, member!.id).run();
                const disabled = { ...fullEnv, WHATSAPP_ACCESS_TOKEN: undefined, MICROSOFT_APP_ID: undefined, JIRA_BASE_URL: undefined } as WorkerEnv;
                expect((await recoverIntegrationPipeline(disabled)).exhausted).toBe(1);
                expect((await recoverIntegrationPipeline(disabled)).exhausted).toBe(0);
        });
});
