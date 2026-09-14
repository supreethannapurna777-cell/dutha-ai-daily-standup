import { env } from "cloudflare:test";
import {
        beforeEach,
        describe,
        expect,
        it,
} from "vitest";

import {
        availabilityManagementResponse,
} from "../src/availability-management";
import type { WorkerEnv } from "../src/env";


const managementEnv = {
        ...env,
        DASHBOARD_USERNAME: "admin",
        DASHBOARD_PASSWORD: "test-password",
} as WorkerEnv;


let requesterId: number;
let responsibleId: number;
let caseId: number;


function authorisation(): string {
        return `Basic ${btoa(
                "admin:test-password",
        )}`;
}


function managementRequest(
        method = "GET",
        body?: URLSearchParams,
        origin = "https://example.com",
): Request {
        return new Request(
                `https://example.com/dashboard/availability?case=${caseId}`,
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


async function addMember(
        name: string,
        phone: string,
        timezone: string,
): Promise<number> {
        const result = await env.DB
                .prepare(
                        `
                        INSERT INTO team_members (
                                name,
                                phone,
                                department,
                                timezone
                        )
                        VALUES (?, ?, ?, ?)
                        RETURNING id
                        `,
                )
                .bind(
                        name,
                        phone,
                        "Development",
                        timezone,
                )
                .first<{ id: number }>();

        if (!result) {
                throw new Error(
                        "Test member was not created.",
                );
        }

        return result.id;
}


async function createCase(): Promise<number> {
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
                        "wamid.availability.management",
                        "2030-01-15T08:00:00.000Z",
                        "Supreeth",
                        "919100000000",
                        "Test reply",
                        "processed",
                )
                .first<{ id: number }>();

        if (!incoming) {
                throw new Error(
                        "Incoming message was not created.",
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

        const result = await env.DB
                .prepare(
                        `
                        INSERT INTO coordination_cases (
                                source_update_id,
                                requester_member_id,
                                responsible_member_id,
                                case_type,
                                issue_summary,
                                status,
                                priority,
                                meeting_duration_minutes
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        RETURNING id
                        `,
                )
                .bind(
                        processed.id,
                        requesterId,
                        responsibleId,
                        "blocker",
                        "Blocked by configuration",
                        "approved",
                        "high",
                        20,
                )
                .first<{ id: number }>();

        if (!result) {
                throw new Error(
                        "Test case was not created.",
                );
        }

        return result.id;
}


async function proposeTimes(): Promise<Response> {
        const body = new URLSearchParams({
                action: "propose",
                case_id: String(caseId),
        });

        body.append(
                "slot",
                "2030-01-15T13:00",
        );

        body.append(
                "slot",
                "2030-01-15T14:00",
        );

        body.append(
                "slot",
                "2030-01-15T15:00",
        );

        return availabilityManagementResponse(
                managementRequest(
                        "POST",
                        body,
                ),
                managementEnv,
        );
}


describe("availability management page", () => {
        beforeEach(async () => {
                await env.DB.batch([
                        env.DB.prepare(
                                "DELETE FROM case_events",
                        ),
                        env.DB.prepare(
                                "DELETE FROM case_availability",
                        ),
                        env.DB.prepare(
                                "DELETE FROM case_time_options",
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

                requesterId = await addMember(
                        "Supreeth",
                        "919100000000",
                        "Asia/Kolkata",
                );

                responsibleId = await addMember(
                        "Imran",
                        "447700900000",
                        "Europe/London",
                );

                caseId = await createCase();
        });

        it("requires authentication", async () => {
                const response =
                        await availabilityManagementResponse(
                                new Request(
                                        `https://example.com/dashboard/availability?case=${caseId}`,
                                ),
                                managementEnv,
                        );

                expect(response.status).toBe(401);
        });

        it("shows both local timezones without phone numbers", async () => {
                const response =
                        await availabilityManagementResponse(
                                managementRequest(),
                                managementEnv,
                        );

                const html =
                        await response.text();

                expect(response.status).toBe(200);
                expect(html).toContain("Supreeth");
                expect(html).toContain("Imran");
                expect(html).toContain(
                        "Asia/Kolkata",
                );
                expect(html).not.toContain(
                        "919100000000",
                );
                expect(html).not.toContain(
                        "447700900000",
                );
        });

        it("creates proposed times in the requester timezone", async () => {
                const response =
                        await proposeTimes();

                expect(response.status).toBe(303);

                const options = await env.DB
                        .prepare(
                                `
                                SELECT starts_at
                                FROM case_time_options
                                WHERE case_id = ?
                                ORDER BY starts_at
                                `,
                        )
                        .bind(caseId)
                        .all<{
                                starts_at: string;
                        }>();

                expect(options.results).toEqual([
                        {
                                starts_at:
                                        "2030-01-15T07:30:00.000Z",
                        },
                        {
                                starts_at:
                                        "2030-01-15T08:30:00.000Z",
                        },
                        {
                                starts_at:
                                        "2030-01-15T09:30:00.000Z",
                        },
                ]);

                const storedCase = await env.DB
                        .prepare(
                                `
                                SELECT status
                                FROM coordination_cases
                                WHERE id = ?
                                `,
                        )
                        .bind(caseId)
                        .first<{
                                status: string;
                        }>();

                expect(storedCase?.status).toBe(
                        "availability_requested",
                );
        });

        it("matches the earliest option selected by both members", async () => {
                await proposeTimes();

                const options = await env.DB
                        .prepare(
                                `
                                SELECT id
                                FROM case_time_options
                                WHERE case_id = ?
                                ORDER BY starts_at
                                `,
                        )
                        .bind(caseId)
                        .all<{ id: number }>();

                const requesterBody =
                        new URLSearchParams({
                                action:
                                        "record_availability",
                                case_id:
                                        String(caseId),
                                member_id:
                                        String(requesterId),
                        });

                requesterBody.append(
                        "option_id",
                        String(
                                options.results[0].id,
                        ),
                );

                requesterBody.append(
                        "option_id",
                        String(
                                options.results[1].id,
                        ),
                );

                const requesterResponse =
                        await availabilityManagementResponse(
                                managementRequest(
                                        "POST",
                                        requesterBody,
                                ),
                                managementEnv,
                        );

                expect(
                        requesterResponse.status,
                ).toBe(303);

                const responsibleBody =
                        new URLSearchParams({
                                action:
                                        "record_availability",
                                case_id:
                                        String(caseId),
                                member_id:
                                        String(responsibleId),
                        });

                responsibleBody.append(
                        "option_id",
                        String(
                                options.results[1].id,
                        ),
                );

                responsibleBody.append(
                        "option_id",
                        String(
                                options.results[2].id,
                        ),
                );

                const responsibleResponse =
                        await availabilityManagementResponse(
                                managementRequest(
                                        "POST",
                                        responsibleBody,
                                ),
                                managementEnv,
                        );

                expect(
                        responsibleResponse.status,
                ).toBe(303);

                expect(
                        responsibleResponse.headers
                                .get("Location"),
                ).toContain("updated=matched");

                const storedCase = await env.DB
                        .prepare(
                                `
                                SELECT
                                        status,
                                        proposed_time
                                FROM coordination_cases
                                WHERE id = ?
                                `,
                        )
                        .bind(caseId)
                        .first<{
                                status: string;
                                proposed_time: string;
                        }>();

                expect(storedCase).toEqual({
                        status: "time_agreed",
                        proposed_time:
                                "2030-01-15T08:30:00.000Z",
                });
        });

        it("rejects cross-origin submissions", async () => {
                const body = new URLSearchParams({
                        action: "propose",
                        case_id: String(caseId),
                });

                const response =
                        await availabilityManagementResponse(
                                managementRequest(
                                        "POST",
                                        body,
                                        "https://attacker.example",
                                ),
                                managementEnv,
                        );

                expect(response.status).toBe(403);
        });
});