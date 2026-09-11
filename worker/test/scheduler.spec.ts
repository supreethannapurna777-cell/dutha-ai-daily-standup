import { env } from "cloudflare:test";
import {
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import type { WorkerEnv } from "../src/env";
import {
	actionForCron,
	getIstDate,
	runScheduledAction,
} from "../src/scheduler";


const scheduledTime = Date.parse(
	"2026-09-11T06:30:00.000Z",
);


function schedulerEnv(
	enabled: "true" | "false",
): WorkerEnv {
	return {
		...env,
		WHATSAPP_API_VERSION: "v26.0",
		WHATSAPP_TEMPLATE_LANGUAGE: "en_US",
		WHATSAPP_INITIAL_TEMPLATE_NAME:
			"daily_standup_request",
		WHATSAPP_REMINDER_TEMPLATE_NAME:
			"daily_standup_reminder",
		WHATSAPP_ACCESS_TOKEN: "test-token",
		WHATSAPP_PHONE_NUMBER_ID: "123456789",
		WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token",
		AUTOMATION_ENABLED: enabled,
	};
}


async function insertMember(
	name: string,
	phone: string,
): Promise<void> {
	await env.DB
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
		.bind(name, phone, "Development")
		.run();
}


describe("Cloudflare scheduled automation", () => {
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
	});

	it("maps the three IST schedules correctly", () => {
		expect(actionForCron("30 6 * * 1-5"))
			.toBe("initial");
		expect(actionForCron("30 9 * * 1-5"))
			.toBe("reminder-1");
		expect(actionForCron("30 12 * * 1-5"))
			.toBe("reminder-2");
		expect(actionForCron("0 0 * * *")).toBeNull();
		expect(getIstDate(scheduledTime))
			.toBe("2026-09-11");
	});

	it("sends nothing while automation is disabled", async () => {
		await insertMember("Supreeth", "919100000000");
		const fetcher = vi.fn();

		const result = await runScheduledAction(
			"30 6 * * 1-5",
			scheduledTime,
			schedulerEnv("false"),
			fetcher,
		);

		expect(result.status).toBe("disabled");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("sends the initial request to every active member", async () => {
		await insertMember("Supreeth", "919100000000");
		await insertMember("Kiran", "919200000000");

		const fetcher = vi.fn(async () =>
			Response.json({
				messages: [{ id: "wamid.sent" }],
			}),
		);

		const result = await runScheduledAction(
			"30 6 * * 1-5",
			scheduledTime,
			schedulerEnv("true"),
			fetcher,
		);

		expect(result).toEqual({
			status: "completed",
			action: "initial",
			selected: 2,
			sent: 2,
			failed: 0,
		});
		expect(fetcher).toHaveBeenCalledTimes(2);

		const auditCount = await env.DB
			.prepare(
				`
				SELECT COUNT(*) AS count
				FROM sent_messages
				WHERE status = 'sent'
				`,
			)
			.first<{ count: number }>();

		expect(auditCount?.count).toBe(2);
	});

	it("reminds only members who have not replied", async () => {
		await insertMember("Supreeth", "919100000000");
		await insertMember("Kiran", "919200000000");

		await env.DB
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
				`,
			)
			.bind(
				"wamid.reply",
				"2026-09-11T07:00:00.000Z",
				"Supreeth",
				"919100000000",
				"Test reply",
				"processed",
			)
			.run();

		const fetcher = vi.fn(async () =>
			Response.json({
				messages: [{ id: "wamid.reminder" }],
			}),
		);

		const result = await runScheduledAction(
			"30 9 * * 1-5",
			Date.parse("2026-09-11T09:30:00.000Z"),
			schedulerEnv("true"),
			fetcher,
		);

		expect(result.selected).toBe(1);
		expect(result.sent).toBe(1);
		expect(fetcher).toHaveBeenCalledTimes(1);

		const requestBody = JSON.parse(
			String(fetcher.mock.calls[0][1]?.body),
		);

		expect(requestBody.to).toBe("919200000000");
	});
});