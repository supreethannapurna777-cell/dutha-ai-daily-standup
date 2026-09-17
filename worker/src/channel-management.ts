import {
        accessibleProjects,
        managementPrincipalFromRequest,
        requireProjectAccess,
        type ManagementPrincipal,
} from "./access-control";
import {
        generateEnrolmentCode,
        hashEnrolmentCode,
} from "./enrolment";
import type { WorkerEnv } from "./env";

interface MemberChannelRow {
        id: number;
        name: string;
        department: string;
        email: string | null;
        enrolment_status: string;
        whatsapp_connected: number;
        teams_connected: number;
}

interface InviteRow {
        id: number;
        expires_at: string;
        max_uses: number;
        use_count: number;
        revoked_at: string | null;
        created_at: string;
}

interface CsvMember {
        name: string;
        email: string;
        department: string;
        timezone: string;
}

const csvMemberLimit = 200;
const csvByteLimit = 256 * 1024;
const allowedTimezones = new Set(["Asia/Kolkata", "Europe/London"]);

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

function parseCsv(text: string): string[][] {
        const rows: string[][] = [];
        let row: string[] = [];
        let field = "";
        let quoted = false;
        for (let index = 0; index < text.length; index += 1) {
                const character = text[index];
                if (quoted) {
                        if (character === '"' && text[index + 1] === '"') {
                                field += '"';
                                index += 1;
                        } else if (character === '"') {
                                quoted = false;
                        } else {
                                field += character;
                        }
                } else if (character === '"') {
                        quoted = true;
                } else if (character === ",") {
                        row.push(field.trim());
                        field = "";
                } else if (character === "\n") {
                        row.push(field.trim());
                        if (row.some((value) => value)) rows.push(row);
                        row = [];
                        field = "";
                } else if (character !== "\r") {
                        field += character;
                }
        }
        if (quoted) throw new Error("The CSV contains an unfinished quoted value.");
        row.push(field.trim());
        if (row.some((value) => value)) rows.push(row);
        return rows;
}

function csvMembers(text: string): CsvMember[] {
        const rows = parseCsv(text.replace(/^\uFEFF/, ""));
        if (!rows.length) throw new Error("The CSV is empty.");
        const headers = rows[0].map((header) => header.trim().toLowerCase());
        const required = ["name", "email", "department", "timezone"];
        if (headers.length !== required.length || required.some((header, index) => headers[index] !== header)) {
                throw new Error("Use this exact header: name,email,department,timezone");
        }
        const dataRows = rows.slice(1);
        if (!dataRows.length) throw new Error("Add at least one employee row.");
        if (dataRows.length > csvMemberLimit) throw new Error(`Import up to ${csvMemberLimit} employees at a time.`);
        const seen = new Set<string>();
        return dataRows.map((values, index) => {
                const rowNumber = index + 2;
                if (values.length !== required.length) throw new Error(`Row ${rowNumber} must contain exactly four columns.`);
                const [name, rawEmail, department, rawTimezone] = values;
                const email = rawEmail.toLowerCase();
                const timezone = rawTimezone || "Asia/Kolkata";
                if (!name || name.length > 120) throw new Error(`Row ${rowNumber} has an invalid name.`);
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error(`Row ${rowNumber} has an invalid work email.`);
                if (!department || department.length > 120) throw new Error(`Row ${rowNumber} has an invalid department.`);
                if (!allowedTimezones.has(timezone)) throw new Error(`Row ${rowNumber} has an unsupported timezone.`);
                if (seen.has(email)) throw new Error(`Row ${rowNumber} repeats ${email}.`);
                seen.add(email);
                return { name, email, department, timezone };
        });
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
                        "Content-Security-Policy":
                                "default-src 'none'; style-src 'unsafe-inline'; "
                                + "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
                },
        });
}

function principal(request: Request): ManagementPrincipal {
        return managementPrincipalFromRequest(request) ?? {
                userId: 1,
                tenantId: 1,
                role: "admin",
        };
}

