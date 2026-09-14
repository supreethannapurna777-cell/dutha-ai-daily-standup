import { env } from "cloudflare:test";
import {
        beforeEach,
        describe,
        expect,
        it,
} from "vitest";

import {
        createCoordinationCase,
} from "../src/coordination";


interface TestMember {
        id: number;
        name: string;
        phone: string;
}


let supreeth: TestMember;
let imran: TestMember;


async function addMember(
        name: string,
        phone: string,
): Promise<TestMember> {
        const inserted = await env.DB
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
                        name,
                        phone,
                        "Development",
                )
                .first<{ id: number }>();

        if (!inserted) {
                throw new Error(
                        "Test member was not created.",
                );
        }

        return {
                id: inserted.id,
                name,
                phone,
        };
}


async function addProcessedUpdate(
        sender: TestMember,
        blockers: string,
        dependencies: string,
        peopleToConnect: string,
): Promise<number> {
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
                        `wamid.${sender.id}.${Date.now()}`,
                        "2026-09-14T10:00:00.000Z",
                        sender.name,
                        sender.phone,
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
                        sender.name,
                        "Test task",
                        peopleToConnect,
                        blockers,
                        dependencies,
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

        return processed.id;
}


describe("coordination case creation", () => {
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

                supreeth = await addMember(
                        "Supreeth",
                        "919100000000",
                );

                imran = await addMember(
                        "Imran",
                        "919200000000",
                );
        });

        it("creates a blocker case and matches the responsible member", async () => {
                const updateId =
                        await addProcessedUpdate(
                                supreeth,
                                "Blocked by deployment configuration",
                                "Blocked by deployment configuration",
                                "Need to coordinate with Imran",
                        );

                const result =
                        await createCoordinationCase(
                                env.DB,
                                updateId,
                        );

                expect(result.created).toBe(true);
                expect(result.status).toBe(
                        "pending_approval",
                );

                const stored = await env.DB
                        .prepare(
                                `
                                SELECT
                                        requester_member_id,
                                        responsible_member_id,
                                        case_type,
                                        status,
                                        priority
                                FROM coordination_cases
                                WHERE id = ?
                                `,
                        )
                        .bind(result.caseId)
                        .first<{
                                requester_member_id: number;
                                responsible_member_id: number;
                                case_type: string;
                                status: string;
                                priority: string;
                        }>();

                expect(stored).toEqual({
                        requester_member_id:
                                supreeth.id,
                        responsible_member_id:
                                imran.id,
                        case_type: "blocker",
                        status: "pending_approval",
                        priority: "high",
                });
        });

        it("creates a coordination case when no blocker exists", async () => {
                const updateId =
                        await addProcessedUpdate(
                                supreeth,
                                "None mentioned",
                                "None mentioned",
                                "Coordinate with Imran",
                        );

                const result =
                        await createCoordinationCase(
                                env.DB,
                                updateId,
                        );

                expect(result.created).toBe(true);

                const stored = await env.DB
                        .prepare(
                                `
                                SELECT case_type
                                FROM coordination_cases
                                WHERE id = ?
                                `,
                        )
                        .bind(result.caseId)
                        .first<{
                                case_type: string;
                        }>();

                expect(stored?.case_type).toBe(
                        "coordination",
                );
        });

        it("requests manager assignment when no member matches", async () => {
                const updateId =
                        await addProcessedUpdate(
                                supreeth,
                                "Blocked by client approval",
                                "Blocked by client approval",
                                "Coordinate with client team",
                        );

                const result =
                        await createCoordinationCase(
                                env.DB,
                                updateId,
                        );

                expect(result.status).toBe(
                        "pending_assignment",
                );

                const stored = await env.DB
                        .prepare(
                                `
                                SELECT responsible_member_id
                                FROM coordination_cases
                                WHERE id = ?
                                `,
                        )
                        .bind(result.caseId)
                        .first<{
                                responsible_member_id:
                                        number | null;
                        }>();

                expect(
                        stored?.responsible_member_id,
                ).toBeNull();
        });

        it("does not create a case for a clear update", async () => {
                const updateId =
                        await addProcessedUpdate(
                                supreeth,
                                "None mentioned",
                                "None mentioned",
                                "Not specified",
                        );

                const result =
                        await createCoordinationCase(
                                env.DB,
                                updateId,
                        );

                expect(result.created).toBe(false);

                const count = await env.DB
                        .prepare(
                                `
                                SELECT COUNT(*) AS count
                                FROM coordination_cases
                                `,
                        )
                        .first<{ count: number }>();

                expect(count?.count).toBe(0);
        });

        it("does not duplicate a case for the same update", async () => {
                const updateId =
                        await addProcessedUpdate(
                                supreeth,
                                "Blocked by deployment",
                                "Blocked by deployment",
                                "Coordinate with Imran",
                        );

                const first =
                        await createCoordinationCase(
                                env.DB,
                                updateId,
                        );

                const second =
                        await createCoordinationCase(
                                env.DB,
                                updateId,
                        );

                expect(first.created).toBe(true);
                expect(second.created).toBe(false);

                const count = await env.DB
                        .prepare(
                                `
                                SELECT COUNT(*) AS count
                                FROM coordination_cases
                                `,
                        )
                        .first<{ count: number }>();

                expect(count?.count).toBe(1);
        });
});