import { env } from "cloudflare:test";
import {
        beforeEach,
        describe,
        expect,
        it,
} from "vitest";

import type { WorkerEnv } from "../src/env";
import {
        memberManagementResponse,
} from "../src/member-management";


const managementEnv = {
        ...env,
        DASHBOARD_USERNAME: "admin",
        DASHBOARD_PASSWORD: "test-password",
} as WorkerEnv;


let existingMemberId: number;


function authorisationHeader(): string {
        return `Basic ${btoa(
                "admin:test-password",
        )}`;
}


function authorisedRequest(
        method = "GET",
        body?: URLSearchParams,
): Request {
        return new Request(
                "https://example.com/dashboard/members",
                {
                        method,
                        headers: {
                                Authorization:
                                        authorisationHeader(),
                                Origin:
                                        "https://example.com",
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


describe("member schedule management", () => {
        beforeEach(async () => {
                await env.DB.batch([
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
                                "Supreeth",
                                "919100000000",
                                "Management",
                        )
                        .first<{ id: number }>();

                if (!inserted) {
                        throw new Error(
                                "Test member was not created.",
                        );
                }

                existingMemberId = inserted.id;
        });

        it("requires dashboard authentication", async () => {
                const response =
                        await memberManagementResponse(
                                new Request(
                                        "https://example.com/dashboard/members",
                                ),
                                managementEnv,
                        );

                expect(response.status).toBe(401);
                expect(
                        response.headers.get(
                                "WWW-Authenticate",
                        ),
                ).toContain("Basic");
        });

        it("never displays stored phone numbers", async () => {
                const response =
                        await memberManagementResponse(
                                authorisedRequest(),
                                managementEnv,
                        );

                const html = await response.text();

                expect(response.status).toBe(200);
                expect(html).toContain("Supreeth");
                expect(html).toContain(
                        "Asia/Kolkata",
                );
                expect(html).not.toContain(
                        "919100000000",
                );
        });

        it("updates timezone and schedule safely", async () => {
                const body = new URLSearchParams({
                        action: "update",
                        member_id:
                                String(existingMemberId),
                        timezone: "Europe/London",
                        initial_time: "09:00",
                        reminder_1_time: "12:00",
                        reminder_2_time: "15:00",
                        active: "1",
                        scheduling_enabled: "1",
                });

                for (
                        const day of [
                                "MON",
                                "TUE",
                                "WED",
                                "THU",
                                "FRI",
                        ]
                ) {
                        body.append(
                                "working_days",
                                day,
                        );
                }

                const response =
                        await memberManagementResponse(
                                authorisedRequest(
                                        "POST",
                                        body,
                                ),
                                managementEnv,
                        );

                expect(response.status).toBe(303);
                expect(
                        response.headers.get("Location"),
                ).toBe(
                        "/dashboard/members?updated=member",
                );

                const member = await env.DB
                        .prepare(
                                `
                                SELECT
                                        timezone,
                                        working_days,
                                        initial_time,
                                        reminder_1_time,
                                        reminder_2_time,
                                        active,
                                        scheduling_enabled
                                FROM team_members
                                WHERE id = ?
                                `,
                        )
                        .bind(existingMemberId)
                        .first<{
                                timezone: string;
                                working_days: string;
                                initial_time: string;
                                reminder_1_time: string;
                                reminder_2_time: string;
                                active: number;
							scheduling_enabled: number;
                        }>();

                expect(member).toEqual({
                        timezone: "Europe/London",
                        working_days:
                                "MON,TUE,WED,THU,FRI",
                        initial_time: "09:00",
                        reminder_1_time: "12:00",
                        reminder_2_time: "15:00",
                        active: 1,
						scheduling_enabled: 1,
                });
        });

        it("rejects an invalid schedule order", async () => {
                const body = new URLSearchParams({
                        action: "update",
                        member_id:
                                String(existingMemberId),
                        timezone: "Asia/Kolkata",
                        initial_time: "15:00",
                        reminder_1_time: "12:00",
                        reminder_2_time: "18:00",
                        active: "1",
                        scheduling_enabled: "1",
                        working_days: "MON",
                });

                const response =
                        await memberManagementResponse(
                                authorisedRequest(
                                        "POST",
                                        body,
                                ),
                                managementEnv,
                        );

                expect(response.status).toBe(400);

                const html = await response.text();

                expect(html).toContain(
                        "chronological order",
                );
        });

        it("adds a member without returning their phone", async () => {
                const body = new URLSearchParams({
                        action: "add",
                        name: "Sreeja",
                        department:
                                "AI & ML Engineer",
                        phone: "919876543210",
                        timezone: "Asia/Kolkata",
                });

                const response =
                        await memberManagementResponse(
                                authorisedRequest(
                                        "POST",
                                        body,
                                ),
                                managementEnv,
                        );

                expect(response.status).toBe(303);
                expect(
                        response.headers.get("Location"),
                ).toBe(
                        "/dashboard/members?updated=added",
                );

                const stored = await env.DB
                        .prepare(
                                `
                                SELECT
                                        name,
                                        department,
                                        timezone,
                                        initial_time,
                                        scheduling_enabled,
										enrolment_status
                                FROM team_members
                                WHERE phone = ?
                                `,
                        )
                        .bind("919876543210")
                        .first<{
                                name: string;
                                department: string;
                                timezone: string;
                                initial_time: string;
							scheduling_enabled: number;
							enrolment_status: string;
                        }>();

                expect(stored).toEqual({
                        name: "Sreeja",
                        department:
                                "AI & ML Engineer",
                        timezone: "Asia/Kolkata",
                        initial_time: "12:00",
						scheduling_enabled: 0,
						enrolment_status: "invited",
                });

				expect(await env.DB.prepare(`
						SELECT COUNT(*) AS count FROM channel_identities
						WHERE team_member_id = (SELECT id FROM team_members WHERE phone = ?)
				`).bind("919876543210").first()).toEqual({ count: 0 });

                const pageResponse =
                        await memberManagementResponse(
                                authorisedRequest(),
                                managementEnv,
                        );

                const html =
                        await pageResponse.text();

                expect(html).toContain("Sreeja");
                expect(html).not.toContain(
                        "919876543210",
                );
        });

        it("creates a single-use employee activation link for an emailed member", async () => {
                const body = new URLSearchParams({
                        action: "add",
                        name: "Activation User",
                        department: "DevOps",
                        email: "activation@example.com",
                        timezone: "Asia/Kolkata",
                });
                const response = await memberManagementResponse(
                        authorisedRequest("POST", body),
                        managementEnv,
                );
                expect(response.status).toBe(303);
                expect(response.headers.get("Location")).toContain("activation=");
                const account = await env.DB.prepare(`
                        SELECT account.email, token.expires_at
                        FROM employee_accounts AS account
                        INNER JOIN employee_activation_tokens AS token
                                ON token.team_member_id = account.team_member_id
                        WHERE account.email = ? AND token.used_at IS NULL
                `).bind("activation@example.com").first();
                expect(account).not.toBeNull();
        });

        it("accepts same-origin changes without an Origin header", async () => {
                const response =
                        await memberManagementResponse(
                                new Request(
                                        "https://example.com/dashboard/members",
                                        {
                                                method:
                                                        "POST",
                                                headers: {
                                                        Authorization:
                                                                authorisationHeader(),
                                                        "Content-Type":
                                                                "application/x-www-form-urlencoded",
                                                        "Sec-Fetch-Site":
                                                                "same-origin",
                                                },
                                                body:
                                                        new URLSearchParams({
                                                                action:
                                                                        "invalid",
                                                        }),
                                        },
                                ),
                                managementEnv,
                        );

                expect(response.status).not.toBe(403);
                expect(
                        await response.text(),
                ).not.toContain(
                        "Invalid request origin.",
                );
        });

        it("rejects cross-origin changes", async () => {
                const response =
                        await memberManagementResponse(
                                new Request(
                                        "https://example.com/dashboard/members",
                                        {
                                                method:
                                                        "POST",
                                                headers: {
                                                        Authorization:
                                                                authorisationHeader(),
                                                        Origin:
                                                                "https://attacker.example",
                                                        "Content-Type":
                                                                "application/x-www-form-urlencoded",
                                                },
                                                body:
                                                        new URLSearchParams({
                                                                action:
                                                                        "add",
                                                        }),
                                        },
                                ),
                                managementEnv,
                        );

                expect(response.status).toBe(403);
        });
});
