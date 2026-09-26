import type { WorkerEnv } from './env';
import { managementPrincipalFromRequest, requireProjectAccess, teamLeadDepartment, type ManagementPrincipal } from './access-control';
import { createEmployeeActivation } from './employee-portal';
import { runDepartmentInitialNow, runProjectInitialNow } from './scheduler';

interface ManagedMember {
	id: number;
	name: string;
	department: string;
	active: number;
	timezone: string;
	working_days: string;
	initial_time: string;
	reminder_1_time: string;
	reminder_2_time: string;
	scheduling_enabled: number;
}

const allowedTimezones = new Set(['Asia/Kolkata', 'Europe/London']);

const allowedDays = new Set(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);

function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}

function isAuthorised(request: Request, env: WorkerEnv): boolean {
	if (!env.DASHBOARD_USERNAME || !env.DASHBOARD_PASSWORD) {
		return false;
	}

	const credentials = btoa(`${env.DASHBOARD_USERNAME}:` + env.DASHBOARD_PASSWORD);

	return request.headers.get('Authorization') === `Basic ${credentials}`;
}

function authenticationRequired(): Response {
	return new Response('Authentication required.', {
		status: 401,
		headers: {
			'WWW-Authenticate': 'Basic realm="Dutha WorkOps"',
		},
	});
}

function htmlResponse(html: string, status = 200): Response {
	return new Response(html, {
		status,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Frame-Options': 'DENY',
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'no-referrer',
			'Content-Security-Policy':
				"default-src 'none'; " + "style-src 'unsafe-inline'; " + "form-action 'self'; " + "base-uri 'none'; " + "frame-ancestors 'none'",
		},
	});
}

function validateSameOrigin(request: Request): boolean {
	const expectedOrigin = new URL(request.url).origin;
	const origin = request.headers.get('Origin');

	if (origin && origin !== 'null') {
		return origin === expectedOrigin;
	}

	return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

function validPhone(phone: string): boolean {
	return /^[1-9][0-9]{7,14}$/.test(phone);
}

function validTime(value: string): boolean {
	const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);

	if (!match) {
		return false;
	}

	return Number(match[2]) % 15 === 0;
}

function minutesFromMidnight(value: string): number {
	const [hours, minutes] = value.split(':').map(Number);

	return hours * 60 + minutes;
}

function normaliseWorkingDays(form: FormData): string | null {
	const days = form
		.getAll('working_days')
		.map(String)
		.map((day) => day.toUpperCase())
		.filter((day) => allowedDays.has(day));

	const uniqueDays = [...new Set(days)];

	if (uniqueDays.length === 0) {
		return null;
	}

	return ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].filter((day) => uniqueDays.includes(day)).join(',');
}

async function getMembers(db: D1Database, tenantId: number, projectId: number, departmentScope: string | null = null): Promise<ManagedMember[]> {
	const result = await db
		.prepare(
			`
                        SELECT
                                id,
                                name,
                                department,
                                active,
                                timezone,
                                working_days,
                                initial_time,
                                reminder_1_time,
                                reminder_2_time,
                                scheduling_enabled
                        FROM team_members
                        WHERE tenant_id = ?
                                AND (? IS NULL OR department = ?)
                                AND (
                                        primary_project_id = ?
                                        OR EXISTS (
                                        SELECT 1 FROM team_member_projects
                                        WHERE team_member_id = team_members.id
                                                AND project_id = ?
                                        )
                                )
                        ORDER BY name
                        `,
		)
		.bind(tenantId, departmentScope, departmentScope, projectId, projectId)
		.all<ManagedMember>();

	return result.results;
}

function dayCheckboxes(member: ManagedMember): string {
	const selected = new Set(member.working_days.split(',').map((day) => day.trim()));

	return ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
		.map(
			(day) => `
                        <label class="day">
                                <input
                                        type="checkbox"
                                        name="working_days"
                                        value="${day}"
                                        ${selected.has(day) ? 'checked' : ''}
                                >
                                ${day}
                        </label>
                `,
		)
		.join('');
}

