import { env } from "cloudflare:test";
import {
        beforeEach,
        describe,
        expect,
        it,
} from "vitest";

import {
        caseManagementResponse,
} from "../src/case-management";
import type { WorkerEnv } from "../src/env";


const caseEnv = {
        ...env,
        DASHBOARD_USERNAME: "admin",
        DASHBOARD_PASSWORD: "test-password",
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
});