async function members(
        db: D1Database,
        tenantId: number,
        projectId: number,
): Promise<MemberChannelRow[]> {
        return (await db.prepare(`
                SELECT member.id, member.name, member.department, member.email,
                        member.enrolment_status,
                        EXISTS (
                                SELECT 1 FROM channel_identities AS identity
                                WHERE identity.team_member_id = member.id
                                        AND identity.channel = 'whatsapp'
                        ) AS whatsapp_connected,
                        EXISTS (
                                SELECT 1 FROM channel_identities AS identity
                                WHERE identity.team_member_id = member.id
                                        AND identity.channel = 'teams'
                        ) AS teams_connected
                FROM team_members AS member
                WHERE member.tenant_id = ? AND member.active = 1
                        AND (
                                member.primary_project_id = ?
                                OR EXISTS (
                                        SELECT 1 FROM team_member_projects AS membership
                                        WHERE membership.team_member_id = member.id
                                                AND membership.project_id = ?
                                )
                        )
                ORDER BY member.name
        `).bind(tenantId, projectId, projectId).all<MemberChannelRow>()).results;
}

async function invites(
        db: D1Database,
        tenantId: number,
        projectId: number,
): Promise<InviteRow[]> {
        return (await db.prepare(`
                SELECT id, expires_at, max_uses, use_count, revoked_at, created_at
                FROM enrolment_invites
                WHERE tenant_id = ? AND project_id = ?
                ORDER BY created_at DESC LIMIT 20
        `).bind(tenantId, projectId).all<InviteRow>()).results;
}

function statusPill(connected: boolean, label: string): string {
        return `<span class="pill ${connected ? "connected" : "pending"}">${escapeHtml(label)}</span>`;
}

