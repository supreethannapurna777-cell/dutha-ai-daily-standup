import {
        proposeCaseTimes,
        recordMemberAvailability,
} from "./availability";
import type { WorkerEnv } from "./env";
import {
        getLocalScheduleDetails,
} from "./scheduler";


interface AvailabilityCase {
        id: number;
        issue_summary: string;
        status: string;
        meeting_duration_minutes: number;
        proposed_time: string | null;
        requester_member_id: number;
        requester_name: string;
        requester_timezone: string;
        responsible_member_id: number;
        responsible_name: string;
        responsible_timezone: string;
}


interface AvailabilityOption {
        id: number;
        starts_at: string;
        status: string;
        requester_selected: number;
        responsible_selected: number;
}


function escapeHtml(value: unknown): string {
        return String(value ?? "")
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#039;");
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

        const credentials = btoa(
                `${env.DASHBOARD_USERNAME}:`
                + env.DASHBOARD_PASSWORD,
        );

        return request.headers.get("Authorization")
                === `Basic ${credentials}`;
}


function authenticationRequired(): Response {
        return new Response(
                "Authentication required.",
                {
                        status: 401,
                        headers: {
                                "WWW-Authenticate":
                                        'Basic realm="Dutha WorkOps"',
                        },
                },
        );
}


function sameOrigin(
        request: Request,
): boolean {
        const expectedOrigin =
                new URL(request.url).origin;
        const origin =
                request.headers.get("Origin");

        if (origin && origin !== "null") {
                return origin === expectedOrigin;
        }

        return request.headers.get(
                "Sec-Fetch-Site",
        ) === "same-origin";
}


function htmlResponse(
        html: string,
        status = 200,
): Response {
        return new Response(
                html,
                {
                        status,
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
                                        + "form-action 'self'; "
                                        + "base-uri 'none'; "
                                        + "frame-ancestors 'none'",
                        },
                },
        );
}


async function getCase(
        db: D1Database,
        caseId: number,
): Promise<AvailabilityCase | null> {
        return db
                .prepare(
                        `
                        SELECT
                                coordination.id,
                                coordination.issue_summary,
                                coordination.status,
                                coordination.meeting_duration_minutes,
                                coordination.proposed_time,
                                requester.id
                                        AS requester_member_id,
                                requester.name
                                        AS requester_name,
                                requester.timezone
                                        AS requester_timezone,
                                responsible.id
                                        AS responsible_member_id,
                                responsible.name
                                        AS responsible_name,
                                responsible.timezone
                                        AS responsible_timezone
                        FROM coordination_cases
                                AS coordination
                        INNER JOIN team_members
                                AS requester
                                ON requester.id
                                        = coordination.requester_member_id
                        INNER JOIN team_members
                                AS responsible
                                ON responsible.id
                                        = coordination.responsible_member_id
                        WHERE coordination.id = ?
                        `,
                )
                .bind(caseId)
                .first<AvailabilityCase>();
}


async function getOptions(
        db: D1Database,
        coordinationCase: AvailabilityCase,
): Promise<AvailabilityOption[]> {
        const result = await db
                .prepare(
                        `
                        SELECT
                                option.id,
                                option.starts_at,
                                option.status,

                                EXISTS (
                                        SELECT 1
                                        FROM case_availability
                                                AS requester_choice
                                        WHERE requester_choice.case_id
                                                = option.case_id
                                                AND requester_choice.member_id
                                                        = ?
                                                AND requester_choice.available_at
                                                        = option.starts_at
                                ) AS requester_selected,

                                EXISTS (
                                        SELECT 1
                                        FROM case_availability
                                                AS responsible_choice
                                        WHERE responsible_choice.case_id
                                                = option.case_id
                                                AND responsible_choice.member_id
                                                        = ?
                                                AND responsible_choice.available_at
                                                        = option.starts_at
                                ) AS responsible_selected

                        FROM case_time_options AS option
                        WHERE option.case_id = ?
                        ORDER BY option.starts_at
                        `,
                )
                .bind(
                        coordinationCase
                                .requester_member_id,
                        coordinationCase
                                .responsible_member_id,
                        coordinationCase.id,
                )
                .all<AvailabilityOption>();

        return result.results;
}


