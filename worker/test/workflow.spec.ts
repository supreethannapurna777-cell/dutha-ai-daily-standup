import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { processInboundTextMessage } from "../src/workflow";

describe("channel-independent text workflow", () => {
        let requesterId: number;
        let responsibleId: number;

        beforeEach(async () => {
                await env.DB.batch([
                        env.DB.prepare("DELETE FROM case_events"),
                        env.DB.prepare("DELETE FROM coordination_cases"),
                        env.DB.prepare("DELETE FROM processed_updates"),
                        env.DB.prepare("DELETE FROM incoming_messages"),
                        env.DB.prepare("DELETE FROM team_members"),
                ]);
                const requester = await env.DB.prepare(`
                        INSERT INTO team_members (
                                name, phone, department, tenant_id, primary_project_id
                        ) VALUES (?, ?, ?, 1, 1) RETURNING id
                `).bind("Teams User", "pending-teams-user", "Operations")
                        .first<{ id: number }>();
                const responsible = await env.DB.prepare(`
                        INSERT INTO team_members (
                                name, phone, department, tenant_id, primary_project_id
                        ) VALUES (?, ?, ?, 1, 1) RETURNING id
                `).bind("Imran", "919200000000", "Platform")
                        .first<{ id: number }>();
                requesterId = requester!.id;
                responsibleId = responsible!.id;
        });

        it("processes a Teams blocker through the same case pipeline", async () => {
                const result = await processInboundTextMessage(env.DB, {
                        channel: "teams",
                        externalMessageId: "message-101",
                        senderExternalId: "teams-user-101",
                        receivedAt: "2026-09-17T05:00:00.000Z",
                        text: [
                                "1. Validate the release",
                                "2. Blocked by production access",
                                "3. Imran",
                                "4. Today",
                        ].join("\n"),
                        identity: {
                                tenantId: 1,
                                projectId: 1,
                                teamMemberId: requesterId,
                                memberName: "Teams User",
                        },
                });
                expect(result.status).toBe("processed");
                const incoming = await env.DB.prepare(`
                        SELECT channel, external_message_id, sender_external_id,
                                team_member_id, whatsapp_message_id
                        FROM incoming_messages LIMIT 1
                `).first();
                expect(incoming).toEqual({
                        channel: "teams",
                        external_message_id: "message-101",
                        sender_external_id: "teams-user-101",
                        team_member_id: requesterId,
                        whatsapp_message_id: "teams:message-101",
                });
                const coordinationCase = await env.DB.prepare(`
                        SELECT requester_member_id, responsible_member_id,
                                issue_summary, tenant_id, project_id
                        FROM coordination_cases LIMIT 1
                `).first();
                expect(coordinationCase).toEqual({
                        requester_member_id: requesterId,
                        responsible_member_id: responsibleId,
                        issue_summary: "Blocked by production access",
                        tenant_id: 1,
                        project_id: 1,
                });
        });

        it("deduplicates within a channel but not across channels", async () => {
                const base = {
                        externalMessageId: "shared-message-id",
                        senderExternalId: "shared-user",
                        receivedAt: "2026-09-17T05:00:00.000Z",
                        text: "No blockers today.",
                        identity: {
                                tenantId: 1,
                                projectId: 1,
                                teamMemberId: requesterId,
                                memberName: "Teams User",
                        },
                } as const;
                expect((await processInboundTextMessage(env.DB, {
                        ...base,
                        channel: "teams",
                })).status).toBe("processed");
                expect((await processInboundTextMessage(env.DB, {
                        ...base,
                        channel: "teams",
                })).status).toBe("duplicate");
                expect((await processInboundTextMessage(env.DB, {
                        ...base,
                        channel: "whatsapp",
                })).status).toBe("processed");
                expect(await env.DB.prepare(`
                        SELECT COUNT(*) AS count FROM incoming_messages
                `).first()).toEqual({ count: 2 });
        });

        it("supports channel-specific interception without duplicating storage", async () => {
                const result = await processInboundTextMessage(env.DB, {
                        channel: "teams",
                        externalMessageId: "command-1",
                        senderExternalId: "teams-user-101",
                        receivedAt: "2026-09-17T05:00:00.000Z",
                        text: "A channel command",
                        identity: {
                                tenantId: 1,
                                projectId: 1,
                                teamMemberId: requesterId,
                                memberName: "Teams User",
                        },
                }, async () => ({
                        handled: true,
                        processingStatus: "command_processed",
                }));
                expect(result.status).toBe("intercepted");
                expect(await env.DB.prepare(`
                        SELECT processing_status FROM incoming_messages
                        WHERE external_message_id = 'command-1'
                `).first()).toEqual({ processing_status: "command_processed" });
                expect(await env.DB.prepare(`
                        SELECT COUNT(*) AS count FROM processed_updates
                `).first()).toEqual({ count: 0 });
        });

        it("rejects an identity outside its tenant and project", async () => {
                const result = await processInboundTextMessage(env.DB, {
                        channel: "teams",
                        externalMessageId: "forged-message",
                        senderExternalId: "forged-user",
                        receivedAt: "2026-09-17T05:00:00.000Z",
                        text: "Blocked by access",
                        identity: {
                                tenantId: 999,
                                projectId: 1,
                                teamMemberId: requesterId,
                                memberName: "Teams User",
                        },
                });
                expect(result.status).toBe("rejected");
                expect(await env.DB.prepare(`
                        SELECT COUNT(*) AS count FROM incoming_messages
                `).first()).toEqual({ count: 0 });
        });
});
