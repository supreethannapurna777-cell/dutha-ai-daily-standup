import { env } from "cloudflare:test";
import {
        beforeEach,
        describe,
        expect,
        it,
        vi,
} from "vitest";

import {
        caseManagementResponse,
} from "../src/case-management";
import type { WorkerEnv } from "../src/env";


const caseEnv = {
        ...env,
        DASHBOARD_USERNAME: "admin",
        DASHBOARD_PASSWORD: "test-password",
        WHATSAPP_API_VERSION: "v26.0",
        WHATSAPP_ACCESS_TOKEN: "test-token",
        WHATSAPP_PHONE_NUMBER_ID: "123456789",
} as WorkerEnv;


let requesterId: number;
let responsibleId: number;
let processedUpdateId: number;
let caseId: number;


function authorisation(): string {
        return `Basic ${btoa(
                "admin:test-password",
        )}`;
}


function request(
        method = "GET",
        body?: URLSearchParams,
        origin = "https://example.com",
): Request {
        return new Request(
                "https://example.com/dashboard/cases",
                {
                        method,
                        headers: {
                                Authorization:
                                        authorisation(),
                                Origin: origin,
                                ...(
                                        body
                                                ? {
                                                        "Content-Type":
                                                                "application/x-www-form-urlencoded",
                                                }
                                                : {}
                                ),
                        },
                        body,
                },
        );
}


