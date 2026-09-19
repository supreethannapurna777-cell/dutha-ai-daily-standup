import {
        managementPrincipalFromRequest,
        type ManagementPrincipal,
} from "./access-control";
import type { WorkerEnv } from "./env";
import { createManagerActivation } from "./auth";

interface ProjectRow {
        id: number;
        project_key: string;
        name: string;
        active: number;
}

interface ManagerRow {
        id: number;
        display_name: string;
        email: string | null;
        tenant_role: string;
        project_ids: string | null;
}

interface MemberRow {
        id: number;
        name: string;
        department: string;
        project_ids: string | null;
}

function escapeHtml(value: unknown): string {
        return String(value ?? "")
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#039;");
}

function isAuthorised(request: Request, env: WorkerEnv): boolean {
        if (!env.DASHBOARD_USERNAME || !env.DASHBOARD_PASSWORD) return false;
        const credentials = btoa(`${env.DASHBOARD_USERNAME}:${env.DASHBOARD_PASSWORD}`);
        return request.headers.get("Authorization") === `Basic ${credentials}`;
}

function sameOrigin(request: Request): boolean {
        const origin = request.headers.get("Origin");
        if (origin && origin !== "null") return origin === new URL(request.url).origin;
        return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

function principal(request: Request): ManagementPrincipal {
        return managementPrincipalFromRequest(request) ?? {
                userId: 1,
                tenantId: 1,
                role: "admin",
        };
}

function response(body: string, status = 200): Response {
        return new Response(body, {
                status,
                headers: {
                        "Content-Type": "text/html; charset=utf-8",
                        "Cache-Control": "no-store",
                        "X-Frame-Options": "DENY",
                        "X-Content-Type-Options": "nosniff",
                        "Referrer-Policy": "no-referrer",
                        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
                },
        });
}

async function data(db: D1Database, tenantId: number): Promise<{
        projects: ProjectRow[];
        managers: ManagerRow[];
        members: MemberRow[];
}> {
        const [projects, managers, members] = await Promise.all([
                db.prepare(`
                        SELECT id, project_key, name, active
                        FROM projects WHERE tenant_id = ? ORDER BY active DESC, name
                `).bind(tenantId).all<ProjectRow>(),
                db.prepare(`
                        SELECT user.id, user.display_name, user.email, user.tenant_role,
                                GROUP_CONCAT(membership.project_id) AS project_ids
                        FROM management_users AS user
                        LEFT JOIN project_memberships AS membership
                                ON membership.management_user_id = user.id
                        WHERE user.tenant_id = ? AND user.active = 1
                        GROUP BY user.id ORDER BY user.display_name
                `).bind(tenantId).all<ManagerRow>(),
                db.prepare(`
                        SELECT member.id, member.name, member.department,
                                GROUP_CONCAT(assignment.project_id) AS project_ids
                        FROM team_members AS member
                        LEFT JOIN team_member_projects AS assignment
                                ON assignment.team_member_id = member.id
                        WHERE member.tenant_id = ? AND member.active = 1
                        GROUP BY member.id ORDER BY member.name
                `).bind(tenantId).all<MemberRow>(),
        ]);
        return {
                projects: projects.results,
                managers: managers.results,
                members: members.results,
        };
}

function assigned(ids: string | null, projectId: number): boolean {
        return new Set(String(ids ?? "").split(",").map(Number)).has(projectId);
}

function assignmentForm(
        action: string,
        projectId: number,
        targetName: string,
        targetId: number,
        isAssigned: boolean,
): string {
        return `<form method="post" class="inline">
                <input type="hidden" name="action" value="${isAssigned ? `remove_${action}` : `add_${action}`}">
                <input type="hidden" name="project_id" value="${projectId}">
                <input type="hidden" name="${targetName}" value="${targetId}">
                <button class="${isAssigned ? "remove" : "assign"}" type="submit">
                        ${isAssigned ? "Remove" : "Assign"}
                </button>
        </form>`;
}

interface TeamGroup {
	department: string;
	members: MemberRow[];
}

function teamGroups(members: MemberRow[]): TeamGroup[] {
	const groups = new Map<string, MemberRow[]>();
	for (const member of members) {
		const department = String(member.department ?? "").trim() || "Unassigned";
		const existing = groups.get(department) ?? [];
		existing.push(member);
		groups.set(department, existing);
	}
	return [...groups.entries()]
		.map(([department, groupedMembers]) => ({ department, members: groupedMembers }))
		.sort((left, right) => left.department.localeCompare(right.department));
}

function confirmationModal(
	id: string,
	title: string,
	detail: string,
	action: "add_team" | "add_all_members",
	projectId: number,
	department: string | null = null,
): string {
	return `<div class="modal" id="${escapeHtml(id)}"><div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(id)}-title">
		<h3 id="${escapeHtml(id)}-title">${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p>
		<div class="modal-actions"><a class="cancel" href="#">Cancel</a><form method="post" class="inline">
			<input type="hidden" name="action" value="${action}"><input type="hidden" name="project_id" value="${projectId}">
			${department === null ? "" : `<input type="hidden" name="department" value="${escapeHtml(department)}">`}
			<button class="assign" type="submit">Confirm assignment</button>
		</form></div></div></div>`;
}

function page(
        projects: ProjectRow[],
        managers: ManagerRow[],
        members: MemberRow[],
        message: string | null,
        error: string | null,
	activationUrl: string | null = null,
): string {
	const teams = teamGroups(members);
	const cards = projects.map((project) => {
                const managerRows = managers.map((manager) => `
                        <tr><td>${escapeHtml(manager.display_name)}<small>${escapeHtml(manager.tenant_role)}</small></td>
                        <td>${assignmentForm("manager", project.id, "management_user_id", manager.id, assigned(manager.project_ids, project.id))}
			${manager.email ? `<form method="post" class="inline"><input type="hidden" name="action" value="manager_activation"><input type="hidden" name="management_user_id" value="${manager.id}"><button type="submit">Activation link</button></form>` : ''}</td></tr>
                `).join("");
		const memberRows = members.map((member) => `
                        <tr><td>${escapeHtml(member.name)}<small>${escapeHtml(member.department)}</small></td>
                        <td>${assignmentForm("member", project.id, "team_member_id", member.id, assigned(member.project_ids, project.id))}</td></tr>
		`).join("");
		const allAssigned = members.length > 0 && members.every((member) => assigned(member.project_ids, project.id));
		const allModalId = `confirm-all-${project.id}`;
		const teamRows = teams.map((team, index) => {
			const assignedCount = team.members.filter((member) => assigned(member.project_ids, project.id)).length;
			const fullyAssigned = assignedCount === team.members.length;
			const modalId = `confirm-team-${project.id}-${index}`;
			return `<tr><td><strong>${escapeHtml(team.department)}</strong><small>${assignedCount} of ${team.members.length} assigned</small></td><td class="inline">
				${fullyAssigned ? '<span class="complete">Assigned</span>' : `<a class="button assign" href="#${modalId}">Assign team</a>`}
				${fullyAssigned ? "" : confirmationModal(modalId, "Assign entire team?", `Assign all ${team.members.length} active members of ${team.department} to ${project.name}?`, "add_team", project.id, team.department)}
			</td></tr>`;
		}).join("");
		return `<section class="project">
                        <div class="project-head"><div><span class="key">${escapeHtml(project.project_key)}</span><h2>${escapeHtml(project.name)}</h2></div>
                        <span class="status">${project.active ? "Active" : "Inactive"}</span></div>
			<div class="columns"><div><h3>Management access</h3><table>${managerRows || '<tr><td>No managers configured.</td></tr>'}</table></div>
			<div><div class="section-head"><h3>Teams</h3>${members.length === 0 || allAssigned ? `<span class="complete">${members.length === 0 ? "No members" : "All assigned"}</span>` : `<a class="button assign" href="#${allModalId}">Assign all members</a>`}</div>
			<table>${teamRows || '<tr><td>No teams configured.</td></tr>'}</table>
			${members.length > 0 && !allAssigned ? confirmationModal(allModalId, "Assign all members?", `Assign all ${members.length} active members to ${project.name}?`, "add_all_members", project.id) : ""}
			<h3 class="member-heading">Individual members</h3><table>${memberRows || '<tr><td>No members configured.</td></tr>'}</table></div></div>
	</section>`;
        }).join("");
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Projects and access · Dutha WorkOps</title><style>
:root{font-family:Inter,Arial,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0;padding:30px}main{max-width:1250px;margin:auto}header{display:flex;justify-content:space-between;gap:20px;align-items:start;margin-bottom:22px}h1,h2,h3{color:#173f6b}h1{margin:0 0 6px}.muted,small{display:block;color:#64748b}.top{color:#1769aa;font-weight:700}.notice,.error{padding:13px;border-radius:9px;margin:14px 0}.notice{background:#dcfce7;color:#166534}.error{background:#fee2e2;color:#991b1b}.create,.project{background:#fff;border-radius:13px;box-shadow:0 3px 14px #0f172a12;padding:21px;margin-bottom:20px}.create-grid{display:grid;grid-template-columns:1fr 2fr auto;gap:12px;align-items:end}label{display:grid;gap:6px;font-weight:700}input,select{padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}button,.button{border:0;border-radius:8px;padding:10px 14px;color:#fff;background:#1769aa;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block}.project-head,.section-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.project-head h2,.section-head h3{margin:5px 0}.key,.status{font-size:12px;font-weight:800}.key{color:#1769aa}.status{color:#166534;background:#dcfce7;padding:6px 9px;border-radius:99px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:24px}table{width:100%;border-collapse:collapse}td{padding:9px;border-bottom:1px solid #e5e7eb}.inline{text-align:right}.assign{background:#15803d}.remove{background:#b91c1c;padding:7px 10px}.complete{color:#166534;background:#dcfce7;border-radius:99px;padding:6px 9px;font-size:12px;font-weight:800}.member-heading{margin-top:24px}.manager-form{margin-top:18px;border-top:1px solid #e5e7eb;padding-top:18px}.manager-grid{display:grid;grid-template-columns:1.3fr 1.5fr 1fr auto;gap:10px;align-items:end}.modal{display:none;position:fixed;inset:0;background:#0f172abf;z-index:10;padding:20px;align-items:center;justify-content:center}.modal:target{display:flex}.modal-card{width:min(500px,100%);background:#fff;border-radius:13px;padding:24px;box-shadow:0 20px 60px #0005}.modal-card h3{margin-top:0}.modal-actions{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:20px}.cancel{color:#475569;font-weight:700;text-decoration:none}@media(max-width:800px){body{padding:15px}.columns,.create-grid,.manager-grid{grid-template-columns:1fr}header{flex-direction:column}.section-head{align-items:flex-start;flex-direction:column}}
</style></head><body><main><header><div><h1>Projects and access</h1><div class="muted">Create projects and control who can see each one.</div></div><a class="top" href="/dashboard">Return to dashboard</a></header>
${message ? `<div class="notice">${escapeHtml(message)}</div>` : ""}${activationUrl ? `<div class="notice"><strong>Secure activation link (valid for 24 hours):</strong><code>${escapeHtml(activationUrl)}</code><p>Send this privately to the manager. Creating another link revokes this one.</p></div>` : ''}${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<section class="create"><h2>Create project</h2><form method="post" class="create-grid"><input type="hidden" name="action" value="create_project"><label>Project key<input name="project_key" maxlength="20" placeholder="CLIENT-OPS" required></label><label>Project name<input name="name" maxlength="100" required></label><button type="submit">Create project</button></form>
<form method="post" class="manager-form"><input type="hidden" name="action" value="create_manager"><h2>Add management user</h2><div class="manager-grid"><label>Name<input name="display_name" maxlength="100" required></label><label>Work email<input name="email" type="email" maxlength="254" required></label><label>Role<select name="tenant_role"><option value="project_manager">Project manager</option><option value="portfolio_leader">Portfolio leader</option><option value="admin">Administrator</option></select></label><button type="submit">Add user</button></div></form></section>
${cards || '<section class="project">No projects configured.</section>'}</main></body></html>`;
}

async function existsInTenant(
        db: D1Database,
        table: "projects" | "management_users" | "team_members",
        id: number,
        tenantId: number,
): Promise<boolean> {
        const row = await db.prepare(`SELECT 1 AS found FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`)
                .bind(id, tenantId).first<{ found: number }>();
        return row?.found === 1;
}

async function mutate(
        form: FormData,
        env: WorkerEnv,
        actor: ManagementPrincipal,
): Promise<string | null> {
        const action = String(form.get("action") ?? "");
        if (action === "create_project") {
                const key = String(form.get("project_key") ?? "").trim().toUpperCase();
                const name = String(form.get("name") ?? "").trim();
                if (!/^[A-Z][A-Z0-9-]{1,19}$/.test(key) || !name || name.length > 100) {
                        return "Enter a valid project key and name.";
                }
                try {
                        await env.DB.prepare(`INSERT INTO projects (tenant_id, project_key, name) VALUES (?, ?, ?)`)
                                .bind(actor.tenantId, key, name).run();
                } catch {
                        return "That project key already exists for this company.";
                }
                return null;
        }
        if (action === "create_manager") {
                const displayName = String(form.get("display_name") ?? "").trim();
                const email = String(form.get("email") ?? "").trim().toLowerCase();
                const role = String(form.get("tenant_role") ?? "");
                if (!displayName || displayName.length > 100 || !["admin", "portfolio_leader", "project_manager"].includes(role)) {
                        return "Enter a valid management user and role.";
                }
                if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
                const subject = email || `pending-${crypto.randomUUID()}`;
                try {
                        await env.DB.prepare(`
                                INSERT INTO management_users (tenant_id, external_subject, display_name, email, tenant_role)
                                VALUES (?, ?, ?, ?, ?)
                        `).bind(actor.tenantId, subject, displayName, email || null, role).run();
                } catch {
                        return "That management user already exists.";
                }
                return null;
        }

        const projectId = Number(form.get("project_id"));
        if (!Number.isSafeInteger(projectId) || !(await existsInTenant(env.DB, "projects", projectId, actor.tenantId))) {
                return "Project was not found.";
        }
        if (["add_manager", "remove_manager"].includes(action)) {
                const userId = Number(form.get("management_user_id"));
                if (!Number.isSafeInteger(userId) || !(await existsInTenant(env.DB, "management_users", userId, actor.tenantId))) return "Management user was not found.";
                if (action === "add_manager") {
                        await env.DB.prepare(`INSERT OR IGNORE INTO project_memberships (project_id, management_user_id) VALUES (?, ?)`)
                                .bind(projectId, userId).run();
                } else {
                        await env.DB.prepare(`DELETE FROM project_memberships WHERE project_id = ? AND management_user_id = ?`)
                                .bind(projectId, userId).run();
                }
                return null;
        }
	if (["add_member", "remove_member"].includes(action)) {
                const memberId = Number(form.get("team_member_id"));
                if (!Number.isSafeInteger(memberId) || !(await existsInTenant(env.DB, "team_members", memberId, actor.tenantId))) return "Team member was not found.";
                if (action === "add_member") {
                        await env.DB.prepare(`INSERT OR IGNORE INTO team_member_projects (project_id, team_member_id) VALUES (?, ?)`)
                                .bind(projectId, memberId).run();
                } else {
                        await env.DB.prepare(`DELETE FROM team_member_projects WHERE project_id = ? AND team_member_id = ?`)
                                .bind(projectId, memberId).run();
                }
		return null;
	}
	if (action === "add_team") {
		const department = String(form.get("department") ?? "").trim();
		if (!department || department.length > 100) return "Team was not found.";
		const unassigned = department === "Unassigned";
		const team = unassigned
			? await env.DB.prepare(`
				SELECT 1 AS found FROM team_members
				WHERE tenant_id = ? AND active = 1 AND TRIM(COALESCE(department, '')) = '' LIMIT 1
			`).bind(actor.tenantId).first<{ found: number }>()
			: await env.DB.prepare(`
				SELECT 1 AS found FROM team_members
				WHERE tenant_id = ? AND active = 1 AND department = ? LIMIT 1
			`).bind(actor.tenantId, department).first<{ found: number }>();
		if (team?.found !== 1) return "Team was not found.";
		if (unassigned) {
			await env.DB.prepare(`
				INSERT OR IGNORE INTO team_member_projects (project_id, team_member_id)
				SELECT ?, id FROM team_members
				WHERE tenant_id = ? AND active = 1 AND TRIM(COALESCE(department, '')) = ''
			`).bind(projectId, actor.tenantId).run();
		} else {
			await env.DB.prepare(`
				INSERT OR IGNORE INTO team_member_projects (project_id, team_member_id)
				SELECT ?, id FROM team_members
				WHERE tenant_id = ? AND active = 1 AND department = ?
			`).bind(projectId, actor.tenantId, department).run();
		}
		return null;
	}
	if (action === "add_all_members") {
		await env.DB.prepare(`
			INSERT OR IGNORE INTO team_member_projects (project_id, team_member_id)
			SELECT ?, id FROM team_members WHERE tenant_id = ? AND active = 1
		`).bind(projectId, actor.tenantId).run();
		return null;
	}
	return "Invalid project management action.";
}

async function render(
        request: Request,
        env: WorkerEnv,
        actor: ManagementPrincipal,
        error: string | null = null,
	activationUrl: string | null = null,
): Promise<Response> {
        const rows = await data(env.DB, actor.tenantId);
        const updated = new URL(request.url).searchParams.get("updated");
        return response(page(rows.projects, rows.managers, rows.members, updated ? "Projects and access updated." : null, error, activationUrl), error ? 400 : 200);
}

async function managerActivation(
	form: FormData,
	request: Request,
	env: WorkerEnv,
	actor: ManagementPrincipal,
): Promise<Response> {
	const action = String(form.get("action") ?? "");
	let managerId: number;
	if (action === "create_manager") {
		const displayName = String(form.get("display_name") ?? "").trim();
		const email = String(form.get("email") ?? "").trim().toLowerCase();
		const role = String(form.get("tenant_role") ?? "");
		if (!displayName || displayName.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["admin", "portfolio_leader", "project_manager"].includes(role)) return render(request, env, actor, "Enter a valid name, work email and role.");
		try {
			const created = await env.DB.prepare(`INSERT INTO management_users (tenant_id, external_subject, display_name, email, tenant_role) VALUES (?, ?, ?, ?, ?) RETURNING id`).bind(actor.tenantId, email, displayName, email, role).first<{ id:number }>();
			if (!created) return render(request, env, actor, "Management user could not be created.");
			managerId = created.id;
		} catch {
			return render(request, env, actor, "That management user already exists.");
		}
	} else {
		managerId = Number(form.get("management_user_id"));
		const manager = Number.isSafeInteger(managerId) ? await env.DB.prepare(`SELECT email FROM management_users WHERE id=? AND tenant_id=? AND active=1 LIMIT 1`).bind(managerId, actor.tenantId).first<{ email:string|null }>() : null;
		if (!manager?.email) return render(request, env, actor, "Management user with a work email was not found.");
	}
	const token = await createManagerActivation(env.DB, managerId);
	const activationUrl = `${new URL(request.url).origin}/manager/activate?token=${encodeURIComponent(token)}`;
	return render(request, env, actor, null, activationUrl);
}

export async function projectManagementResponse(
        request: Request,
        env: WorkerEnv,
): Promise<Response> {
        if (!isAuthorised(request, env)) return new Response("Authentication required.", { status: 401 });
        const actor = principal(request);
        if (actor.role !== "admin") return new Response("Administrator access required.", { status: 403 });
        if (request.method === "GET") return render(request, env, actor);
        if (request.method !== "POST") return new Response("Method not allowed.", { status: 405, headers: { Allow: "GET, POST" } });
        if (!sameOrigin(request)) return new Response("Invalid request origin.", { status: 403 });
	const form = await request.formData();
	if (["create_manager", "manager_activation"].includes(String(form.get("action") ?? ""))) return managerActivation(form, request, env, actor);
        const error = await mutate(form, env, actor);
        if (error) return render(request, env, actor, error);
        return new Response(null, { status: 303, headers: { Location: "/dashboard/projects?updated=1" } });
}
