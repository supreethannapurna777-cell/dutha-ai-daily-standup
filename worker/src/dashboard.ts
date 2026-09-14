import type { WorkerEnv } from "./env";
import {
        getLocalScheduleDetails,
} from "./scheduler";


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


function escapeHtml(value: unknown): string {
        return String(value ?? "")
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#039;");
}


function isActiveBlocker(
        value: string | null,
): boolean {
        if (!value) {
                return false;
        }

        const normalised = value
                .trim()
                .toLowerCase();

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
                !env.DASHBOARD_USERNAME
                || !env.DASHBOARD_PASSWORD
        ) {
                return false;
        }

        const expected =
                `Basic ${btoa(
                        `${env.DASHBOARD_USERNAME}:`
                        + env.DASHBOARD_PASSWORD,
                )}`;

        return request.headers.get("Authorization")
                === expected;
}


function safeTimezone(
        timezone: string,
): string {
        try {
                new Intl.DateTimeFormat(
                        "en-US",
                        {
                                timeZone: timezone,
                        },
                ).format(new Date());

                return timezone;
        } catch {
                return "Asia/Kolkata";
        }
}


function formatReceivedAt(
        value: string | null,
        timezone: string,
): string {
        if (!value) {
                return "Pending";
        }

        return new Date(value).toLocaleString(
                "en-IN",
                {
                        timeZone:
                                safeTimezone(timezone),
                        dateStyle: "medium",
                        timeStyle: "short",
                },
        );
}


function respondedOnMemberLocalDate(
        row: DashboardRow,
        nowTimestamp: number,
): boolean {
        if (!row.received_at) {
                return false;
        }

        const receivedTimestamp = Date.parse(
                row.received_at,
        );

        if (Number.isNaN(receivedTimestamp)) {
                return false;
        }

        const timezone = safeTimezone(
                row.timezone,
        );

        const currentLocalDate =
                getLocalScheduleDetails(
                        nowTimestamp,
                        timezone,
                ).date;

        const receivedLocalDate =
                getLocalScheduleDetails(
                        receivedTimestamp,
                        timezone,
                ).date;

        return currentLocalDate
                === receivedLocalDate;
}