function page(
        projectId: number,
        projectOptions: string,
        rows: MemberChannelRow[],
        inviteRows: InviteRow[],
        env: WorkerEnv,
        generatedCode: string | null,
        notice: string | null,
        error: string | null,
): string {
        const whatsappReady = Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
        const memberRows = rows.map((member) => `
                <tr>
                        <td><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(member.department)}</small></td>
                        <td>
                                <form method="post" class="email-form">
                                        <input type="hidden" name="action" value="save_email">
                                        <input type="hidden" name="project_id" value="${projectId}">
                                        <input type="hidden" name="member_id" value="${member.id}">
                                        <input type="email" name="email" maxlength="254" value="${escapeHtml(member.email)}" placeholder="Work email" required>
                                        <button type="submit">Save</button>
                                </form>
                        </td>
                        <td>${statusPill(Boolean(member.whatsapp_connected), member.whatsapp_connected ? "Connected" : "Not connected")}</td>
                        <td>${statusPill(Boolean(member.teams_connected), member.teams_connected ? "Connected" : "Not connected")}</td>
                </tr>
        `).join("");

        const inviteTable = inviteRows.map((invite) => {
                const active = !invite.revoked_at && Date.parse(invite.expires_at) > Date.now()
                        && invite.use_count < invite.max_uses;
                return `<tr><td>${escapeHtml(new Date(invite.created_at).toLocaleDateString("en-IN"))}</td>
                        <td>${escapeHtml(new Date(invite.expires_at).toLocaleString("en-IN"))}</td>
                        <td>${invite.use_count} / ${invite.max_uses}</td>
                        <td>${statusPill(active, active ? "Active" : "Closed")}</td>
                        <td>${active ? `<div class="invite-actions"><form method="post"><input type="hidden" name="action" value="replace_invite"><input type="hidden" name="project_id" value="${projectId}"><input type="hidden" name="invite_id" value="${invite.id}"><button type="submit">Replace</button></form><form method="post"><input type="hidden" name="action" value="revoke_invite"><input type="hidden" name="project_id" value="${projectId}"><input type="hidden" name="invite_id" value="${invite.id}"><button class="danger" type="submit">Revoke</button></form></div>` : "—"}</td></tr>`;
        }).join("");

        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Channels and enrolment · Dutha WorkOps</title><style>
:root{font-family:Inter,Arial,sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0;padding:28px}main{max-width:1180px;margin:auto}header{display:flex;justify-content:space-between;gap:20px;align-items:start;margin-bottom:20px}h1,h2{color:#173f6b}h1{margin:0 0 6px}.muted,small{display:block;color:#64748b}.back{color:#1769aa;font-weight:700}.notice,.error,.code{padding:14px;border-radius:10px;margin:14px 0}.notice{background:#dcfce7;color:#166534}.error{background:#fee2e2;color:#991b1b}.code{background:#eff6ff;border:1px solid #93c5fd}.code strong{display:block;font-size:22px;letter-spacing:2px;color:#173f6b;margin:8px 0}.toolbar,.card{background:#fff;border-radius:14px;box-shadow:0 3px 14px #0f172a12;padding:20px;margin-bottom:18px}.toolbar{display:flex;justify-content:space-between;gap:14px;align-items:end}.toolbar form{display:flex;gap:9px;align-items:end}.integrations{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px}.integration{background:#fff;border-radius:14px;box-shadow:0 3px 14px #0f172a12;padding:18px}.integration h2{font-size:18px;margin:0 0 8px}.pill{display:inline-block;padding:5px 9px;border-radius:99px;font-size:12px;font-weight:800}.connected{background:#dcfce7;color:#166534}.pending{background:#f1f5f9;color:#475569}select,input{padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}input[type=file]{max-width:100%}button{border:0;border-radius:8px;padding:10px 13px;background:#1769aa;color:#fff;font-weight:700;cursor:pointer}.danger{background:#b91c1c;padding:7px 10px}.create,.import-form{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.create label,.import-form label{display:grid;gap:6px}.email-form,.invite-actions{display:flex;gap:7px}.email-form input{min-width:230px}.import-help{background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:11px;margin:10px 0}.import-help code{display:block;margin-top:5px;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px;border-bottom:1px solid #e5e7eb;vertical-align:middle}th{color:#475569;font-size:13px}.scroll{overflow:auto}.actions{display:flex;gap:10px;flex-wrap:wrap}.actions a{color:#1769aa;font-weight:700}@media(max-width:800px){body{padding:14px}header,.toolbar{flex-direction:column}.integrations{grid-template-columns:1fr}.email-form{min-width:260px}table{min-width:850px}}
</style></head><body><main><header><div><h1>Channels and enrolment</h1><div class="muted">Connect people once, then let Dutha coordinate across channels.</div></div><a class="back" href="/dashboard?project=${projectId}">Return to dashboard</a></header>
${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
${generatedCode ? `<div class="code"><span>Share this instruction only with people assigned to this project:</span><strong>JOIN ${escapeHtml(generatedCode)} work-email@company.com</strong><span>The code is shown only now. Employees replace the example with their own saved work email.</span></div>` : ""}
<section class="toolbar"><form method="get"><label>Project<br><select name="project">${projectOptions}</select></label><button type="submit">Open</button></form><div class="actions"><a href="/dashboard/projects">Projects and access</a><a href="/dashboard/members?project=${projectId}">Member schedules</a></div></section>
<section class="integrations"><article class="integration"><h2>WhatsApp</h2>${statusPill(whatsappReady, whatsappReady ? "Configured" : "Needs configuration")}<p class="muted">Text, voice and secure self-enrolment.</p></article><article class="integration"><h2>Microsoft Teams</h2>${statusPill(false, "Foundation ready next")}<p class="muted">Will use the same employee identity and workflow.</p></article><article class="integration"><h2>Jira / Atlassian</h2>${statusPill(false, "Foundation ready next")}<p class="muted">Will link blockers to verified Jira work.</p></article></section>
<section class="card"><h2>Add employees from CSV</h2><p class="muted">Import up to ${csvMemberLimit} employees into this project. No phone numbers are required.</p><div class="import-help">Required header:<code>name,email,department,timezone</code><small>Supported timezones: Asia/Kolkata and Europe/London.</small></div><form method="post" enctype="multipart/form-data" class="import-form"><input type="hidden" name="action" value="import_members"><input type="hidden" name="project_id" value="${projectId}"><label>CSV file<input type="file" name="members_csv" accept=".csv,text/csv" required></label><button type="submit">Import employees</button></form></section>
<section class="card"><h2>Invite this project</h2><p class="muted">First save each employee's work email. One invitation code can then enrol the assigned project members.</p><form method="post" class="create"><input type="hidden" name="action" value="create_invite"><input type="hidden" name="project_id" value="${projectId}"><label>Expires after<select name="expiry_days"><option value="1">1 day</option><option value="3" selected>3 days</option><option value="7">7 days</option></select></label><label>Maximum joins<input type="number" name="max_uses" min="1" max="1000" value="100"></label><button type="submit">Create invitation</button></form></section>
<section class="card"><h2>Employee identities</h2><p class="muted">Phone numbers and external IDs remain private. Only connection status is shown.</p><div class="scroll"><table><thead><tr><th>Employee</th><th>Work email</th><th>WhatsApp</th><th>Teams</th></tr></thead><tbody>${memberRows || '<tr><td colspan="4">No members assigned to this project.</td></tr>'}</tbody></table></div></section>
<section class="card"><h2>Recent invitations</h2><div class="scroll"><table><thead><tr><th>Created</th><th>Expires</th><th>Joins</th><th>Status</th><th></th></tr></thead><tbody>${inviteTable || '<tr><td colspan="5">No invitations created.</td></tr>'}</tbody></table></div></section>
</main></body></html>`;
}

async function render(
        request: Request,
        env: WorkerEnv,
        actor: ManagementPrincipal,
        projectId: number,
        generatedCode: string | null = null,
        notice: string | null = null,
        error: string | null = null,
): Promise<Response> {
        const projects = await accessibleProjects(env.DB, actor);
        const options = projects.map((project) => `<option value="${project.id}"${project.id === projectId ? " selected" : ""}>${escapeHtml(project.project_key)} · ${escapeHtml(project.name)}</option>`).join("");
        const [memberRows, inviteRows] = await Promise.all([
                members(env.DB, actor.tenantId, projectId),
                invites(env.DB, actor.tenantId, projectId),
        ]);
        return response(page(projectId, options, memberRows, inviteRows, env, generatedCode, notice, error), error ? 400 : 200);
}

export async function channelManagementResponse(
        request: Request,
        env: WorkerEnv,
        now = new Date(),
): Promise<Response> {
        if (!isAuthorised(request, env)) return new Response("Authentication required.", { status: 401 });
        const actor = principal(request);
        if (actor.role !== "admin") return new Response("Administrator access required.", { status: 403 });
        const url = new URL(request.url);
        const projectId = Number(url.searchParams.get("project") ?? (request.method === "POST" ? "0" : "1"));
        let selectedProject = projectId;
        if (request.method === "POST") {
                const form = await request.clone().formData();
                selectedProject = Number(form.get("project_id"));
        }
        if (!Number.isSafeInteger(selectedProject) || selectedProject <= 0) return new Response("Invalid project.", { status: 400 });
        try {
                await requireProjectAccess(env.DB, actor, selectedProject);
        } catch {
                return new Response("Project access denied.", { status: 403 });
        }
        if (request.method === "GET") return render(request, env, actor, selectedProject);
        if (request.method !== "POST") return new Response("Method not allowed.", { status: 405, headers: { Allow: "GET, POST" } });
        if (!sameOrigin(request)) return new Response("Invalid request origin.", { status: 403 });

        const form = await request.formData();
        const action = String(form.get("action") ?? "");
        if (action === "import_members") {
                const upload = form.get("members_csv");
                if (!(upload instanceof File) || upload.size === 0) {
                        return render(request, env, actor, selectedProject, null, null, "Choose a CSV file to import.");
                }
                if (upload.size > csvByteLimit) {
                        return render(request, env, actor, selectedProject, null, null, "The CSV must be 256 KB or smaller.");
                }
                let imported: CsvMember[];
                try {
                        imported = csvMembers(await upload.text());
                } catch (error) {
                        return render(request, env, actor, selectedProject, null, null, error instanceof Error ? error.message : "The CSV could not be read.");
                }
                for (const member of imported) {
                        const existing = await env.DB.prepare(`
                                SELECT 1 AS found FROM team_members
                                WHERE tenant_id = ? AND lower(email) = ? LIMIT 1
                        `).bind(actor.tenantId, member.email).first();
                        if (existing) {
                                return render(request, env, actor, selectedProject, null, null, `${member.email} is already assigned in this company. No employees were imported.`);
                        }
                }
                try {
                        await env.DB.batch([
                                ...imported.map((member) => env.DB.prepare(`
                                        INSERT INTO team_members (
                                                name, phone, department, timezone, tenant_id,
                                                primary_project_id, email, enrolment_status,
                                                scheduling_enabled
                                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'invited', 0)
                                `).bind(
                                        member.name,
                                        `pending-${crypto.randomUUID()}`,
                                        member.department,
                                        member.timezone,
                                        actor.tenantId,
                                        selectedProject,
                                        member.email,
                                )),
                                env.DB.prepare(`
                                        INSERT INTO channel_identity_events (
                                                tenant_id, channel, event_type, details
                                        ) VALUES (?, 'whatsapp', 'members_imported', ?)
                                `).bind(actor.tenantId, `Project ${selectedProject}; count ${imported.length}`),
                        ]);
                } catch {
                        return render(request, env, actor, selectedProject, null, null, "The import could not be completed. No employees were added.");
                }
                return render(request, env, actor, selectedProject, null, `${imported.length} employee${imported.length === 1 ? "" : "s"} imported. They can now use the project invitation.`);
        }
        if (action === "save_email") {
                const memberId = Number(form.get("member_id"));
                const email = String(form.get("email") ?? "").trim().toLowerCase();
                if (!Number.isSafeInteger(memberId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                        return render(request, env, actor, selectedProject, null, null, "Enter a valid work email.");
                }
                try {
                        const result = await env.DB.prepare(`
                                UPDATE team_members SET email = ?
                                WHERE id = ? AND tenant_id = ? AND (
                                        primary_project_id = ? OR EXISTS (
                                                SELECT 1 FROM team_member_projects
                                                WHERE team_member_id = team_members.id AND project_id = ?
                                        )
                                )
                        `).bind(email, memberId, actor.tenantId, selectedProject, selectedProject).run();
                        if (!result.meta.changes) return render(request, env, actor, selectedProject, null, null, "Member was not found.");
                } catch {
                        return render(request, env, actor, selectedProject, null, null, "That email is already assigned in this company.");
                }
                return render(request, env, actor, selectedProject, null, "Work email saved.");
        }

        if (action === "create_invite") {
                const expiryDays = Number(form.get("expiry_days"));
                const maxUses = Number(form.get("max_uses"));
                if (![1, 3, 7].includes(expiryDays) || !Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
                        return render(request, env, actor, selectedProject, null, null, "Choose valid invitation limits.");
                }
                const code = generateEnrolmentCode();
                const codeHash = await hashEnrolmentCode(code);
                const expiresAt = new Date(now.getTime() + expiryDays * 86_400_000).toISOString();
                await env.DB.batch([
                        env.DB.prepare(`
                                INSERT INTO enrolment_invites (
                                        tenant_id, project_id, created_by_management_user_id,
                                        code_hash, expires_at, max_uses
                                ) VALUES (?, ?, ?, ?, ?, ?)
                        `).bind(actor.tenantId, selectedProject, actor.userId, codeHash, expiresAt, maxUses),
                        env.DB.prepare(`
                                INSERT INTO channel_identity_events (
                                        tenant_id, channel, event_type, details
                                ) VALUES (?, 'whatsapp', 'invite_created', ?)
                        `).bind(actor.tenantId, `Project ${selectedProject}; expires ${expiresAt}`),
                ]);
                return render(request, env, actor, selectedProject, code, "Invitation created. Copy it now.");
        }

        if (action === "revoke_invite") {
                const inviteId = Number(form.get("invite_id"));
                const result = await env.DB.prepare(`
                        UPDATE enrolment_invites SET revoked_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND tenant_id = ? AND project_id = ? AND revoked_at IS NULL
                `).bind(inviteId, actor.tenantId, selectedProject).run();
                if (!result.meta.changes) return render(request, env, actor, selectedProject, null, null, "Invitation was not found or was already closed.");
                await env.DB.prepare(`
                        INSERT INTO channel_identity_events (
                                tenant_id, channel, event_type, details
                        ) VALUES (?, 'whatsapp', 'invite_revoked', ?)
                `).bind(actor.tenantId, `Invitation ${inviteId}`).run();
                return render(request, env, actor, selectedProject, null, "Invitation revoked.");
        }

        if (action === "replace_invite") {
                const inviteId = Number(form.get("invite_id"));
                if (!Number.isSafeInteger(inviteId) || inviteId <= 0) {
                        return render(request, env, actor, selectedProject, null, null, "Invalid invitation.");
                }
                const existing = await env.DB.prepare(`
                        SELECT max_uses FROM enrolment_invites
                        WHERE id = ? AND tenant_id = ? AND project_id = ?
                                AND revoked_at IS NULL AND expires_at > ?
                                AND use_count < max_uses
                `).bind(inviteId, actor.tenantId, selectedProject, now.toISOString()).first<{ max_uses: number }>();
                if (!existing) return render(request, env, actor, selectedProject, null, null, "Invitation was not found or was already closed.");
                const code = generateEnrolmentCode();
                const codeHash = await hashEnrolmentCode(code);
                const expiresAt = new Date(now.getTime() + 3 * 86_400_000).toISOString();
                await env.DB.batch([
                        env.DB.prepare(`
                                UPDATE enrolment_invites SET revoked_at = ?
                                WHERE id = ? AND tenant_id = ? AND project_id = ? AND revoked_at IS NULL
                        `).bind(now.toISOString(), inviteId, actor.tenantId, selectedProject),
                        env.DB.prepare(`
                                INSERT INTO enrolment_invites (
                                        tenant_id, project_id, created_by_management_user_id,
                                        code_hash, expires_at, max_uses
                                ) VALUES (?, ?, ?, ?, ?, ?)
                        `).bind(actor.tenantId, selectedProject, actor.userId, codeHash, expiresAt, existing.max_uses),
                        env.DB.prepare(`
                                INSERT INTO channel_identity_events (
                                        tenant_id, channel, event_type, details
                                ) VALUES (?, 'whatsapp', 'invite_revoked', ?)
                        `).bind(actor.tenantId, `Invitation ${inviteId}; replaced`),
                        env.DB.prepare(`
                                INSERT INTO channel_identity_events (
                                        tenant_id, channel, event_type, details
                                ) VALUES (?, 'whatsapp', 'invite_created', ?)
                        `).bind(actor.tenantId, `Project ${selectedProject}; replacement expires ${expiresAt}`),
                ]);
                return render(request, env, actor, selectedProject, code, "Invitation replaced. The old code no longer works.");
        }

        return render(request, env, actor, selectedProject, null, null, "Invalid action.");
}
