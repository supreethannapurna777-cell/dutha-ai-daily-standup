import { processWebhookPayload } from "./webhook";


export interface WorkerEnv {
	DB: D1Database;
	WHATSAPP_API_VERSION: string;
	WHATSAPP_WEBHOOK_VERIFY_TOKEN: string;
}


function jsonResponse(
	body: unknown,
	status = 200,
): Response {
	return Response.json(body, { status });
}


function verifyWebhook(
	request: Request,
	env: WorkerEnv,
): Response {
	const url = new URL(request.url);
	const mode = url.searchParams.get("hub.mode");
	const token = url.searchParams.get("hub.verify_token");
	const challenge = url.searchParams.get("hub.challenge");

	const isValid =
		mode === "subscribe" &&
		Boolean(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) &&
		token === env.WHATSAPP_WEBHOOK_VERIFY_TOKEN &&
		Boolean(challenge);

	if (!isValid) {
		return new Response("Forbidden", { status: 403 });
	}

	return new Response(challenge, {
		status: 200,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}


async function receiveWebhook(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	let payload: unknown;

	try {
		payload = await request.json();
	} catch {
		return jsonResponse(
			{ error: "Invalid JSON payload" },
			400,
		);
	}

	const result = await processWebhookPayload(
		payload,
		env.DB,
	);

	return jsonResponse({
		status: "EVENT_RECEIVED",
		...result,
	});
}


export default {
	async fetch(
		request: Request,
		env: WorkerEnv,
		_context: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return jsonResponse({
				service: "Dutha AI Daily Standup",
				status: "running",
				environment: "cloudflare-worker",
			});
		}

		if (
			request.method === "GET" &&
			url.pathname === "/webhook"
		) {
			return verifyWebhook(request, env);
		}

		if (
			request.method === "POST" &&
			url.pathname === "/webhook"
		) {
			return receiveWebhook(request, env);
		}

		return jsonResponse(
			{ error: "Not found" },
			404,
		);
	},
} satisfies ExportedHandler<WorkerEnv>;