function memberCard(member: ManagedMember): string {
	return `
                <details class="member-card">
			<summary class="member-title">
				<div><h2>${escapeHtml(member.name)}</h2><p>${escapeHtml(member.department)}</p></div>
				<span class="status ${member.active ? 'active' : 'inactive'}">${member.active ? 'Active' : 'Removed'}</span>
			</summary>
		<form method="post" class="member-form">
                        <input
                                type="hidden"
                                name="action"
                                value="update"
                        >
                        <input
                                type="hidden"
                                name="member_id"
                                value="${member.id}"
                        >

                        <div class="form-grid">
                                <label>
                                        Timezone
                                        <select name="timezone" required>
                                                <option
                                                        value="Asia/Kolkata"
                                                        ${member.timezone === 'Asia/Kolkata' ? 'selected' : ''}
                                                >
                                                        India
                                                        (Asia/Kolkata)
                                                </option>
                                                <option
                                                        value="Europe/London"
                                                        ${member.timezone === 'Europe/London' ? 'selected' : ''}
                                                >
                                                        United Kingdom
                                                        (Europe/London)
                                                </option>
                                        </select>
                                </label>

                                <label>
                                        Initial request
                                        <input
                                                type="time"
                                                name="initial_time"
                                                step="900"
                                                value="${escapeHtml(member.initial_time)}"
                                                required
                                        >
                                </label>

                                <label>
                                        First reminder
                                        <input
                                                type="time"
                                                name="reminder_1_time"
                                                step="900"
                                                value="${escapeHtml(member.reminder_1_time)}"
                                                required
                                        >
                                </label>

                                <label>
                                        Final reminder
                                        <input
                                                type="time"
                                                name="reminder_2_time"
                                                step="900"
                                                value="${escapeHtml(member.reminder_2_time)}"
                                                required
                                        >
                                </label>
                        </div>

                        <fieldset>
                                <legend>Working days</legend>
                                <div class="days">
                                        ${dayCheckboxes(member)}
                                </div>
                        </fieldset>

                        <div class="toggles">
                                <label>
                                        <input
                                                type="checkbox"
                                                name="active"
                                                value="1"
                                                ${member.active ? 'checked' : ''}
                                        >
                                        Active team member
                                </label>

                                <label>
                                        <input
                                                type="checkbox"
                                                name="scheduling_enabled"
                                                value="1"
                                                ${member.scheduling_enabled ? 'checked' : ''}
                                        >
                                        Automated messages enabled
                                </label>
                        </div>

                        <button type="submit">
                                Save member schedule
                        </button>
		</form>
	</details>
        `;
}

