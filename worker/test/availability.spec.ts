import { env } from "cloudflare:test";
import {
        beforeEach,
        describe,
        expect,
        it,
} from "vitest";

import {
        proposeCaseTimes,
        recordMemberAvailability,
} from "../src/availability";


let requesterId: number;
let responsibleId: number;
let caseId: number;


const now = new Date(
        "2026-09-14T10:00:00.000Z",
);


async function createMember(
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
                        "Member was not created.",
                );
        }

        return result.id;
}


async function createApprovedCase(): Promise<number> {
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
                        "wamid.availability",
                        "2026-09-14T09:00:00.000Z",
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
                        15,
                )
                .first<{ id: number }>();

        if (!result) {
                throw new Error(
                        "Coordination case was not created.",
                );
        }

        return result.id;
}


async function optionIds(): Promise<number[]> {
        const result = await env.DB
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

        return result.results.map(
                (option) => option.id,
        );
}


describe("case availability matching", () => {
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

                requesterId = await createMember(
                        "Supreeth",
                        "919100000000",
                        "Asia/Kolkata",
                );

                responsibleId = await createMember(
                        "Imran",
                        "919200000000",
                        "Asia/Kolkata",
                );

                caseId = await createApprovedCase();
        });

        it("creates future time options for an approved case", async () => {
                const result = await proposeCaseTimes(
                        env.DB,
                        caseId,
                        [
                                "2026-09-14T12:00:00.000Z",
                                "2026-09-14T13:00:00.000Z",
                                "2026-09-14T14:00:00.000Z",
                        ],
                        "manager",
                        now,
                );

                expect(result).toEqual({
                        success: true,
                        created: 3,
                });

                const storedCase = await env.DB
                        .prepare(
                                `
                                SELECT status
                                FROM coordination_cases
                                WHERE id = ?
                                `,
                        )
                        .bind(caseId)
                        .first<{ status: string }>();

                expect(storedCase?.status).toBe(
                        "availability_requested",
                );
        });

        it("rejects invalid or past options", async () => {
                const result = await proposeCaseTimes(
                        env.DB,
                        caseId,
                        [
                                "2026-09-14T09:00:00.000Z",
                                "invalid",
                        ],
                        "manager",
                        now,
                );

                expect(result.success).toBe(false);
                expect(result.created).toBe(0);
        });

        it("waits when only one member responds", async () => {
                await proposeCaseTimes(
                        env.DB,
                        caseId,
                        [
                                "2026-09-14T12:00:00.000Z",
                                "2026-09-14T13:00:00.000Z",
                        ],
                        "manager",
                        now,
                );

                const options = await optionIds();

                const result =
                        await recordMemberAvailability(
                                env.DB,
                                caseId,
                                requesterId,
                                [options[0]],
                        );

                expect(result.success).toBe(true);
                expect(result.matched).toBe(false);
        });

        it("automatically selects the common time", async () => {
                await proposeCaseTimes(
                        env.DB,
                        caseId,
                        [
                                "2026-09-14T12:00:00.000Z",
                                "2026-09-14T13:00:00.000Z",
                                "2026-09-14T14:00:00.000Z",
                        ],
                        "manager",
                        now,
                );

                const options = await optionIds();

                await recordMemberAvailability(
                        env.DB,
                        caseId,
                        requesterId,
                        [
                                options[0],
                                options[1],
                        ],
                );

                const result =
                        await recordMemberAvailability(
                                env.DB,
                                caseId,
                                responsibleId,
                                [
                                        options[1],
                                        options[2],
                                ],
                        );

                expect(result.success).toBe(true);
                expect(result.matched).toBe(true);
                expect(result.matchedTime).toBe(
                        "2026-09-14T13:00:00.000Z",
                );

                const storedCase = await env.DB
                        .prepare(
                                `
                                SELECT status, proposed_time
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
                                "2026-09-14T13:00:00.000Z",
                });
        });

        it("does not match different selections", async () => {
                await proposeCaseTimes(
                        env.DB,
                        caseId,
                        [
                                "2026-09-14T12:00:00.000Z",
                                "2026-09-14T13:00:00.000Z",
                        ],
                        "manager",
                        now,
                );

                const options = await optionIds();

                await recordMemberAvailability(
                        env.DB,
                        caseId,
                        requesterId,
                        [options[0]],
                );

                const result =
                        await recordMemberAvailability(
                                env.DB,
                                caseId,
                                responsibleId,
                                [options[1]],
                        );

                expect(result.success).toBe(true);
                expect(result.matched).toBe(false);
        });
});