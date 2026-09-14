import { env } from "cloudflare:test";
import {
        beforeEach,
        describe,
        expect,
        it,
} from "vitest";

import {
        processWebhookPayload,
} from "../src/webhook";


describe("WhatsApp coordination integration", () => {
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

                await env.DB.batch([
                        env.DB
                                .prepare(
                                        `
                                        INSERT INTO team_members (
                                                name,
                                                phone,
                                                department
                                        )
                                        VALUES (?, ?, ?)
                                        `,
                                )
                                .bind(
                                        "Supreeth",
                                        "919100000000",
                                        "Management",
                                ),
                        env.DB
                                .prepare(
                                        `
                                        INSERT INTO team_members (
                                                name,
                                                phone,
                                                department
                                        )
                                        VALUES (?, ?, ?)
                                        `,
                                )
                                .bind(
                                        "Imran",
                                        "919200000000",
                                        "Forward Deployment",
                                ),
                ]);
        });

        it("creates a coordination case from a WhatsApp blocker reply", async () => {
                const payload = {
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
                                                                                        "wamid.coordination.test",
                                                                                from:
                                                                                        "919100000000",
                                                                                timestamp:
                                                                                        "1789374600",
                                                                                type:
                                                                                        "text",
                                                                                text: {
                                                                                        body:
                                                                                                "1. Validate deployment\n"
                                                                                                + "2. Blocked by deployment configuration\n"
                                                                                                + "3. Need to coordinate with Imran\n"
                                                                                                + "4. Today",
                                                                                },
                                                                        },
                                                                ],
                                                        },
                                                },
                                        ],
                                },
                        ],
                };

                const result =
                        await processWebhookPayload(
                                payload,
                                env.DB,
                                new Date(
                                        "2026-09-14T10:00:00.000Z",
                                ),
                        );

                expect(result).toEqual({
                        received: 1,
                        duplicates: 0,
                        ignored: 0,
                });

                const coordinationCase =
                        await env.DB
                                .prepare(
                                        `
                                        SELECT
                                                requester.name
                                                        AS requester_name,
                                                responsible.name
                                                        AS responsible_name,
                                                coordination.case_type,
                                                coordination.issue_summary,
                                                coordination.status,
                                                coordination.priority
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
                                        LIMIT 1
                                        `,
                                )
                                .first<{
                                        requester_name: string;
                                        responsible_name:
                                                string | null;
                                        case_type: string;
                                        issue_summary: string;
                                        status: string;
                                        priority: string;
                                }>();

                expect(coordinationCase).toEqual({
                        requester_name: "Supreeth",
                        responsible_name: "Imran",
                        case_type: "blocker",
                        issue_summary:
                                "Blocked by deployment configuration",
                        status: "pending_approval",
                        priority: "high",
                });

                const eventCount = await env.DB
                        .prepare(
                                `
                                SELECT COUNT(*) AS count
                                FROM case_events
                                WHERE event_type
                                        = 'case_created'
                                `,
                        )
                        .first<{ count: number }>();

                expect(eventCount?.count).toBe(1);
        });
});