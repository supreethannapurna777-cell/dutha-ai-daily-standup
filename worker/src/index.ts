import { createDashboardResponse } from "./dashboard";
import type { WorkerEnv } from "./env";
import {
	dataDeletionResponse,
	privacyPolicyResponse,
	termsOfServiceResponse,
} from "./legal";
import { verifyMetaSignature } from "./meta-signature";
import { runScheduledAction } from "./scheduler";
import { processWebhookPayload } from "./webhook";

export type { WorkerEnv } from "./env";


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
	if (!env.WHATSAPP_APP_SECRET) {
		return jsonResponse(
			{ error: "Webhook security is not configured" },
			503,
		);
	}

	const rawBody = await request.text();

	const signatureIsValid = await verifyMetaSignature(
		rawBody,
		request.headers.get("X-Hub-Signature-256"),
		env.WHATSAPP_APP_SECRET,
	);

	if (!signatureIsValid) {
		return jsonResponse(
			{ error: "Invalid webhook signature" },
			401,
		);
	}

	let payload: unknown;

	try {
		payload = JSON.parse(rawBody);
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

	console.log(JSON.stringify({
		event: "whatsapp_webhook_processed",
		received: result.received,
		duplicates: result.duplicates,
		ignored: result.ignored,
	}));

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

		if (
			request.method === "GET" &&
			url.pathname === "/"
		) {
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

		if (
			request.method === "GET" &&
			url.pathname === "/privacy"
		) {
			return privacyPolicyResponse();
		}

		if (
			request.method === "GET" &&
			url.pathname === "/data-deletion"
		) {
			return dataDeletionResponse();
		}

		if (
			request.method === "GET" &&
			url.pathname === "/terms"
		) {
			return termsOfServiceResponse();
		}

		if (
			request.method === "GET" &&
			url.pathname === "/dashboard"
		) {
			return createDashboardResponse(request, env);
		}

		return jsonResponse(
			{ error: "Not found" },
			404,
		);
	},

	async scheduled(
		controller: ScheduledController,
		env: WorkerEnv,
		context: ExecutionContext,
	): Promise<void> {
		context.waitUntil(
			runScheduledAction(
				controller.cron,
				controller.scheduledTime,
				env,
			).then(() => undefined),
		);
	},
} satisfies ExportedHandler<WorkerEnv>;