function page(members: ManagedMember[], message: string | null, error: string | null, activationLink: string | null = null, projectId = 1, departmentScope: string | null = null): string {
	const activeMembers = members.filter((member) => member.active);
	const removedMembers = members.filter((member) => !member.active);
	const departments = new Map<string, ManagedMember[]>();
	for (const member of activeMembers) {
		const name = member.department.trim() || 'Unassigned';
		departments.set(name, [...(departments.get(name) ?? []), member]);
	}
	const cards = [...departments.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, teamMembers]) => `
		<details class="team-card"><summary><span><strong>${escapeHtml(name)}</strong><small>${teamMembers.length} active ${teamMembers.length === 1 ? 'member' : 'members'}</small></span><span class="open-label">Open team</span></summary><div class="team-members">${teamMembers.map(memberCard).join('')}</div></details>
	`).join('') || `<p class="empty">No active members configured.</p>`;
	const archive = removedMembers.length ? `<details class="archive"><summary><strong>Removed members</strong><span>${removedMembers.length}</span></summary><p>Excluded from normal scheduling. Open a member and mark them active to restore access.</p>${removedMembers.map(memberCard).join('')}</details>` : '';

	return `<!DOCTYPE html>
<html lang="en">
<head>
        <meta charset="UTF-8">
        <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
        >
        <title>Member Scheduling | Dutha WorkOps</title>
        <style>
                :root {
                        font-family: Inter, Arial, sans-serif;
			color: #dbeafe;
			background: #070b18;
			color-scheme: dark;
                }

                * {
                        box-sizing: border-box;
                }

                body {
                        margin: 0;
                        padding: 32px;
			min-height:100vh;
			background:radial-gradient(circle at 12% 0,#172554 0,transparent 38%),radial-gradient(circle at 92% 8%,#312e81 0,transparent 34%),#070b18;
                }

                main {
                        max-width: 1150px;
                        margin: auto;
                }

                header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        gap: 20px;
                        margin-bottom: 24px;
                }

                h1 {
                        margin: 0 0 6px;
			color: #f8fafc;
                }

                h2 {
                        margin: 0;
                }

                p {
			color: #94a3b8;
                        margin: 4px 0;
                }

                a {
			color: #93c5fd;
                        font-weight: 700;
                }

                .notice,
                .error {
                        padding: 14px;
                        border-radius: 10px;
                        margin-bottom: 18px;
                }

                .notice {
			background: #0c4a6e;
			color: #e0f2fe;
                }

                .error {
                        background: #fee2e2;
                        color: #991b1b;
                }

                .add-card,
                .member-card,.team-card,.archive {
			background:#111827d9;border:1px solid #334155;border-radius:18px;box-shadow:0 18px 50px #0005;margin-bottom:16px;backdrop-filter:blur(18px);
                }
		.add-card{padding:0}.add-card>summary,.team-card>summary,.archive>summary{cursor:pointer;list-style:none;padding:20px;display:flex;align-items:center;justify-content:space-between;gap:16px}.add-card>summary::-webkit-details-marker,.team-card>summary::-webkit-details-marker,.archive>summary::-webkit-details-marker,.member-card>summary::-webkit-details-marker{display:none}.add-card[open]>summary,.team-card[open]>summary,.archive[open]>summary{border-bottom:1px solid #334155}.add-card form{padding:20px}.team-members{padding:16px}.open-label{color:#93c5fd;font-weight:800;font-size:13px}.archive{margin-top:28px}.archive>p{padding:0 20px}.archive>.member-card{margin:12px 20px}.team-card small{display:block;color:#94a3b8;margin-top:4px}

                .member-title {
                        display: flex;
                        justify-content: space-between;
                        align-items: start;
			margin:0;padding:17px 20px;cursor:pointer;list-style:none;
                }
		.member-form{padding:0 20px 20px;border-top:1px solid #273449}

                .status {
                        padding: 5px 10px;
                        border-radius: 999px;
                        font-size: 12px;
                        font-weight: 700;
                }

                .active {
			background:#1e3a8a;color:#bfdbfe;
                }

                .inactive {
			background:#3f3f46;color:#e4e4e7;
                }

                .form-grid {
                        display: grid;
                        grid-template-columns:
                                repeat(4, minmax(150px, 1fr));
                        gap: 14px;
                }

                label {
                        display: grid;
                        gap: 6px;
			color:#cbd5e1;
                        font-size: 14px;
                }

                input,
                select {
                        width:  100%;
			border:1px solid #475569;
                        border-radius: 8px;
                        padding: 10px;
			background:#0b1220;color:#f8fafc;
                }

                fieldset {
			border:1px solid #334155;
                        border-radius: 10px;
                        margin: 18px 0;
                }

                .days,
                .toggles {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 14px;
                }

                .day,
                .toggles label {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                }

                .day input,
                .toggles input {
                        width: auto;
                }

                button {
                        margin-top: 18px;
                        border: 0;
                        border-radius: 9px;
                        padding: 11px 16px;
                        color: white;
			background:linear-gradient(135deg,#2563eb,#7c3aed);
                        font-weight: 700;
                        cursor: pointer;
                }

                .privacy {
			color:#94a3b8;
                        font-size: 13px;
                }

                @media (max-width: 850px) {
                        body {
                                padding: 16px;
                        }

                        header {
                                align-items: start;
                                flex-direction: column;
                        }

                        .form-grid {
                                grid-template-columns: 1fr;
                        }
                }
        </style>
</head>
<body>
        <main>
                <header>
                        <div>
                                <h1>Member scheduling</h1>
                                <p>
                                        Manage local times, working days
                                        and automation.
                                </p>
                        </div>
                        <a href="/dashboard?project=${projectId}">
                                Return to dashboard
                        </a>
                </header>

                ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ''}

                ${activationLink ? `<div class="notice"><strong>Employee activation link (valid for 24 hours)</strong><p>Send this private, single-use link to the employee's work email:</p><input value="${escapeHtml(activationLink)}" readonly aria-label="Employee activation link"></div>` : ''}

                ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}

                <section class="add-card">
                        <h2>${departmentScope ? `${escapeHtml(departmentScope)} team stand-up` : 'Project stand-up'}</h2>
                        <p>Send today's request to ${departmentScope ? 'your assigned team' : 'active employees'} whose automated messages are enabled. Anyone already sent an initial request today is skipped.</p>
                        <details>
                                <summary>Send stand-up now</summary>
                                <form method="post">
                                        <input type="hidden" name="action" value="send_now">
                                        <p>This sends a real WhatsApp template message${departmentScope ? ' only to your team' : ''}.</p>
                                        <button type="submit">Confirm and send now</button>
                                </form>
                        </details>
                </section>

		<details class="add-card"><summary><strong>＋ Add new team member</strong><span class="open-label">Open form</span></summary><form method="post">
                        <input
                                type="hidden"
                                name="action"
                                value="add"
                        >

                        <h2>Add team member</h2>
                        <p>
                                Add a work email now. The employee can connect
                                their own WhatsApp number using an invitation.
                        </p>

                        <div class="form-grid">
                                <label>
                                        Name
                                        <input
                                                name="name"
                                                maxlength="80"
                                                required
                                        >
                                </label>

                                <label>
                                        Department
                                        <input
                                                name="department"
                                                maxlength="100"
                                                required
                                        >
                                </label>

                                <label>
                                        Work email
                                        <input
                                                name="email"
                                                type="email"
                                                maxlength="254"
                                                placeholder="name@company.com"
                                        >
                                </label>

                                <label>
                                        WhatsApp number (optional)
                                        <input
                                                name="phone"
                                                inputmode="numeric"
                                                autocomplete="off"
                                                maxlength="15"
                                                placeholder="Country code and number"
                                        >
                                </label>

                                <label>
                                        Timezone
                                        <select name="timezone" required>
                                                <option value="Asia/Kolkata">
                                                        India
                                                        (Asia/Kolkata)
                                                </option>
                                                <option value="Europe/London">
                                                        United Kingdom
                                                        (Europe/London)
                                                </option>
                                        </select>
                                </label>
                        </div>

                        <button type="submit">
                                Add member
                        </button>
                </form></details>

                ${cards}
		${archive}

                <p class="privacy">
                        Private management page. Phone numbers are never
                        returned in page content.
                </p>
        </main>
