import { describe, expect, it } from "vitest";

import {
	extractNumberedAnswers,
	extractUpdate,
} from "../src/extract-update";


describe("extractUpdate", () => {
	it("extracts all four numbered answers", () => {
		const reply = [
			"1. Configure the WhatsApp webhook",
			"2. No blockers or dependencies",
			"3. Kiran",
			"4. 9 PM",
		].join("\n");

		expect(extractUpdate(reply)).toEqual({
			tasks: "Configure the WhatsApp webhook",
			people_to_connect: "Kiran",
			blockers: "None mentioned",
			dependencies: "None mentioned",
			expected_completion: "9 PM",
			original_reply: reply,
		});
	});

	it("preserves a real blocker and dependency", () => {
		const reply = [
			"1) Deploy the application",
			"2) Waiting for database access",
			"3) Bhavani",
			"4) Tomorrow morning",
		].join("\n");

		const result = extractUpdate(reply);

		expect(result.blockers).toBe(
			"Waiting for database access",
		);
		expect(result.dependencies).toBe(
			"Waiting for database access",
		);
	});

	it("supports multiline numbered answers", () => {
		const reply = [
			"1. Configure the webhook",
			"and test the dashboard",
			"2. None",
			"3. Kiran",
			"4. Today",
		].join("\n");

		const answers = extractNumberedAnswers(reply);

		expect(answers["1"]).toBe(
			"Configure the webhook\nand test the dashboard",
		);
	});

	it("preserves unstructured replies safely", () => {
		const reply = "Working on documentation.";
		const result = extractUpdate(reply);

		expect(result.tasks).toBe("Not specified");
		expect(result.original_reply).toBe(reply);
	});
});