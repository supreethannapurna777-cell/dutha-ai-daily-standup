import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	dataDeletionResponse,
	privacyPolicyResponse,
	termsOfServiceResponse,
} from "../src/legal";


describe("Public legal pages", () => {
	it("provides a complete privacy policy", async () => {
		const response = privacyPolicyResponse();
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type"))
			.toContain("text/html");
		expect(html).toContain("Privacy Policy");
		expect(html).toContain("Information we process");
		expect(html).toContain("WhatsApp phone number");
		expect(html).toContain(
			"supreethannapurna807@gmail.com",
		);
	});

	it("provides user data deletion instructions", async () => {
		const response = dataDeletionResponse();
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain("User Data Deletion Instructions");
		expect(html).toContain(
			"Dutha Standup Data Deletion Request",
		);
		expect(html).toContain("within 30 days");
		expect(html).toContain("Do not send");
	});

	it("provides terms of service", async () => {
		const response = termsOfServiceResponse();
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain("Terms of Service");
		expect(html).toContain("Authorised use");
		expect(html).toContain("Prohibited use");
		expect(html).toContain("Privacy Policy");
	});

	it("adds security headers to legal pages", () => {
		const responses = [
			privacyPolicyResponse(),
			dataDeletionResponse(),
			termsOfServiceResponse(),
		];

		for (const response of responses) {
			expect(
				response.headers.get("X-Content-Type-Options"),
			).toBe("nosniff");

			expect(response.headers.get("X-Frame-Options"))
				.toBe("DENY");

			expect(
				response.headers.get("Content-Security-Policy"),
			).toContain("frame-ancestors 'none'");
		}
	});

	it("serves every legal page through its public route", async () => {
		const paths = [
			"/privacy",
			"/data-deletion",
			"/terms",
		];

		for (const path of paths) {
			const response = await SELF.fetch(
				`https://example.com${path}`,
			);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type"))
				.toContain("text/html");
		}
	});
});