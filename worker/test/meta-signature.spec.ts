import { describe, expect, it } from "vitest";

import { verifyMetaSignature } from "../src/meta-signature";


async function createSignature(
	body: string,
	secret: string,
): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{
			name: "HMAC",
			hash: "SHA-256",
		},
		false,
		["sign"],
	);

	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(body),
	);

	const hex = Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");

	return `sha256=${hex}`;
}


describe("Meta webhook signature verification", () => {
	it("accepts a correctly signed body", async () => {
		const body = JSON.stringify({ object: "whatsapp_business_account" });
		const secret = "test-app-secret";
		const signature = await createSignature(body, secret);

		expect(
			await verifyMetaSignature(body, signature, secret),
		).toBe(true);
	});

	it("rejects a body changed after signing", async () => {
		const secret = "test-app-secret";
		const signature = await createSignature(
			JSON.stringify({ message: "original" }),
			secret,
		);

		expect(
			await verifyMetaSignature(
				JSON.stringify({ message: "changed" }),
				signature,
				secret,
			),
		).toBe(false);
	});

	it("rejects a missing or malformed signature", async () => {
		expect(
			await verifyMetaSignature("{}", null, "test-app-secret"),
		).toBe(false);

		expect(
			await verifyMetaSignature(
				"{}",
				"sha256=invalid",
				"test-app-secret",
			),
		).toBe(false);
	});
});