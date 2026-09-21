import {
	describe,
	expect,
	it,
	vi,
} from "vitest";

import type { WorkerEnv } from "../src/env";
import {
	sendAvailabilityRequest,
	sendInitialRequest,
	sendMeetingScheduled,
	sendReminder,
	sendTextMessage,
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
	WHATSAPP_AVAILABILITY_TEMPLATE_NAME:
		"coordination_availability_request",
	WHATSAPP_MEETING_TEMPLATE_NAME:
		"coordination_meeting_scheduled",
	WHATSAPP_ACCESS_TOKEN: "private-test-token",
	WHATSAPP_PHONE_NUMBER_ID: "123456789",
} as WorkerEnv;


describe("WhatsApp template sending", () => {
	it("sends a free-form confirmation message", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				messages: [{ id: "wamid.text-001" }],
			}),
		);

		const result = await sendTextMessage(
			testEnv,
			member.phone,
			"Availability saved.",
			fetcher,
		);

		expect(result).toEqual({
			success: true,
			messageId: "wamid.text-001",
		});

		const payload = JSON.parse(
			String(fetcher.mock.calls[0][1]?.body),
		);

		expect(payload.type).toBe("text");
		expect(payload.to).toBe("919100000000");
		expect(payload.text).toEqual({
			preview_url: false,
			body: "Availability saved.",
		});
	});

	it("sends numbered availability options", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				messages: [{ id: "wamid.availability-001" }],
			}),
		);

		const result = await sendAvailabilityRequest(
			testEnv,
			member,
			42,
			"1. 15 Jan 2030, 1:00 pm\n2. 15 Jan 2030, 2:00 pm",
			fetcher,
		);

		expect(result.success).toBe(true);

		const payload = JSON.parse(
			String(fetcher.mock.calls[0][1]?.body),
		);

		expect(payload.template.name).toBe(
			"coordination_availability_request",
		);
		expect(
			payload.template.components[0]
				.parameters.map(
					(parameter: { text: string }) =>
						parameter.text,
				),
		).toEqual([
			"Supreeth",
			"42",
			"1. 15 Jan 2030, 1:00 pm\n2. 15 Jan 2030, 2:00 pm",
			"42",
		]);
	});

	it("sends scheduled meeting details with an approved template", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				messages: [{ id: "wamid.meeting-001" }],
			}),
		);

		const result = await sendMeetingScheduled(
			testEnv,
			member,
			9,
			"21 Sept 2026, 9:00 pm (Asia/Kolkata)",
			15,
			"https://teams.microsoft.com/l/meetup-join/test",
			fetcher,
		);

		expect(result).toEqual({
			success: true,
			messageId: "wamid.meeting-001",
		});

		const payload = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
		expect(payload.type).toBe("template");
		expect(payload.template.name).toBe("coordination_meeting_scheduled");
		expect(payload.template.components[0].parameters.map(
			(parameter: { text: string }) => parameter.text,
		)).toEqual([
			"Supreeth",
			"9",
			"21 Sept 2026, 9:00 pm (Asia/Kolkata)",
			"15",
			"https://teams.microsoft.com/l/meetup-join/test",
		]);
	});

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
