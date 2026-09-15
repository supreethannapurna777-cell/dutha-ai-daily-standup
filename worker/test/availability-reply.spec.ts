import { env } from "cloudflare:test";
import {
        beforeEach,
        describe,
        expect,
        it,
        vi,
} from "vitest";

import {
        processAvailabilityReply,
} from "../src/availability-reply";
import {
        processWebhookPayload,
} from "../src/webhook";


interface TestCase {
        id: number;
        requesterId: number;
        responsibleId: number;
}


async function createAvailabilityCase(): Promise<TestCase> {
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
                        "Delivery",
                )
                .first<{ id: number }>();

        const sourceMessage = await env.DB
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
                        "wamid.source",
                        "2030-01-01T08:00:00.000Z",
                        "Supreeth",
                        "919100000000",
                        "Blocked by deployment",
                        "processed",
                )
                .first<{ id: number }>();

        if (!requester || !responsible || !sourceMessage) {
                throw new Error("Test records were not created.");
        }

        const sourceUpdate = await env.DB
                .prepare(
                        `
                        INSERT INTO processed_updates (
                                message_id,
                                sender_name,
                                original_reply,
                                processing_status
                        )
                        VALUES (?, ?, ?, ?)
                        RETURNING id
                        `,
                )
                .bind(
                        sourceMessage.id,
                        "Supreeth",
                        "Blocked by deployment",
                        "processed",
                )
                .first<{ id: number }>();

        if (!sourceUpdate) {
                throw new Error("Source update was not created.");
        }

        const coordinationCase = await env.DB
                .prepare(
                        `
                        INSERT INTO coordination_cases (
                                source_update_id,
                                requester_member_id,
                                responsible_member_id,
                                case_type,
                                issue_summary,
                                status
                        )
                        VALUES (?, ?, ?, ?, ?, ?)
                        RETURNING id
                        `,
                )
                .bind(
                        sourceUpdate.id,
                        requester.id,
                        responsible.id,
                        "blocker",
                        "Blocked by deployment",
                        "availability_requested",
                )
                .first<{ id: number }>();

        if (!coordinationCase) {
                throw new Error("Coordination case was not created.");
        }

        await env.DB.batch([
                env.DB
                        .prepare(
                                `
                                INSERT INTO case_time_options (
                                        case_id,
                                        starts_at,
                                        status
                                )
                                VALUES (?, ?, 'proposed')
                                `,
                        )
                        .bind(
                                coordinationCase.id,
                                "2030-01-15T08:30:00.000Z",
                        ),
                env.DB
                        .prepare(
                                `
                                INSERT INTO case_time_options (
                                        case_id,
                                        starts_at,
                                        status
                                )
                                VALUES (?, ?, 'proposed')
                                `,
                        )
                        .bind(
                                coordinationCase.id,
                                "2030-01-15T09:30:00.000Z",
                        ),
        ]);

        return {
                id: coordinationCase.id,
                requesterId: requester.id,
                responsibleId: responsible.id,
        };
}


function availabilityPayload(
        caseId: number,
) {
        return {
                entry: [
                        {
                                changes: [
                                        {
                                                value: {
                                                        contacts: [
                                                                {
                                                                        profile: {
                                                                                name:
                                                                                        "Supreeth",
                                                                        },
                                                                },
                                                        ],
                                                        messages: [
                                                                {
                                                                        id:
                                                                                "wamid.availability",
                                                                        from:
                                                                                "919100000000",
                                                                        timestamp:
                                                                                "1894700000",
                                                                        type:
                                                                                "text",
                                                                        text: {
                                                                                body:
                                                                                        `CASE ${caseId}: 1,2`,
                                                                        },
                                                                },
                                                        ],
                                                },
                                        },
                                ],
                        },
                ],
        };
}


