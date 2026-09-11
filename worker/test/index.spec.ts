import {
	createExecutionContext,
	env,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker, { type WorkerEnv } from "../src/index";


const IncomingRequest =
	Request<unknown, IncomingRequestCfProperties>;

const testEnv: WorkerEnv = {
	...env,
	WHATSAPP_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
};


async function callWorker(url: string): Promise<Response> {
	const request = new IncomingRequest(url);
	const context = createExecutionContext();

	const response = await worker.fetch(
		request,
		testEnv,
		context,
	);

	await waitOnExecutionContext(context);
	return response;
}


describe("Dutha AI Daily Standup worker", () => {
	it("returns a healthy service response", async () => {
		const response = await SELF.fetch(
			"https://example.com/",
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			service: "Dutha AI Daily Standup",
			status: "running",
			environment: "cloudflare-worker",
		});
	});

	it("verifies a valid Meta webhook request", async () => {
		const response = await callWorker(
			"https://example.com/webhook" +
				"?hub.mode=subscribe" +
				"&hub.verify_token=test-verify-token" +
				"&hub.challenge=123456",
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("123456");
	});

	it("rejects an invalid Meta verify token", async () => {
		const response = await callWorker(
			"https://example.com/webhook" +
				"?hub.mode=subscribe" +
				"&hub.verify_token=wrong-token" +
				"&hub.challenge=123456",
		);

		expect(response.status).toBe(403);
		expect(await response.text()).toBe("Forbidden");
	});

	it("returns 404 for an unknown route", async () => {
		const response = await callWorker(
			"https://example.com/unknown",
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "Not found",
		});
	});
});