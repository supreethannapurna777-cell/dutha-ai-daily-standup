import type { WorkerEnv } from './env';
import { managementPrincipalFromRequest, requireProjectAccess, type ManagementPrincipal } from './access-control';
import { sendTextMessage, type Fetcher } from './whatsapp';

interface CaseRow {
	id: number;
	requester_member_id: number;
	requester_name: string;
	responsible_member_id: number | null;
	responsible_name: string | null;
	case_type: string;
	issue_summary: string;
	status: string;
	priority: string;
	meeting_duration_minutes: number;
	proposed_time: string | null;
	meeting_link: string | null;
	manager_notes: string | null;
	resolution_state: string;
	sla_due_at: string | null;
	resolution_summary: string | null;
	resolution_proposed_at: string | null;
	resolution_verified_at: string | null;
	requested_at: string;
	updated_at: string;
}

interface MemberOption {
	id: number;
	name: string;
	department: string;
}

const allowedDurations = new Set([15, 20, 30, 45, 60]);

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

function validOrigin(request: Request): boolean {
	const expectedOrigin = new URL(request.url).origin;
	const origin = request.headers.get('Origin');

	if (origin && origin !== 'null') {
		return origin === expectedOrigin;
	}

	return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

function formatStatus(status: string): string {
	const readable = status.replace(/_/g, ' ');

	return readable.charAt(0).toUpperCase() + readable.slice(1);
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

async function getCases(db: D1Database, tenantId: number, projectId: number): Promise<CaseRow[]> {
	const result = await db
		.prepare(
			`
                        SELECT
                                coordination.id,
                                coordination.requester_member_id,
                                requester.name
                                        AS requester_name,
                                coordination.responsible_member_id,
                                responsible.name
                                        AS responsible_name,
                                coordination.case_type,
                                coordination.issue_summary,
                                coordination.status,
                                coordination.priority,
                                coordination.meeting_duration_minutes,
                                coordination.proposed_time,
                                coordination.meeting_link,
                                coordination.manager_notes,
                                coordination.resolution_state,
                                coordination.sla_due_at,
                                coordination.resolution_summary,
                                coordination.resolution_proposed_at,
                                coordination.resolution_verified_at,
                                coordination.requested_at,
                                coordination.updated_at
                        FROM coordination_cases
                                AS coordination
                        INNER JOIN team_members
                                AS requester
                                ON requester.id
                                        = coordination.requester_member_id
                        LEFT JOIN team_members
                                AS responsible
                                ON responsible.id
                                        = coordination.responsible_member_id
                        WHERE coordination.tenant_id = ?
                                AND coordination.project_id = ?
                        ORDER BY
                                CASE coordination.status
                                        WHEN 'pending_assignment'
                                                THEN 1
                                        WHEN 'pending_approval'
                                                THEN 2
                                        WHEN 'approved'
                                                THEN 3
                                        WHEN 'availability_requested'
                                                THEN 4
                                        WHEN 'time_agreed'
                                                THEN 5
                                        WHEN 'scheduled'
                                                THEN 6
                                        WHEN 'in_progress'
                                                THEN 7
                                        ELSE 8
                                END,
                                coordination.requested_at DESC
                        `,
		)
		.bind(tenantId, projectId)
		.all<CaseRow>();

	return result.results;
}

async function getMembers(db: D1Database, tenantId: number, projectId: number): Promise<MemberOption[]> {
	const result = await db
		.prepare(
			`
                        SELECT id, name, department
                        FROM team_members
                        WHERE active = 1 AND tenant_id = ?
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
		.bind(tenantId, projectId, projectId)
		.all<MemberOption>();

	return result.results;
}

function memberOptions(members: MemberOption[], currentMemberId: number | null, requesterMemberId: number): string {
	const available = members.filter((member) => member.id !== requesterMemberId);

	return [
		`<option value="">Select responsible person</option>`,
		...available.map(
			(member) => `
                        <option
                                value="${member.id}"
                                ${member.id === currentMemberId ? 'selected' : ''}
                        >
                                ${escapeHtml(member.name)}
                                — ${escapeHtml(member.department)}
                        </option>
                `,
		),
	].join('');
}

function caseCard(coordinationCase: CaseRow, members: MemberOption[]): string {
	const canDecide = ['pending_assignment', 'pending_approval'].includes(coordinationCase.status);

	const canResolve = ['approved', 'availability_requested', 'time_agreed', 'scheduled', 'in_progress'].includes(coordinationCase.status);

	const canSchedule = coordinationCase.status === 'time_agreed' && coordinationCase.proposed_time;
	const canVerify = coordinationCase.resolution_state === 'awaiting_verification';
	const canEscalate = !['resolved', 'awaiting_verification'].includes(coordinationCase.resolution_state);

	return `
                <article class="case-card">
                        <div class="case-header">
                                <div>
                                        <div class="case-number">
                                                Case #${coordinationCase.id}
                                        </div>
                                        <h2>${escapeHtml(coordinationCase.issue_summary)}</h2>
                                </div>

                                <div class="badges">
                                        <span class="badge ${escapeHtml(coordinationCase.priority)}">
                                                ${escapeHtml(coordinationCase.priority)}
                                        </span>
                                        <span class="badge status">
                                                ${escapeHtml(formatStatus(coordinationCase.status))}
                                        </span>
                                        <span class="badge lifecycle">
                                                ${escapeHtml(formatStatus(coordinationCase.resolution_state))}
                                        </span>
                                </div>
                        </div>

                        <div class="case-details">
                                <div>
                                        <strong>Requester</strong>
                                        <span>${escapeHtml(coordinationCase.requester_name)}</span>
                                </div>

                                <div>
                                        <strong>Responsible person</strong>
                                        <span>${escapeHtml(coordinationCase.responsible_name ?? 'Not assigned')}</span>
                                </div>

                                <div>
                                        <strong>Type</strong>
                                        <span>${escapeHtml(coordinationCase.case_type)}</span>
                                </div>

                                <div>
                                        <strong>Duration</strong>
                                        <span>
                                                ${coordinationCase.meeting_duration_minutes} minutes
                                        </span>
                                </div>
                                <div>
                                        <strong>SLA due</strong>
                                        <span>${escapeHtml(coordinationCase.sla_due_at ? new Date(coordinationCase.sla_due_at).toLocaleString('en-IN') : 'Set after triage')}</span>
                                </div>
                        </div>

                        ${
													canDecide
														? `
                                                <form method="post">
                                                        <input
                                                                type="hidden"
                                                                name="case_id"
                                                                value="${coordinationCase.id}"
                                                        >

                                                        <div class="form-grid">
                                                                <label>
                                                                        Responsible person
                                                                        <select
                                                                                name="responsible_member_id"
                                                                                required
                                                                        >
                                                                                ${memberOptions(
																																									members,
																																									coordinationCase.responsible_member_id,
																																									coordinationCase.requester_member_id,
																																								)}
                                                                        </select>
                                                                </label>

                                                                <label>
                                                                        Discussion duration
                                                                        <select
                                                                                name="meeting_duration_minutes"
                                                                        >
                                                                                ${[15, 20, 30, 45, 60]
																																									.map(
																																										(duration) => `
                                                                                                        <option
                                                                                                                value="${duration}"
                                                                                                                ${
																																																									duration ===
																																																									coordinationCase.meeting_duration_minutes
																																																										? 'selected'
																																																										: ''
																																																								}
                                                                                                        >
                                                                                                                ${duration} minutes
                                                                                                        </option>
                                                                                                `,
																																									)
																																									.join('')}
                                                                        </select>
                                                                </label>
                                                        </div>

                                                        <label>
                                                                Manager notes
                                                                <textarea
                                                                        name="manager_notes"
                                                                        maxlength="500"
                                                                        placeholder="Optional instructions or context"
                                                                >${escapeHtml(coordinationCase.manager_notes ?? '')}</textarea>
                                                        </label>

                                                        <div class="actions">
                                                                <button
                                                                        name="action"
                                                                        value="approve"
                                                                        class="approve"
                                                                >
                                                                        Approve
                                                                </button>

                                                                <button
                                                                        name="action"
                                                                        value="reject"
                                                                        class="reject"
                                                                        formnovalidate
                                                                >
                                                                        Reject
                                                                </button>
                                                        </div>
                                                </form>
                                        `
														: ''
												}

                        ${
													canSchedule
														? `
                                                <form method="post">
                                                        <input
                                                                type="hidden"
                                                                name="case_id"
                                                                value="${coordinationCase.id}"
                                                        >

                                                        <label>
                                                                Meeting link
                                                                <input
                                                                        type="url"
                                                                        name="meeting_link"
                                                                        value="${escapeHtml(coordinationCase.meeting_link ?? '')}"
                                                                        placeholder="https://teams.microsoft.com/..."
                                                                        maxlength="2048"
                                                                        required
                                                                >
                                                        </label>

                                                        <button
                                                                name="action"
                                                                value="schedule"
                                                                class="approve"
                                                        >
                                                                Save link and notify participants
                                                        </button>
                                                </form>
                                        `
														: ''
												}

                        ${
													coordinationCase.meeting_link && coordinationCase.status === 'scheduled'
														? `
                                                <div class="notes">
                                                        <strong>Meeting link:</strong>
                                                        <a
                                                                href="${escapeHtml(coordinationCase.meeting_link)}"
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                        >
                                                                Open meeting
                                                        </a>
                                                </div>
                                        `
														: ''
												}

                        ${
													canResolve
														? `
                                                <div class="actions">
                                                        <a
                                                                class="availability-link"
                                                                href="/dashboard/availability?case=${coordinationCase.id}"
                                                        >
                                                                Manage availability
                                                        </a>
                                                </div>

                                                <form method="post">
                                                        <input
                                                                type="hidden"
                                                                name="case_id"
                                                                value="${coordinationCase.id}"
                                                        >

                                                        <label>
                                                                Resolution note
                                                                <textarea
                                                                        name="manager_notes"
                                                                        maxlength="500"
                                                                        placeholder="How was the blocker resolved?"
                                                                        required
                                                                ></textarea>
                                                        </label>

                                                        <button
                                                                name="action"
                                                                value="resolve"
                                                                class="resolve"
                                                        >
                                                                Submit for verification
                                                        </button>
                                                </form>
                                        `
														: ''
										}

                        ${canVerify ? `
                                <form method="post">
                                        <input type="hidden" name="case_id" value="${coordinationCase.id}">
                                        <label>Verification note
                                                <textarea name="manager_notes" maxlength="500" placeholder="What evidence confirms the blocker is gone?" required></textarea>
                                        </label>
                                        <button name="action" value="verify_resolution" class="resolve">Verify and close</button>
                                </form>
                        ` : ''}

                        ${canEscalate ? `
                                <form method="post">
                                        <input type="hidden" name="case_id" value="${coordinationCase.id}">
                                        <label>Escalation reason
                                                <textarea name="manager_notes" maxlength="500" placeholder="Why does this need escalation?" required></textarea>
                                        </label>
                                        <button name="action" value="escalate" class="reject">Escalate blocker</button>
                                </form>
                        ` : ''}

                        ${coordinationCase.resolution_summary ? `<div class="notes"><strong>Resolution evidence:</strong> ${escapeHtml(coordinationCase.resolution_summary)}</div>` : ''}

                        ${
													coordinationCase.manager_notes
														? `
                                                <div class="notes">
                                                        <strong>Manager notes:</strong>
                                                        ${escapeHtml(coordinationCase.manager_notes)}
                                                </div>
                                        `
														: ''
												}
                </article>
        `;
}

function page(cases: CaseRow[], members: MemberOption[], message: string | null, error: string | null): string {
	const openCount = cases.filter((coordinationCase) => !['resolved', 'rejected', 'cancelled'].includes(coordinationCase.status)).length;

	const pendingCount = cases.filter((coordinationCase) =>
		['pending_assignment', 'pending_approval'].includes(coordinationCase.status),
	).length;

	const criticalCount = cases.filter(
		(coordinationCase) =>
			coordinationCase.priority === 'critical' && !['resolved', 'rejected', 'cancelled'].includes(coordinationCase.status),
	).length;

	const cards = cases.length
		? cases.map((coordinationCase) => caseCard(coordinationCase, members)).join('')
		: `
                        <div class="empty">
                                No coordination cases created yet.
                        </div>
                `;

	return `<!DOCTYPE html>
<html lang="en">
<head>
        <meta charset="UTF-8">
        <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
        >
        <title>Coordination Cases | Dutha WorkOps</title>
        <style>
                :root {
                        font-family: Inter, Arial, sans-serif;
                        color: #172033;
                        background: #f4f7fb;
                }

                * {
                        box-sizing: border-box;
                }

                body {
                        margin: 0;
                        padding: 32px;
                }

                main {
                        max-width: 1150px;
                        margin: auto;
                }

                header {
                        display: flex;
                        justify-content: space-between;
                        gap: 20px;
                        align-items: center;
                }

                h1 {
                        color: #173f6b;
                        margin-bottom: 5px;
                }

                h2 {
                        margin: 5px 0 0;
                        font-size: 19px;
                }

                p {
                        color: #64748b;
                }

                a {
                        color: #1769aa;
                        font-weight: 700;
                }

                .metrics {
                        display: grid;
                        grid-template-columns: repeat(3, 1fr);
                        gap: 15px;
                        margin: 24px 0;
                }

                .metric,
                .case-card,
                .empty {
                        background: white;
                        border-radius: 13px;
                        box-shadow: 0 3px 14px #0f172a12;
                }

                .metric {
                        padding: 18px;
                }

                .metric strong {
                        display: block;
                        color: #173f6b;
                        font-size: 28px;
                        margin-top: 7px;
                }

                .notice,
                .error {
                        border-radius: 9px;
                        padding: 13px;
                        margin-top: 18px;
                }

                .notice {
                        background: #dcfce7;
                        color: #166534;
                }

                .error {
                        background: #fee2e2;
                        color: #991b1b;
                }

                .case-card {
                        padding: 20px;
                        margin-bottom: 18px;
                }

                .case-header,
                .badges,
                .actions {
                        display: flex;
                        justify-content: space-between;
                        gap: 10px;
                        align-items: start;
                }

                .case-number {
                        color: #64748b;
                        font-size: 13px;
                }

                .badge {
                        padding: 6px 9px;
                        border-radius: 999px;
                        font-size: 12px;
                        font-weight: 700;
                        text-transform: capitalize;
                }

                .status {
                        color: #1e3a5f;
                        background: #dbeafe;
                }

                .lifecycle {
                        color: #5b21b6;
                        background: #ede9fe;
                }

                .normal {
                        color: #475569;
                        background: #e2e8f0;
                }

                .high {
                        color: #9a3412;
                        background: #ffedd5;
                }

                .critical {
                        color: #991b1b;
                        background: #fee2e2;
                }

                .case-details,
                .form-grid {
                        display: grid;
                        grid-template-columns:
                                repeat(4, minmax(140px, 1fr));
                        gap: 14px;
                        margin: 18px 0;
                }

                .case-details div {
                        display: grid;
                        gap: 5px;
                }

                .case-details span {
                        color: #475569;
                }

                label {
                        display: grid;
                        gap: 7px;
                        color: #334155;
                        margin-top: 12px;
                }

                select,
                textarea {
                        width: 100%;
                        border: 1px solid #cbd5e1;
                        border-radius: 8px;
                        padding: 10px;
                        background: white;
                }

                textarea {
                        min-height: 75px;
                        resize: vertical;
                }

                button {
                        border: 0;
                        color: white;
                        border-radius: 8px;
                        padding: 10px 15px;
                        font-weight: 700;
                        cursor: pointer;
                }

                .availability-link {
                        display: inline-block;
                        color: white;
                        background: #7c3aed;
                        border-radius: 8px;
                        padding: 10px 15px;
                        font-weight: 700;
                        text-decoration: none;
                }
                .actions {
                        justify-content: flex-start;
                        margin-top: 14px;
                }

                .approve,
                .resolve {
                        background: #15803d;
                }

                .reject {
                        background: #b91c1c;
                }

                .notes {
                        margin-top: 15px;
                        background: #f8fafc;
                        padding: 12px;
                        border-radius: 8px;
                }

                .empty {
                        padding: 35px;
                        text-align: center;
                        color: #64748b;
                }

                @media (max-width: 800px) {
                        body {
                                padding: 16px;
                        }

                        header {
                                align-items: start;
                                flex-direction: column;
                        }

                        .metrics,
                        .case-details,
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
                                <h1>Coordination cases</h1>
                                <p>
                                        Review blockers, assign owners
                                        and record decisions.
                                </p>
                        </div>

                        <a href="/dashboard">
                                Return to dashboard
                        </a>
                </header>

                <section class="metrics">
                        <div class="metric">
                                Open cases
                                <strong>${openCount}</strong>
                        </div>

                        <div class="metric">
                                Awaiting manager
                                <strong>${pendingCount}</strong>
                        </div>

                        <div class="metric">
                                Critical
                                <strong>${criticalCount}</strong>
                        </div>
                </section>

                ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ''}

                ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}

                ${cards}
        </main>
</body>
</html>`;
}

async function renderPage(
	request: Request,
	env: WorkerEnv,
	principal: ManagementPrincipal,
	projectId: number,
	error: string | null = null,
): Promise<Response> {
	const [cases, members] = await Promise.all([
		getCases(env.DB, principal.tenantId, projectId),
		getMembers(env.DB, principal.tenantId, projectId),
	]);

	const updated = new URL(request.url).searchParams.get('updated');

	const message =
		updated === 'approved'
			? 'Coordination case approved.'
			: updated === 'rejected'
				? 'Coordination case rejected.'
				: updated === 'scheduled'
					? 'Meeting scheduled and participants notified.'
					: updated === 'resolved'
						? 'Coordination case resolved.'
						: updated === 'verification'
							? 'Resolution recorded and awaiting verification.'
							: updated === 'escalated'
								? 'Coordination case escalated.'
						: null;

	return htmlResponse(page(cases, members, message, error), error ? 400 : 200);
}

async function getCase(db: D1Database, caseId: number, tenantId: number, projectId: number): Promise<CaseRow | null> {
	return db
		.prepare(
			`
                        SELECT
                                coordination.id,
                                coordination.requester_member_id,
                                requester.name
                                        AS requester_name,
                                coordination.responsible_member_id,
                                responsible.name
                                        AS responsible_name,
                                coordination.case_type,
                                coordination.issue_summary,
                                coordination.status,
                                coordination.priority,
                                coordination.meeting_duration_minutes,
                                coordination.proposed_time,
                                coordination.meeting_link,
                                coordination.manager_notes,
                                coordination.resolution_state,
                                coordination.sla_due_at,
                                coordination.resolution_summary,
                                coordination.resolution_proposed_at,
                                coordination.resolution_verified_at,
                                coordination.requested_at,
                                coordination.updated_at
                        FROM coordination_cases
                                AS coordination
                        INNER JOIN team_members
                                AS requester
                                ON requester.id
                                        = coordination.requester_member_id
                        LEFT JOIN team_members
                                AS responsible
                                ON responsible.id
                                        = coordination.responsible_member_id
                        WHERE coordination.id = ?
                                AND coordination.tenant_id = ?
                                AND coordination.project_id = ?
                        `,
		)
		.bind(caseId, tenantId, projectId)
		.first<CaseRow>();
}

async function recordManagerEvent(db: D1Database, caseId: number, eventType: string, details: string): Promise<void> {
	await db
		.prepare(
			`
                        INSERT INTO case_events (
                                case_id,
                                event_type,
                                actor_type,
                                details
                        )
                        VALUES (?, ?, 'manager', ?)
                        `,
		)
		.bind(caseId, eventType, details)
		.run();
}

function validMeetingLink(value: string): boolean {
	if (!value || value.length > 2048) {
		return false;
	}

	try {
		const url = new URL(value);

		return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
	} catch {
		return false;
	}
}

function formatMeetingTime(value: string): string {
	const date = new Date(value);

	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return (
		new Intl.DateTimeFormat('en-US', {
			dateStyle: 'medium',
			timeStyle: 'short',
			timeZone: 'UTC',
		}).format(date) + ' UTC'
	);
}

async function participantWasNotified(db: D1Database, caseId: number, memberId: number): Promise<boolean> {
	const event = await db
		.prepare(
			`
                        SELECT id
                        FROM case_events
                        WHERE case_id = ?
                                AND event_type =
                                        'meeting_link_notification_sent'
                                AND actor_member_id = ?
                        LIMIT 1
                        `,
		)
		.bind(caseId, memberId)
		.first<{ id: number }>();

	return Boolean(event);
}

async function recordParticipantNotification(db: D1Database, caseId: number, memberId: number): Promise<void> {
	await db
		.prepare(
			`
                        INSERT INTO case_events (
                                case_id,
                                event_type,
                                actor_type,
                                actor_member_id,
                                details
                        )
                        VALUES (
                                ?,
                                'meeting_link_notification_sent',
                                'system',
                                ?,
                                'Meeting details sent by WhatsApp'
                        )
                        `,
		)
		.bind(caseId, memberId)
		.run();
}

async function notifyParticipants(
	coordinationCase: CaseRow,
	meetingLink: string,
	env: WorkerEnv,
	fetcher: Fetcher,
): Promise<string | null> {
	if (!coordinationCase.responsible_member_id || !coordinationCase.proposed_time) {
		return 'The case is missing scheduling information.';
	}

	const participants = await env.DB.prepare(
		`
                        SELECT id, phone
                        FROM team_members
                        WHERE id IN (?, ?)
                        ORDER BY id
                        `,
	)
		.bind(coordinationCase.requester_member_id, coordinationCase.responsible_member_id)
		.all<{
			id: number;
			phone: string;
		}>();

	if (participants.results.length !== 2) {
		return 'Both participants must exist before scheduling.';
	}

	const message = [
		'Discussion scheduled',
		`Case #${coordinationCase.id}`,
		`Time: ${formatMeetingTime(coordinationCase.proposed_time)}`,
		`Duration: ${coordinationCase.meeting_duration_minutes} minutes`,
		`Join: ${meetingLink}`,
	].join('\n');

	for (const participant of participants.results) {
		if (await participantWasNotified(env.DB, coordinationCase.id, participant.id)) {
			continue;
		}

		const result = await sendTextMessage(env, participant.phone, message, fetcher);

		if (!result.success) {
			return 'Meeting link saved, but a WhatsApp notification failed. Submit again to retry.';
		}

		await recordParticipantNotification(env.DB, coordinationCase.id, participant.id);
	}

	return null;
}

async function processDecision(
	form: FormData,
	env: WorkerEnv,
	fetcher: Fetcher,
	principal: ManagementPrincipal,
	projectId: number,
): Promise<{
	error: string | null;
	redirect: string | null;
}> {
	const caseId = Number(form.get('case_id'));

	const action = String(form.get('action') ?? '');

	const notes = String(form.get('manager_notes') ?? '').trim();

	if (!Number.isInteger(caseId) || caseId <= 0) {
		return {
			error: 'Invalid coordination case.',
			redirect: null,
		};
	}

	if (notes.length > 500) {
		return {
			error: 'Manager notes are too long.',
			redirect: null,
		};
	}

	const coordinationCase = await getCase(env.DB, caseId, principal.tenantId, projectId);

	if (!coordinationCase) {
		return {
			error: 'Coordination case was not found.',
			redirect: null,
		};
	}

	if (action === 'approve') {
		if (!['pending_assignment', 'pending_approval'].includes(coordinationCase.status)) {
			return {
				error: 'This case is no longer awaiting approval.',
				redirect: null,
			};
		}

		const responsibleMemberId = Number(form.get('responsible_member_id'));

		const duration = Number(form.get('meeting_duration_minutes'));

		if (
			!Number.isInteger(responsibleMemberId) ||
			responsibleMemberId <= 0 ||
			responsibleMemberId === coordinationCase.requester_member_id
		) {
			return {
				error: 'Select a valid responsible person.',
				redirect: null,
			};
		}

		if (!allowedDurations.has(duration)) {
			return {
				error: 'Select a valid discussion duration.',
				redirect: null,
			};
		}

		const responsible = await env.DB.prepare(
			`
                                        SELECT id, name
                                        FROM team_members
                                        WHERE id = ?
                                                AND active = 1
                                                AND tenant_id = ?
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
			.bind(responsibleMemberId, principal.tenantId, projectId, projectId)
			.first<{
				id: number;
				name: string;
			}>();

		if (!responsible) {
			return {
				error: 'Responsible person was not found.',
				redirect: null,
			};
		}

		await env.DB.prepare(
			`
                                UPDATE coordination_cases
                                SET
                                        responsible_member_id = ?,
                                        meeting_duration_minutes = ?,
                                        manager_notes = ?,
                                        status = 'approved',
                                        resolution_state = 'triaged',
                                        sla_due_at = COALESCE(
                                                sla_due_at,
                                                datetime('now', CASE priority
                                                        WHEN 'critical' THEN '+4 hours'
                                                        WHEN 'high' THEN '+1 day'
                                                        WHEN 'normal' THEN '+3 days'
                                                        ELSE '+5 days'
                                                END)
                                        ),
                                        approved_at = CURRENT_TIMESTAMP,
                                        updated_at = CURRENT_TIMESTAMP
                                WHERE id = ?
                                `,
		)
			.bind(responsible.id, duration, notes || null, caseId)
			.run();

		await recordManagerEvent(env.DB, caseId, 'case_approved', `Approved and assigned to ${responsible.name}`);

		return {
			error: null,
			redirect: 'approved',
		};
	}

	if (action === 'reject') {
		if (!['pending_assignment', 'pending_approval'].includes(coordinationCase.status)) {
			return {
				error: 'This case cannot be rejected now.',
				redirect: null,
			};
		}

		await env.DB.prepare(
			`
                                UPDATE coordination_cases
                                SET
                                        status = 'rejected',
                                        manager_notes = ?,
                                        updated_at = CURRENT_TIMESTAMP
                                WHERE id = ?
                                `,
		)
			.bind(notes || null, caseId)
			.run();

		await recordManagerEvent(env.DB, caseId, 'case_rejected', notes || 'Rejected by manager');

		return {
			error: null,
			redirect: 'rejected',
		};
	}

	if (action === 'schedule') {
		const meetingLink = String(form.get('meeting_link') ?? '').trim();

		if (coordinationCase.status === 'scheduled' && coordinationCase.meeting_link === meetingLink) {
			return {
				error: null,
				redirect: 'scheduled',
			};
		}

		if (coordinationCase.status !== 'time_agreed' || !coordinationCase.proposed_time || !coordinationCase.responsible_member_id) {
			return {
				error: 'A meeting link can only be added after a common time is agreed.',
				redirect: null,
			};
		}

		if (!validMeetingLink(meetingLink)) {
			return {
				error: 'Enter a valid HTTPS meeting link.',
				redirect: null,
			};
		}

		await env.DB.prepare(
			`
                                UPDATE coordination_cases
                                SET
                                        meeting_link = ?,
                                        updated_at = CURRENT_TIMESTAMP
                                WHERE id = ?
                                        AND status = 'time_agreed'
                                `,
		)
			.bind(meetingLink, caseId)
			.run();

		const notificationError = await notifyParticipants(coordinationCase, meetingLink, env, fetcher);

		if (notificationError) {
			return {
				error: notificationError,
				redirect: null,
			};
		}

		await env.DB.prepare(
			`
                                UPDATE coordination_cases
                                SET
                                        status = 'scheduled',
                                        resolution_state = 'in_coordination',
                                        updated_at = CURRENT_TIMESTAMP
                                WHERE id = ?
                                        AND status = 'time_agreed'
                                `,
		)
			.bind(caseId)
			.run();

		await recordManagerEvent(env.DB, caseId, 'meeting_scheduled', 'Meeting link saved and participants notified');

		return {
			error: null,
			redirect: 'scheduled',
		};
	}

	if (action === 'resolve') {
		if (!['approved', 'availability_requested', 'time_agreed', 'scheduled', 'in_progress'].includes(coordinationCase.status)) {
			return {
				error: 'This case cannot be resolved from its current status.',
				redirect: null,
			};
		}

		if (!notes) {
			return {
				error: 'Enter a resolution note.',
				redirect: null,
			};
		}

		await env.DB.prepare(
			`
                                UPDATE coordination_cases
                                SET
                                        status = 'in_progress',
                                        resolution_state = 'awaiting_verification',
                                        manager_notes = ?,
                                        resolution_summary = ?,
                                        resolution_proposed_at = CURRENT_TIMESTAMP,
                                        updated_at = CURRENT_TIMESTAMP
                                WHERE id = ?
                                `,
		)
			.bind(notes, notes, caseId)
			.run();

		await env.DB.prepare(`
			INSERT INTO blocker_resolution_evidence (
				tenant_id, project_id, case_id, evidence_type, summary,
				created_by_type, created_by_management_user_id
			) VALUES (?, ?, ?, 'manager_note', ?, 'manager', ?)
		`).bind(principal.tenantId, projectId, caseId, notes, principal.userId).run();

		await recordManagerEvent(env.DB, caseId, 'resolution_proposed', notes);

		return {
			error: null,
			redirect: 'verification',
		};
	}

	if (action === 'verify_resolution') {
		if (coordinationCase.resolution_state !== 'awaiting_verification') {
			return { error: 'This case is not awaiting resolution verification.', redirect: null };
		}
		if (!notes) return { error: 'Enter a verification note.', redirect: null };
		await env.DB.prepare(`
			UPDATE coordination_cases SET status = 'resolved', resolution_state = 'resolved',
				resolution_verified_at = CURRENT_TIMESTAMP, verified_by_type = 'manager',
				resolved_at = CURRENT_TIMESTAMP, manager_notes = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND resolution_state = 'awaiting_verification'
		`).bind(notes, caseId).run();
		await env.DB.prepare(`
			INSERT INTO blocker_resolution_evidence (
				tenant_id, project_id, case_id, evidence_type, summary,
				created_by_type, created_by_management_user_id
			) VALUES (?, ?, ?, 'requester_confirmation', ?, 'manager', ?)
		`).bind(principal.tenantId, projectId, caseId, notes, principal.userId).run();
		await recordManagerEvent(env.DB, caseId, 'resolution_verified', notes);
		return { error: null, redirect: 'resolved' };
	}

	if (action === 'escalate') {
		if (coordinationCase.resolution_state === 'resolved') {
			return { error: 'A resolved case cannot be escalated.', redirect: null };
		}
		if (!notes) return { error: 'Enter an escalation reason.', redirect: null };
		await env.DB.prepare(`
			UPDATE coordination_cases SET resolution_state = 'escalated', priority = 'critical',
				manager_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
		`).bind(notes, caseId).run();
		await recordManagerEvent(env.DB, caseId, 'case_escalated', notes);
		return { error: null, redirect: 'escalated' };
	}

	return {
		error: 'Invalid manager action.',
		redirect: null,
	};
}

export async function caseManagementResponse(request: Request, env: WorkerEnv, fetcher: Fetcher = fetch): Promise<Response> {
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

	if (request.method === 'GET') {
		return renderPage(request, env, principal, projectId);
	}

	if (request.method !== 'POST') {
		return new Response('Method not allowed.', {
			status: 405,
			headers: {
				Allow: 'GET, POST',
			},
		});
	}

	if (!validOrigin(request)) {
		return new Response('Invalid request origin.', { status: 403 });
	}

	const form = await request.formData();

	const decision = await processDecision(form, env, fetcher, principal, projectId);

	if (decision.error) {
		return renderPage(request, env, principal, projectId, decision.error);
	}

	return new Response(null, {
		status: 303,
		headers: {
			Location: `/dashboard/cases?updated=${decision.redirect}`,
		},
	});
}