async function getDashboardRows(
        db: D1Database,
): Promise<DashboardRow[]> {
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
                                        FROM incoming_messages AS candidate
                                        WHERE candidate.sender_phone
                                                = member.phone
                                        ORDER BY
                                                candidate.received_at DESC
                                        LIMIT 1
                                )
                        LEFT JOIN processed_updates AS processed
                                ON processed.message_id
                                        = incoming.id
                        WHERE member.active = 1
                        ORDER BY member.name
                        `,
                )
                .all<DashboardRow>();

        return result.results;
}


function displayValue(
        row: PreparedDashboardRow,
        value: string | null,
): string {
        if (!row.respondedToday) {
                return "—";
        }

        return value || "Not specified";
}


export async function createDashboardResponse(
        request: Request,
        env: WorkerEnv,
        now = new Date(),
): Promise<Response> {
        if (
                !env.DASHBOARD_USERNAME
                || !env.DASHBOARD_PASSWORD
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
                                                'Basic realm="Dutha WorkOps Dashboard"',
                                },
                        },
                );
        }

        const databaseRows =
                await getDashboardRows(env.DB);

        const rows: PreparedDashboardRow[] =
                databaseRows.map((row) => ({
                        ...row,
                        respondedToday:
                                respondedOnMemberLocalDate(
                                        row,
                                        now.getTime(),
                                ),
                }));

        const total = rows.length;

        const received = rows.filter(
                (row) => row.respondedToday,
        ).length;

        const pending = total - received;

        const blockers = rows.filter(
                (row) =>
                        row.respondedToday
                        && isActiveBlocker(
                                row.blockers,
                        ),
        ).length;

        const completion =
                total === 0
                        ? 0
                        : Math.round(
                                (received / total) * 100,
                        );

        const tableRows = rows.length
                ? rows.map((row) => {
                        const responded =
                                row.respondedToday;

                        const timezone =
                                safeTimezone(
                                        row.timezone,
                                );

                        return `
                                <tr>
                                        <td>
                                                <strong>${
                                                        escapeHtml(
                                                                row.name,
                                                        )
                                                }</strong>
                                                <small>${
                                                        escapeHtml(
                                                                row.department,
                                                        )
                                                }</small>
                                                <small>${
                                                        escapeHtml(
                                                                timezone,
                                                        )
                                                }</small>
                                        </td>
                                        <td>
                                                <span class="badge ${
                                                        responded
                                                                ? "received"
                                                                : "pending"
                                                }">
                                                        ${
                                                                responded
                                                                        ? "Received"
                                                                        : "Pending"
                                                        }
                                                </span>
                                                ${
                                                        row.scheduling_enabled
                                                                ? ""
                                                                : '<small class="paused">Automation paused</small>'
                                                }
                                        </td>
                                        <td>${
                                                escapeHtml(
                                                        displayValue(
                                                                row,
                                                                row.tasks,
                                                        ),
                                                )
                                        }</td>
                                        <td>${
                                                escapeHtml(
                                                        displayValue(
                                                                row,
                                                                row.people_to_connect,
                                                        ),
                                                )
                                        }</td>
                                        <td class="${
                                                responded
                                                && isActiveBlocker(
                                                        row.blockers,
                                                )
                                                        ? "danger"
                                                        : ""
                                        }">
                                                ${
                                                        escapeHtml(
                                                                displayValue(
                                                                        row,
                                                                        row.blockers,
                                                                ),
                                                        )
                                                }
                                        </td>
                                        <td>${
                                                escapeHtml(
                                                        displayValue(
                                                                row,
                                                                row.expected_completion,
                                                        ),
                                                )
                                        }</td>
                                        <td>${
                                                escapeHtml(
                                                        responded
                                                                ? formatReceivedAt(
                                                                        row.received_at,
                                                                        timezone,
                                                                )
                                                                : "Pending"
                                                        )
                                        }</td>
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

        const operationalTime =
                now.toLocaleString(
                        "en-IN",
                        {
                                timeZone:
                                        "Asia/Kolkata",
                                dateStyle: "medium",
                                timeStyle: "short",
                        },
                );

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
                        max-width: 1400px;
                        margin: auto;
                }

                .header {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 20px;
                }

                h1 {
                        margin-bottom: 4px;
                        color: #173f6b;
                }

                .subtitle {
                        color: #64748b;
                        margin-top: 0;
                }

                .manage-link {
                        display: inline-block;
                        color: white;
                        background: #1769aa;
                        padding: 11px 15px;
                        border-radius: 9px;
                        text-decoration: none;
                        font-weight: 700;
                }

                .cards {
                        display: grid;
                        grid-template-columns:
                                repeat(4, minmax(150px, 1fr));
                        gap: 16px;
                        margin: 24px 0;
                }

                .card,
                .table-wrap {
                        background: white;
                        border-radius: 12px;
                        box-shadow: 0 3px 14px #0f172a12;
                }

                .card {
                        padding: 20px;
                }

                .label {
                        color: #64748b;
                        font-size: 14px;
                }

                .value {
                        font-size: 30px;
                        font-weight: 700;
                        margin-top: 8px;
                        color: #173f6b;
                }

                .table-wrap {
                        overflow-x: auto;
                }

                table {
                        width: 100%;
                        border-collapse: collapse;
                }

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

                .paused {
                        color: #b45309;
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

                @media (max-width: 800px) {
                        body {
                                padding: 16px;
                        }

                        .header {
                                align-items: start;
                                flex-direction: column;
                        }

                        .cards {
                                grid-template-columns:
                                        repeat(2, 1fr);
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
                                        Live team status as of ${
                                                escapeHtml(
                                                        operationalTime,
                                                )
                                        } IST
                                </p>
                        </div>

                        <a
                                class="manage-link"
                                href="/dashboard/members"
                        >
                                Manage members and schedules
                        </a>
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
                                        Completion
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
                        Private management dashboard ·
                        Phone numbers are never displayed ·
                        Each response is evaluated using the
                        member's configured local date
                </footer>
        </main>
</body>
</html>`;

        return new Response(
                html,
                {
                        status: 200,
                        headers: {
                                "Content-Type":
                                        "text/html; charset=utf-8",
                                "Cache-Control": "no-store",
                                "X-Frame-Options": "DENY",
                                "X-Content-Type-Options":
                                        "nosniff",
                                "Referrer-Policy":
                                        "no-referrer",
                                "Content-Security-Policy":
                                        "default-src 'none'; "
                                        + "style-src 'unsafe-inline'; "
                                        + "frame-ancestors 'none'; "
                                        + "base-uri 'none'",
                        },
                },
        );
}