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
		const sentences = text
			.split(/(?<=[.!?])\s+|\n+/)
			.map((sentence) => sentence.trim())
			.filter(Boolean);

		const taskParts: string[] = [];
		for (const sentence of sentences) {
			const taskMatch = sentence.match(
				/^(?:task\s*:\s*|my\s+task\s+(?:for\s+)?today\s+is\s+|today\s+i\s+(?:will|am|plan\s+to|need\s+to)\s+|i\s+(?:will\s+work\s+on|am\s+working\s+on|am\s+verifying|am\s+testing)\s+|working\s+on\s+)(.+?)[.!?]?$/i,
			);
			if (!taskMatch) continue;
			const task = taskMatch[1].trim();
			if (task && !/^(?:blocked|waiting|unable)\b/i.test(task)) {
				taskParts.push(task);
			}
		}

		if (taskParts.length > 0) {
			tasks = taskParts.join("; ");
		}

		const explicitPeopleMatch = text.match(
			/(?:coordinate\s+with|connect\s+with)\s+([a-zA-Z][a-zA-Z ]+?)(?:\.|,|\n|$)/i,
		);

		const blockerSentences = sentences.filter((sentence) => {
			const value = sentence.toLowerCase();
			const isResolved =
				value.includes("blocker is resolved")
				|| value.includes("blocker was resolved")
				|| value.includes("no longer blocked")
				|| value.includes("resolved now");
			const isHypothetical =
				/\b(?:might|may|could)\s+be\s+blocked\b/i.test(sentence)
				|| /\bif\b.+\b(?:will|would)\s+be\s+blocked\b/i.test(sentence);
			const hasPositiveBlocker =
				/\b(?:i\s+am|i'm|we\s+are|we're)\s+blocked\s+(?:because|by|on)\b/i.test(sentence)
				|| /\b(?:cannot|can't|unable\s+to)\s+(?:continue|proceed|complete|test|deploy)\b/i.test(sentence)
				|| /\bwaiting\s+for\b/i.test(sentence)
				|| /\bblocker\s*(?:is|:)\s*/i.test(sentence);

			return hasPositiveBlocker && !isResolved && !isHypothetical;
		});

		if (blockerSentences.length > 0) {
			blockers = blockerSentences.join(" ");
			dependencies = blockers;
		} else if (
			/\bno\s+(?:(?:current|active|additional|other)\s+)?blockers?\b/i.test(text)
			|| lowerText.includes("no dependency")
			|| lowerText.includes("blocker is resolved")
			|| lowerText.includes("no longer blocked")
			|| lowerText.includes("resolved now")
		) {
			blockers = "None mentioned";
			dependencies = "None mentioned";
		}

		const blockerText = blockerSentences.join(" ");
		const inferredPeopleMatch = blockerText.match(
			/\b(?:because|by|from|waiting\s+for)\s+([A-Z][a-z]+)(?=\s+(?:has|hasn't|did|needs|must|is|was|will|to)\b)/,
		);
		const peopleMatch = explicitPeopleMatch ?? inferredPeopleMatch;

		if (peopleMatch) {
			peopleToConnect = peopleMatch[1].trim();
		}

		const durationMatch = text.match(
			/\b(?:need|require)\s+((?:approximately|about|around)?\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:minutes?|hours?|days?))\b/i,
		);
		const explicitCompletionMatch = text.match(
			/\bexpected\s+completion(?:\s+time)?\s*(?:is|:)?\s*(.+?)(?:\.|\n|$)/i,
		);
		const deadlineMatch = text.match(
			/\b(?:expect(?:ed)?\s+to\s+)?(?:complete|finish)\b.+?\bby\s+(.+?)(?:\.|\n|$)/i,
		);
		const completionMatch =
			durationMatch
			?? explicitCompletionMatch
			?? deadlineMatch;

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
