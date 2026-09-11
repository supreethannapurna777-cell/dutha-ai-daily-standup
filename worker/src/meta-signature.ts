function hexToBytes(hex: string): Uint8Array | null {
	if (!/^[0-9a-f]{64}$/i.test(hex)) {
		return null;
	}

	const bytes = new Uint8Array(hex.length / 2);

	for (let index = 0; index < hex.length; index += 2) {
		bytes[index / 2] = Number.parseInt(
			hex.slice(index, index + 2),
			16,
		);
	}

	return bytes;
}


export async function verifyMetaSignature(
	rawBody: string,
	signatureHeader: string | null,
	appSecret: string,
): Promise<boolean> {
	if (!appSecret || !signatureHeader?.startsWith("sha256=")) {
		return false;
	}

	const signature = hexToBytes(
		signatureHeader.slice("sha256=".length),
	);

	if (!signature) {
		return false;
	}

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(appSecret),
		{
			name: "HMAC",
			hash: "SHA-256",
		},
		false,
		["verify"],
	);

	return crypto.subtle.verify(
		"HMAC",
		key,
		signature,
		encoder.encode(rawBody),
	);
}