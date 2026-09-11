import { env } from "cloudflare:test";
import {
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";

import { createDashboardResponse } from "../src/dashboard";
import type { WorkerEnv } from "../src/env";


const dashboardEnv = {
	...env,
	DASHBOARD_USERNAME: "admin",
	DASHBOARD_PASSWORD: "test-password",
} as WorkerEnv;


function authorisedRequest(): Request {
	const credentials = btoa("admin:test-password");

	return new Request(
		"https://example.com/dashboard",
		{
			headers: {
				Authorization: `Basic ${credentials}`,
			},
		},
	);
}


describe("secure dashboard", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM sent_messages"),
			env.DB.prepare("DELETE FROM processed_updates"),
			env.DB.prepare("DELETE FROM incoming_messages"),
			env.DB.prepare("DELETE FROM team_members"),
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
		const response = await createDashboardResponse(
			new Request(
				"https://example.com/dashboard",
			),
			dashboardEnv,
		);

		expect(response.status).toBe(401);
		expect(
			response.headers.get("WWW-Authenticate"),
		).toContain("Basic");
	});

	it("shows today’s response metrics without phone numbers", async () => {
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
				"wamid.dashboard",
				"2026-09-11T06:45:00.000Z",
				"Supreeth",
				"919100000000",
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
				"Supreeth",
				"Deploy <script>alert(1)</script>",
				"Kiran",
				"None mentioned",
				"None mentioned",
				"6 PM",
				"Test reply",
				"processed",
			)
			.run();

		const response = await createDashboardResponse(
			authorisedRequest(),
			dashboardEnv,
			new Date("2026-09-11T09:00:00.000Z"),
		);

		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain("1 / 2");
		expect(html).toContain("50%");
		expect(html).toContain("Supreeth");
		expect(html).toContain("Kiran");
		expect(html).not.toContain("919100000000");
		expect(html).toContain(
			"&lt;script&gt;alert(1)&lt;/script&gt;",
		);
		expect(html).not.toContain(
			"<script>alert(1)</script>",
		);
	});
});