function localDateTimeToUtc(
        localValue: string,
        timezone: string,
): string | null {
        const match =
                /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
                        .exec(localValue);

        if (!match) {
                return null;
        }

        const [
                ,
                year,
                month,
                day,
                hour,
                minute,
        ] = match;

        const targetAsUtc = Date.UTC(
                Number(year),
                Number(month) - 1,
                Number(day),
                Number(hour),
                Number(minute),
        );

        let estimate = targetAsUtc;

        try {
                for (
                        let attempt = 0;
                        attempt < 4;
                        attempt += 1
                ) {
                        const observed =
                                getLocalScheduleDetails(
                                        estimate,
                                        timezone,
                                );

                        const observedAsUtc =
                                Date.parse(
                                        `${observed.date}`
                                        + `T${observed.time}:00.000Z`,
                                );

                        estimate +=
                                targetAsUtc
                                - observedAsUtc;
                }

                const finalLocal =
                        getLocalScheduleDetails(
                                estimate,
                                timezone,
                        );

                const requested =
                        `${year}-${month}-${day}`
                        + `T${hour}:${minute}`;

                const converted =
                        `${finalLocal.date}`
                        + `T${finalLocal.time}`;

                if (requested !== converted) {
                        return null;
                }

                return new Date(
                        estimate,
                ).toISOString();
        } catch {
                return null;
        }
}


function formatInTimezone(
        value: string,
        timezone: string,
): string {
        return new Date(value).toLocaleString(
                "en-IN",
                {
                        timeZone: timezone,
                        dateStyle: "medium",
                        timeStyle: "short",
                },
        );
}


function optionsForm(
        coordinationCase: AvailabilityCase,
        options: AvailabilityOption[],
        memberType:
                | "requester"
                | "responsible",
): string {
        const isRequester =
                memberType === "requester";

        const memberId = isRequester
                ? coordinationCase
                        .requester_member_id
                : coordinationCase
                        .responsible_member_id;

        const memberName = isRequester
                ? coordinationCase.requester_name
                : coordinationCase.responsible_name;

        const selectedProperty = isRequester
                ? "requester_selected"
                : "responsible_selected";

        return `
                <form method="post" class="selection">
                        <input
                                type="hidden"
                                name="action"
                                value="record_availability"
                        >
                        <input
                                type="hidden"
                                name="case_id"
                                value="${coordinationCase.id}"
                        >
                        <input
                                type="hidden"
                                name="member_id"
                                value="${memberId}"
                        >

                        <h3>
                                ${escapeHtml(memberName)} availability
                        </h3>

                        ${
                                options.map((option) => `
                                        <label class="choice">
                                                <input
                                                        type="checkbox"
                                                        name="option_id"
                                                        value="${option.id}"
                                                        ${
                                                                option[
                                                                        selectedProperty
                                                                ]
                                                                        ? "checked"
                                                                        : ""
                                                        }
                                                >
                                                <span>
                                                        ${
                                                                escapeHtml(
                                                                        formatInTimezone(
                                                                                option.starts_at,
                                                                                isRequester
                                                                                        ? coordinationCase.requester_timezone
                                                                                        : coordinationCase.responsible_timezone,
                                                                        ),
                                                                )
                                                        }
                                                </span>
                                        </label>
                                `).join("")
                        }

                        <button type="submit">
                                Save ${escapeHtml(memberName)} availability
                        </button>
                </form>
        `;
}


