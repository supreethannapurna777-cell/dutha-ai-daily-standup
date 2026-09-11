import type { WorkerEnv } from "./env";
import { getIstDate } from "./scheduler";


interface DashboardRow {
	name: string;
	department: string;
	received_at: string | null;
	tasks: string | null;
	people_to_connect: string | null;
	blockers: string | null;
	expected_completion: string | null;
}


function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}


function isActiveBlocker(value: string | null): boolean {
	if (!value) {
		return false;
	}

	const normalised = value.trim().toLowerCase();

	return ![
		"",
		"none",
		"none mentioned",
		"not specified",
		"no",
		"nil",
	].includes(normalised);
}


function isAuthorised(
	request: Request,
	env: WorkerEnv,
): boolean {
	if (
		!env.DASHBOARD_USERNAME ||
		!env.DASHBOARD_PASSWORD
	) {
		return false;
	}

	const expected =
		`Basic ${btoa(
			`${env.DASHBOARD_USERNAME}:` +
			env.DASHBOARD_PASSWORD,
		)}`;

	return request.headers.get("Authorization") === expected;
}


function formatReceivedAt(value: string | null): string {
	if (!value) {
		return "Pending";
	}

	return new Date(value).toLocaleString("en-IN", {
		timeZone: "Asia/Kolkata",
		dateStyle: "medium",
		timeStyle: "short",
	});
}


async function getDashboardRows(
	db: D1Database,
	istDate: string,
): Promise<DashboardRow[]> {
	const result = await db
		.prepare(
			`
			SELECT
				member.name,
				member.department,
				incoming.received_at,
				processed.tasks,
				processed.people_to_connect,
				processed.blockers,
				processed.expected_completion
			FROM team_members AS member
			LEFT JOIN incoming_messages AS incoming
				ON incoming.id = (
					SELECT candidate.id
					FROM incoming_messages AS candidate
					WHERE candidate.sender_phone = member.phone
						AND date(
							candidate.received_at,
							'+5 hours',
							'+30 minutes'
						) = ?
					ORDER BY candidate.received_at DESC
					LIMIT 1
				)
			LEFT JOIN processed_updates AS processed
				ON processed.message_id = incoming.id
			WHERE member.active = 1
			ORDER BY member.name
			`,
		)
		.bind(istDate)
		.all<DashboardRow>();

	return result.results;
}


export async function createDashboardResponse(
	request: Request,
	env: WorkerEnv,
	now = new Date(),
): Promise<Response> {
	if (
		!env.DASHBOARD_USERNAME ||
		!env.DASHBOARD_PASSWORD
	) {
		return new Response(
			"Dashboard authentication is not configured.",
			{ status: 503 },
		);
	}

	if (!isAuthorised(request, env)) {
		return new Response(
			"Authentication required.",
			{
				status: 401,
				headers: {
					"WWW-Authenticate":
						'Basic realm="Dutha Standup Dashboard"',
				},
			},
		);
	}

	const istDate = getIstDate(now.getTime());
	const rows = await getDashboardRows(env.DB, istDate);

	const total = rows.length;
	const received = rows.filter(
		(row) => Boolean(row.received_at),
	).length;
	const pending = total - received;
	const blockers = rows.filter(
		(row) => isActiveBlocker(row.blockers),
	).length;
	const completion =
		total === 0
			? 0
			: Math.round((received / total) * 100);

	const tableRows = rows.length
		? rows.map((row) => {
			const responded = Boolean(row.received_at);

			return `
				<tr>
					<td>
						<strong>${escapeHtml(row.name)}</strong>
						<small>${escapeHtml(row.department)}</small>
					</td>
					<td>
						<span class="badge ${responded ? "received" : "pending"}">
							${responded ? "Received" : "Pending"}
						</span>
					</td>
					<td>${escapeHtml(row.tasks || "—")}</td>
					<td>${escapeHtml(row.people_to_connect || "—")}</td>
					<td class="${isActiveBlocker(row.blockers) ? "danger" : ""}">
						${escapeHtml(row.blockers || "—")}
					</td>
					<td>${escapeHtml(row.expected_completion || "—")}</td>
					<td>${escapeHtml(formatReceivedAt(row.received_at))}</td>
				</tr>
			`;
		}).join("")
		: `
			<tr>
				<td colspan="7" class="empty">
					No active team members configured.
				</td>
			</tr>
		`;

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Dutha AI Daily Standup</title>
	<style>
		:root {
			font-family: Inter, Arial, sans-serif;
			color: #172033;
			background: #f4f7fb;
		}
		* { box-sizing: border-box; }
		body { margin: 0; padding: 32px; }
		main { max-width: 1400px; margin: auto; }
		h1 { margin-bottom: 4px; color: #173f6b; }
		.subtitle { color: #64748b; margin-top: 0; }
		.cards {
			display: grid;
			grid-template-columns: repeat(4, minmax(150px, 1fr));
			gap: 16px;
			margin: 24px 0;
		}
		.card, .table-wrap {
			background: white;
			border-radius: 12px;
			box-shadow: 0 3px 14px #0f172a12;
		}
		.card { padding: 20px; }
		.label { color: #64748b; font-size: 14px; }
		.value {
			font-size: 30px;
			font-weight: 700;
			margin-top: 8px;
			color: #173f6b;
		}
		.table-wrap { overflow-x: auto; }
		table { width: 100%; border-collapse: collapse; }
		th {
			background: #173f6b;
			color: white;
			text-align: left;
			padding: 14px;
		}
		td {
			padding: 14px;
			border-bottom: 1px solid #e5eaf1;
			vertical-align: top;
		}
		td small {
			display: block;
			color: #64748b;
			margin-top: 4px;
		}
		.badge {
			display: inline-block;
			padding: 5px 9px;
			border-radius: 999px;
			font-size: 12px;
			font-weight: 700;
		}
		.received { color: #166534; background: #dcfce7; }
		.pending { color: #92400e; background: #fef3c7; }
		.danger { color: #b91c1c; font-weight: 600; }
		.empty { text-align: center; color: #64748b; }
		footer { margin-top: 18px; color: #64748b; font-size: 13px; }
		@media (max-width: 800px) {
			body { padding: 16px; }
			.cards { grid-template-columns: repeat(2, 1fr); }
		}
	</style>
</head>
<body>
	<main>
		<h1>Dutha AI Daily Standup</h1>
		<p class="subtitle">Team status for ${escapeHtml(istDate)} (IST)</p>

		<section class="cards">
			<div class="card">
				<div class="label">Responses received</div>
				<div class="value">${received} / ${total}</div>
			</div>
			<div class="card">
				<div class="label">Completion</div>
				<div class="value">${completion}%</div>
			</div>
			<div class="card">
				<div class="label">Pending members</div>
				<div class="value">${pending}</div>
			</div>
			<div class="card">
				<div class="label">Active blockers</div>
				<div class="value">${blockers}</div>
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
						<th>Completion</th>
						<th>Received at</th>
					</tr>
				</thead>
				<tbody>${tableRows}</tbody>
			</table>
		</div>

		<footer>
			Private management dashboard · Phone numbers are never displayed
		</footer>
	</main>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Frame-Options": "DENY",
			"Content-Security-Policy":
				"default-src 'none'; style-src 'unsafe-inline'",
		},
	});
}