import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
        hashEnrolmentCode,
        processWhatsappEnrolment,
        resolveChannelIdentity,
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

function managementRequest(method = "GET", body?: URLSearchParams | FormData): Request {
        return new Request("https://example.com/dashboard/channels?project=1", {
                method,
                headers: {
                        Authorization: `Basic ${btoa("admin:test-password")}`,
                        ...(method === "POST" ? {
                                Origin: "https://example.com",
                        } : {}),
                        ...(body instanceof URLSearchParams ? {
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

        it("resolves a Teams identity through the shared identity model", async () => {
                await env.DB.prepare(`
                        INSERT INTO channel_identities (
                                tenant_id, team_member_id, channel,
                                external_id, display_name
                        ) VALUES (1, ?, 'teams', 'teams-user-1', 'Sreeja')
                `).bind(memberId).run();
                expect(await resolveChannelIdentity(
                        env.DB,
                        "teams",
                        "teams-user-1",
                )).toEqual({
                        tenantId: 1,
                        projectId: 1,
                        teamMemberId: memberId,
                        memberName: "Sreeja",
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

		it("connects a directly invited WhatsApp number after YES", async () => {
				await env.DB.prepare(`
						UPDATE team_members
						SET phone = '919900000009', enrolment_status = 'invited'
						WHERE id = ?
				`).bind(memberId).run();
				await env.DB.prepare(`
						INSERT INTO direct_whatsapp_invites (
							team_member_id, tenant_id, project_id, expires_at
						) VALUES (?, 1, 1, '2099-01-01T00:00:00.000Z')
				`).bind(memberId).run();

				const result = await processWhatsappEnrolment(
						env.DB,
						"919900000009",
						"Sreeja",
						"wamid.direct.1",
						"YES",
				);

				expect(result).toMatchObject({ handled: true, success: true, duplicate: false });
				expect(result.message).toContain("Welcome Sreeja");
				expect(await resolveWhatsappIdentity(env.DB, "919900000009"))
						.toMatchObject({ teamMemberId: memberId });
				expect(await env.DB.prepare(`
						SELECT enrolment_status, scheduling_enabled FROM team_members WHERE id = ?
				`).bind(memberId).first()).toEqual({ enrolment_status: "enrolled", scheduling_enabled: 1 });
		});

		it("does not connect a stored number before an invitation is sent", async () => {
				await env.DB.prepare(`
						UPDATE team_members SET phone = '919900000008', enrolment_status = 'invited'
						WHERE id = ?
				`).bind(memberId).run();
				const result = await processWhatsappEnrolment(
						env.DB,
						"919900000008",
						"Sreeja",
						"wamid.direct.2",
						"YES",
				);
				expect(result.handled).toBe(false);
				expect(await resolveWhatsappIdentity(env.DB, "919900000008")).toBeNull();
		});

        it("resets a WhatsApp connection so the same number can enrol again", async () => {
                await env.DB.prepare(`
                        INSERT INTO channel_identities (
                                tenant_id, team_member_id, channel, external_id, display_name
                        ) VALUES (1, ?, 'whatsapp', '919900000001', 'Sreeja')
                `).bind(memberId).run();
                await env.DB.prepare(`
                        UPDATE team_members
                        SET phone = '919900000001', enrolment_status = 'enrolled', scheduling_enabled = 1
                        WHERE id = ?
                `).bind(memberId).run();

                const response = await channelManagementResponse(
                        managementRequest("POST", new URLSearchParams({
                                action: "reset_whatsapp",
                                project_id: "1",
                                member_id: String(memberId),
                        })),
                        managementEnv,
                );
                expect(response.status).toBe(200);
                expect(await response.text()).toContain("same phone number can now enrol again");
                expect(await env.DB.prepare(`
                        SELECT COUNT(*) AS count FROM channel_identities
                        WHERE team_member_id = ? AND channel = 'whatsapp'
                `).bind(memberId).first()).toEqual({ count: 0 });
                const member = await env.DB.prepare(`
                        SELECT phone, enrolment_status, scheduling_enabled
                        FROM team_members WHERE id = ?
                `).bind(memberId).first<{ phone: string; enrolment_status: string; scheduling_enabled: number }>();
                expect(member?.phone).toMatch(/^pending-/);
                expect(member).toMatchObject({ enrolment_status: "invited", scheduling_enabled: 0 });
        });

        it("soft-removes an employee only after their name is confirmed", async () => {
                const rejected = await channelManagementResponse(
                        managementRequest("POST", new URLSearchParams({
                                action: "remove_member",
                                project_id: "1",
                                member_id: String(memberId),
                                confirm_name: "wrong name",
                        })),
                        managementEnv,
                );
                expect(rejected.status).toBe(400);
                expect(await env.DB.prepare("SELECT active FROM team_members WHERE id = ?").bind(memberId).first())
                        .toEqual({ active: 1 });

                const response = await channelManagementResponse(
                        managementRequest("POST", new URLSearchParams({
                                action: "remove_member",
                                project_id: "1",
                                member_id: String(memberId),
                                confirm_name: "Sreeja",
                        })),
                        managementEnv,
                );
                expect(response.status).toBe(200);
                expect(await response.text()).toContain("Sreeja was removed");
                const member = await env.DB.prepare(`
                        SELECT active, email, enrolment_status, scheduling_enabled
                        FROM team_members WHERE id = ?
                `).bind(memberId).first();
                expect(member).toEqual({
                        active: 0,
                        email: null,
                        enrolment_status: "suspended",
                        scheduling_enabled: 0,
                });
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

        it("imports validated employees from CSV without phone numbers", async () => {
                const form = new FormData();
                form.set("action", "import_members");
                form.set("project_id", "1");
                form.set("members_csv", new File([
                        "name,email,department,timezone\n"
                        + "Anita,anita@example.com,Finance,Asia/Kolkata\n"
                        + '"John, Peter",john@example.com,Operations,Europe/London\n',
                ], "members.csv", { type: "text/csv" }));

                const response = await channelManagementResponse(
                        managementRequest("POST", form),
                        managementEnv,
                );
                const html = await response.text();
                expect(response.status).toBe(200);
                expect(html).toContain("2 employees imported");
                const imported = (await env.DB.prepare(`
                        SELECT name, email, department, timezone, enrolment_status,
                                scheduling_enabled
                        FROM team_members WHERE email IN (?, ?) ORDER BY email
                `).bind("anita@example.com", "john@example.com").all()).results;
                expect(imported).toEqual([
                        {
                                name: "Anita",
                                email: "anita@example.com",
                                department: "Finance",
                                timezone: "Asia/Kolkata",
                                enrolment_status: "invited",
                                scheduling_enabled: 0,
                        },
                        {
                                name: "John, Peter",
                                email: "john@example.com",
                                department: "Operations",
                                timezone: "Europe/London",
                                enrolment_status: "invited",
                                scheduling_enabled: 0,
                        },
                ]);
        });

        it("rejects the whole CSV before import when an email is duplicated", async () => {
                const form = new FormData();
                form.set("action", "import_members");
                form.set("project_id", "1");
                form.set("members_csv", new File([
                        "name,email,department,timezone\n"
                        + "Anita,anita@example.com,Finance,Asia/Kolkata\n"
                        + "Again,anita@example.com,Finance,Asia/Kolkata\n",
                ], "members.csv", { type: "text/csv" }));
                const response = await channelManagementResponse(
                        managementRequest("POST", form),
                        managementEnv,
                );
                expect(response.status).toBe(400);
                expect(await response.text()).toContain("repeats anita@example.com");
                expect(await env.DB.prepare(`
                        SELECT COUNT(*) AS count FROM team_members
                        WHERE email = 'anita@example.com'
                `).first()).toEqual({ count: 0 });
        });

        it("does not import employees into another tenant's project", async () => {
                const tenant = await env.DB.prepare(`
                        INSERT INTO tenants (slug, name) VALUES (?, ?) RETURNING id
                `).bind(`other-${crypto.randomUUID()}`, "Other company").first<{ id: number }>();
                const project = await env.DB.prepare(`
                        INSERT INTO projects (tenant_id, project_key, name)
                        VALUES (?, ?, ?) RETURNING id
                `).bind(tenant!.id, "PRIVATE", "Private project").first<{ id: number }>();
                const form = new FormData();
                form.set("action", "import_members");
                form.set("project_id", String(project!.id));
                form.set("members_csv", new File([
                        "name,email,department,timezone\n"
                        + "Outsider,outsider@example.com,Finance,Asia/Kolkata\n",
                ], "members.csv", { type: "text/csv" }));
                const response = await channelManagementResponse(
                        managementRequest("POST", form),
                        managementEnv,
                );
                expect(response.status).toBe(403);
                expect(await response.text()).toBe("Project access denied.");
                expect(await env.DB.prepare(`
                        SELECT COUNT(*) AS count FROM team_members
                        WHERE email = 'outsider@example.com'
                `).first()).toEqual({ count: 0 });
        });

        it("replaces an active invitation and closes its old code", async () => {
                const hash = await hashEnrolmentCode("ABCDEFGH23");
                const invite = await env.DB.prepare(`
                        INSERT INTO enrolment_invites (
                                tenant_id, project_id, created_by_management_user_id,
                                code_hash, expires_at, max_uses
                        ) VALUES (1, 1, 1, ?, ?, 12) RETURNING id
                `).bind(hash, "2026-09-20T00:00:00.000Z").first<{ id: number }>();
                const response = await channelManagementResponse(
                        managementRequest("POST", new URLSearchParams({
                                action: "replace_invite",
                                project_id: "1",
                                invite_id: String(invite!.id),
                        })),
                        managementEnv,
                        new Date("2026-09-17T00:00:00.000Z"),
                );
                const html = await response.text();
                expect(response.status).toBe(200);
                expect(html).toContain("Invitation replaced");
                expect(html).toMatch(/JOIN [A-Z2-9]{10} work-email@company\.com/);
                expect(await env.DB.prepare(`
                        SELECT COUNT(*) AS count FROM enrolment_invites
                        WHERE project_id = 1 AND revoked_at IS NULL AND max_uses = 12
                `).first()).toEqual({ count: 1 });
                expect(await env.DB.prepare(`
                        SELECT revoked_at FROM enrolment_invites WHERE id = ?
                `).bind(invite!.id).first<{ revoked_at: string | null }>()).toEqual({
                        revoked_at: "2026-09-17T00:00:00.000Z",
                });
        });
});