function page(
        coordinationCase: AvailabilityCase | null,
        options: AvailabilityOption[],
        message: string | null,
        error: string | null,
): string {
        if (!coordinationCase) {
                return `<!DOCTYPE html>
<html lang="en">
<head>
        <meta charset="UTF-8">
        <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
        >
        <title>Availability | Dutha WorkOps</title>
</head>
<body>
        <h1>Coordination case not found</h1>
        <a href="/dashboard/cases">Return to cases</a>
</body>
</html>`;
        }

        const canPropose = [
                "approved",
                "availability_requested",
        ].includes(
                coordinationCase.status,
        );

        const collecting =
                coordinationCase.status
                        === "availability_requested";

        const agreed =
                coordinationCase.status
                        === "time_agreed"
                && coordinationCase.proposed_time;

        return `<!DOCTYPE html>
<html lang="en">
<head>
        <meta charset="UTF-8">
        <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
        >
        <title>Case Availability | Dutha WorkOps</title>

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
                        max-width: 1050px;
                        margin: auto;
                }

                header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        gap: 20px;
                }

                h1 {
                        margin-bottom: 5px;
                        color: #173f6b;
                }

                p {
                        color: #64748b;
                }

                a {
                        color: #1769aa;
                        font-weight: 700;
                }

                .summary,
                .panel,
                .notice,
                .error,
                .agreed {
                        background: white;
                        border-radius: 13px;
                        box-shadow: 0 3px 14px #0f172a12;
                        padding: 20px;
                        margin-top: 18px;
                }

                .details,
                .slots,
                .people {
                        display: grid;
                        gap: 14px;
                }

                .details {
                        grid-template-columns:
                                repeat(4, 1fr);
                }

                .slots {
                        grid-template-columns:
                                repeat(3, 1fr);
                }

                .people {
                        grid-template-columns:
                                repeat(2, 1fr);
                }

                label {
                        display: grid;
                        gap: 7px;
                }

                input[type="datetime-local"] {
                        width: 100%;
                        padding: 10px;
                        border: 1px solid #cbd5e1;
                        border-radius: 8px;
                }

                .choice {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        padding: 9px;
                        border-bottom: 1px solid #e2e8f0;
                }

                button {
                        margin-top: 15px;
                        border: 0;
                        border-radius: 8px;
                        padding: 11px 15px;
                        color: white;
                        background: #1769aa;
                        font-weight: 700;
                        cursor: pointer;
                }

                .notice {
                        color: #166534;
                        background: #dcfce7;
                }

                .error {
                        color: #991b1b;
                        background: #fee2e2;
                }

                .agreed {
                        color: #166534;
                        background: #dcfce7;
                }

                .timezone {
                        font-size: 13px;
                        color: #64748b;
                }

                @media (max-width: 750px) {
                        body {
                                padding: 16px;
                        }

                        header {
                                align-items: start;
                                flex-direction: column;
                        }

                        .details,
                        .slots,
                        .people {
                                grid-template-columns: 1fr;
                        }
                }
        </style>
</head>

<body>
        <main>
                <header>
                        <div>
                                <h1>
                                        Case #${
                                                coordinationCase.id
                                        } availability
                                </h1>
                                <p>
                                        ${
                                                escapeHtml(
                                                        coordinationCase.issue_summary,
                                                )
                                        }
                                </p>
                        </div>

                        <a href="/dashboard/cases">
                                Return to cases
                        </a>
                </header>

                ${
                        message
                                ? `<div class="notice">${
                                        escapeHtml(message)
                                }</div>`
                                : ""
                }

                ${
                        error
                                ? `<div class="error">${
                                        escapeHtml(error)
                                }</div>`
                                : ""
                }

                <section class="summary">
                        <div class="details">
                                <div>
                                        <strong>Status</strong>
                                        <p>${
                                                escapeHtml(
                                                        coordinationCase.status,
                                                )
                                        }</p>
                                </div>

                                <div>
                                        <strong>Requester</strong>
                                        <p>${
                                                escapeHtml(
                                                        coordinationCase.requester_name,
                                                )
                                        }</p>
                                </div>

                                <div>
                                        <strong>Responsible</strong>
                                        <p>${
                                                escapeHtml(
                                                        coordinationCase.responsible_name,
                                                )
                                        }</p>
                                </div>

                                <div>
                                        <strong>Duration</strong>
                                        <p>
                                                ${
                                                        coordinationCase.meeting_duration_minutes
                                                } minutes
                                        </p>
                                </div>
                        </div>
                </section>

                ${
                        agreed
                                ? `
                                        <section class="agreed">
                                                <strong>
                                                        Common time agreed
                                                </strong>

                                                <p>
                                                        ${
                                                                escapeHtml(
                                                                        formatInTimezone(
                                                                                coordinationCase.proposed_time as string,
                                                                                coordinationCase.requester_timezone,
                                                                        ),
                                                                )
                                                        }
                                                        (${
                                                                escapeHtml(
                                                                        coordinationCase.requester_timezone,
                                                                )
                                                        })
                                                </p>

                                                <p>
                                                        ${
                                                                escapeHtml(
                                                                        formatInTimezone(
                                                                                coordinationCase.proposed_time as string,
                                                                                coordinationCase.responsible_timezone,
                                                                        ),
                                                                )
                                                        }
                                                        (${
                                                                escapeHtml(
                                                                        coordinationCase.responsible_timezone,
                                                                )
                                                        })
                                                </p>
                                        </section>
                                `
                                : ""
                }

                ${
                        canPropose
                                ? `
                                        <section class="panel">
                                                <h2>
                                                        Propose discussion times
                                                </h2>

                                                <p>
                                                        Enter times in ${
                                                                escapeHtml(
                                                                        coordinationCase.requester_name,
                                                                )
                                                        }'s timezone:
                                                        <strong>
                                                                ${
                                                                        escapeHtml(
                                                                                coordinationCase.requester_timezone,
                                                                        )
                                                                }
                                                        </strong>
                                                </p>

                                                <form method="post">
                                                        <input
                                                                type="hidden"
                                                                name="action"
                                                                value="propose"
                                                        >
                                                        <input
                                                                type="hidden"
                                                                name="case_id"
                                                                value="${
                                                                        coordinationCase.id
                                                                }"
                                                        >

                                                        <div class="slots">
                                                                <label>
                                                                        Option 1
                                                                        <input
                                                                                type="datetime-local"
                                                                                name="slot"
                                                                                step="900"
                                                                                required
                                                                        >
                                                                </label>

                                                                <label>
                                                                        Option 2
                                                                        <input
                                                                                type="datetime-local"
                                                                                name="slot"
                                                                                step="900"
                                                                                required
                                                                        >
                                                                </label>

                                                                <label>
                                                                        Option 3
                                                                        <input
                                                                                type="datetime-local"
                                                                                name="slot"
                                                                                step="900"
                                                                        >
                                                                </label>
                                                        </div>

                                                        <button type="submit">
                                                                Create time options
                                                        </button>
                                                </form>
                                        </section>
                                `
                                : ""
                }

                ${
                        collecting && options.length
                                ? `
                                        <section class="panel">
                                                <h2>
                                                        Pilot availability collection
                                                </h2>

                                                <p>
                                                        These manager-assisted
                                                        controls will later be
                                                        replaced by WhatsApp
                                                        selection messages.
                                                </p>

                                                <div class="people">
                                                        ${
                                                                optionsForm(
                                                                        coordinationCase,
                                                                        options,
                                                                        "requester",
                                                                )
                                                        }

                                                        ${
                                                                optionsForm(
                                                                        coordinationCase,
                                                                        options,
                                                                        "responsible",
                                                                )
                                                        }
                                                </div>
                                        </section>
                                `
                                : ""
                }
        </main>
</body>
</html>`;
}


