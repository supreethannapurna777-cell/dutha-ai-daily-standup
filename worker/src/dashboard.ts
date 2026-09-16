import type { WorkerEnv } from './env';
import { accessibleProjects, managementPrincipalFromRequest, requireProjectAccess } from './access-control';
import { getLocalScheduleDetails } from './scheduler';

interface DashboardRow {
	name: string;
	department: string;
	timezone: string;
	scheduling_enabled: number;
	received_at: string | null;
	tasks: string | null;
	people_to_connect: string | null;
	blockers: string | null;
	expected_completion: string | null;
}

interface PreparedDashboardRow extends DashboardRow {
	respondedToday: boolean;
}

interface HistoryRow extends DashboardRow {
	original_reply: string | null;
}

function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}

function isActiveBlocker(value: string | null): boolean {
	const normalised = String(value ?? '')
		.trim()
		.toLowerCase();

	return !['', 'none', 'none mentioned', 'not specified', 'no', 'nil'].includes(normalised);
}

function isAuthorised(request: Request, env: WorkerEnv): boolean {
	if (!env.DASHBOARD_USERNAME || !env.DASHBOARD_PASSWORD) {
		return false;
	}

	const credentials = btoa(`${env.DASHBOARD_USERNAME}:` + env.DASHBOARD_PASSWORD);

	return request.headers.get('Authorization') === `Basic ${credentials}`;
}

function safeTimezone(timezone: string): string {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());

		return timezone;
	} catch {
		return 'Asia/Kolkata';
	}
}

function respondedOnMemberLocalDate(row: DashboardRow, nowTimestamp: number): boolean {
	if (!row.received_at) {
		return false;
	}

	const receivedTimestamp = Date.parse(row.received_at);

	if (Number.isNaN(receivedTimestamp)) {
		return false;
	}

	const timezone = safeTimezone(row.timezone);

	const today = getLocalScheduleDetails(nowTimestamp, timezone).date;

	const responseDate = getLocalScheduleDetails(receivedTimestamp, timezone).date;

	return today === responseDate;
}

function formatReceivedAt(value: string | null, timezone: string): string {
	if (!value) {
		return 'Pending';
	}

	return new Date(value).toLocaleString('en-IN', {
		timeZone: safeTimezone(timezone),
		dateStyle: 'medium',
		timeStyle: 'short',
	});
}

async function getDashboardRows(db: D1Database, tenantId: number, projectId: number): Promise<DashboardRow[]> {
	const result = await db
		.prepare(
			`
                        SELECT
                                member.name,
                                member.department,
                                member.timezone,
                                member.scheduling_enabled,
                                incoming.received_at,
                                processed.tasks,
                                processed.people_to_connect,
                                processed.blockers,
                                processed.expected_completion
                        FROM team_members AS member
                        LEFT JOIN incoming_messages AS incoming
                                ON incoming.id = (
                                        SELECT candidate.id
                                        FROM incoming_messages
                                                AS candidate
                                        WHERE candidate.sender_phone
                                                = member.phone
                                                AND candidate.tenant_id = member.tenant_id
                                                AND candidate.project_id = ?
                                        ORDER BY
                                                candidate.received_at DESC
                                        LIMIT 1
                                )
                        LEFT JOIN processed_updates AS processed
                                ON processed.message_id
                                        = incoming.id
                        WHERE member.active = 1
                                AND member.tenant_id = ?
                                AND (
                                        member.primary_project_id = ?
                                        OR EXISTS (
                                        SELECT 1
                                        FROM team_member_projects AS membership
                                        WHERE membership.team_member_id = member.id
                                                AND membership.project_id = ?
                                        )
                                )
                        ORDER BY member.name
                        `,
		)
		.bind(projectId, tenantId, projectId, projectId)
		.all<DashboardRow>();

	return result.results;
}

