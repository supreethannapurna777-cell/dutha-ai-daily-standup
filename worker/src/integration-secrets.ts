const encoder = new TextEncoder();

function decodeBase64(value:string):Uint8Array {
	const normalized=value.replaceAll('-','+').replaceAll('_','/');
	return Uint8Array.from(atob(normalized+'='.repeat((4-normalized.length%4)%4)),c=>c.charCodeAt(0));
}

function encodeBase64(value:Uint8Array):string {
	let binary=''; for (const byte of value) binary+=String.fromCharCode(byte);
	return btoa(binary).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}

async function encryptionKey(secret:string):Promise<CryptoKey> {
	let raw:Uint8Array;
	try { raw=decodeBase64(secret.trim()); } catch { throw new Error('INTEGRATION_ENCRYPTION_KEY must be base64 for exactly 32 random bytes.'); }
	if (raw.byteLength!==32) throw new Error('INTEGRATION_ENCRYPTION_KEY must be base64 for exactly 32 random bytes.');
	return crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);
}

function aad(tenantId:number,projectId:number,provider:string,field:string):Uint8Array {
	return encoder.encode(`dutha:v1:${tenantId}:${projectId}:${provider}:${field}`);
}

export async function encryptIntegrationSecret(secret:string, masterKey:string, tenantId:number, projectId:number, provider:string, field:string):Promise<{ciphertext:string;iv:string}> {
	const key=await encryptionKey(masterKey); const iv=crypto.getRandomValues(new Uint8Array(12));
	const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(tenantId,projectId,provider,field)},key,encoder.encode(secret));
	return {ciphertext:encodeBase64(new Uint8Array(encrypted)),iv:encodeBase64(iv)};
}

export async function decryptIntegrationSecret(ciphertext:string, iv:string, masterKey:string, tenantId:number, projectId:number, provider:string, field:string):Promise<string> {
	const key=await encryptionKey(masterKey);
	const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:decodeBase64(iv),additionalData:aad(tenantId,projectId,provider,field)},key,decodeBase64(ciphertext));
	return new TextDecoder().decode(plaintext);
}
