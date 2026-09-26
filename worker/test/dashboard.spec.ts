import { env } from "cloudflare:test";
import {
        beforeEach,
        describe,
        expect,
        it,
} from "vitest";

import {
        createDashboardResponse,
} from "../src/dashboard";
import type { WorkerEnv } from "../src/env";


const dashboardEnv = {
        ...env,
        DASHBOARD_USERNAME: "admin",
        DASHBOARD_PASSWORD: "test-password",
} as WorkerEnv;


function authorisedRequest(): Request {
        const credentials = btoa(
                "admin:test-password",
        );

        return new Request(
                "https://example.com/dashboard",
                {
                        headers: {
                                Authorization:
                                        `Basic ${credentials}`,
                        },
                },
        );
}


async function addIncomingUpdate(
        phone: string,
        name: string,
        messageId: string,
        receivedAt: string,
): Promise<void> {
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
                        messageId,
                        receivedAt,
                        name,
                        phone,
                        "Test reply",
                        "processed",
                )
                .first<{ id: number }>();

        await env.DB
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
                        `,
                )
                .bind(
                        incoming?.id,
                        name,
                        "Deploy <script>alert(1)</script>",
                        "Kiran",
                        "None mentioned",
                        "None mentioned",
                        "6 PM",
                        "Test reply",
                        "processed",
                )
                .run();
}


describe("secure timezone-aware dashboard", () => {
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
                                "DELETE FROM voice_update_events",
                        ),
                        env.DB.prepare(
                                "DELETE FROM voice_updates",
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
                                        "Kiran",
                                        "919200000000",
                                        "Development",
                                ),
                ]);
        });

        it("requires authentication", async () => {
                const response =
                        await createDashboardResponse(
                                new Request(
                                        "https://example.com/dashboard",
                                ),
                                dashboardEnv,
                        );

                expect(response.status).toBe(401);
        });

        it("shows navigation and metrics without phone numbers", async () => {
                await addIncomingUpdate(
                        "919100000000",
                        "Supreeth",
                        "wamid.dashboard",
                        "2026-09-11T06:45:00.000Z",
                );

                const response =
                        await createDashboardResponse(
                                authorisedRequest(),
                                dashboardEnv,
                                new Date(
                                        "2026-09-11T09:00:00.000Z",
                                ),
                        );

                const html =
                        await response.text();

                expect(response.status).toBe(200);
                expect(html).toContain("1 / 2");
                expect(html).toContain(
                        "Needs action",
                );
			expect(html).toContain(
			"Open coordination cases",
		);
                expect(html).toContain(
                        "Awaiting employee confirmation",
                );
                expect(html).toContain("Setup");
                expect(html).toContain("Manage project");
                expect(html).toContain(
                        "Asia/Kolkata",
                );
                expect(html).not.toContain(
                        "919100000000",
                );
                expect(html).toContain(
                        "&lt;script&gt;alert(1)&lt;/script&gt;",
                );
                expect(html).not.toContain(
                        "<script>alert(1)</script>",
                );
        });

        it("does not count an earlier UK local-day reply", async () => {
                await env.DB
                        .prepare(
                                `
                                UPDATE team_members
                                SET timezone = 'Europe/London'
                                WHERE name = 'Kiran'
                                `,
                        )
                        .run();

                await addIncomingUpdate(
                        "919200000000",
                        "Kiran",
                        "wamid.london.previous",
                        "2026-01-15T22:00:00.000Z",
                );

                const response =
                        await createDashboardResponse(
                                authorisedRequest(),
                                dashboardEnv,
                                new Date(
                                        "2026-01-16T01:00:00.000Z",
                                ),
                        );

                const html =
                        await response.text();

                expect(response.status).toBe(200);
                expect(html).toContain("0 / 2");
                expect(html).toContain("0%");
                expect(html).toContain(
                        "Europe/London",
                );
                expect(html).not.toContain(
                        "Deploy &lt;script&gt;",
                );
        });

        it("shows earlier updates in the seven-day history", async () => {
                await addIncomingUpdate(
                        "919100000000",
                        "Supreeth",
                        "wamid.history",
                        "2026-09-09T06:45:00.000Z",
                );

                const response = await createDashboardResponse(
                        new Request(
                                "https://example.com/dashboard?view=history&period=7",
                                { headers: authorisedRequest().headers },
                        ),
                        dashboardEnv,
                        new Date("2026-09-11T09:00:00.000Z"),
                );
                const html = await response.text();

                expect(response.status).toBe(200);
                expect(html).toContain("Update history");
                expect(html).toContain("Test reply");
                expect(html).toContain("Expected completion");
                expect(html).not.toContain("919100000000");
        });

        it("supports yesterday and member filters", async () => {
                await addIncomingUpdate(
                        "919100000000", "Supreeth", "wamid.yesterday",
                        "2026-09-10T06:45:00.000Z",
                );
                await addIncomingUpdate(
                        "919200000000", "Kiran", "wamid.today",
                        "2026-09-11T06:45:00.000Z",
                );

                const response = await createDashboardResponse(
                        new Request(
                                "https://example.com/dashboard?view=history&period=yesterday&member=Supreeth",
                                { headers: authorisedRequest().headers },
                        ),
                        dashboardEnv,
                        new Date("2026-09-11T09:00:00.000Z"),
                );
                const html = await response.text();

                expect(html).toContain("Yesterday");
                expect(html).toContain("Supreeth");
                expect(html.match(/<tr>/g)).toHaveLength(2);
        });

	it("labels response and expected completion clearly", async () => {
                const response = await createDashboardResponse(
                        authorisedRequest(), dashboardEnv,
                        new Date("2026-09-11T09:00:00.000Z"),
                );
                const html = await response.text();
                expect(html).toContain("Team updates today");
                expect(html).toContain("Expected completion");
		expect(html).toContain("History");
	});

	it("renders a company command center for a CEO without exposing phone numbers", async () => {
		const response = await createDashboardResponse(
			new Request("https://example.com/dashboard?view=overview", {
				headers: {
					...Object.fromEntries(authorisedRequest().headers),
					"X-Dutha-User-Id": "1",
					"X-Dutha-Tenant-Id": "1",
					"X-Dutha-Tenant-Role": "ceo",
				},
			}),
			dashboardEnv,
			new Date("2026-09-11T09:00:00.000Z"),
		);
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain("Company command center");
		expect(html).toContain("Open coordination cases");
		expect(html).not.toContain("919100000000");
	});

	it("renders a project delivery brief with only operational exceptions", async () => {
		const response = await createDashboardResponse(
			new Request("https://example.com/dashboard?view=brief", { headers: authorisedRequest().headers }),
			dashboardEnv,
			new Date("2026-09-11T09:00:00.000Z"),
		);
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain("What needs attention");
		expect(html).toContain("Missing updates");
		expect(html).toContain("Open coordination cases");
	});

	it("gives a Team Lead direct links to their scoped team actions", async () => {
		const lead = await env.DB.prepare("INSERT INTO management_users (tenant_id, external_subject, display_name, tenant_role, workops_role) VALUES (1, 'dashboard-lead@example.com', 'Dashboard Lead', 'project_manager', 'team_lead') RETURNING id").first<{ id:number }>();
		if (!lead) throw new Error("Team Lead was not created.");
		await env.DB.prepare("INSERT INTO team_lead_assignments (project_id, management_user_id, department) VALUES (1, ?, 'Management')").bind(lead.id).run();
		const request = authorisedRequest();
		request.headers.set("X-Dutha-User-Id", String(lead.id));
		request.headers.set("X-Dutha-Tenant-Id", "1");
		request.headers.set("X-Dutha-Tenant-Role", "team_lead");

		const response = await createDashboardResponse(request, dashboardEnv, new Date("2026-09-11T09:00:00.000Z"));
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain("Team command center");
		expect(html).toContain("Team brief");
		expect(html).toContain("Manage team");
		expect(html).not.toContain("Needs action");
	});
});
