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

	it("extracts a natural-language blocker, owner, task and duration", () => {
		const reply = "Yesterday I completed the Prometheus target verification and corrected two monitoring alerts. Today I will connect the Git repository to ArgoCD and begin the deployment configuration. I am blocked because Kiran has not yet shared the repository URL and required access. Once I receive them, I need approximately two hours to complete the connection.";

		expect(extractUpdate(reply)).toEqual({
			tasks: "connect the Git repository to ArgoCD and begin the deployment configuration",
			people_to_connect: "Kiran",
			blockers: "I am blocked because Kiran has not yet shared the repository URL and required access.",
			dependencies: "I am blocked because Kiran has not yet shared the repository URL and required access.",
			expected_completion: "approximately two hours",
			original_reply: reply,
		});
	});

	it("does not treat completed as an expected-completion marker", () => {
		const result = extractUpdate(
			"Yesterday I completed monitoring. Today I will test alerts.",
		);

		expect(result.expected_completion).toBe("Not specified");
	});

	it("does not create an active blocker from resolved language", () => {
		const result = extractUpdate(
			"I was initially blocked, but the blocker is resolved now. No additional blocker currently.",
		);

		expect(result.blockers).toBe("None mentioned");
		expect(result.dependencies).toBe("None mentioned");
	});

	it("does not promote a hypothetical risk to an active blocker", () => {
		const result = extractUpdate(
			"If the old API fails, I will be blocked.",
		);

		expect(result.blockers).toBe("Not specified");
	});
});