</body>
</html>`;
}

async function renderManagementPage(
	request: Request,
	env: WorkerEnv,
	principal: ManagementPrincipal,
	projectId: number,
	error: string | null = null,
	departmentScope: string | null = null,
): Promise<Response> {
	if (!isAuthorised(request, env)) {
		return authenticationRequired();
	}

	const members = await getMembers(env.DB, principal.tenantId, projectId, departmentScope);
	const params = new URL(request.url).searchParams;
	const updated = params.get('updated');
	const activationToken = params.get('activation');
	const activationLink = activationToken
		? `${new URL(request.url).origin}/employee/activate?token=${encodeURIComponent(activationToken)}`
		: null;

	const message = updated === 'member'
		? 'Member schedule updated successfully.'
		: updated === 'added'
			? 'Team member added successfully.'
			: updated === 'sent'
				? `Stand-up request completed: ${params.get('sent') ?? '0'} sent, ${params.get('skipped') ?? '0'} already sent today, ${params.get('failed') ?? '0'} failed.`
				: null;

	return htmlResponse(page(members, message, error, activationLink, projectId, departmentScope), error ? 400 : 200);
}

interface AddMemberResult {
	error: string | null;
	activationToken?: string;
}

async function addMember(form: FormData, env: WorkerEnv, principal: ManagementPrincipal, projectId: number, departmentScope: string | null = null): Promise<AddMemberResult> {
	const name = String(form.get('name') ?? '').trim();

	const department = departmentScope ?? String(form.get('department') ?? '').trim();

	const phone = String(form.get('phone') ?? '').replace(/\D/g, '');
	const email = String(form.get('email') ?? '').trim().toLowerCase();

	const timezone = String(form.get('timezone') ?? '');

	if (!name || name.length > 80 || !department || department.length > 100) {
		return { error: 'Enter a valid name and department.' };
	}

	if (phone && !validPhone(phone)) {
		return { error: 'Enter a valid WhatsApp number with country code or leave it blank.' };
	}

	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return { error: 'Enter a valid work email.' };
	}

	if (!phone && !email) {
		return { error: 'Enter a work email or WhatsApp number.' };
	}

	if (!allowedTimezones.has(timezone)) {
		return { error: 'Select a supported timezone.' };
	}

	try {
		const storedPhone = phone || `pending-${crypto.randomUUID()}`;
		const enrolmentStatus = 'invited';
		const inserted = await env.DB.prepare(
			`
                                INSERT INTO team_members (
                                        name,
                                        phone,
                                        department,
                                        timezone,
                                        tenant_id,
                                        primary_project_id,
                                        email,
                                        enrolment_status,
                                        scheduling_enabled
                                )
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                RETURNING id
                                `,
		)
			.bind(
				name,
				storedPhone,
				department,
				timezone,
				principal.tenantId,
				projectId,
				email || null,
				enrolmentStatus,
				0,
			)
			.first<{ id: number }>();
		if (!inserted) throw new Error('Member was not inserted.');
		await env.DB.prepare(
			`
                        INSERT INTO team_member_projects (project_id, team_member_id)
                        VALUES (?, ?)
                `,
		)
			.bind(projectId, inserted.id)
			.run();
		const activationToken = email
			? await createEmployeeActivation(env.DB, inserted.id, principal.tenantId, email)
			: undefined;
		return { error: null, activationToken };
	} catch {
		return { error: 'The member could not be added. The email or phone number may already exist.' };
	}
}

async function updateMember(form: FormData, env: WorkerEnv, principal: ManagementPrincipal, projectId: number, departmentScope: string | null = null): Promise<string | null> {
	const memberId = Number(form.get('member_id'));

	const timezone = String(form.get('timezone') ?? '');

	const initialTime = String(form.get('initial_time') ?? '');

	const reminder1Time = String(form.get('reminder_1_time') ?? '');

	const reminder2Time = String(form.get('reminder_2_time') ?? '');

	const workingDays = normaliseWorkingDays(form);

	const active = form.get('active') === '1' ? 1 : 0;

	const schedulingEnabled = form.get('scheduling_enabled') === '1' ? 1 : 0;

	if (!Number.isInteger(memberId) || memberId <= 0) {
		return 'Invalid team member.';
	}

	if (!allowedTimezones.has(timezone)) {
		return 'Select a supported timezone.';
	}

	if (!validTime(initialTime) || !validTime(reminder1Time) || !validTime(reminder2Time)) {
		return 'Times must use valid 15-minute intervals.';
	}

	if (
		minutesFromMidnight(initialTime) >= minutesFromMidnight(reminder1Time) ||
		minutesFromMidnight(reminder1Time) >= minutesFromMidnight(reminder2Time)
	) {
		return 'Initial request and reminders must be in chronological order.';
	}

	if (!workingDays) {
		return 'Select at least one working day.';
	}

	const result = await env.DB.prepare(
		`
                        UPDATE team_members
                        SET
                                timezone = ?,
                                working_days = ?,
                                initial_time = ?,
                                reminder_1_time = ?,
                                reminder_2_time = ?,
                                active = ?,
                                scheduling_enabled = ?
                        WHERE id = ? AND tenant_id = ?
                                AND (? IS NULL OR department = ?)
                                AND (
                                        primary_project_id = ?
                                        OR EXISTS (
                                        SELECT 1 FROM team_member_projects
                                        WHERE team_member_id = team_members.id
                                                AND project_id = ?
                                        )
                                )
                        `,
	)
		.bind(
			timezone,
			workingDays,
			initialTime,
			reminder1Time,
			reminder2Time,
			active,
			schedulingEnabled,
			memberId,
			principal.tenantId,
			departmentScope,
			departmentScope,
			projectId,
			projectId,
		)
		.run();

	if (!result.meta.changes) {
		return 'Team member was not found.';
	}

	return null;
}

export async function memberManagementResponse(request: Request, env: WorkerEnv): Promise<Response> {
	if (!isAuthorised(request, env)) {
		return authenticationRequired();
	}

	const principal = managementPrincipalFromRequest(request) ?? {
		userId: 1,
		tenantId: 1,
		role: 'admin' as const,
	};
	const projectId = Number(new URL(request.url).searchParams.get('project') ?? 1);
	if (!Number.isSafeInteger(projectId) || projectId <= 0) {
		return new Response('Invalid project.', { status: 400 });
	}
	try {
		await requireProjectAccess(env.DB, principal, projectId);
	} catch {
		return new Response('Project access denied.', { status: 403 });
	}
	const departmentScope = await teamLeadDepartment(env.DB, principal, projectId);
	if (principal.role === 'team_lead' && !departmentScope) return new Response('Team Lead assignment was not found.', { status: 403 });

	if (request.method === 'GET') {
		return renderManagementPage(request, env, principal, projectId, null, departmentScope);
	}

	if (request.method !== 'POST') {
		return new Response('Method not allowed.', {
			status: 405,
			headers: {
				Allow: 'GET, POST',
			},
		});
	}

	if (!validateSameOrigin(request)) {
		return new Response('Invalid request origin.', { status: 403 });
	}

	const form = await request.formData();
	const action = String(form.get('action') ?? '');

	let error: string | null;
	let redirectValue: string;

	if (action === 'add') {
		const result = await addMember(form, env, principal, projectId, departmentScope);
		error = result.error;
		redirectValue = 'added';
		if (!error && result.activationToken) {
			return new Response(null, {
				status: 303,
				headers: {
					Location: `/dashboard/members?project=${projectId}&updated=added&activation=${encodeURIComponent(result.activationToken)}`,
					'Cache-Control': 'no-store',
				},
			});
		}
	} else if (action === 'update') {
		error = await updateMember(form, env, principal, projectId, departmentScope);
		redirectValue = 'member';
	} else if (action === 'send_now') {
		if (env.AUTOMATION_ENABLED !== 'true') {
			error = 'Automation is globally paused. No messages were sent.';
			redirectValue = '';
		} else {
			const result = departmentScope !== null
				? await runDepartmentInitialNow(env, principal.tenantId, projectId, departmentScope)
				: await runProjectInitialNow(env, principal.tenantId, projectId);
			return new Response(null, {
				status: 303,
				headers: {
					Location: `/dashboard/members?project=${projectId}&updated=sent&sent=${result.sent}&skipped=${result.skipped}&failed=${result.failed}`,
				},
			});
		}
	} else {
		error = 'Invalid management action.';
		redirectValue = '';
	}

	if (error) {
		return renderManagementPage(request, env, principal, projectId, error, departmentScope);
	}

	return new Response(null, {
		status: 303,
		headers: {
			Location: `/dashboard/members?project=${projectId}&updated=${redirectValue}`,
		},
	});
}
