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
		await env.DB.prepare(`
			DELETE FROM team_member_projects
			WHERE project_id > 1 OR team_member_id IN (
				SELECT id FROM team_members WHERE name LIKE 'Project Test %' OR tenant_id > 1
			)
		`).run();
		await env.DB.prepare("DELETE FROM team_members WHERE name LIKE 'Project Test %' OR tenant_id > 1").run();
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

	it("creates a management user and displays a single-use activation link", async () => {
		const response = await projectManagementResponse(
			request("POST", new URLSearchParams({ action: "create_manager", display_name: "Pilot Manager", email: "pilot.manager@example.com", tenant_role: "project_manager" }).toString()),
			testEnv,
		);
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain("Secure activation link");
		expect(html).toContain("Email was not sent");
		expect(html).toContain("https://example.com/manager/activate?token=");
		const manager = await env.DB.prepare(`SELECT id FROM management_users WHERE email='pilot.manager@example.com'`).first<{ id:number }>();
		const invite = manager ? await env.DB.prepare(`SELECT expires_at FROM management_activation_tokens WHERE management_user_id=? AND revoked_at IS NULL`).bind(manager.id).first() : null;
		expect(invite).toBeTruthy();
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

	it("renders department teams and bulk-assignment confirmations", async () => {
		await env.DB.prepare(`
			INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id)
			VALUES ('Project Test Developer', 'project-test-render', 'DevOps', 1, 1)
		`).run();

		const response = await projectManagementResponse(request(), testEnv);
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain("Teams");
		expect(html).toContain("DevOps");
		expect(html).toContain("Assign team");
		expect(html).toContain("Assign all members");
		expect(html).toContain("Assign entire team?");
		expect(html).toContain("Assign all members?");
	});

	it("assigns only the selected department from the authenticated tenant", async () => {
		const tenant = await env.DB.prepare(`
			INSERT INTO tenants (slug, name) VALUES ('project-test-other', 'Project Test Other')
			RETURNING id
		`).first<{ id: number }>();
		if (!tenant) throw new Error("Tenant not created.");
		await env.DB.batch([
			env.DB.prepare(`INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id) VALUES (?, ?, ?, ?, ?)`)
				.bind("Project Test Dev One", "project-test-dev-one", "DevOps", 1, 1),
			env.DB.prepare(`INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id) VALUES (?, ?, ?, ?, ?)`)
				.bind("Project Test Dev Two", "project-test-dev-two", "DevOps", 1, 1),
			env.DB.prepare(`INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id) VALUES (?, ?, ?, ?, ?)`)
				.bind("Project Test SAP", "project-test-sap", "SAP", 1, 1),
			env.DB.prepare(`INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id) VALUES (?, ?, ?, ?, ?)`)
				.bind("Project Test Other Dev", "project-test-other-dev", "DevOps", tenant.id, 1),
		]);

		const response = await projectManagementResponse(
			request("POST", new URLSearchParams({ action: "add_team", project_id: "1", department: "DevOps" }).toString()),
			testEnv,
		);
		expect(response.status).toBe(303);
		const assignedRows = await env.DB.prepare(`
			SELECT member.name
			FROM team_member_projects AS assignment
			JOIN team_members AS member ON member.id = assignment.team_member_id
			WHERE assignment.project_id = 1 AND member.name LIKE 'Project Test %'
			ORDER BY member.name
		`).all<{ name: string }>();
		expect(assignedRows.results.map((row) => row.name)).toEqual([
			"Project Test Dev One",
			"Project Test Dev Two",
		]);
	});

	it("assigns every active member from the authenticated tenant only", async () => {
		const tenant = await env.DB.prepare(`
			INSERT INTO tenants (slug, name) VALUES ('project-test-bulk-other', 'Project Test Bulk Other')
			RETURNING id
		`).first<{ id: number }>();
		if (!tenant) throw new Error("Tenant not created.");
		await env.DB.batch([
			env.DB.prepare(`INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id) VALUES (?, ?, ?, ?, ?)`)
				.bind("Project Test Bulk One", "project-test-bulk-one", "DevOps", 1, 1),
			env.DB.prepare(`INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id) VALUES (?, ?, ?, ?, ?)`)
				.bind("Project Test Bulk Two", "project-test-bulk-two", "SAP", 1, 1),
			env.DB.prepare(`INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id) VALUES (?, ?, ?, ?, ?)`)
				.bind("Project Test Bulk Other", "project-test-bulk-other", "SAP", tenant.id, 1),
		]);

		const response = await projectManagementResponse(
			request("POST", "action=add_all_members&project_id=1"),
			testEnv,
		);
		expect(response.status).toBe(303);
		const assignedRows = await env.DB.prepare(`
			SELECT member.name
			FROM team_member_projects AS assignment
			JOIN team_members AS member ON member.id = assignment.team_member_id
			WHERE assignment.project_id = 1 AND member.name LIKE 'Project Test Bulk %'
			ORDER BY member.name
		`).all<{ name: string }>();
		expect(assignedRows.results.map((row) => row.name)).toEqual([
			"Project Test Bulk One",
			"Project Test Bulk Two",
		]);
	});

	it("rejects an unknown team", async () => {
		const response = await projectManagementResponse(
			request("POST", "action=add_team&project_id=1&department=Missing-Team"),
			testEnv,
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Team was not found.");
	});
});
