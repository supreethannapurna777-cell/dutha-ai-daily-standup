import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
        hashEnrolmentCode,
        processWhatsappEnrolment,
        resolveWhatsappIdentity,
} from "../src/enrolment";
import { channelManagementResponse } from "../src/channel-management";
import type { WorkerEnv } from "../src/env";

const managementEnv = {
        ...env,
        DASHBOARD_USERNAME: "admin",
        DASHBOARD_PASSWORD: "test-password",
        WHATSAPP_ACCESS_TOKEN: "configured",
        WHATSAPP_PHONE_NUMBER_ID: "configured",
} as WorkerEnv;

function managementRequest(method = "GET", body?: URLSearchParams): Request {
        return new Request("https://example.com/dashboard/channels?project=1", {
                method,
                headers: {
                        Authorization: `Basic ${btoa("admin:test-password")}`,
                        ...(method === "POST" ? {
                                Origin: "https://example.com",
                                "Content-Type": "application/x-www-form-urlencoded",
                        } : {}),
                },
                body,
        });
}

describe("secure channel enrolment", () => {
        let memberId: number;

        beforeEach(async () => {
                await env.DB.prepare("DELETE FROM channel_identity_events").run();
                await env.DB.prepare("DELETE FROM enrolment_invites").run();
                await env.DB.prepare("DELETE FROM channel_identities").run();
                await env.DB.prepare("DELETE FROM team_members").run();
                const member = await env.DB.prepare(`
                        INSERT INTO team_members (
                                name, phone, department, tenant_id,
                                primary_project_id, email, enrolment_status,
                                scheduling_enabled
                        ) VALUES (?, ?, ?, 1, 1, ?, 'invited', 0)
                        RETURNING id
                `).bind(
                        "Sreeja",
                        `pending-${crypto.randomUUID()}`,
                        "AI & ML",
                        "sreeja@example.com",
                ).first<{ id: number }>();
                memberId = member!.id;
                await env.DB.prepare(`
                        INSERT INTO team_member_projects (project_id, team_member_id)
                        VALUES (1, ?)
                `).bind(memberId).run();
        });

        it("connects a project member using an expiring invitation", async () => {
                const hash = await hashEnrolmentCode("ABCDEFGH23");
                await env.DB.prepare(`
                        INSERT INTO enrolment_invites (
                                tenant_id, project_id, created_by_management_user_id,
                                code_hash, expires_at, max_uses
                        ) VALUES (1, 1, 1, ?, ?, 5)
                `).bind(hash, "2026-09-20T00:00:00.000Z").run();

                const result = await processWhatsappEnrolment(
                        env.DB,
                        "919900000001",
                        "Sreeja",
                        "wamid.join.1",
                        "JOIN ABCDEFGH23 sreeja@example.com",
                        new Date("2026-09-17T00:00:00.000Z"),
                );

                expect(result.success).toBe(true);
                expect(result.message).toContain("Welcome Sreeja");
                expect(await resolveWhatsappIdentity(env.DB, "919900000001"))
                        .toMatchObject({ tenantId: 1, projectId: 1, teamMemberId: memberId });
                const member = await env.DB.prepare(`
                        SELECT phone, enrolment_status, scheduling_enabled
                        FROM team_members WHERE id = ?
                `).bind(memberId).first();
                expect(member).toEqual({
                        phone: "919900000001",
                        enrolment_status: "enrolled",
                        scheduling_enabled: 0,
                });
        });

        it("rejects an email that is not assigned to the invited project", async () => {
                const hash = await hashEnrolmentCode("ABCDEFGH23");
                await env.DB.prepare(`
                        INSERT INTO enrolment_invites (
                                tenant_id, project_id, created_by_management_user_id,
                                code_hash, expires_at
                        ) VALUES (1, 1, 1, ?, ?)
                `).bind(hash, "2026-09-20T00:00:00.000Z").run();
                const result = await processWhatsappEnrolment(
                        env.DB,
                        "919900000002",
                        "Unknown",
                        "wamid.join.2",
                        "JOIN ABCDEFGH23 outsider@example.com",
                        new Date("2026-09-17T00:00:00.000Z"),
                );
                expect(result.success).toBe(false);
                expect(result.message).toContain("not assigned");
        });

        it("shows a simple setup page without exposing phone numbers", async () => {
                const response = await channelManagementResponse(
                        managementRequest(),
                        managementEnv,
                );
                const html = await response.text();
                expect(response.status).toBe(200);
                expect(html).toContain("Channels and enrolment");
                expect(html).toContain("WhatsApp");
                expect(html).toContain("Microsoft Teams");
                expect(html).toContain("Jira / Atlassian");
                expect(html).not.toContain("pending-");
        });

        it("creates an invitation and shows its code only in the response", async () => {
                const response = await channelManagementResponse(
                        managementRequest("POST", new URLSearchParams({
                                action: "create_invite",
                                project_id: "1",
                                expiry_days: "3",
                                max_uses: "10",
                        })),
                        managementEnv,
                        new Date("2026-09-17T00:00:00.000Z"),
                );
                const html = await response.text();
                expect(response.status).toBe(200);
                expect(html).toMatch(/JOIN [A-Z2-9]{10} work-email@company\.com/);
                expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM enrolment_invites").first())
                        .toEqual({ count: 1 });
        });
});