async function getOpenCaseCount(db: D1Database, tenantId: number, projectId: number): Promise<number> {
	const result = await db
		.prepare(
			`
                        SELECT COUNT(*) AS count
                        FROM coordination_cases
                        WHERE tenant_id = ? AND project_id = ?
                        AND status NOT IN (
                                'resolved',
                                'rejected',
                                'cancelled'
                        )
                        `,
		)
		.bind(tenantId, projectId)
		.first<{ count: number }>();

	return result?.count ?? 0;
}

async function getVoiceUpdateCounts(
	db: D1Database,
	tenantId: number,
	projectId: number,
): Promise<{
	awaiting: number;
	failed: number;
}> {
	const result = await db
		.prepare(
			`
                SELECT
                        SUM(CASE WHEN status = 'awaiting_confirmation' THEN 1 ELSE 0 END)
                                AS awaiting,
                        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)
                                AS failed
                FROM voice_updates
                WHERE tenant_id = ? AND project_id = ?
        `,
		)
		.bind(tenantId, projectId)
		.first<{
			awaiting: number | null;
			failed: number | null;
		}>();

	return {
		awaiting: result?.awaiting ?? 0,
		failed: result?.failed ?? 0,
	};
}

async function getHistoryRows(db: D1Database, tenantId: number, projectId: number): Promise<HistoryRow[]> {
	const result = await db
		.prepare(
			`
                SELECT member.name, member.department, member.timezone,
                        member.scheduling_enabled, incoming.received_at,
                        processed.tasks, processed.people_to_connect,
                        processed.blockers, processed.expected_completion,
                        COALESCE(processed.original_reply, incoming.original_reply)
                                AS original_reply
                FROM incoming_messages AS incoming
                INNER JOIN team_members AS member
                        ON member.phone = incoming.sender_phone
                LEFT JOIN processed_updates AS processed
                        ON processed.message_id = incoming.id
                WHERE member.active = 1
                        AND member.tenant_id = ?
                        AND incoming.tenant_id = ?
                        AND incoming.project_id = ?
                        AND incoming.processing_status = 'processed'
                ORDER BY incoming.received_at DESC
                LIMIT 500
        `,
		)
		.bind(tenantId, tenantId, projectId)
		.all<HistoryRow>();
	return result.results;
}

