import type { WorkerEnv } from './env';
import { duthaThemeCss, themeButton, themeScriptTag } from './ui';
import { accessibleProjects, managementPrincipalFromRequest, requireProjectAccess, teamLeadDepartment, type AccessibleProject, type ManagementPrincipal } from './access-control';
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

interface PortfolioProjectRow {
	id: number;
	project_key: string;
	name: string;
	members: number;
	reported_today: number;
	active_blockers: number;
	open_cases: number;
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

async function getDashboardRows(db: D1Database, tenantId: number, projectId: number, department: string | null = null): Promise<DashboardRow[]> {
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
								AND (? IS NULL OR member.department = ?)
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
		.bind(projectId, tenantId, department, department, projectId, projectId)
		.all<DashboardRow>();

	return result.results;
}

async function getOpenCaseCount(db: D1Database, tenantId: number, projectId: number, department: string | null = null): Promise<number> {
	const result = await db
		.prepare(
			`
                        SELECT COUNT(*) AS count
                        FROM coordination_cases
                        WHERE tenant_id = ? AND project_id = ?
						AND (? IS NULL OR requester_member_id IN (SELECT id FROM team_members WHERE tenant_id=? AND department=?))
                        AND status NOT IN (
                                'resolved',
                                'rejected',
                                'cancelled'
                        )
                        `,
		)
		.bind(tenantId, projectId, department, tenantId, department)
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

async function getHistoryRows(db: D1Database, tenantId: number, projectId: number, department: string | null = null): Promise<HistoryRow[]> {
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
						AND (? IS NULL OR member.department = ?)
                        AND incoming.tenant_id = ?
                        AND incoming.project_id = ?
                        AND incoming.processing_status = 'processed'
                ORDER BY incoming.received_at DESC
                LIMIT 500
        `,
		)
		.bind(tenantId, department, department, tenantId, projectId)
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
</style></head><body><main><div class="header"><div><h1>Update history</h1><p class="subtitle">${escapeHtml(title)} · each response shown in the member's local time</p></div><nav class="nav"><a href="/dashboard?project=${projectId}">Return to dashboard</a><a href="/dashboard/members?project=${projectId}">Members</a><a href="/dashboard/cases?project=${projectId}">Cases</a><form method="post" action="/logout"><button class="logout">Sign out</button></form></nav></div>
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

function deliveryBriefResponse(rows: PreparedDashboardRow[], openCases: number, projectId: number, role: string): Response {
	const missing = rows.filter((row) => !row.respondedToday);
	const blockers = rows.filter((row) => row.respondedToday && isActiveBlocker(row.blockers));
	const list = (items: PreparedDashboardRow[], text: (row: PreparedDashboardRow) => string, empty: string) => items.length
		? '<ul>' + items.map((row) => '<li><strong>' + escapeHtml(row.name) + '</strong><small>' + escapeHtml(row.department) + '</small><p>' + escapeHtml(text(row)) + '</p></li>').join('') + '</ul>'
		: '<p class="empty">' + empty + '</p>';
	const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Delivery brief · Dutha</title><style>:root{font-family:Inter,Arial,sans-serif;color:#e2e8f0;background:#070b18}*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:30px;background:radial-gradient(circle at 8% 0,#1e3a8a 0,transparent 35%),radial-gradient(circle at 94% 0,#312e81 0,transparent 31%),#070b18}main{max-width:1100px;margin:auto}.head{display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:22px}.eyebrow{color:#93c5fd;font-size:11px;letter-spacing:.12em;font-weight:900}h1,h2{color:#f8fafc;margin:6px 0}.muted,small{color:#94a3b8}.back{padding:10px 13px;background:#172554;color:#bfdbfe;border-radius:10px;text-decoration:none;font-weight:800}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:16px}.metric,.section{background:#111827d9;border:1px solid #334155;border-radius:17px;box-shadow:0 18px 50px #0007}.metric{padding:18px}.metric strong{display:block;font-size:30px;margin-top:6px}.section{padding:20px;margin-top:16px}.section h2{font-size:18px}.section ul{padding:0;margin:0;list-style:none}.section li{padding:13px 0;border-bottom:1px solid #273449}.section li:last-child{border:0}.section p{margin:5px 0 0;color:#cbd5e1}.section a{color:#bfdbfe;font-weight:800}.empty{color:#94a3b8}@media(max-width:700px){body{padding:16px}.head{flex-direction:column}.summary{grid-template-columns:1fr}}</style></head><body><main><header class="head"><div><div class="eyebrow">' + (role === 'team_lead' ? 'TEAM DELIVERY BRIEF' : 'PROJECT DELIVERY BRIEF') + '</div><h1>What needs attention</h1><p class="muted">Exceptions, ownership and next actions—without a productivity ranking.</p></div><a class="back" href="/dashboard?project=' + projectId + '">Project dashboard</a></header><section class="summary"><div class="metric"><small>Missing updates</small><strong>' + missing.length + '</strong></div><div class="metric"><small>Active blockers</small><strong>' + blockers.length + '</strong></div><div class="metric"><small>Open coordination cases</small><strong>' + openCases + '</strong></div></section><section class="section"><h2>Blockers requiring follow-up</h2>' + list(blockers,(row) => row.blockers || 'Blocker reported.','No active blockers reported today.') + '</section><section class="section"><h2>Updates still missing</h2>' + list(missing,() => 'No stand-up received today.','Everyone in scope has reported today.') + '</section><section class="section"><h2>Next action</h2><p><a href="/dashboard/cases?project=' + projectId + '">Open coordination queue →</a></p><p><a href="/dashboard/members?project=' + projectId + '">Open team schedules →</a></p></section></main></body></html>';
	return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"}});
}

async function portfolioRows(db: D1Database, tenantId: number, projectIds: number[], now: Date): Promise<PortfolioProjectRow[]> {
	if (!projectIds.length) return [];
	const placeholders = projectIds.map(() => '?').join(',');
	const result = await db.prepare(`
                SELECT project.id, project.project_key, project.name,
                        COUNT(DISTINCT member.id) AS members,
                        SUM(CASE WHEN incoming.received_at >= ? THEN 1 ELSE 0 END) AS reported_today,
                        SUM(CASE WHEN lower(COALESCE(processed.blockers, '')) NOT IN ('', 'none', 'none mentioned', 'not specified', 'no', 'nil') THEN 1 ELSE 0 END) AS active_blockers,
                        (SELECT COUNT(*) FROM coordination_cases AS cases WHERE cases.project_id=project.id AND cases.tenant_id=project.tenant_id AND cases.status NOT IN ('resolved','rejected','cancelled')) AS open_cases
                FROM projects AS project
                LEFT JOIN team_members AS member ON member.tenant_id=project.tenant_id AND member.active=1
                    AND (member.primary_project_id=project.id OR EXISTS (SELECT 1 FROM team_member_projects AS assignment WHERE assignment.project_id=project.id AND assignment.team_member_id=member.id))
                LEFT JOIN incoming_messages AS incoming ON incoming.id=(SELECT candidate.id FROM incoming_messages AS candidate WHERE candidate.tenant_id=member.tenant_id AND candidate.project_id=project.id AND candidate.sender_phone=member.phone ORDER BY candidate.received_at DESC LIMIT 1)
                LEFT JOIN processed_updates AS processed ON processed.message_id=incoming.id
                WHERE project.tenant_id=? AND project.active=1 AND project.id IN (${placeholders})
                GROUP BY project.id ORDER BY open_cases DESC, active_blockers DESC, project.name
        `).bind(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), tenantId, ...projectIds).all<PortfolioProjectRow>();
	return result.results;
}

async function organisationOverviewResponse(db: D1Database, principal: ManagementPrincipal, projects: AccessibleProject[], now: Date): Promise<Response> {
	const rows = await portfolioRows(db, principal.tenantId, projects.map((project) => project.id), now);
	const totals = rows.reduce((total, row) => ({ members: total.members + row.members, reported: total.reported + row.reported_today, blockers: total.blockers + row.active_blockers, cases: total.cases + row.open_cases }), { members: 0, reported: 0, blockers: 0, cases: 0 });
	const tableRows = rows.map((row) => `<tr><td><strong>${escapeHtml(row.project_key)}</strong><small>${escapeHtml(row.name)}</small></td><td>${row.members ? Math.round(row.reported_today / row.members * 100) : 0}%<small>${row.reported_today}/${row.members} reported</small></td><td class="${row.active_blockers ? 'risk' : ''}">${row.active_blockers}</td><td class="${row.open_cases ? 'risk' : ''}">${row.open_cases}</td><td><a href="/dashboard?project=${row.id}">Open project →</a></td></tr>`).join('') || '<tr><td colspan="5">No accessible projects.</td></tr>';
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Company command center · Dutha</title><style>:root{font-family:Inter,Arial,sans-serif;color:#e2e8f0;background:#070b18}*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:32px;background:radial-gradient(circle at 5% 0,#1e3a8a 0,transparent 35%),radial-gradient(circle at 95% 0,#312e81 0,transparent 31%),#070b18}main{max-width:1180px;margin:auto}.top{display:flex;justify-content:space-between;gap:18px;align-items:start;margin-bottom:25px}.eyebrow{color:#93c5fd;font-size:11px;letter-spacing:.13em;font-weight:900}h1{margin:6px 0;color:#f8fafc}.muted,small{color:#94a3b8}.back{color:#bfdbfe;padding:10px 13px;background:#172554;border-radius:10px;text-decoration:none;font-weight:800}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}.metric,.table{background:#111827d9;border:1px solid #334155;border-radius:17px;box-shadow:0 18px 50px #0007}.metric{padding:19px}.metric small{display:block}.metric strong{display:block;font-size:31px;margin-top:8px;color:#f8fafc}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:700px}th,td{padding:16px;text-align:left;border-bottom:1px solid #273449}th{color:#93c5fd;font-size:12px;text-transform:uppercase;letter-spacing:.08em}td small{display:block;margin-top:4px}td a{color:#bfdbfe}.risk{color:#fda4af;font-weight:900}@media(max-width:760px){body{padding:17px}.top{flex-direction:column}.metrics{grid-template-columns:repeat(2,1fr)}}</style></head><body><main><header class="top"><div><div class="eyebrow">${principal.role === 'ceo' ? 'CHIEF EXECUTIVE VIEW' : 'ORGANISATION CONTROL'}</div><h1>Company command center</h1><p class="muted">Delivery exceptions, ownership signals and project readiness—not surveillance.</p></div><a class="back" href="/dashboard?project=${projects[0]?.id ?? 1}">Project dashboard</a></header><section class="metrics"><div class="metric"><small>Active projects</small><strong>${rows.length}</strong></div><div class="metric"><small>Stand-up coverage</small><strong>${totals.members ? Math.round(totals.reported / totals.members * 100) : 0}%</strong></div><div class="metric"><small>Open blockers</small><strong>${totals.blockers}</strong></div><div class="metric"><small>Open coordination cases</small><strong>${totals.cases}</strong></div></section><section class="table"><table><thead><tr><th>Project</th><th>Coverage</th><th>Blockers</th><th>Cases</th><th></th></tr></thead><tbody>${tableRows}</tbody></table></section></main></body></html>`;
	return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" } });
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
	const roleProfile = principal.role === 'admin'
		? { eyebrow: 'ORGANISATION CONTROL', title: 'Executive command center', copy: 'Organisation-wide operational visibility and integration control.', focus: 'Organisation readiness' }
		: principal.role === 'ceo'
			? { eyebrow: 'CHIEF EXECUTIVE VIEW', title: 'Company command center', copy: 'Organisation-wide delivery health, signals and follow-through.', focus: 'Company readiness' }
			: principal.role === 'portfolio_leader'
			? { eyebrow: 'PORTFOLIO CONTROL', title: 'Portfolio command center', copy: 'See delivery health across the projects you lead.', focus: 'Portfolio readiness' }
			: principal.role === 'team_lead'
				? { eyebrow: 'TEAM CONTROL', title: 'Team command center', copy: 'Focus on your team’s updates, blockers and follow-through.', focus: 'Team readiness' }
				: { eyebrow: 'PROJECT CONTROL', title: 'Project command center', copy: 'Focus on today’s team signals, blockers and follow-through.', focus: 'Project readiness' };
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
	const leadDepartment = await teamLeadDepartment(env.DB, principal, requestedProject);
	if (new URL(request.url).searchParams.get('view') === 'overview' && ['admin', 'ceo', 'portfolio_leader'].includes(principal.role)) {
		return organisationOverviewResponse(env.DB, principal, projects, now);
	}
	const projectOptions = projects.map((project) => `
		<option value="${project.id}" ${project.id === requestedProject ? 'selected' : ''}>
			${escapeHtml(project.project_key)} · ${escapeHtml(project.name)}
		</option>
	`).join('');

	if (new URL(request.url).searchParams.get('view') === 'history') {
		return historyResponse(await getHistoryRows(env.DB, principal.tenantId, requestedProject, leadDepartment), request, now, requestedProject);
	}

	const [databaseRows, openCases, voiceCounts] = await Promise.all([
		getDashboardRows(env.DB, principal.tenantId, requestedProject, leadDepartment),
		getOpenCaseCount(env.DB, principal.tenantId, requestedProject, leadDepartment),
		leadDepartment ? Promise.resolve({ awaiting: 0, failed: 0 }) : getVoiceUpdateCounts(env.DB, principal.tenantId, requestedProject),
	]);

	const rows: PreparedDashboardRow[] = databaseRows.map((row) => ({
		...row,
		respondedToday: respondedOnMemberLocalDate(row, now.getTime()),
	}));

	const total = rows.length;

	const received = rows.filter((row) => row.respondedToday).length;

	const blockers = rows.filter((row) => row.respondedToday && isActiveBlocker(row.blockers)).length;

	if (new URL(request.url).searchParams.get('view') === 'brief') {
		return deliveryBriefResponse(rows, openCases, requestedProject, principal.role);
	}

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
        ${themeScriptTag}

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

                ${duthaThemeCss}
                body{background-attachment:fixed!important}.header{padding:20px 22px;border:1px solid var(--d-line);border-radius:20px;background:var(--d-glass);backdrop-filter:blur(24px);box-shadow:0 12px 35px rgba(29,55,73,.07)}.cards .card{transition:transform .18s,box-shadow .18s}.cards .card:hover{transform:translateY(-3px)}[data-theme="dark"] body{background:radial-gradient(circle at 6% 0,#1e3a8a 0,transparent 34%),radial-gradient(circle at 94% 4%,#312e81 0,transparent 30%),#070b18!important;color:#e2e8f0!important}[data-theme="dark"] h1,[data-theme="dark"] .value{color:#f8fafc!important}[data-theme="dark"] .subtitle,[data-theme="dark"] .label, [data-theme="dark"] td small,[data-theme="dark"] footer{color:#94a3b8!important}[data-theme="dark"] .header,[data-theme="dark"] .card,[data-theme="dark"] .table-wrap{background:#111827d9!important;border:1px solid #334155!important;box-shadow:0 18px 50px #0007!important}[data-theme="dark"] th{background:#172554!important}[data-theme="dark"] td{border-color:#273449!important}[data-theme="dark"] .navigation a{background:linear-gradient(135deg,#2563eb,#7c3aed)!important}[data-theme="dark"] .navigation .cases{background:#312e81!important}
                .eyebrow{color:#60a5fa;font-size:11px;letter-spacing:.11em;font-weight:900;margin-bottom:5px}.featured{background:linear-gradient(135deg,#1d4ed8,#4338ca)!important}.featured .label,.featured .value,.featured small{color:#fff!important}
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
                                <div class="eyebrow">${roleProfile.eyebrow}</div><h1>${roleProfile.title}</h1>
                                <p class="subtitle">
                                        ${roleProfile.copy} · ${escapeHtml(operationalTime)} IST
                                </p>
                        </div>

                        <nav class="navigation">
                                ${themeButton}
                                ${projects.length > 1 ? `<form method="get" action="/dashboard">
                                        <select name="project" aria-label="Select project">
                                                ${projectOptions}
                                        </select>
                                        <button type="submit">Open project</button>
                                </form>` : ''}


								<a href="/dashboard?view=brief&amp;project=${requestedProject}">${principal.role === 'team_lead' ? 'Team brief' : 'Delivery brief'}</a>

								${principal.role === 'team_lead' ? `<a href="/dashboard/members?project=${requestedProject}">Manage team</a>` : `<a href="/dashboard/members?project=${requestedProject}">${principal.role === 'project_manager' ? 'Manage team' : 'Manage project'}</a>`}

								${principal.role === 'team_lead' ? `<a class="cases" href="/dashboard/cases?project=${requestedProject}">Raise blocker</a>` : ''}

								${principal.role === 'team_lead' ? '' : `<a
                                        class="cases"
                                        href="/dashboard/cases?project=${requestedProject}"
                                >
                                        Needs action
                                </a>`}

								${['admin', 'ceo', 'portfolio_leader'].includes(principal.role) ? '<a href="/dashboard?view=overview">Company view</a>' : ''}

                                <a href="/dashboard?view=history&amp;period=7&amp;project=${requestedProject}">
                                        History
                                </a>

                                ${principal.role === 'admin' ? `<a href="/dashboard/channels?project=${requestedProject}">Setup</a>` : ''}

				${principal.role === 'admin' ? '<a href="/dashboard/settings">Settings</a>' : ''}

                                <form method="post" action="/logout">
                                        <button type="submit">Sign out</button>
                                </form>
                        </nav>
                </div>

                <section class="cards">
                        <div class="card featured">
                                <div class="label">${roleProfile.focus}</div>
                                <div class="value">${total ? Math.round((received / total) * 100) : 0}%</div>
                                <small>${received} of ${total} active members reported today</small>
                        </div>
                        <div class="card">
                                <div class="label">
                                        Team updates today
                                </div>
                                <div class="value">
                                        ${received} / ${total}
                                </div>
                        </div>

                        <div class="card">
                                <div class="label">
                                        Blockers reported today
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
                                        Awaiting employee confirmation
                                </div>
                                <div class="value voice-value">
                                        ${voiceCounts.awaiting}
                                </div>
                        </div>

                        ${voiceCounts.failed > 0 ? `<div class="card">
                                <div class="label">
                                        System alerts
                                </div>
                                <div class="value failure-value">
                                        ${voiceCounts.failed}
                                </div>
                        </div>` : ''}
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
			'Content-Security-Policy': "default-src 'none'; " + "style-src 'unsafe-inline'; script-src 'self'; " + "frame-ancestors 'none'; " + "base-uri 'none'",
		},
	});
}
