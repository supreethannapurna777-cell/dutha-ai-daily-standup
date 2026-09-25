import type { WorkerEnv } from './env';
import { managementPrincipalFromRequest, requireProjectAccess, type ManagementPrincipal } from './access-control';
import { sendMeetingScheduled, type Fetcher } from './whatsapp';
import { jiraConfigFromEnv, syncApprovedCaseToJira } from './jira-sync';
import { atlassianMcpConfigFromEnv } from './atlassian-mcp';

interface CaseRow {
	id: number;
	tenant_id: number;
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
	external_issue_key: string | null;
	external_issue_url: string | null;
	external_status: string | null;
	jira_sync_status: string | null;
	meeting_notifications_submitted: number;
	meeting_notifications_delivered: number;
	meeting_notifications_failed: number;
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
				coordination.tenant_id,
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
                                coordination.updated_at,
                                jira.external_issue_key,
                                jira.external_issue_url,
                                jira.external_status,
                                jira.sync_status AS jira_sync_status,
				COALESCE((SELECT COUNT(*) FROM sent_messages AS submitted
					WHERE submitted.message_type = 'meeting_notification'
						AND submitted.scheduled_for = ('case:' || coordination.id || ':meeting')
						AND submitted.status IN ('submitted', 'sent')), 0) AS meeting_notifications_submitted,
				COALESCE((SELECT COUNT(*) FROM sent_messages AS delivered
					WHERE delivered.message_type = 'meeting_notification'
						AND delivered.scheduled_for = ('case:' || coordination.id || ':meeting')
						AND delivered.status IN ('delivered', 'read')), 0) AS meeting_notifications_delivered,
				COALESCE((SELECT COUNT(*) FROM sent_messages AS failed
					WHERE failed.message_type = 'meeting_notification'
						AND failed.scheduled_for = ('case:' || coordination.id || ':meeting')
						AND failed.status = 'failed'), 0) AS meeting_notifications_failed
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
                        LEFT JOIN jira_case_links
                                AS jira
                                ON jira.case_id = coordination.id
                                        AND jira.tenant_id = coordination.tenant_id
                                        AND jira.project_id = coordination.project_id
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
	const jiraUrl = safeExternalUrl(coordinationCase.external_issue_url);

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

