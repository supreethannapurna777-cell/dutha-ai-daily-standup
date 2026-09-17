import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "../src/env";
import { hashEnrolmentCode } from "../src/enrolment";
import { deliverPendingTeamsNotifications, teamsWebhookResponse } from "../src/teams";

const teamsEnv = {
        ...env,
        MICROSOFT_APP_ID: "bot-app-id",
        MICROSOFT_APP_PASSWORD: "bot-secret",
        MICROSOFT_TENANT_ID: "tenant-id",
} as WorkerEnv;

function activity(text: string, id = "activity-1") {
        return {
                type: "message", id, timestamp: "2026-09-17T08:00:00.000Z",
                serviceUrl: "https://smba.trafficmanager.net/teams",
                channelId: "msteams", text,
                from: { id: "teams-user-1", name: "Sreeja", aadObjectId: "aad-user-1" },
                recipient: { id: "bot-app-id", name: "Dutha" },
                conversation: { id: "conversation-1", tenantId: "tenant-id" },
                channelData: { tenant: { id: "tenant-id" } },
        };
}

function inbound(text: string, id?: string): Request {
        return new Request("https://dutha.example/webhooks/teams", {
                method: "POST",
                headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
                body: JSON.stringify(activity(text, id)),
        });
}

function connectorFetcher() {
        return vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "connector-token" });
                return Response.json({ id: "sent-activity" }, { status: 201 });
        });
}

describe("Microsoft Teams adapter", () => {
        let memberId: number;

        beforeEach(async () => {
                await env.DB.batch([
                        env.DB.prepare("DELETE FROM channel_notification_outbox"),
                        env.DB.prepare("DELETE FROM teams_conversation_references"),
                        env.DB.prepare("DELETE FROM channel_identity_events"),
                        env.DB.prepare("DELETE FROM enrolment_invites"),
                        env.DB.prepare("DELETE FROM channel_identities"),
                        env.DB.prepare("DELETE FROM case_events"),
                        env.DB.prepare("DELETE FROM coordination_cases"),
                        env.DB.prepare("DELETE FROM processed_updates"),
                        env.DB.prepare("DELETE FROM incoming_messages"),
                        env.DB.prepare("DELETE FROM team_member_projects"),
                        env.DB.prepare("DELETE FROM team_members"),
                ]);
                const member = await env.DB.prepare(`
                        INSERT INTO team_members (name, phone, department, tenant_id,
                                primary_project_id, email, enrolment_status)
                        VALUES ('Sreeja', ?, 'AI', 1, 1, 'sreeja@example.com', 'invited') RETURNING id
                `).bind(`pending-${crypto.randomUUID()}`).first<{ id: number }>();
                memberId = member!.id;
                await env.DB.prepare("INSERT INTO team_member_projects (project_id, team_member_id) VALUES (1, ?)").bind(memberId).run();
        });

        it("rejects an activity when the Bot Framework token is invalid", async () => {
                const response = await teamsWebhookResponse(inbound("hello"), teamsEnv, connectorFetcher(), async () => false);
                expect(response.status).toBe(401);
        });

        it("self-enrols a project member and stores a proactive conversation reference", async () => {
                const codeHash = await hashEnrolmentCode("ABCDEFGH23");
                await env.DB.prepare(`INSERT INTO enrolment_invites (tenant_id, project_id, created_by_management_user_id, code_hash, expires_at) VALUES (1, 1, 1, ?, '2026-09-20T00:00:00.000Z')`).bind(codeHash).run();
                const fetcher = connectorFetcher();
                const response = await teamsWebhookResponse(
                        inbound("JOIN ABCDEFGH23 sreeja@example.com"), teamsEnv, fetcher, async () => true,
                );
                expect(response.status).toBe(202);
                expect(await env.DB.prepare("SELECT channel, external_id FROM channel_identities WHERE team_member_id = ?").bind(memberId).first()).toEqual({ channel: "teams", external_id: "teams-user-1" });
                expect(await env.DB.prepare("SELECT conversation_id, service_url FROM teams_conversation_references WHERE team_member_id = ?").bind(memberId).first()).toEqual({ conversation_id: "conversation-1", service_url: "https://smba.trafficmanager.net/teams" });
        });

        it("routes a Teams update through the shared Dutha workflow", async () => {
                await env.DB.prepare(`INSERT INTO channel_identities (tenant_id, team_member_id, channel, external_id) VALUES (1, ?, 'teams', 'teams-user-1')`).bind(memberId).run();
                const response = await teamsWebhookResponse(inbound("Today I am testing. I am blocked by API access."), teamsEnv, connectorFetcher(), async () => true);
                expect(response.status).toBe(202);
                expect(await response.json()).toEqual({ status: "processed" });
                expect(await env.DB.prepare("SELECT channel, team_member_id FROM incoming_messages WHERE external_message_id = 'activity-1'").first()).toEqual({ channel: "teams", team_member_id: memberId });
        });

        it("delivers queued Teams notifications with app-only Bot Connector auth", async () => {
                await env.DB.prepare(`INSERT INTO teams_conversation_references (tenant_id, team_member_id, service_url, conversation_id, bot_id, user_id) VALUES (1, ?, 'https://smba.trafficmanager.net/teams', 'conversation-1', 'bot-app-id', 'teams-user-1')`).bind(memberId).run();
                const incoming = await env.DB.prepare(`INSERT INTO incoming_messages (whatsapp_message_id, received_at, sender_name, sender_phone, original_reply, processing_status, tenant_id, project_id, channel, external_message_id, sender_external_id, team_member_id) VALUES ('teams-source', '2026-09-17T08:00:00Z', 'Sreeja', 'teams-user-1', 'blocked', 'processed', 1, 1, 'teams', 'teams-source', 'teams-user-1', ?) RETURNING id`).bind(memberId).first<{ id: number }>();
                const processed = await env.DB.prepare(`INSERT INTO processed_updates (message_id, sender_name, blockers, original_reply, processing_status, tenant_id, project_id) VALUES (?, 'Sreeja', 'blocked', 'blocked', 'processed', 1, 1) RETURNING id`).bind(incoming!.id).first<{ id: number }>();
                const coordination = await env.DB.prepare(`INSERT INTO coordination_cases (source_update_id, requester_member_id, case_type, issue_summary, status, priority, tenant_id, project_id, resolution_state) VALUES (?, ?, 'blocker', 'blocked', 'approved', 'high', 1, 1, 'triaged') RETURNING id`).bind(processed!.id, memberId).first<{ id: number }>();
                await env.DB.prepare(`INSERT INTO channel_notification_outbox (tenant_id, project_id, case_id, team_member_id, channel, notification_type, deduplication_key, message) VALUES (1, 1, ?, ?, 'teams', 'resolution', 'teams-resolution-test', 'Please verify')`).bind(coordination!.id, memberId).run();
                const fetcher = connectorFetcher();
                expect(await deliverPendingTeamsNotifications(teamsEnv, fetcher)).toBe(1);
                expect(fetcher).toHaveBeenCalledTimes(2);
                expect(await env.DB.prepare("SELECT delivery_status, attempt_count FROM channel_notification_outbox WHERE deduplication_key = 'teams-resolution-test'").first()).toEqual({ delivery_status: "sent", attempt_count: 1 });
        });
});
