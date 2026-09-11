import {
	describe,
	expect,
	it,
	vi,
} from "vitest";

import type { WorkerEnv } from "../src/env";
import {
	sendInitialRequest,
	sendReminder,
	type TeamMember,
} from "../src/whatsapp";


const member: TeamMember = {
	id: 1,
	name: "Supreeth",
	phone: "+91 91000-00000",
	department: "Management",
};


const testEnv = {
	WHATSAPP_API_VERSION: "v26.0",
	WHATSAPP_TEMPLATE_LANGUAGE: "en_US",
	WHATSAPP_INITIAL_TEMPLATE_NAME:
		"daily_standup_request",
	WHATSAPP_REMINDER_TEMPLATE_NAME:
		"daily_standup_reminder",
	WHATSAPP_ACCESS_TOKEN: "private-test-token",
	WHATSAPP_PHONE_NUMBER_ID: "123456789",
} as WorkerEnv;


describe("WhatsApp template sending", () => {
	it("sends an initial template to a normalised phone", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				messages: [{ id: "wamid.sent-001" }],
			}),
		);

		const result = await sendInitialRequest(
			testEnv,
			member,
			fetcher,
		);

		expect(result).toEqual({
			success: true,
			messageId: "wamid.sent-001",
		});

		const [url, options] = fetcher.mock.calls[0];
		const payload = JSON.parse(
			String(options?.body),
		);

		expect(url).toContain(
			"/v26.0/123456789/messages",
		);
		expect(payload.to).toBe("919100000000");
		expect(payload.template.name).toBe(
			"daily_standup_request",
		);
		expect(
			payload.template.components[0]
				.parameters[0].text,
		).toBe("Supreeth");
	});

	it("sends the selected reminder timing", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				messages: [{ id: "wamid.reminder-001" }],
			}),
		);

		const result = await sendReminder(
			testEnv,
			member,
			2,
			fetcher,
		);

		expect(result.success).toBe(true);

		const payload = JSON.parse(
			String(fetcher.mock.calls[0][1]?.body),
		);

		expect(
			payload.template.components[0]
				.parameters[1].text,
		).toBe("6 PM");
	});

	it("returns a safe error from Meta", async () => {
		const fetcher = vi.fn(async () =>
			Response.json(
				{
					error: {
						message: "Template not approved",
					},
				},
				{ status: 400 },
			),
		);

		const result = await sendInitialRequest(
			testEnv,
			member,
			fetcher,
		);

		expect(result).toEqual({
			success: false,
			error: "Template not approved",
		});
	});
});