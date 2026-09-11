import type { WorkerEnv } from "./env";


export interface TeamMember {
	id: number;
	name: string;
	phone: string;
	department: string;
}


export interface SendResult {
	success: boolean;
	messageId?: string;
	error?: string;
}


export type Fetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;


export function normalisePhone(phone: string): string {
	return phone.replace(/\D/g, "");
}


export async function sendTemplateMessage(
	env: WorkerEnv,
	recipient: string,
	templateName: string,
	parameters: string[],
	fetcher: Fetcher = fetch,
): Promise<SendResult> {
	const phone = normalisePhone(recipient);

	if (
		!env.WHATSAPP_ACCESS_TOKEN ||
		!env.WHATSAPP_PHONE_NUMBER_ID ||
		!phone ||
		!templateName
	) {
		return {
			success: false,
			error: "Missing WhatsApp configuration",
		};
	}

	const payload = {
		messaging_product: "whatsapp",
		recipient_type: "individual",
		to: phone,
		type: "template",
		template: {
			name: templateName,
			language: {
				code: env.WHATSAPP_TEMPLATE_LANGUAGE,
			},
			components: [
				{
					type: "body",
					parameters: parameters.map((text) => ({
						type: "text",
						text,
					})),
				},
			],
		},
	};

	const response = await fetcher(
		`https://graph.facebook.com/${env.WHATSAPP_API_VERSION}` +
			`/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
		{
			method: "POST",
			headers: {
				Authorization:
					`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		},
	);

		let responseBody: Record<string, unknown> = {};

	try {
		responseBody =
			await response.json() as Record<string, unknown>;
	} catch {
		responseBody = {};
	}

	if (!response.ok) {
		const errorObject =
			typeof responseBody.error === "object" &&
			responseBody.error !== null
				? responseBody.error as Record<string, unknown>
				: {};

		return {
			success: false,
			error:
				typeof errorObject.message === "string"
					? errorObject.message
					: `WhatsApp API HTTP ${response.status}`,
		};
	}

	const messages = Array.isArray(responseBody.messages)
		? responseBody.messages
		: [];
	const firstMessage = messages[0];

	const messageId =
		typeof firstMessage === "object" &&
		firstMessage !== null &&
		typeof (
			firstMessage as Record<string, unknown>
		).id === "string"
			? (
					firstMessage as Record<string, string>
				).id
			: undefined;

	return {
		success: true,
		messageId,
	};
}


export function sendInitialRequest(
	env: WorkerEnv,
	member: TeamMember,
	fetcher: Fetcher = fetch,
): Promise<SendResult> {
	return sendTemplateMessage(
		env,
		member.phone,
		env.WHATSAPP_INITIAL_TEMPLATE_NAME,
		[member.name],
		fetcher,
	);
}


export function sendReminder(
	env: WorkerEnv,
	member: TeamMember,
	reminderNumber: 1 | 2,
	fetcher: Fetcher = fetch,
): Promise<SendResult> {
	const timing =
		reminderNumber === 1
			? "3 PM"
			: "6 PM";

	return sendTemplateMessage(
		env,
		member.phone,
		env.WHATSAPP_REMINDER_TEMPLATE_NAME,
		[member.name, timing],
		fetcher,
	);
}