describe("WhatsApp availability replies", () => {
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
        });

        it("matches a common time from numbered WhatsApp replies", async () => {
                const coordinationCase =
                        await createAvailabilityCase();

                const requesterResult =
                        await processAvailabilityReply(
                                env.DB,
                                "919100000000",
                                `CASE ${coordinationCase.id}: 1,2`,
                        );

                const responsibleResult =
                        await processAvailabilityReply(
                                env.DB,
                                "919200000000",
                                `CASE #${coordinationCase.id}: 2`,
                        );

                expect(requesterResult).toEqual({
                        handled: true,
                        success: true,
                        matched: false,
                        error: undefined,
                });
                expect(responsibleResult).toEqual({
                        handled: true,
                        success: true,
                        matched: true,
                        error: undefined,
                });

                const storedCase = await env.DB
                        .prepare(
                                `
                                SELECT status, proposed_time
                                FROM coordination_cases
                                WHERE id = ?
                                `,
                        )
                        .bind(coordinationCase.id)
                        .first<{
                                status: string;
                                proposed_time: string;
                        }>();

                expect(storedCase).toEqual({
                        status: "time_agreed",
                        proposed_time:
                                "2030-01-15T09:30:00.000Z",
                });
        });

        it("rejects an unavailable option number", async () => {
                const coordinationCase =
                        await createAvailabilityCase();

                const result =
                        await processAvailabilityReply(
                                env.DB,
                                "919100000000",
                                `CASE ${coordinationCase.id}: 3`,
                        );

                expect(result.handled).toBe(true);
                expect(result.success).toBe(false);
                expect(result.error).toContain(
                        "option numbers are invalid",
                );
        });

        it("leaves ordinary stand-up text for the normal parser", async () => {
                const result =
                        await processAvailabilityReply(
                                env.DB,
                                "919100000000",
                                "1. Deploy the Worker\n2. No blockers",
                        );

                expect(result.handled).toBe(false);
        });

        it("routes a webhook reply without creating a stand-up update", async () => {
                const coordinationCase =
                        await createAvailabilityCase();

                const replySender = vi.fn(async () => ({
                        success: true,
                }));

                const result = await processWebhookPayload(
                        availabilityPayload(
                                coordinationCase.id,
                        ),
                        env.DB,
                        new Date(),
                        replySender,
                );

                expect(result).toEqual({
                        received: 1,
                        duplicates: 0,
                        ignored: 0,
                });

                const incoming = await env.DB
                        .prepare(
                                `
                                SELECT processing_status
                                FROM incoming_messages
                                WHERE whatsapp_message_id = ?
                                `,
                        )
                        .bind("wamid.availability")
                        .first<{
                                processing_status: string;
                        }>();

                const processedCount = await env.DB
                        .prepare(
                                `
                                SELECT COUNT(*) AS count
                                FROM processed_updates
                                `,
                        )
                        .first<{ count: number }>();

                expect(incoming?.processing_status).toBe(
                        "availability_processed",
                );
                expect(processedCount?.count).toBe(1);
                expect(replySender).toHaveBeenCalledWith(
                        "919100000000",
                        expect.stringContaining(
                                "Availability saved",
                        ),
                );
        });

        it("sends a correction for an invalid WhatsApp selection", async () => {
                const coordinationCase =
                        await createAvailabilityCase();
                const replySender = vi.fn(async () => ({
                        success: true,
                }));
                const payload = availabilityPayload(
                        coordinationCase.id,
                );

                payload.entry[0].changes[0]
                        .value.messages[0].text.body =
                                `CASE ${coordinationCase.id}: 9`;

                await processWebhookPayload(
                        payload,
                        env.DB,
                        new Date(),
                        replySender,
                );

                expect(replySender).toHaveBeenCalledWith(
                        "919100000000",
                        expect.stringContaining(
                                "Availability was not saved",
                        ),
                );

                const incoming = await env.DB
                        .prepare(
                                `
                                SELECT processing_status
                                FROM incoming_messages
                                WHERE whatsapp_message_id = ?
                                `,
                        )
                        .bind("wamid.availability")
                        .first<{
                                processing_status: string;
                        }>();

                expect(incoming?.processing_status).toBe(
                        "availability_rejected",
                );
        });
});