                        ${coordinationCase.external_issue_key ? `
                                <div class="notes jira-link">
                                        <strong>Jira:</strong>
                                        ${jiraUrl ? `
                                                <a href="${escapeHtml(jiraUrl)}" target="_blank" rel="noopener noreferrer">
                                                        ${escapeHtml(coordinationCase.external_issue_key)} ↗ Open in Jira
                                                </a>
                                        ` : escapeHtml(coordinationCase.external_issue_key)}
                                        <span class="badge status">
                                                ${escapeHtml(formatStatus(coordinationCase.external_status ?? 'status pending'))}
                                        </span>
                                        <span class="badge lifecycle">
                                                ${escapeHtml(formatStatus(coordinationCase.jira_sync_status ?? 'unknown'))}
                                        </span>
                                </div>
                        ` : ''}

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
				coordinationCase.meeting_notifications_submitted
				|| coordinationCase.meeting_notifications_delivered
				|| coordinationCase.meeting_notifications_failed
					? `
				<div class="notes">
					<strong>WhatsApp:</strong>
					${coordinationCase.meeting_notifications_delivered} delivered,
					${coordinationCase.meeting_notifications_submitted} awaiting delivery,
					${coordinationCase.meeting_notifications_failed} failed
				</div>
			` : ''
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

interface CaseFilters {
	quick: string;
	search: string;
	requester: string;
	owner: string;
	status: string;
	priority: string;
	type: string;
	resolution: string;
	age: string;
	sla: string;
	duration: string;
	sort: string;
}

function safeExternalUrl(value: string | null): string | null {
	if (!value) {
		return null;
	}

	try {
		const url = new URL(value);
		return url.protocol === 'https:' ? url.toString() : null;
	} catch {
		return null;
	}
}

const closedStatuses = new Set(['resolved', 'rejected', 'cancelled']);

function caseAgeDays(coordinationCase: CaseRow, now = Date.now()): number {
	const requested = new Date(coordinationCase.requested_at).getTime();
	return Number.isNaN(requested) ? 0 : Math.max(0, Math.floor((now - requested) / 86_400_000));
}

function readFilters(url: URL): CaseFilters {
	const value = (name: string) => (url.searchParams.get(name) ?? '').trim();
	return {
		quick: value('quick'), search: value('search'), requester: value('requester'), owner: value('owner'),
		status: value('status'), priority: value('priority'), type: value('type'),
		resolution: value('resolution'), age: value('age'), sla: value('sla'),
		duration: value('duration'), sort: value('sort') || 'attention',
	};
}

function filteredCases(cases: CaseRow[], filters: CaseFilters): CaseRow[] {
	const now = Date.now();
	const filtered = cases.filter((item) => {
		const age = caseAgeDays(item, now);
		const overdue = Boolean(item.sla_due_at && new Date(item.sla_due_at).getTime() < now && !closedStatuses.has(item.status));
		const query = filters.search.toLowerCase();
		return (!query || `${item.id} ${item.issue_summary} ${item.requester_name} ${item.responsible_name ?? ''} ${item.external_issue_key ?? ''}`.toLowerCase().includes(query))
			&& (!filters.quick || (filters.quick === 'open' ? !closedStatuses.has(item.status) : filters.quick === 'unassigned' ? item.responsible_member_id === null && !closedStatuses.has(item.status) : filters.quick === 'overdue' ? overdue : filters.quick === 'awaiting_verification' ? item.resolution_state === 'awaiting_verification' : item.status === 'resolved' || item.resolution_state === 'resolved'))
			&& (!filters.requester || String(item.requester_member_id) === filters.requester)
			&& (!filters.owner || (filters.owner === 'unassigned' ? item.responsible_member_id === null : String(item.responsible_member_id) === filters.owner))
			&& (!filters.status || item.status === filters.status)
			&& (!filters.priority || item.priority === filters.priority)
			&& (!filters.type || item.case_type === filters.type)
			&& (!filters.resolution || item.resolution_state === filters.resolution)
			&& (!filters.duration || String(item.meeting_duration_minutes) === filters.duration)
			&& (!filters.age || (filters.age === 'today' ? age === 0 : filters.age === '7' ? age <= 7 : filters.age === '30' ? age <= 30 : age > 30))
			&& (!filters.sla || (filters.sla === 'overdue' ? overdue : filters.sla === 'due_soon' ? Boolean(item.sla_due_at && !overdue && new Date(item.sla_due_at).getTime() - now <= 86_400_000) : !overdue));
	});
	return filtered.sort((a, b) => {
		if (filters.sort === 'oldest') return new Date(a.requested_at).getTime() - new Date(b.requested_at).getTime();
		if (filters.sort === 'newest') return new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime();
		if (filters.sort === 'sla') return (a.sla_due_at ? new Date(a.sla_due_at).getTime() : Infinity) - (b.sla_due_at ? new Date(b.sla_due_at).getTime() : Infinity);
		if (filters.sort === 'attention') {
			const statusRank: Record<string, number> = {
				pending_approval: 0,
				pending_assignment: 1,
				approved: 2,
				availability_requested: 3,
				time_agreed: 4,
				scheduled: 5,
				in_progress: 6,
				resolved: 8,
				rejected: 9,
				cancelled: 10,
			};
			const priorityRank: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
			return (statusRank[a.status] ?? 7) - (statusRank[b.status] ?? 7)
				|| (priorityRank[a.priority] ?? 4) - (priorityRank[b.priority] ?? 4)
				|| new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime();
		}
		const rank: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
		return (rank[a.priority] ?? 4) - (rank[b.priority] ?? 4);
	});
}

function selectOptions(values: Array<[string, string]>, selected: string): string {
	return [`<option value="">All</option>`, ...values.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`)].join('');
}

function page(cases: CaseRow[], members: MemberOption[], message: string | null, error: string | null, requestUrl: URL, projectId: number): string {
	const view = requestUrl.searchParams.get('view') === 'overview' ? 'overview' : 'cases';
	const filters = readFilters(requestUrl);
	const visibleCases = filteredCases(cases, filters);
	const openCount = cases.filter((coordinationCase) => !['resolved', 'rejected', 'cancelled'].includes(coordinationCase.status)).length;

	const pendingCount = cases.filter((coordinationCase) =>
		['pending_assignment', 'pending_approval'].includes(coordinationCase.status),
	).length;

	const criticalCount = cases.filter(
		(coordinationCase) =>
			coordinationCase.priority === 'critical' && !['resolved', 'rejected', 'cancelled'].includes(coordinationCase.status),
	).length;
	const now = Date.now();
	const resolvedCount = cases.filter((item) => item.status === 'resolved' || item.resolution_state === 'resolved').length;
	const overdueCount = cases.filter((item) => item.sla_due_at && new Date(item.sla_due_at).getTime() < now && !closedStatuses.has(item.status)).length;
	const unassignedCount = cases.filter((item) => item.responsible_member_id === null && !closedStatuses.has(item.status)).length;
	const statusCounts = cases.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.status]: (counts[item.status] ?? 0) + 1 }), {});
	const priorityCounts = ['critical', 'high', 'normal', 'low'].map((priority) => [priority, cases.filter((item) => item.priority === priority).length] as const);
	const maxPriority = Math.max(1, ...priorityCounts.map(([, count]) => count));
	const openCases = cases.filter((item) => !closedStatuses.has(item.status));
	const ageCounts = [
		['Today', openCases.filter((item) => caseAgeDays(item, now) === 0).length],
		['1–7 days', openCases.filter((item) => caseAgeDays(item, now) >= 1 && caseAgeDays(item, now) <= 7).length],
		['8–30 days', openCases.filter((item) => caseAgeDays(item, now) >= 8 && caseAgeDays(item, now) <= 30).length],
		['30+ days', openCases.filter((item) => caseAgeDays(item, now) > 30).length],
	] as const;
	const statusTotal = Math.max(1, cases.length);
	let statusOffset = 0;
	const statusPalette = ['#2563eb', '#7c3aed', '#f59e0b', '#10b981', '#ef4444', '#64748b'];
	const statusSegments = Object.entries(statusCounts).map(([status, count], index) => {
		const start = (statusOffset / statusTotal) * 100;
		statusOffset += count;
		return `${statusPalette[index % statusPalette.length]} ${start}% ${(statusOffset / statusTotal) * 100}%`;
	}).join(', ');

	const cards = visibleCases.length
		? visibleCases.map((coordinationCase) => caseCard(coordinationCase, members)).join('')
		: `
                        <div class="empty">
                                No cases match these filters. Clear filters to see everything.
                        </div>
                `;
	const activeFilterCount = Object.entries(filters).filter(([key, value]) => key !== 'sort' && Boolean(value)).length;
	const unique = (values: string[]) => [...new Set(values)].sort().map((value) => [value, formatStatus(value)] as [string, string]);
	const requesterOptions = [...new Map(cases.map((item) => [item.requester_member_id, item.requester_name])).entries()].map(([id, name]) => [String(id), name] as [string, string]);
	const ownerOptions: Array<[string, string]> = [['unassigned', 'Unassigned'], ...requesterOptions];
	const attention = [...cases].filter((item) => !closedStatuses.has(item.status)).sort((a, b) => {
		const rank: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
		return (rank[a.priority] ?? 4) - (rank[b.priority] ?? 4) || new Date(a.requested_at).getTime() - new Date(b.requested_at).getTime();
	}).slice(0, 5);

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

				.page-nav { display:flex; gap:8px; margin-top:20px; border-bottom:1px solid #dbe3ef; }
				.page-nav a { padding:11px 16px; text-decoration:none; color:#52647a; border-bottom:3px solid transparent; }
				.page-nav a.active { color:#1769aa; border-color:#1769aa; }
				.page-heading { display:flex; align-items:center; gap:12px; }
				.filter-drawer { position:fixed; z-index:20; left:0; top:0; bottom:0; pointer-events:none; }
				.filter-drawer summary { pointer-events:auto; position:absolute; top:22px; left:18px; width:44px; height:44px; display:grid; place-items:center; border-radius:12px; color:white; background:#173f6b; cursor:pointer; box-shadow:0 5px 18px #0f172a35; list-style:none; font-size:21px; }
				.filter-drawer summary::-webkit-details-marker { display:none; }
				.filter-drawer[open] { width:100%; background:#0f172a55; pointer-events:auto; }
				.filter-drawer[open] summary { left:318px; background:#334155; }
				.filter-panel { width:300px; height:100%; overflow:auto; background:#fff; padding:26px 20px; box-shadow:10px 0 30px #0f172a25; }
				.filter-panel h2 { color:#173f6b; margin:0 0 4px; }
				.filter-panel form { display:grid; gap:3px; }
				.quick-views { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:15px 0; }
				.quick-views a { padding:8px; border-radius:8px; background:#f1f5f9; color:#334155; font-size:12px; text-decoration:none; }
				.filter-panel input, .filter-panel select { width:100%; border:1px solid #cbd5e1; border-radius:8px; padding:9px; background:white; }
				.filter-actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:14px; }
				.apply { background:#1769aa; }
				.clear { display:grid; place-items:center; border:1px solid #cbd5e1; border-radius:8px; text-decoration:none; color:#475569; }
				.filter-trigger { background:#173f6b; color:white; border-radius:9px; padding:10px 13px; font-weight:700; }
				.analytics-metrics { grid-template-columns:repeat(6,1fr); }
				.analytics-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; margin-bottom:20px; }
				.analytics-card { background:white; border-radius:13px; padding:20px; box-shadow:0 3px 14px #0f172a12; }
				.analytics-card h2 { color:#173f6b; margin:0 0 18px; }
				.donut-wrap { display:flex; align-items:center; gap:26px; }
				.donut { width:150px; aspect-ratio:1; flex:0 0 auto; border-radius:50%; background:conic-gradient(${statusSegments || '#e2e8f0 0 100%'}); position:relative; }
				.donut::after { content:'${cases.length}'; position:absolute; inset:28px; display:grid; place-items:center; border-radius:50%; background:white; font-size:26px; font-weight:800; color:#173f6b; }
				.legend { display:grid; gap:9px; width:100%; }
				.legend-row { display:flex; justify-content:space-between; gap:15px; color:#475569; }
				.legend-row i { width:9px; height:9px; border-radius:50%; display:inline-block; margin-right:7px; }
				.bars { display:grid; gap:14px; }
				.bar-row { display:grid; grid-template-columns:105px 1fr 30px; gap:10px; align-items:center; font-size:13px; text-transform:capitalize; }
				.bar-track { height:10px; background:#eef2f7; border-radius:99px; overflow:hidden; }
				.bar-fill { height:100%; border-radius:99px; background:linear-gradient(90deg,#1769aa,#7c3aed); }
				.attention-list { display:grid; gap:10px; }
				.attention-item { display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:12px; padding:12px; border:1px solid #e2e8f0; border-radius:10px; text-decoration:none; color:#172033; }
				.attention-item small { display:block; color:#64748b; margin-top:4px; }
				.count-pill { min-width:28px; height:28px; display:grid; place-items:center; border-radius:8px; background:#eff6ff; color:#1769aa; font-weight:800; }
				.case-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:18px 0; }
				.case-toolbar p { margin:0; }
				.sort-control { display:flex; align-items:end; gap:8px; margin-left:auto; }
				.sort-control label { display:grid; gap:4px; color:#52647a; font-size:12px; font-weight:700; }
				.sort-control select { min-width:150px; border:1px solid #cbd5e1; border-radius:8px; padding:9px; background:white; }
				.sort-control button { background:#1769aa; padding:10px 13px; }

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
						.analytics-metrics { grid-template-columns:repeat(2,1fr); }
						.analytics-grid { grid-template-columns:1fr; }
						.donut-wrap { align-items:flex-start; flex-direction:column; }
						.filter-drawer summary { top:10px; left:8px; }
						.filter-drawer[open] summary { left:auto; right:10px; }
                }
        </style>
</head>
<body>
        <main>
                <header>
                        <div>
                                <div class="page-heading"><h1>Coordination</h1></div>
                                <p>
										Turn blockers into owned, measurable outcomes.
                                </p>
                        </div>

                        <a href="/dashboard">
                                Return to dashboard
                        </a>
                </header>

				<nav class="page-nav" aria-label="Coordination views">
					<a class="${view === 'overview' ? 'active' : ''}" href="/dashboard/cases?project=${projectId}&amp;view=overview">Overview</a>
					<a class="${view === 'cases' ? 'active' : ''}" href="/dashboard/cases?project=${projectId}&amp;view=cases">All cases</a>
				</nav>

                ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ''}

                ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}

				${view === 'overview' ? `
				<section class="metrics analytics-metrics" aria-label="Case summary">
					<div class="metric">Open<strong>${openCount}</strong></div>
					<div class="metric">Awaiting manager<strong>${pendingCount}</strong></div>
					<div class="metric">Overdue<strong>${overdueCount}</strong></div>
					<div class="metric">Critical<strong>${criticalCount}</strong></div>
					<div class="metric">Unassigned<strong>${unassignedCount}</strong></div>
					<div class="metric">Resolved<strong>${resolvedCount}</strong></div>
				</section>
				<section class="analytics-grid">
					<div class="analytics-card">
						<h2>Case status</h2>
						<div class="donut-wrap"><div class="donut" role="img" aria-label="Case status distribution"></div><div class="legend">
						${Object.entries(statusCounts).map(([status, count], index) => `<div class="legend-row"><span><i style="background:${statusPalette[index % statusPalette.length]}"></i>${escapeHtml(formatStatus(status))}</span><strong>${count}</strong></div>`).join('') || '<span>No cases yet</span>'}
						</div></div>
					</div>
					<div class="analytics-card"><h2>Priority mix</h2><div class="bars">
						${priorityCounts.map(([priority, count]) => `<div class="bar-row"><span>${priority}</span><div class="bar-track"><div class="bar-fill" style="width:${(count / maxPriority) * 100}%"></div></div><strong>${count}</strong></div>`).join('')}
					</div></div>
					<div class="analytics-card"><h2>Open-case age</h2><div class="bars">
						${ageCounts.map(([label, count]) => `<div class="bar-row"><span>${label}</span><div class="bar-track"><div class="bar-fill" style="width:${openCases.length ? (count / openCases.length) * 100 : 0}%"></div></div><strong>${count}</strong></div>`).join('')}
					</div></div>
					<div class="analytics-card"><h2>Needs attention</h2><div class="attention-list">
						${attention.map((item) => `<a class="attention-item" href="/dashboard/cases?project=${projectId}&amp;view=cases&amp;search=${item.id}"><span class="count-pill">#${item.id}</span><span><strong>${escapeHtml(item.issue_summary)}</strong><small>${escapeHtml(item.responsible_name ?? 'Unassigned')} · ${caseAgeDays(item, now)} day(s) open</small></span><span class="badge ${escapeHtml(item.priority)}">${escapeHtml(item.priority)}</span></a>`).join('') || '<p>No open cases need attention.</p>'}
					</div></div>
				</section>
				` : `
				<details class="filter-drawer">
					<summary aria-label="Open case filters" title="Filters">☰</summary>
					<aside class="filter-panel" aria-label="Case filters">
						<h2>Filter cases</h2><p>Find the work that needs attention.</p>
						<div class="quick-views" aria-label="Quick views">
							<a href="/dashboard/cases?project=${projectId}&amp;view=cases&amp;quick=open">All open</a>
							<a href="/dashboard/cases?project=${projectId}&amp;view=cases&amp;quick=unassigned">Unassigned</a>
							<a href="/dashboard/cases?project=${projectId}&amp;view=cases&amp;quick=overdue">Overdue</a>
							<a href="/dashboard/cases?project=${projectId}&amp;view=cases&amp;quick=awaiting_verification">Awaiting verification</a>
							<a href="/dashboard/cases?project=${projectId}&amp;view=cases&amp;quick=resolved">Resolved</a>
						</div>
						<form method="get" action="/dashboard/cases">
							<input type="hidden" name="project" value="${projectId}"><input type="hidden" name="view" value="cases">
							<label>Search<input name="search" value="${escapeHtml(filters.search)}" placeholder="Case, person or issue"></label>
							<label>Requester<select name="requester">${selectOptions(requesterOptions, filters.requester)}</select></label>
							<label>Responsible person<select name="owner">${selectOptions(ownerOptions, filters.owner)}</select></label>
							<label>Status<select name="status">${selectOptions(unique(cases.map((item) => item.status)), filters.status)}</select></label>
							<label>Priority<select name="priority">${selectOptions(unique(cases.map((item) => item.priority)), filters.priority)}</select></label>
							<label>Case type<select name="type">${selectOptions(unique(cases.map((item) => item.case_type)), filters.type)}</select></label>
							<label>Resolution state<select name="resolution">${selectOptions(unique(cases.map((item) => item.resolution_state)), filters.resolution)}</select></label>
							<label>Case age<select name="age">${selectOptions([['today','Today'],['7','Last 7 days'],['30','Last 30 days'],['older','Older than 30 days']], filters.age)}</select></label>
							<label>SLA<select name="sla">${selectOptions([['on_track','On track'],['due_soon','Due soon'],['overdue','Overdue']], filters.sla)}</select></label>
							<label>Meeting duration<select name="duration">${selectOptions([...allowedDurations].map((duration) => [String(duration), `${duration} minutes`] as [string, string]), filters.duration)}</select></label>
							<label>Sort by<select name="sort">${[['attention','Needs attention'],['newest','Latest first'],['oldest','Oldest first'],['priority','Priority'],['sla','SLA deadline']].map(([value,label]) => `<option value="${value}" ${filters.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
							<div class="filter-actions"><button class="apply" type="submit">Apply filters</button><a class="clear" href="/dashboard/cases?project=${projectId}&amp;view=cases">Clear</a></div>
						</form>
					</aside>
				</details>
				<div class="case-toolbar"><span class="filter-trigger">☰ Filters${activeFilterCount ? ` · ${activeFilterCount} active` : ''}</span><p>Showing <strong>${visibleCases.length}</strong> of ${cases.length} cases</p><form class="sort-control" method="get" action="/dashboard/cases"><input type="hidden" name="project" value="${projectId}"><input type="hidden" name="view" value="cases"><label>Order<select name="sort">${[['attention','Needs attention'],['newest','Latest first'],['oldest','Oldest first'],['priority','Priority'],['sla','SLA deadline']].map(([value,label]) => `<option value="${value}" ${filters.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><button type="submit">Apply</button></form></div>
				${cards}
				`}
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
	const requestUrl = new URL(request.url);
	const [cases, members] = await Promise.all([
		getCases(env.DB, principal.tenantId, projectId),
		getMembers(env.DB, principal.tenantId, projectId),
	]);

	const updated = requestUrl.searchParams.get('updated');

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

	return htmlResponse(page(cases, members, message, error, requestUrl, projectId), error ? 400 : 200);
}

async function getCase(db: D1Database, caseId: number, tenantId: number, projectId: number): Promise<CaseRow | null> {
	return db
		.prepare(
			`
                        SELECT
                                coordination.id,
				coordination.tenant_id,
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
                                coordination.updated_at,
                                jira.external_issue_key,
                                jira.external_issue_url,
                                jira.external_status,
                                jira.sync_status AS jira_sync_status,
				COALESCE((SELECT COUNT(*) FROM sent_messages AS submitted
					WHERE submitted.message_type = 'meeting_notification'
						AND submitted.scheduled_for = ('case:' || coordination.id || ':meeting')
						AND submitted.status IN ('submitted', 'sent')), 0) AS meeting_notifications_submitted,
				COALESCE((SELECT COUNT(*) FROM sent_messages AS delivered
					WHERE delivered.message_type = 'meeting_notification'
						AND delivered.scheduled_for = ('case:' || coordination.id || ':meeting')
						AND delivered.status IN ('delivered', 'read')), 0) AS meeting_notifications_delivered,
				COALESCE((SELECT COUNT(*) FROM sent_messages AS failed
					WHERE failed.message_type = 'meeting_notification'
						AND failed.scheduled_for = ('case:' || coordination.id || ':meeting')
						AND failed.status = 'failed'), 0) AS meeting_notifications_failed
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
                        LEFT JOIN jira_case_links
                                AS jira
                                ON jira.case_id = coordination.id
                                        AND jira.tenant_id = coordination.tenant_id
                                        AND jira.project_id = coordination.project_id
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

function formatMeetingTime(value: string, timezone = 'UTC'): string {
	const date = new Date(value);

	if (Number.isNaN(date.getTime())) {
		return value;
	}

	try {
		return `${new Intl.DateTimeFormat('en-IN', {
			dateStyle: 'medium',
			timeStyle: 'short',
			timeZone: timezone,
		}).format(date)} (${timezone})`;
	} catch {
		return `${new Intl.DateTimeFormat('en-IN', {
			dateStyle: 'medium',
			timeStyle: 'short',
			timeZone: 'UTC',
		}).format(date)} (UTC)`;
	}
}

async function participantWasNotified(db: D1Database, caseId: number, memberId: number): Promise<boolean> {
	const message = await db
		.prepare(
			`
				SELECT id
				FROM sent_messages
				WHERE team_member_id = ?
					AND message_type = 'meeting_notification'
					AND scheduled_for = ?
					AND status IN ('submitted', 'sent', 'delivered', 'read')
				LIMIT 1
				`,
		)
		.bind(memberId, `case:${caseId}:meeting`)
		.first<{ id: number }>();

	return Boolean(message);
}

async function recordParticipantNotification(
	db: D1Database,
	caseId: number,
	memberId: number,
	messageId: string,
	tenantId: number,
): Promise<void> {
	await db.prepare(
		`
		INSERT INTO sent_messages (
			team_member_id,
			whatsapp_message_id,
			message_type,
			scheduled_for,
			sent_at,
			status,
			error_message
			, tenant_id
		)
		VALUES (?, ?, 'meeting_notification', ?, CURRENT_TIMESTAMP, 'submitted', NULL, ?)
		`,
	)
		.bind(memberId, messageId, `case:${caseId}:meeting`, tenantId)
		.run();

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
				'meeting_link_notification_submitted',
                                'system',
                                ?,
				'Meeting notification accepted by WhatsApp for delivery'
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
			SELECT id, name, phone, timezone
                        FROM team_members
                        WHERE id IN (?, ?)
                        ORDER BY id
                        `,
	)
		.bind(coordinationCase.requester_member_id, coordinationCase.responsible_member_id)
		.all<{
			id: number;
			name: string;
			phone: string;
			timezone: string;
		}>();

	if (participants.results.length !== 2) {
		return 'Both participants must exist before scheduling.';
	}

	if (!env.WHATSAPP_MEETING_TEMPLATE_NAME) {
		return 'Meeting link saved, but the WhatsApp meeting template is not configured.';
	}

	for (const participant of participants.results) {
		if (await participantWasNotified(env.DB, coordinationCase.id, participant.id)) {
			continue;
		}

		const result = await sendMeetingScheduled(
			env,
			participant,
			coordinationCase.id,
			formatMeetingTime(coordinationCase.proposed_time, participant.timezone),
			coordinationCase.meeting_duration_minutes,
			meetingLink,
			fetcher,
		);

		if (!result.success) {
			return 'Meeting link saved, but a WhatsApp notification failed. Submit again to retry.';
		}

		if (!result.messageId) {
			return 'Meeting link saved, but WhatsApp did not return a message ID. Submit again to retry.';
		}

		await recordParticipantNotification(
			env.DB,
			coordinationCase.id,
			participant.id,
			result.messageId,
			coordinationCase.tenant_id,
		);
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

		const jiraConfig = jiraConfigFromEnv(env);
		if (jiraConfig) {
			try {
				const jiraResult = await syncApprovedCaseToJira(
					env.DB,
					caseId,
					jiraConfig,
					fetcher,
					atlassianMcpConfigFromEnv(env),
				);
				console.log(JSON.stringify({
					event: 'jira_case_sync_completed',
					caseId,
					status: jiraResult.status,
					issueKey: jiraResult.issueKey,
				}));
			} catch (error) {
				console.error(JSON.stringify({
					event: 'jira_case_sync_failed',
					caseId,
					error: error instanceof Error ? error.message : 'Unknown Jira sync error',
				}));
			}
		}

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

		await recordManagerEvent(env.DB, caseId, 'meeting_scheduled', 'Meeting link saved and participant notifications submitted to WhatsApp');

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
