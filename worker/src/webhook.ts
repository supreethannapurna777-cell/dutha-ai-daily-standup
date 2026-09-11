import {
	extractUpdate,
	type ExtractedUpdate,
} from "./extract-update";


interface StoredMessage {
	id: number;
	senderName: string;
	senderPhone: string;
	receivedAt: string;
	originalReply: string;
	extracted: ExtractedUpdate;
}


export interface WebhookResult {
	received: number;
	duplicates: number;
	ignored: number;
}


function timestampToIso(
	timestamp: unknown,
	fallback: Date,
): string {
	const seconds = Number(timestamp);

	if (Number.isFinite(seconds) && seconds > 0) {
		return new Date(seconds * 1000).toISOString();
	}

	return fallback.toISOString();
}


async function storeMessage(
	db: D1Database,
	whatsappMessageId: string,
	senderName: string,
	senderPhone: string,
	receivedAt: string,
	originalReply: string,
): Promise<StoredMessage | null> {
	const inserted = await db
		.prepare(
			`
			INSERT OR IGNORE INTO incoming_messages (
				whatsapp_message_id,
				received_at,
				sender_name,
				sender_phone,
				original_reply,
				processing_status
			)
			VALUES (?, ?, ?, ?, ?, ?)
			RETURNING id
			`,
		)
		.bind(
			whatsappMessageId,
			receivedAt,
			senderName,
			senderPhone,
			originalReply,
			"received",
		)
		.first<{ id: number }>();

	if (!inserted) {
		return null;
	}

	return {
		id: inserted.id,
		senderName,
		senderPhone,
		receivedAt,
		originalReply,
		extracted: extractUpdate(originalReply),
	};
}


async function saveProcessedUpdate(
	db: D1Database,
	message: StoredMessage,
): Promise<void> {
	const update = message.extracted;

	await db.batch([
		db
			.prepare(
				`
				INSERT INTO processed_updates (
					message_id,
					sender_name,
					tasks,
					people_to_connect,
					blockers,
					dependencies,
					expected_completion,
					original_reply,
					processing_status
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				`,
			)
			.bind(
				message.id,
				message.senderName,
				update.tasks,
				update.people_to_connect,
				update.blockers,
				update.dependencies,
				update.expected_completion,
				update.original_reply,
				"processed",
			),
		db
			.prepare(
				`
				UPDATE incoming_messages
				SET processing_status = ?
				WHERE id = ?
				`,
			)
			.bind("processed", message.id),
	]);
}


export async function processWebhookPayload(
	payload: unknown,
	db: D1Database,
	now = new Date(),
): Promise<WebhookResult> {
	const result: WebhookResult = {
		received: 0,
		duplicates: 0,
		ignored: 0,
	};

	if (
		typeof payload !== "object" ||
		payload === null
	) {
		return result;
	}

	const root = payload as Record<string, unknown>;
	const entries = Array.isArray(root.entry)
		? root.entry
		: [];

	for (const entryValue of entries) {
		if (
			typeof entryValue !== "object" ||
			entryValue === null
		) {
			continue;
		}

		const entry = entryValue as Record<string, unknown>;
		const changes = Array.isArray(entry.changes)
			? entry.changes
			: [];

		for (const changeValue of changes) {
			if (
				typeof changeValue !== "object" ||
				changeValue === null
			) {
				continue;
			}

			const change =
				changeValue as Record<string, unknown>;
			const value =
				typeof change.value === "object" &&
				change.value !== null
					? change.value as Record<string, unknown>
					: {};

			const contacts = Array.isArray(value.contacts)
				? value.contacts
				: [];

			let contactName = "WhatsApp User";

			const firstContact = contacts[0];

			if (
				typeof firstContact === "object" &&
				firstContact !== null
			) {
				const contact =
					firstContact as Record<string, unknown>;
				const profile =
					typeof contact.profile === "object" &&
					contact.profile !== null
						? contact.profile as Record<
								string,
								unknown
							>
						: {};

				if (typeof profile.name === "string") {
					contactName = profile.name;
				}
			}

			const messages = Array.isArray(value.messages)
				? value.messages
				: [];

			for (const messageValue of messages) {
				if (
					typeof messageValue !== "object" ||
					messageValue === null
				) {
					result.ignored += 1;
					continue;
				}

				const message =
					messageValue as Record<string, unknown>;

				if (message.type !== "text") {
					result.ignored += 1;
					continue;
				}

				const textObject =
					typeof message.text === "object" &&
					message.text !== null
						? message.text as Record<
								string,
								unknown
							>
						: {};

				const messageId =
					typeof message.id === "string"
						? message.id.trim()
						: "";
				const senderPhone =
					typeof message.from === "string"
						? message.from.trim()
						: "";
				const text =
					typeof textObject.body === "string"
						? textObject.body.trim()
						: "";

				if (!messageId || !senderPhone || !text) {
					result.ignored += 1;
					continue;
				}

				const stored = await storeMessage(
					db,
					messageId,
					contactName,
					senderPhone,
					timestampToIso(
						message.timestamp,
						now,
					),
					text,
				);

				if (!stored) {
					result.duplicates += 1;
					continue;
				}

				await saveProcessedUpdate(db, stored);
				result.received += 1;
			}
		}
	}

	return result;
}