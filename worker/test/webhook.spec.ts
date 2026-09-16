import { env } from "cloudflare:test";
import {
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { processWebhookPayload } from "../src/webhook";


function textWebhookPayload(
	messageId = "wamid.test-001",
) {
	return {
		object: "whatsapp_business_account",
		entry: [
			{
				changes: [
					{
						field: "messages",
						value: {
							contacts: [
								{
									profile: {
										name: "Test User",
									},
								},
							],
							messages: [
								{
									from: "919100000000",
									id: messageId,
									timestamp: "1700000000",
									type: "text",
									text: {
										body: [
											"1. Deploy the Worker",
											"2. No blockers",
											"3. Kiran",
											"4. 6 PM",
										].join("\n"),
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


function audioWebhookPayload(
	messageId = "wamid.voice-webhook-001",
) {
	const payload = textWebhookPayload(messageId);
	const message = payload.entry[0].changes[0].value.messages[0] as
		Record<string, unknown>;
	message.type = "audio";
	delete message.text;
	message.audio = {
		id: "media-webhook-001",
		mime_type: "audio/ogg; codecs=opus",
	};
	return payload;
}


describe("WhatsApp webhook processing", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare(
				"DELETE FROM processed_updates",
			),
			env.DB.prepare(
				"DELETE FROM incoming_messages",
			),
		]);
	});

	it("stores and processes a text reply", async () => {
		const result = await processWebhookPayload(
			textWebhookPayload(),
			env.DB,
		);

		expect(result).toEqual({
			received: 1,
			duplicates: 0,
			ignored: 0,
		});

		const incoming = await env.DB
			.prepare(
				`
				SELECT
					whatsapp_message_id,
					sender_name,
					sender_phone,
					processing_status
				FROM incoming_messages
				`,
			)
			.first<{
				whatsapp_message_id: string;
				sender_name: string;
				sender_phone: string;
				processing_status: string;
			}>();

		expect(incoming).toEqual({
			whatsapp_message_id: "wamid.test-001",
			sender_name: "Test User",
			sender_phone: "919100000000",
			processing_status: "processed",
		});

		const processed = await env.DB
			.prepare(
				`
				SELECT
					tasks,
					people_to_connect,
					blockers,
					dependencies,
					expected_completion
				FROM processed_updates
				`,
			)
			.first<{
				tasks: string;
				people_to_connect: string;
				blockers: string;
				dependencies: string;
				expected_completion: string;
			}>();

		expect(processed).toEqual({
			tasks: "Deploy the Worker",
			people_to_connect: "Kiran",
			blockers: "None mentioned",
			dependencies: "None mentioned",
			expected_completion: "6 PM",
		});
	});

	it("does not process the same WhatsApp message twice", async () => {
		const payload = textWebhookPayload(
			"wamid.duplicate-test",
		);

		const first = await processWebhookPayload(
			payload,
			env.DB,
		);
		const second = await processWebhookPayload(
			payload,
			env.DB,
		);

		expect(first.received).toBe(1);
		expect(second).toEqual({
			received: 0,
			duplicates: 1,
			ignored: 0,
		});

		const incomingCount = await env.DB
			.prepare(
				"SELECT COUNT(*) AS count FROM incoming_messages",
			)
			.first<{ count: number }>();

		const processedCount = await env.DB
			.prepare(
				"SELECT COUNT(*) AS count FROM processed_updates",
			)
			.first<{ count: number }>();

		expect(incomingCount?.count).toBe(1);
		expect(processedCount?.count).toBe(1);
	});

	it("ignores non-text WhatsApp messages", async () => {
		const payload = textWebhookPayload();
		const message =
			payload.entry[0].changes[0].value.messages[0];

		message.type = "image";

		const result = await processWebhookPayload(
			payload,
			env.DB,
		);

		expect(result).toEqual({
			received: 0,
			duplicates: 0,
			ignored: 1,
		});
	});

	it("routes an audio message to the voice receiver", async () => {
		const receiver = vi.fn().mockResolvedValue(true);
		const result = await processWebhookPayload(
			audioWebhookPayload(),
			env.DB,
			new Date(),
			undefined,
			receiver,
		);

		expect(result).toEqual({
			received: 1,
			duplicates: 0,
			ignored: 0,
		});
		expect(receiver).toHaveBeenCalledWith({
			whatsappMessageId: "wamid.voice-webhook-001",
			senderName: "Test User",
			senderPhone: "919100000000",
			receivedAt: "2023-11-14T22:13:20.000Z",
			mediaId: "media-webhook-001",
			mimeType: "audio/ogg; codecs=opus",
		});
	});

	it("safely ignores a malformed payload", async () => {
		const result = await processWebhookPayload(
			{ unexpected: true },
			env.DB,
		);

		expect(result).toEqual({
			received: 0,
			duplicates: 0,
			ignored: 0,
		});
	});
});
