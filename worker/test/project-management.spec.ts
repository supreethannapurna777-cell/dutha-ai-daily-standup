import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { WorkerEnv } from "../src/env";
import { projectManagementResponse } from "../src/project-management";

const testEnv: WorkerEnv = {
        ...env,
        DASHBOARD_USERNAME: "admin",
        DASHBOARD_PASSWORD: "test-password",
};

function request(
        method = "GET",
        body?: string,
        identity: Record<string, string> = {},
): Request {
        return new Request("https://example.com/dashboard/projects", {
                method,
                headers: {
                        Authorization: `Basic ${btoa("admin:test-password")}`,
                        ...(method === "POST" ? {
                                "Content-Type": "application/x-www-form-urlencoded",
                                Origin: "https://example.com",
                        } : {}),
                        ...identity,
                },
                body,
        });
}

describe("project and access management", () => {
        beforeEach(async () => {
                await env.DB.prepare("DELETE FROM project_memberships WHERE project_id > 1 OR management_user_id > 1").run();
                await env.DB.prepare("DELETE FROM management_users WHERE id > 1").run();
                await env.DB.prepare("DELETE FROM projects WHERE id > 1").run();
                await env.DB.prepare("DELETE FROM tenants WHERE id > 1").run();
        });

        it("renders the Aurowise project without exposing phone numbers", async () => {
                const response = await projectManagementResponse(request(), testEnv);
                const html = await response.text();
                expect(response.status).toBe(200);
                expect(html).toContain("Dutha WorkOps Pilot");
                expect(html).toContain("Projects and access");
                expect(html).not.toContain("masked_phone");
        });

        it("creates a project inside the authenticated tenant", async () => {
                const response = await projectManagementResponse(
                        request("POST", "action=create_project&project_key=client-ops&name=Client+Operations"),
                        testEnv,
                );
                expect(response.status).toBe(303);
                const project = await env.DB.prepare(`
                        SELECT tenant_id, project_key, name FROM projects
                        WHERE project_key = 'CLIENT-OPS'
                `).first<{ tenant_id: number; project_key: string; name: string }>();
                expect(project).toEqual({
                        tenant_id: 1,
                        project_key: "CLIENT-OPS",
                        name: "Client Operations",
                });
        });

        it("rejects a project manager from the administrator page", async () => {
                const response = await projectManagementResponse(
                        request("GET", undefined, {
                                "X-Dutha-User-Id": "10",
                                "X-Dutha-Tenant-Id": "1",
                                "X-Dutha-Tenant-Role": "project_manager",
                        }),
                        testEnv,
                );
                expect(response.status).toBe(403);
        });

        it("cannot assign a member from another tenant", async () => {
                const tenant = await env.DB.prepare(`
                        INSERT INTO tenants (slug, name) VALUES ('other-company', 'Other Company')
                        RETURNING id
                `).first<{ id: number }>();
                if (!tenant) throw new Error("Tenant not created.");
                const member = await env.DB.prepare(`
                        INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id)
                        VALUES ('Other Member', '919999999999', 'Other', ?, 1) RETURNING id
                `).bind(tenant.id).first<{ id: number }>();
                if (!member) throw new Error("Member not created.");

                const response = await projectManagementResponse(
                        request("POST", `action=add_member&project_id=1&team_member_id=${member.id}`),
                        testEnv,
                );
                expect(response.status).toBe(400);
                expect(await response.text()).toContain("Team member was not found.");
                const assignment = await env.DB.prepare(`
                        SELECT 1 AS found FROM team_member_projects
                        WHERE project_id = 1 AND team_member_id = ?
                `).bind(member.id).first<{ found: number }>();
                expect(assignment).toBeNull();
        });
});
