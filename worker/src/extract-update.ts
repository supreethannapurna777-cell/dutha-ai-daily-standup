export interface ExtractedUpdate {
	tasks: string;
	people_to_connect: string;
	blockers: string;
	dependencies: string;
	expected_completion: string;
	original_reply: string;
}


export function extractNumberedAnswers(
	text: string,
): Record<string, string> {
	const markerPattern = /^\s*([1-4])[.)\-:]\s*/gm;
	const markers = Array.from(text.matchAll(markerPattern));
	const answers: Record<string, string> = {};

	for (let index = 0; index < markers.length; index += 1) {
		const marker = markers[index];
		const number = marker[1];
		const answerStart =
			(marker.index ?? 0) + marker[0].length;
		const answerEnd =
			index + 1 < markers.length
				? markers[index + 1].index
				: text.length;

		const answer = text
			.slice(answerStart, answerEnd)
			.trim();

		if (answer) {
			answers[number] = answer;
		}
	}

	return answers;
}


export function extractUpdate(
	originalReply: string,
): ExtractedUpdate {
	const text = originalReply.trim();
	const lowerText = text.toLowerCase();
	const answers = extractNumberedAnswers(text);

	let tasks = "Not specified";
	let peopleToConnect = "Not specified";
	let blockers = "Not specified";
	let dependencies = "Not specified";
	let expectedCompletion = "Not specified";

	if (Object.keys(answers).length > 0) {
		tasks = answers["1"] ?? tasks;
		const blockerAnswer = answers["2"] ?? "";
		peopleToConnect = answers["3"] ?? peopleToConnect;
		expectedCompletion =
			answers["4"] ?? expectedCompletion;

		if (blockerAnswer) {
			const blockerLower = blockerAnswer.toLowerCase();

			if (
				blockerLower.includes("no blocker") ||
				blockerLower.includes("no dependency") ||
				["none", "no", "nil"].includes(blockerLower)
			) {
				blockers = "None mentioned";
				dependencies = "None mentioned";
			} else {
				blockers = blockerAnswer;
				dependencies = blockerAnswer;
			}
		}
	} else {
		const taskMatch = text.match(
			/(?:today\s+i\s+will|i\s+will\s+work\s+on)\s+(.+?)(?:\.|\n|$)/i,
		);

		if (taskMatch) {
			tasks = taskMatch[1].trim();
		}

		const peopleMatch = text.match(
			/(?:coordinate\s+with|connect\s+with|with)\s+([a-zA-Z][a-zA-Z ]+?)(?:\.|\n|$)/i,
		);

		if (peopleMatch) {
			peopleToConnect = peopleMatch[1].trim();
		}

		if (
			lowerText.includes("no blocker") ||
			lowerText.includes("no dependency")
		) {
			blockers = "None mentioned";
			dependencies = "None mentioned";
		}

		const completionMatch = text.match(
			/(?:expected\s+completion(?:\s+time)?|complete)\s*(?:is|by|:)?\s*(.+?)(?:\.|\n|$)/i,
		);

		if (completionMatch) {
			expectedCompletion = completionMatch[1].trim();
		}
	}

	return {
		tasks,
		people_to_connect: peopleToConnect,
		blockers,
		dependencies,
		expected_completion: expectedCompletion,
		original_reply: text,
	};
}