function validDate(value: string | null): value is string {
	return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function dayNumber(value: string): number {
	return Math.floor(Date.parse(`${value}T00:00:00.000Z`) / 86_400_000);
}

function historyIncludes(row: HistoryRow, nowTimestamp: number, period: string, from: string | null, to: string | null): boolean {
	if (!row.received_at) return false;
	const receivedTimestamp = Date.parse(row.received_at);
	if (Number.isNaN(receivedTimestamp)) return false;
	const timezone = safeTimezone(row.timezone);
	const rowDate = getLocalScheduleDetails(receivedTimestamp, timezone).date;
	if (period === 'custom' && validDate(from) && validDate(to)) {
		return rowDate >= from && rowDate <= to;
	}
	const today = getLocalScheduleDetails(nowTimestamp, timezone).date;
	const age = dayNumber(today) - dayNumber(rowDate);
	if (period === 'yesterday') return age === 1;
	if (period === '30') return age >= 0 && age < 30;
	return age >= 0 && age < 7;
}

function historyResponse(rows: HistoryRow[], request: Request, now: Date, projectId: number): Response {
	const url = new URL(request.url);
	const requestedPeriod = url.searchParams.get('period') ?? '7';
	const period = ['yesterday', '7', '30', 'custom'].includes(requestedPeriod) ? requestedPeriod : '7';
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const member = (url.searchParams.get('member') ?? '').trim();
	const members = [...new Set(rows.map((row) => row.name))].sort((left, right) => left.localeCompare(right));
	const filtered = rows.filter((row) => (!member || row.name === member) && historyIncludes(row, now.getTime(), period, from, to));
	const activeBlockers = filtered.filter((row) => isActiveBlocker(row.blockers)).length;
	const memberOptions = members
		.map((name) => `<option value="${escapeHtml(name)}"${name === member ? ' selected' : ''}>${escapeHtml(name)}</option>`)
		.join('');
	const tableRows = filtered.length
		? filtered
				.map(
					(row) => `
                <tr><td>${escapeHtml(formatReceivedAt(row.received_at, row.timezone))}<small>${escapeHtml(safeTimezone(row.timezone))}</small></td>
                <td><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.department)}</small></td>
                <td>${escapeHtml(row.tasks || 'Not specified')}</td><td>${escapeHtml(row.people_to_connect || 'Not specified')}</td>
                <td class="${isActiveBlocker(row.blockers) ? 'danger' : ''}">${escapeHtml(row.blockers || 'Not specified')}</td>
                <td>${escapeHtml(row.expected_completion || 'Not specified')}</td><td class="reply">${escapeHtml(row.original_reply || 'Not available')}</td></tr>`,
				)
				.join('')
		: `<tr><td colspan="7" class="empty">No updates match this period and member.</td></tr>`;
	const title =
		period === 'yesterday' ? 'Yesterday' : period === '30' ? 'Last 30 days' : period === 'custom' ? 'Custom range' : 'Last 7 days';
	const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dutha update history</title><style>
:root{font-family:Inter,Arial,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0;padding:32px}main{max-width:1500px;margin:auto}.header{display:flex;justify-content:space-between;align-items:center;gap:20px}h1{margin:0;color:#173f6b}.subtitle,small{color:#64748b}.nav{display:flex;gap:9px;flex-wrap:wrap}.nav a,.nav button{border:0;border-radius:9px;padding:11px 15px;color:#fff;background:#1769aa;text-decoration:none;font-weight:700;cursor:pointer}.nav .logout{background:#475569}.filters,.summary,.table-wrap{background:#fff;border-radius:12px;box-shadow:0 3px 14px #0f172a12}.filters{display:flex;align-items:end;gap:12px;flex-wrap:wrap;padding:18px;margin:24px 0 15px}.filters label{display:grid;gap:6px;font-size:13px;font-weight:700}.filters select,.filters input{padding:10px;border:1px solid #cbd5e1;border-radius:8px}.filters button{padding:11px 18px;border:0;border-radius:8px;background:#7c3aed;color:#fff;font-weight:700}.summary{display:flex;gap:28px;padding:16px 20px;margin-bottom:15px}.summary strong{font-size:23px;color:#173f6b}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1200px}th{padding:13px;background:#173f6b;color:#fff;text-align:left}td{padding:13px;border-bottom:1px solid #e5eaf1;vertical-align:top;max-width:300px}td small{display:block;margin-top:4px}.danger{color:#b91c1c;font-weight:600}.reply{white-space:pre-wrap}.empty{text-align:center;color:#64748b}footer{margin-top:16px;color:#64748b;font-size:13px}@media(max-width:700px){body{padding:16px}.header{align-items:start;flex-direction:column}}
</style></head><body><main><div class="header"><div><h1>Update history</h1><p class="subtitle">${escapeHtml(title)} · each response shown in the member's local time</p></div><nav class="nav"><a href="/dashboard?project=${projectId}">Today</a><a href="/dashboard/members?project=${projectId}">Members</a><a href="/dashboard/cases?project=${projectId}">Cases</a><form method="post" action="/logout"><button class="logout">Sign out</button></form></nav></div>
<form class="filters" method="get" action="/dashboard"><input type="hidden" name="view" value="history"><label>Period<select name="period"><option value="yesterday"${period === 'yesterday' ? ' selected' : ''}>Yesterday</option><option value="7"${period === '7' ? ' selected' : ''}>Last 7 days</option><option value="30"${period === '30' ? ' selected' : ''}>Last 30 days</option><option value="custom"${period === 'custom' ? ' selected' : ''}>Custom dates</option></select></label><label>From<input type="date" name="from" value="${escapeHtml(validDate(from) ? from : '')}"></label><label>To<input type="date" name="to" value="${escapeHtml(validDate(to) ? to : '')}"></label><label>Member<select name="member"><option value="">All members</option>${memberOptions}</select></label><button type="submit">Apply filters</button></form>
<section class="summary"><div><small>Updates</small><br><strong>${filtered.length}</strong></div><div><small>Active blockers reported</small><br><strong>${activeBlockers}</strong></div></section>
<div class="table-wrap"><table><thead><tr><th>Received</th><th>Member</th><th>Tasks</th><th>Coordination</th><th>Blockers</th><th>Expected completion</th><th>Original reply</th></tr></thead><tbody>${tableRows}</tbody></table></div><footer>Private management history · Phone numbers are never displayed · Up to 500 recent processed updates</footer></main></body></html>`;
	return new Response(html, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Frame-Options': 'DENY',
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'no-referrer',
			'Content-Security-Policy':
				"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
		},
	});
}

function displayedValue(row: PreparedDashboardRow, value: string | null): string {
	if (!row.respondedToday) {
		return '—';
	}

	return value || 'Not specified';
}

export async function createDashboardResponse(request: Request, env: WorkerEnv, now = new Date()): Promise<Response> {
	if (!env.DASHBOARD_USERNAME || !env.DASHBOARD_PASSWORD) {
		return new Response('Dashboard authentication is not configured.', { status: 503 });
	}

	if (!isAuthorised(request, env)) {
		return new Response('Authentication required.', {
			status: 401,
			headers: {
				'WWW-Authenticate': 'Basic realm="Dutha WorkOps Dashboard"',
			},
		});
	}

	const principal = managementPrincipalFromRequest(request) ?? {
		userId: 1,
		tenantId: 1,
		role: 'admin' as const,
	};
	const requestedProject = Number(new URL(request.url).searchParams.get('project') ?? 1);
	if (!Number.isSafeInteger(requestedProject) || requestedProject <= 0) {
		return new Response('Invalid project.', { status: 400 });
	}
	try {
		await requireProjectAccess(env.DB, principal, requestedProject);
	} catch {
		return new Response('Project access denied.', { status: 403 });
	}
	const projects = await accessibleProjects(env.DB, principal);
	const projectOptions = projects.map((project) => `
		<option value="${project.id}" ${project.id === requestedProject ? 'selected' : ''}>
			${escapeHtml(project.project_key)} · ${escapeHtml(project.name)}
		</option>
	`).join('');

	if (new URL(request.url).searchParams.get('view') === 'history') {
		return historyResponse(await getHistoryRows(env.DB, principal.tenantId, requestedProject), request, now, requestedProject);
	}

	const [databaseRows, openCases, voiceCounts] = await Promise.all([
		getDashboardRows(env.DB, principal.tenantId, requestedProject),
		getOpenCaseCount(env.DB, principal.tenantId, requestedProject),
		getVoiceUpdateCounts(env.DB, principal.tenantId, requestedProject),
	]);

	const rows: PreparedDashboardRow[] = databaseRows.map((row) => ({
		...row,
		respondedToday: respondedOnMemberLocalDate(row, now.getTime()),
	}));

	const total = rows.length;

	const received = rows.filter((row) => row.respondedToday).length;

	const pending = total - received;

	const blockers = rows.filter((row) => row.respondedToday && isActiveBlocker(row.blockers)).length;

	const completion = total === 0 ? 0 : Math.round((received / total) * 100);

	const tableRows = rows.length
		? rows
				.map((row) => {
					const responded = row.respondedToday;

					const timezone = safeTimezone(row.timezone);

					return `
                                <tr>
                                        <td>
                                                <strong>${escapeHtml(row.name)}</strong>
                                                <small>${escapeHtml(row.department)}</small>
                                                <small>${escapeHtml(timezone)}</small>
                                        </td>

                                        <td>
                                                <span class="badge ${responded ? 'received' : 'pending'}">
                                                        ${responded ? 'Received' : 'Pending'}
                                                </span>

                                                ${
																									row.scheduling_enabled
																										? ''
																										: `
                                                                        <small class="paused">
                                                                                Automation paused
                                                                        </small>
                                                                `
																								}
                                        </td>

                                        <td>${escapeHtml(displayedValue(row, row.tasks))}</td>

                                        <td>${escapeHtml(displayedValue(row, row.people_to_connect))}</td>

                                        <td class="${responded && isActiveBlocker(row.blockers) ? 'danger' : ''}">
                                                ${escapeHtml(displayedValue(row, row.blockers))}
                                        </td>

                                        <td>${escapeHtml(displayedValue(row, row.expected_completion))}</td>

                                        <td>${escapeHtml(responded ? formatReceivedAt(row.received_at, timezone) : 'Pending')}</td>
                                </tr>
                        `;
				})
				.join('')
		: `
                        <tr>
                                <td colspan="7" class="empty">
                                        No active team members configured.
                                </td>
                        </tr>
                `;

	const operationalTime = now.toLocaleString('en-IN', {
		timeZone: 'Asia/Kolkata',
		dateStyle: 'medium',
		timeStyle: 'short',
	});

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
        <meta charset="UTF-8">
        <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
        >
        <title>Dutha WorkOps</title>

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
                        max-width: 1450px;
                        margin: auto;
                }

                .header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        gap: 20px;
                }

                h1 {
                        margin: 0 0 5px;
                        color: #173f6b;
                }

                .subtitle {
                        color: #64748b;
                        margin: 0;
                }

                .navigation {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 10px;
                }

                .navigation a {
                        display: inline-block;
                        padding: 11px 15px;
                        border-radius: 9px;
                        color: white;
                        background: #1769aa;
                        text-decoration: none;
                        font-weight: 700;
                }

                .navigation .cases {
                        background: #7c3aed;
                }

                .navigation button {
                        padding: 11px 15px;
                        border: 0;
                        border-radius: 9px;
                        color: white;
                        background: #475569;
                        font: inherit;
                        font-weight: 700;
                        cursor: pointer;
                }

                .cards {
                        display: grid;
                        grid-template-columns:
                                repeat(auto-fit, minmax(170px, 1fr));
                        gap: 15px;
                        margin: 24px 0;
                }

                .card,
                .table-wrap {
                        background: white;
                        border-radius: 12px;
                        box-shadow: 0 3px 14px #0f172a12;
                }

                .card {
                        padding: 19px;
                }

                .label {
                        color: #64748b;
                        font-size: 14px;
                }

                .value {
                        margin-top: 7px;
                        color: #173f6b;
                        font-size: 29px;
                        font-weight: 700;
                }

                .case-value {
                        color: #7c3aed;
                }

                .voice-value {
                        color: #0f766e;
                }

                .failure-value {
                        color: #b91c1c;
                }

                .table-wrap {
                        overflow-x: auto;
                }

                table {
                        width: 100%;
                        border-collapse: collapse;
                }

                th {
                        padding: 14px;
                        color: white;
                        background: #173f6b;
                        text-align: left;
                }

                td {
                        padding: 14px;
                        border-bottom: 1px solid #e5eaf1;
                        vertical-align: top;
                }

                td small {
                        display: block;
                        margin-top: 4px;
                        color: #64748b;
                }

                .badge {
                        display: inline-block;
                        padding: 5px 9px;
                        border-radius: 999px;
                        font-size: 12px;
                        font-weight: 700;
                }

                .received {
                        color: #166534;
                        background: #dcfce7;
                }

                .pending {
                        color: #92400e;
                        background: #fef3c7;
                }

                .paused {
                        color: #b45309;
                }

                .danger {
                        color: #b91c1c;
                        font-weight: 600;
                }

                .empty {
                        text-align: center;
                        color: #64748b;
                }

                footer {
                        margin-top: 18px;
                        color: #64748b;
                        font-size: 13px;
                }

                @media (max-width: 950px) {
                        .cards {
                                grid-template-columns:
                                        repeat(2, 1fr);
                        }
                }

                @media (max-width: 700px) {
                        body {
                                padding: 16px;
                        }

                        .header {
                                align-items: start;
                                flex-direction: column;
                        }

                        .cards {
                                grid-template-columns: 1fr;
                        }
                }
        </style>
</head>

<body>
        <main>
                <div class="header">
                        <div>
                                <h1>Dutha WorkOps</h1>
                                <p class="subtitle">
                                        Live team status as of ${escapeHtml(operationalTime)} IST
                                </p>
                        </div>

                        <nav class="navigation">
                                <form method="get" action="/dashboard">
                                        <select name="project" aria-label="Select project">
                                                ${projectOptions}
                                        </select>
                                        <button type="submit">Open project</button>
                                </form>

                                ${principal.role === 'admin' ? '<a href="/dashboard/projects">Projects and access</a>' : ''}
                                <a
                                        href="/dashboard/members?project=${requestedProject}"
                                >
                                        Manage members and schedules
                                </a>

                                <a
                                        class="cases"
                                        href="/dashboard/cases?project=${requestedProject}"
                                >
                                        View coordination cases
                                </a>

                                <a href="/dashboard?view=history&amp;period=7&amp;project=${requestedProject}">
                                        View update history
                                </a>

                                <form method="post" action="/logout">
                                        <button type="submit">Sign out</button>
                                </form>
                        </nav>
                </div>

                <section class="cards">
                        <div class="card">
                                <div class="label">
                                        Responses received
                                </div>
                                <div class="value">
                                        ${received} / ${total}
                                </div>
                        </div>

                        <div class="card">
                                <div class="label">
                                        Response completion
                                </div>
                                <div class="value">
                                        ${completion}%
                                </div>
                        </div>

                        <div class="card">
                                <div class="label">
                                        Pending members
                                </div>
                                <div class="value">
                                        ${pending}
                                </div>
                        </div>

                        <div class="card">
                                <div class="label">
                                        Active blockers
                                </div>
                                <div class="value">
                                        ${blockers}
                                </div>
                        </div>

                        <div class="card">
                                <div class="label">
                                        Open coordination cases
                                </div>
                                <div class="value case-value">
                                        ${openCases}
                                </div>
                        </div>

                        <div class="card">
                                <div class="label">
                                        Voice updates awaiting confirmation
                                </div>
                                <div class="value voice-value">
                                        ${voiceCounts.awaiting}
                                </div>
                        </div>

                        <div class="card">
                                <div class="label">
                                        Voice transcription failures
                                </div>
                                <div class="value failure-value">
                                        ${voiceCounts.failed}
                                </div>
                        </div>
                </section>

                <div class="table-wrap">
                        <table>
                                <thead>
                                        <tr>
                                                <th>Team member</th>
                                                <th>Status</th>
                                                <th>Tasks</th>
                                                <th>Coordination</th>
                                                <th>Blockers</th>
                                                <th>Expected completion</th>
                                                <th>Received at</th>
                                        </tr>
                                </thead>

                                <tbody>
                                        ${tableRows}
                                </tbody>
                        </table>
                </div>

                <footer>
                        Private management dashboard ·
                        Phone numbers are never displayed ·
                        Responses use each member's configured local date
                </footer>
        </main>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Frame-Options': 'DENY',
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'no-referrer',
			'Content-Security-Policy': "default-src 'none'; " + "style-src 'unsafe-inline'; " + "frame-ancestors 'none'; " + "base-uri 'none'",
		},
	});
}
