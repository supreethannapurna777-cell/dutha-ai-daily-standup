import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "../src/env";
import { deliverPendingWhatsappNotifications, jiraWebhookAuthorised, processJiraWebhook } from "../src/jira-webhook";
import { processResolutionReply } from "../src/resolution-reply";

let requesterId: number;
let caseId: number;

function request(id = "evt-1"): Request {
        return new Request("https://dutha.example/webhooks/jira", {
                method: "POST",
                headers: { "X-Atlassian-Webhook-Identifier": id },
        });
}

function payload(done = true) {
        return {
                webhookEvent: "jira:issue_updated",
                timestamp: 1789610000000,
                issue: {
                        id: "10001",
                        key: "DUTHA-42",
                        fields: {
                                status: { id: done ? "3" : "2", name: done ? "Done" : "In Progress", statusCategory: { key: done ? "done" : "indeterminate" } },
                                assignee: { accountId: "abc", displayName: "Imran" },
                                resolution: done ? { name: "Done" } : null,
                        },
                },
                comment: { id: "900", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "API access supplied" }] }] } },
        };
}

describe("Jira return path and requester verification", () => {
        beforeEach(async () => {
                await env.DB.batch([
                        env.DB.prepare("DELETE FROM channel_notification_outbox"),
                        env.DB.prepare("DELETE FROM jira_webhook_events"),
                        env.DB.prepare("DELETE FROM jira_case_links"),
                        env.DB.prepare("DELETE FROM blocker_resolution_evidence"),
                        env.DB.prepare("DELETE FROM case_events"),
                        env.DB.prepare("DELETE FROM coordination_cases"),
                        env.DB.prepare("DELETE FROM processed_updates"),
                        env.DB.prepare("DELETE FROM incoming_messages"),
                        env.DB.prepare("DELETE FROM channel_identities"),
                        env.DB.prepare("DELETE FROM team_members"),
                ]);
                const requester = await env.DB.prepare(`INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id) VALUES ('Supreeth', '919100000010', 'Management', 1, 1) RETURNING id`).first<{ id: number }>();
                requesterId = requester!.id;
                await env.DB.prepare(`INSERT INTO channel_identities (tenant_id, team_member_id, channel, external_id) VALUES (1, ?, 'whatsapp', '919100000010')`).bind(requesterId).run();
                const incoming = await env.DB.prepare(`INSERT INTO incoming_messages (whatsapp_message_id, received_at, sender_name, sender_phone, original_reply, processing_status, tenant_id, project_id, channel, external_message_id, sender_external_id, team_member_id) VALUES ('wamid.return', '2026-09-17T06:00:00Z', 'Supreeth', '919100000010', 'blocked', 'processed', 1, 1, 'whatsapp', 'wamid.return', '919100000010', ?) RETURNING id`).bind(requesterId).first<{ id: number }>();
                const processed = await env.DB.prepare(`INSERT INTO processed_updates (message_id, sender_name, blockers, original_reply, processing_status, tenant_id, project_id) VALUES (?, 'Supreeth', 'blocked', 'blocked', 'processed', 1, 1) RETURNING id`).bind(incoming!.id).first<{ id: number }>();
                const coordination = await env.DB.prepare(`INSERT INTO coordination_cases (source_update_id, requester_member_id, case_type, issue_summary, status, priority, tenant_id, project_id, resolution_state) VALUES (?, ?, 'blocker', 'Need API access', 'approved', 'high', 1, 1, 'triaged') RETURNING id`).bind(processed!.id, requesterId).first<{ id: number }>();
                caseId = coordination!.id;
                await env.DB.prepare(`INSERT INTO jira_case_links (tenant_id, project_id, case_id, external_issue_id, external_issue_key, sync_status) VALUES (1, 1, ?, '10001', 'DUTHA-42', 'synced')`).bind(caseId).run();
        });

        it("requires the configured webhook secret", () => {
                const configured = { JIRA_WEBHOOK_SECRET: "secret" } as WorkerEnv;
                expect(jiraWebhookAuthorised(new Request("https://x", { headers: { Authorization: "Bearer secret" } }), configured)).toBe(true);
                expect(jiraWebhookAuthorised(new Request("https://x", { headers: { Authorization: "Bearer wrong" } }), configured)).toBe(false);
        });

        it("moves a completed Jira issue to requester verification and queues notice", async () => {
                expect(await processJiraWebhook(env.DB, payload(), request())).toEqual({ status: "processed", caseId, action: "awaiting_verification" });
                expect(await env.DB.prepare("SELECT resolution_state, resolution_summary FROM coordination_cases WHERE id = ?").bind(caseId).first()).toEqual({ resolution_state: "awaiting_verification", resolution_summary: "API access supplied" });
                expect((await env.DB.prepare("SELECT * FROM channel_notification_outbox WHERE case_id = ?").bind(caseId).all()).results).toHaveLength(1);
        });

        it("deduplicates repeated Jira delivery", async () => {
                await processJiraWebhook(env.DB, payload(), request());
                expect(await processJiraWebhook(env.DB, payload(), request())).toEqual({ status: "duplicate" });
        });

        it("returns Jira reopen changes to active coordination", async () => {
                await processJiraWebhook(env.DB, payload(), request());
                expect(await processJiraWebhook(env.DB, payload(false), request("evt-2"))).toEqual({ status: "processed", caseId, action: "in_progress" });
        });

        it("lets only the requester verify the proposed resolution", async () => {
                await processJiraWebhook(env.DB, payload(), request());
                const result = await processResolutionReply(env.DB, {
                        channel: "whatsapp", externalMessageId: "reply-1", senderExternalId: "919100000010",
                        receivedAt: new Date().toISOString(), text: `VERIFY ${caseId}`,
                        identity: { tenantId: 1, projectId: 1, teamMemberId: requesterId, memberName: "Supreeth" },
                });
                expect(result.processingStatus).toBe("resolution_verified");
                expect((await env.DB.prepare("SELECT resolution_state, verified_by_type FROM coordination_cases WHERE id = ?").bind(caseId).first())).toEqual({ resolution_state: "resolved", verified_by_type: "requester" });
        });

        it("reopens and escalates when requester rejects the resolution", async () => {
                await processJiraWebhook(env.DB, payload(), request());
                const result = await processResolutionReply(env.DB, {
                        channel: "whatsapp", externalMessageId: "reply-2", senderExternalId: "919100000010",
                        receivedAt: new Date().toISOString(), text: `REOPEN ${caseId} access still fails`,
                        identity: { tenantId: 1, projectId: 1, teamMemberId: requesterId, memberName: "Supreeth" },
                });
                expect(result.processingStatus).toBe("resolution_reopened");
                expect((await env.DB.prepare("SELECT resolution_state, priority FROM coordination_cases WHERE id = ?").bind(caseId).first())).toEqual({ resolution_state: "escalated", priority: "critical" });
        });

        it("delivers queued WhatsApp notices and records delivery", async () => {
                await processJiraWebhook(env.DB, payload(), request());
                const fetcher = vi.fn().mockResolvedValue(Response.json({ messages: [{ id: "wamid.sent" }] }));
                const workerEnv = { ...env, WHATSAPP_ACCESS_TOKEN: "token", WHATSAPP_PHONE_NUMBER_ID: "123", WHATSAPP_API_VERSION: "v26.0" } as WorkerEnv;
                expect(await deliverPendingWhatsappNotifications(workerEnv, fetcher)).toBe(1);
                expect((await env.DB.prepare("SELECT delivery_status, attempt_count FROM channel_notification_outbox WHERE case_id = ?").bind(caseId).first())).toEqual({ delivery_status: "sent", attempt_count: 1 });
        });
});
