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

	it('allows the CEO to manage company access controls', async () => {
		const response = await projectManagementResponse(request('GET', undefined, {
			'X-Dutha-User-Id':'1', 'X-Dutha-Tenant-Id':'1', 'X-Dutha-Tenant-Role':'ceo',
		}), testEnv);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Projects and access');
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

	it("archives a project only after exact key confirmation and can restore it", async () => {
		const create = await env.DB.prepare(`INSERT INTO projects (tenant_id, project_key, name) VALUES (1, 'ARCHIVE-ME', 'Archive Me') RETURNING id`).first<{id:number}>();
		const rejected = await projectManagementResponse(request('POST', `action=archive_project&project_id=${create!.id}&confirm_key=wrong`), testEnv);
		expect(rejected.status).toBe(400);
		const accepted = await projectManagementResponse(request('POST', `action=archive_project&project_id=${create!.id}&confirm_key=ARCHIVE-ME`), testEnv);
		expect(accepted.status).toBe(303);
		let row = await env.DB.prepare(`SELECT active FROM projects WHERE id=?`).bind(create!.id).first<{active:number}>();
		expect(row?.active).toBe(0);
		await projectManagementResponse(request('POST', `action=restore_project&project_id=${create!.id}`), testEnv);
		row = await env.DB.prepare(`SELECT active FROM projects WHERE id=?`).bind(create!.id).first<{active:number}>();
		expect(row?.active).toBe(1);
	});

	it("deactivates and restores a management user without removing the seeded admin", async () => {
		const user = await env.DB.prepare(`INSERT INTO management_users (tenant_id, external_subject, display_name, email, tenant_role) VALUES (1, 'deactivate@example.com', 'Deactivate Me', 'deactivate@example.com', 'project_manager') RETURNING id`).first<{id:number}>();
		const wrong = await projectManagementResponse(request('POST', `action=deactivate_manager&management_user_id=${user!.id}&confirm_name=wrong`), testEnv);
		expect(wrong.status).toBe(400);
		const removed = await projectManagementResponse(request('POST', `action=deactivate_manager&management_user_id=${user!.id}&confirm_name=Deactivate+Me`), testEnv);
		expect(removed.status).toBe(303);
		let row = await env.DB.prepare(`SELECT active FROM management_users WHERE id=?`).bind(user!.id).first<{active:number}>();
		expect(row?.active).toBe(0);
		await projectManagementResponse(request('POST', `action=restore_manager&management_user_id=${user!.id}`), testEnv);
		row = await env.DB.prepare(`SELECT active FROM management_users WHERE id=?`).bind(user!.id).first<{active:number}>();
		expect(row?.active).toBe(1);
		const admin = await env.DB.prepare(`SELECT active FROM management_users WHERE id=1`).first<{active:number}>();
		expect(admin?.active).toBe(1);
	});

	it("archives a team by pausing its active members and removing its lead assignment", async () => {
		const member = await env.DB.prepare(`INSERT INTO team_members (name, phone, department, tenant_id, primary_project_id, active, scheduling_enabled) VALUES ('Archive Team Member', 'archive-team-member', 'Archive Team', 1, 1, 1, 1) RETURNING id`).first<{id:number}>();
		const lead = await env.DB.prepare(`INSERT INTO management_users (tenant_id, external_subject, display_name, email, tenant_role, workops_role) VALUES (1, 'archive-lead@example.com', 'Archive Lead', 'archive-lead@example.com', 'project_manager', 'team_lead') RETURNING id`).first<{id:number}>();
		await env.DB.prepare(`INSERT INTO team_lead_assignments (project_id, management_user_id, department) VALUES (1, ?, 'Archive Team')`).bind(lead!.id).run();
		const wrong = await projectManagementResponse(request('POST', 'action=archive_team&department=Archive+Team&confirm_department=wrong'), testEnv);
		expect(wrong.status).toBe(400);
		await projectManagementResponse(request('POST', 'action=archive_team&department=Archive+Team&confirm_department=Archive+Team'), testEnv);
		const archived = await env.DB.prepare(`SELECT active, scheduling_enabled FROM team_members WHERE id=?`).bind(member!.id).first<{active:number;scheduling_enabled:number}>();
		expect(archived).toEqual({active:0,scheduling_enabled:0});
		const assignment = await env.DB.prepare(`SELECT 1 AS found FROM team_lead_assignments WHERE management_user_id=?`).bind(lead!.id).first();
		expect(assignment).toBeNull();
	});
});