async function renderPage(
        request: Request,
        env: WorkerEnv,
        error: string | null = null,
): Promise<Response> {
        const caseId = Number(
                new URL(request.url)
                        .searchParams
                        .get("case"),
        );

        const coordinationCase =
                Number.isInteger(caseId)
                && caseId > 0
                        ? await getCase(
                                env.DB,
                                caseId,
                        )
                        : null;

        const options = coordinationCase
                ? await getOptions(
                        env.DB,
                        coordinationCase,
                )
                : [];

        const updated =
                new URL(request.url)
                        .searchParams
                        .get("updated");

        const message =
                updated === "proposed"
                        ? "Discussion times created."
                        : updated === "availability"
                                ? "Availability saved."
                                : updated === "matched"
                                        ? "Common time matched automatically."
                                        : null;

        return htmlResponse(
                page(
                        coordinationCase,
                        options,
                        message,
                        error,
                ),
                error ? 400 : 200,
        );
}


export async function availabilityManagementResponse(
        request: Request,
        env: WorkerEnv,
): Promise<Response> {
        if (!isAuthorised(request, env)) {
                return authenticationRequired();
        }

        if (request.method === "GET") {
                return renderPage(request, env);
        }

        if (request.method !== "POST") {
                return new Response(
                        "Method not allowed.",
                        {
                                status: 405,
                                headers: {
                                        Allow: "GET, POST",
                                },
                        },
                );
        }

        if (!sameOrigin(request)) {
                return new Response(
                        "Invalid request origin.",
                        { status: 403 },
                );
        }

        const form = await request.formData();

        const action = String(
                form.get("action") ?? "",
        );

        const caseId = Number(
                form.get("case_id"),
        );

        if (
                !Number.isInteger(caseId)
                || caseId <= 0
        ) {
                return renderPage(
                        request,
                        env,
                        "Invalid coordination case.",
                );
        }

        const coordinationCase =
                await getCase(env.DB, caseId);

        if (!coordinationCase) {
                return renderPage(
                        request,
                        env,
                        "Coordination case was not found.",
                );
        }

        if (action === "propose") {
                const localSlots = form
                        .getAll("slot")
                        .map(String)
                        .filter(Boolean);

                const utcSlots = localSlots
                        .map(
                                (slot) =>
                                        localDateTimeToUtc(
                                                slot,
                                                coordinationCase
                                                        .requester_timezone,
                                        ),
                        );

                if (
                        utcSlots.some(
                                (slot) => !slot,
                        )
                ) {
                        return renderPage(
                                request,
                                env,
                                "One or more proposed times are invalid.",
                        );
                }

                const result =
                        await proposeCaseTimes(
                                env.DB,
                                caseId,
                                utcSlots as string[],
                                "manager",
                        );

                if (!result.success) {
                        return renderPage(
                                request,
                                env,
                                result.error
                                        ?? "Times could not be created.",
                        );
                }

                return new Response(
                        null,
                        {
                                status: 303,
                                headers: {
                                        Location:
                                                `/dashboard/availability`
                                                + `?case=${caseId}`
                                                + "&updated=proposed",
                                },
                        },
                );
        }

        if (action === "record_availability") {
                const memberId = Number(
                        form.get("member_id"),
                );

                const optionIds = form
                        .getAll("option_id")
                        .map(Number);

                const result =
                        await recordMemberAvailability(
                                env.DB,
                                caseId,
                                memberId,
                                optionIds,
                        );

                if (!result.success) {
                        return renderPage(
                                request,
                                env,
                                result.error
                                        ?? "Availability could not be saved.",
                        );
                }

                return new Response(
                        null,
                        {
                                status: 303,
                                headers: {
                                        Location:
                                                `/dashboard/availability`
                                                + `?case=${caseId}`
                                                + `&updated=${
                                                        result.matched
                                                                ? "matched"
                                                                : "availability"
                                                }`,
                                },
                        },
                );
        }

        return renderPage(
                request,
                env,
                "Invalid availability action.",
        );
}