describe("manager coordination case controls", () => {
        beforeEach(async () => {
                await env.DB.batch([
                        env.DB.prepare(
                                "DELETE FROM jira_case_links",
                        ),
                        env.DB.prepare(
                                "DELETE FROM case_events",
                        ),
                        env.DB.prepare(
                                "DELETE FROM case_availability",
                        ),
                        env.DB.prepare(
                                "DELETE FROM coordination_cases",
                        ),
                        env.DB.prepare(
                                "DELETE FROM sent_messages",
                        ),
                        env.DB.prepare(
                                "DELETE FROM processed_updates",
                        ),
                        env.DB.prepare(
                                "DELETE FROM incoming_messages",
                        ),
                        env.DB.prepare(
                                "DELETE FROM team_members",
                        ),
                ]);

                const requester = await env.DB
                        .prepare(
                                `
                                INSERT INTO team_members (
                                        name,
                                        phone,
                                        department
                                )
                                VALUES (?, ?, ?)
                                RETURNING id
                                `,
                        )
                        .bind(
                                "Supreeth",
                                "919100000000",
                                "Management",
                        )
                        .first<{ id: number }>();

                const responsible = await env.DB
                        .prepare(
                                `
                                INSERT INTO team_members (
                                        name,
                                        phone,
                                        department
                                )
                                VALUES (?, ?, ?)
                                RETURNING id
                                `,
                        )
                        .bind(
                                "Imran",
                                "919200000000",
                                "Forward Deployment",
                        )
                        .first<{ id: number }>();

                if (!requester || !responsible) {
                        throw new Error(
                                "Test members were not created.",
                        );
                }

                requesterId = requester.id;
                responsibleId = responsible.id;

                const incoming = await env.DB
                        .prepare(
                                `
                                INSERT INTO incoming_messages (
                                        whatsapp_message_id,
                                        received_at,
                                        sender_name,
                                        sender_phone,
                                        original_reply,
                                        processing_status
                                )
                                VALUES (?, ?, ?, ?, ?, ?)
                                RETURNING id
                                `,
                        )
                        .bind(
                                "wamid.case.management",
                                "2026-09-14T10:00:00.000Z",
                                "Supreeth",
                                "919100000000",
                                "Test reply",
                                "processed",
                        )
                        .first<{ id: number }>();

                if (!incoming) {
                        throw new Error(
                                "Incoming update was not created.",
                        );
                }

                const processed = await env.DB
                        .prepare(
                                `
                                INSERT INTO processed_updates (
                                        message_id,
                                        sender_name,
                                        tasks,
                                        people_to_connect,
                                        blockers,
                                        dependencies,
                                        expected_completion,
                                        original_reply,
                                        processing_status
                                )
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                RETURNING id
                                `,
                        )
                        .bind(
                                incoming.id,
                                "Supreeth",
                                "Deploy application",
                                "Imran",
                                "Blocked by configuration",
                                "Blocked by configuration",
                                "Today",
                                "Test reply",
                                "processed",
                        )
                        .first<{ id: number }>();

                if (!processed) {
                        throw new Error(
                                "Processed update was not created.",
                        );
                }

                processedUpdateId = processed.id;

                const coordinationCase = await env.DB
                        .prepare(
                                `
                                INSERT INTO coordination_cases (
                                        source_update_id,
                                        requester_member_id,
                                        responsible_member_id,
                                        case_type,
                                        issue_summary,
                                        status,
                                        priority
                                )
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                                RETURNING id
                                `,
                        )
                        .bind(
                                processedUpdateId,
                                requesterId,
                                responsibleId,
                                "blocker",
                                "Blocked by configuration",
                                "pending_approval",
                                "high",
                        )
                        .first<{ id: number }>();

                if (!coordinationCase) {
                        throw new Error(
                                "Coordination case was not created.",
                        );
                }

                caseId = coordinationCase.id;
        });

        it("requires authentication", async () => {
                const response =
                        await caseManagementResponse(
                                new Request(
                                        "https://example.com/dashboard/cases",
                                ),
                                caseEnv,
                        );

                expect(response.status).toBe(401);
        });

        it("shows cases without phone numbers", async () => {
                const response =
                        await caseManagementResponse(
                                request(),
                                caseEnv,
                        );

                const html = await response.text();

                expect(response.status).toBe(200);
                expect(html).toContain(
                        "Blocked by configuration",
                );
                expect(html).toContain("Supreeth");
                expect(html).toContain("Imran");
                expect(html).not.toContain(
                        "919100000000",
                );
                expect(html).not.toContain(
                        "919200000000",
                );
                expect(html).toContain(
                        "Pending approval",
                );
                expect(html).not.toContain(
                        "Manage availability",
                );
        });

        it("allows the manager to approve and assign a case", async () => {
                const body = new URLSearchParams({
                        case_id: String(caseId),
                        action: "approve",
                        responsible_member_id:
                                String(responsibleId),
                        meeting_duration_minutes:
                                "20",
                        manager_notes:
                                "Discuss deployment configuration.",
                });

                const response =
                        await caseManagementResponse(
                                request("POST", body),
                                caseEnv,
                        );

                expect(response.status).toBe(303);

                const stored = await env.DB
                        .prepare(
                                `
                                SELECT
                                        status,
                                        responsible_member_id,
                                        meeting_duration_minutes,
                                        manager_notes
                                FROM coordination_cases
                                WHERE id = ?
                                `,
                        )
                        .bind(caseId)
                        .first<{
                                status: string;
                                responsible_member_id: number;
                                meeting_duration_minutes: number;
                                manager_notes: string;
                        }>();

                expect(stored).toEqual({
                        status: "approved",
                        responsible_member_id:
                                responsibleId,
                        meeting_duration_minutes: 20,
                        manager_notes:
                                "Discuss deployment configuration.",
                });

                const pageResponse =
                        await caseManagementResponse(
                                request(),
                                caseEnv,
                        );

                const pageHtml =
                        await pageResponse.text();

                expect(pageHtml).toContain(
                        `/dashboard/availability?case=${caseId}`,
                );
                expect(pageHtml).toContain(
                        "Manage availability",
                );
        });

        it("creates a Jira issue when an approved case has Jira configured", async () => {
                const body = new URLSearchParams({
                        case_id: String(caseId),
                        action: "approve",
                        responsible_member_id: String(responsibleId),
                        meeting_duration_minutes: "20",
                        manager_notes: "Create the external work item.",
                });
                const fetcher = vi.fn().mockResolvedValue(Response.json({
                        id: "10050",
                        key: "DUTHA-50",
                }, { status: 201 }));
                const response = await caseManagementResponse(
                        request("POST", body),
                        {
                                ...caseEnv,
                                JIRA_BASE_URL: "https://example.atlassian.net",
                                JIRA_EMAIL: "integration@example.com",
                                JIRA_API_TOKEN: "test-token",
                                JIRA_PROJECT_KEY: "DUTHA",
                        },
                        fetcher,
                );
                expect(response.status).toBe(303);
                expect(fetcher).toHaveBeenCalledOnce();
                expect(await env.DB.prepare(`
                        SELECT sync_status, external_issue_key
                        FROM jira_case_links WHERE case_id = ?
                `).bind(caseId).first()).toEqual({
                        sync_status: "synced",
                        external_issue_key: "DUTHA-50",
                });
        });

        it("allows the manager to reject a case", async () => {
                const body = new URLSearchParams({
                        case_id: String(caseId),
                        action: "reject",
                        manager_notes:
                                "No meeting required.",
                });

                const response =
                        await caseManagementResponse(
                                request("POST", body),
                                caseEnv,
                        );

                expect(response.status).toBe(303);

                const stored = await env.DB
                        .prepare(
                                `
                                SELECT status
                                FROM coordination_cases
                                WHERE id = ?
                                `,
                        )
                        .bind(caseId)
                        .first<{ status: string }>();

                expect(stored?.status).toBe(
                        "rejected",
                );
        });

        it("saves a meeting link and notifies both participants once", async () => {
                await env.DB
                        .prepare(
                                `
                                UPDATE coordination_cases
                                SET
                                        status = 'time_agreed',
                                        proposed_time = ?
                                WHERE id = ?
                                `,
                        )
                        .bind(
                                "2030-01-15T08:30:00.000Z",
                                caseId,
                        )
                        .run();

                const pageResponse =
                        await caseManagementResponse(
                                request(),
                                caseEnv,
                        );

                const pageHtml =
                        await pageResponse.text();

                expect(pageHtml).toContain(
                        "Save link and notify participants",
                );

                const fetcher = vi.fn(async () =>
                        Response.json({
                                messages: [{ id: "wamid.meeting" }],
                        }),
                );

                const meetingLink =
                        "https://teams.microsoft.com/l/meetup-join/test";
                const body = new URLSearchParams({
                        case_id: String(caseId),
                        action: "schedule",
                        meeting_link: meetingLink,
                });

                const firstResponse =
                        await caseManagementResponse(
                                request("POST", body),
                                caseEnv,
                                fetcher,
                        );

                expect(firstResponse.status).toBe(303);
                expect(fetcher).toHaveBeenCalledTimes(2);

                const stored = await env.DB
                        .prepare(
                                `
                                SELECT status, meeting_link
                                FROM coordination_cases
                                WHERE id = ?
                                `,
                        )
                        .bind(caseId)
                        .first<{
                                status: string;
                                meeting_link: string;
                        }>();

                expect(stored).toEqual({
                        status: "scheduled",
                        meeting_link: meetingLink,
                });

                const sentEvents = await env.DB
                        .prepare(
                                `
                                SELECT COUNT(*) AS count
                                FROM case_events
                                WHERE case_id = ?
                                        AND event_type =
                                                'meeting_link_notification_sent'
                                `,
                        )
                        .bind(caseId)
                        .first<{ count: number }>();

                expect(sentEvents?.count).toBe(2);

                const secondResponse =
                        await caseManagementResponse(
                                request("POST", body),
                                caseEnv,
                                fetcher,
                        );

                expect(secondResponse.status).toBe(303);
                expect(fetcher).toHaveBeenCalledTimes(2);
        });

        it("rejects an unsafe meeting link", async () => {
                await env.DB
                        .prepare(
                                `
                                UPDATE coordination_cases
                                SET
                                        status = 'time_agreed',
                                        proposed_time = ?
                                WHERE id = ?
                                `,
                        )
                        .bind(
                                "2030-01-15T08:30:00.000Z",
                                caseId,
                        )
                        .run();

                const fetcher = vi.fn();
                const response =
                        await caseManagementResponse(
                                request(
                                        "POST",
                                        new URLSearchParams({
                                                case_id: String(caseId),
                                                action: "schedule",
                                                meeting_link:
                                                        "javascript:alert(1)",
                                        }),
                                ),
                                caseEnv,
                                fetcher,
                        );

                expect(response.status).toBe(400);
                expect(await response.text()).toContain(
                        "Enter a valid HTTPS meeting link.",
                );
                expect(fetcher).not.toHaveBeenCalled();
        });

        it("retries only the participant whose notification failed", async () => {
                await env.DB
                        .prepare(
                                `
                                UPDATE coordination_cases
                                SET
                                        status = 'time_agreed',
                                        proposed_time = ?
                                WHERE id = ?
                                `,
                        )
                        .bind(
                                "2030-01-15T08:30:00.000Z",
                                caseId,
                        )
                        .run();

                const fetcher = vi.fn()
                        .mockResolvedValueOnce(
                                Response.json({
                                        messages: [{ id: "wamid.first" }],
                                }),
                        )
                        .mockResolvedValueOnce(
                                Response.json(
                                        {
                                                error: {
                                                        message:
                                                                "Temporary failure",
                                                },
                                        },
                                        { status: 500 },
                                ),
                        )
                        .mockResolvedValueOnce(
                                Response.json({
                                        messages: [{ id: "wamid.retry" }],
                                }),
                        );

                const body = () =>
                        new URLSearchParams({
                                case_id: String(caseId),
                                action: "schedule",
                                meeting_link:
                                        "https://meet.google.com/abc-defg-hij",
                        });

                const failedResponse =
                        await caseManagementResponse(
                                request("POST", body()),
                                caseEnv,
                                fetcher,
                        );

                expect(failedResponse.status).toBe(400);
                expect(fetcher).toHaveBeenCalledTimes(2);

                const retryResponse =
                        await caseManagementResponse(
                                request("POST", body()),
                                caseEnv,
                                fetcher,
                        );

                expect(retryResponse.status).toBe(303);
                expect(fetcher).toHaveBeenCalledTimes(3);

                const stored = await env.DB
                        .prepare(
                                `
                                SELECT status
                                FROM coordination_cases
                                WHERE id = ?
                                `,
                        )
                        .bind(caseId)
                        .first<{ status: string }>();

                expect(stored?.status).toBe("scheduled");
        });

        it("accepts same-origin browser actions without an Origin header", async () => {
                const body = new URLSearchParams({
                        case_id: String(caseId),
                        action: "reject",
                        manager_notes:
                                "No meeting required.",
                });

                const response =
                        await caseManagementResponse(
                                new Request(
                                        "https://example.com/dashboard/cases",
                                        {
                                                method: "POST",
                                                headers: {
                                                        Authorization:
                                                                authorisation(),
                                                        "Content-Type":
                                                                "application/x-www-form-urlencoded",
                                                        "Sec-Fetch-Site":
                                                                "same-origin",
                                                },
                                                body,
                                        },
                                ),
                                caseEnv,
                        );

                expect(response.status).toBe(303);

                const stored = await env.DB
                        .prepare(
                                `
                                SELECT status
                                FROM coordination_cases
                                WHERE id = ?
                                `,
                        )
                        .bind(caseId)
                        .first<{ status: string }>();

                expect(stored?.status).toBe(
                        "rejected",
                );
        });

        it("rejects cross-origin manager actions", async () => {
                const body = new URLSearchParams({
                        case_id: String(caseId),
                        action: "reject",
                });

                const response =
                        await caseManagementResponse(
                                request(
                                        "POST",
                                        body,
                                        "https://attacker.example",
                                ),
                                caseEnv,
                        );

                expect(response.status).toBe(403);
        });

        it("requires evidence and verification before closing a blocker", async () => {
                await env.DB.prepare(`
                        UPDATE coordination_cases
                        SET status = 'approved', resolution_state = 'triaged',
                                responsible_member_id = ?
                        WHERE id = ?
                `).bind(responsibleId, caseId).run();

                const proposed = await caseManagementResponse(
                        request("POST", new URLSearchParams({
                                case_id: String(caseId),
                                action: "resolve",
                                manager_notes: "Credentials were issued and tested.",
                        })),
                        caseEnv,
                );
                expect(proposed.status).toBe(303);
                const awaiting = await env.DB.prepare(`
                        SELECT status, resolution_state, resolution_summary
                        FROM coordination_cases WHERE id = ?
                `).bind(caseId).first<{
                        status: string;
                        resolution_state: string;
                        resolution_summary: string;
                }>();
                expect(awaiting).toEqual({
                        status: "in_progress",
                        resolution_state: "awaiting_verification",
                        resolution_summary: "Credentials were issued and tested.",
                });

                const verified = await caseManagementResponse(
                        request("POST", new URLSearchParams({
                                case_id: String(caseId),
                                action: "verify_resolution",
                                manager_notes: "Requester confirmed database access.",
                        })),
                        caseEnv,
                );
                expect(verified.status).toBe(303);
                const closed = await env.DB.prepare(`
                        SELECT status, resolution_state, verified_by_type
                        FROM coordination_cases WHERE id = ?
                `).bind(caseId).first<{
                        status: string;
                        resolution_state: string;
                        verified_by_type: string;
                }>();
                expect(closed).toEqual({
                        status: "resolved",
                        resolution_state: "resolved",
                        verified_by_type: "manager",
                });
                const evidence = await env.DB.prepare(`
                        SELECT COUNT(*) AS count FROM blocker_resolution_evidence
                        WHERE case_id = ?
                `).bind(caseId).first<{ count: number }>();
                expect(evidence?.count).toBe(2);
        });

        it("escalates an unresolved blocker to critical", async () => {
                const response = await caseManagementResponse(
                        request("POST", new URLSearchParams({
                                case_id: String(caseId),
                                action: "escalate",
                                manager_notes: "SLA risk requires delivery-head action.",
                        })),
                        caseEnv,
                );
                expect(response.status).toBe(303);
                const stored = await env.DB.prepare(`
                        SELECT resolution_state, priority FROM coordination_cases WHERE id = ?
                `).bind(caseId).first<{ resolution_state: string; priority: string }>();
                expect(stored).toEqual({ resolution_state: "escalated", priority: "critical" });
        });
});
