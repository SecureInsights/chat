const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PROTOCOL_VERSION = 2;
export const PBKDF2_ITERATIONS = 310000;

export function utf8ToBytes(value) {
	return encoder.encode(String(value ?? ''));
}

export function bytesToUtf8(bytes) {
	return decoder.decode(bytes);
}

export function concatBytes(...parts) {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function randomBytes(length) {
	const out = new Uint8Array(length);
	crypto.getRandomValues(out);
	return out;
}

export function base64UrlEncode(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value) {
	const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
	const binary = atob(padded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

export async function sha256Bytes(...parts) {
	const data = concatBytes(...parts.map(part => part instanceof Uint8Array ? part : utf8ToBytes(part)));
	return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export function stableStringify(value) {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}
	return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function stableBytes(value) {
	return utf8ToBytes(stableStringify(value));
}

export async function deriveRoomSecrets(roomName, password) {
	const normalizedRoom = String(roomName || '').trim().normalize('NFKC');
	const normalizedPassword = String(password || '').normalize('NFKC');
	const salt = await sha256Bytes('nodecrypt/v2/room-salt/', normalizedRoom);
	const passwordKey = await crypto.subtle.importKey(
		'raw',
		utf8ToBytes(normalizedPassword),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const pwdBits = await crypto.subtle.deriveBits({
		name: 'PBKDF2',
		salt,
		iterations: PBKDF2_ITERATIONS,
		hash: 'SHA-256'
	}, passwordKey, 256);
	const pwdKey = new Uint8Array(pwdBits);
	const roomId = base64UrlEncode((await hkdfBytes(pwdKey, 'nodecrypt/v2/room-id', salt, 16)));
	const roomPsk = await hkdfBytes(pwdKey, 'nodecrypt/v2/room-psk', salt, 32);
	return {
		roomId,
		roomPsk,
		normalizedRoom
	};
}

export async function hkdfBytes(ikm, info, salt = new Uint8Array(), length = 32) {
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({
		name: 'HKDF',
		hash: 'SHA-256',
		salt,
		info: utf8ToBytes(info)
	}, key, length * 8);
	return new Uint8Array(bits);
}

export async function generateEcdhKeyPair() {
	return crypto.subtle.generateKey({
		name: 'ECDH',
		namedCurve: 'P-256'
	}, true, ['deriveBits']);
}

export async function exportEcdhPublicKey(publicKey) {
	return base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', publicKey)));
}

export async function importEcdhPublicKey(publicKey) {
	return crypto.subtle.importKey(
		'raw',
		base64UrlDecode(publicKey),
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[]
	);
}

export async function deriveEcdhSecret(privateKey, publicKey) {
	return new Uint8Array(await crypto.subtle.deriveBits({
		name: 'ECDH',
		public: publicKey
	}, privateKey, 256));
}

export async function importAesKey(raw) {
	return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function nonceFrom(prefix, sequence) {
	const nonce = new Uint8Array(12);
	nonce.set(prefix.slice(0, 4), 0);
	let seq = BigInt(sequence);
	for (let i = 11; i >= 4; i--) {
		nonce[i] = Number(seq & 0xffn);
		seq >>= 8n;
	}
	return nonce;
}

export async function aesGcmEncrypt(rawKey, nonce, aad, value) {
	const key = await importAesKey(rawKey);
	const plaintext = stableBytes(value);
	const ciphertext = await crypto.subtle.encrypt({
		name: 'AES-GCM',
		iv: nonce,
		additionalData: aad,
		tagLength: 128
	}, key, plaintext);
	return base64UrlEncode(new Uint8Array(ciphertext));
}

export async function aesGcmDecrypt(rawKey, nonce, aad, ciphertext) {
	const key = await importAesKey(rawKey);
	const plaintext = await crypto.subtle.decrypt({
		name: 'AES-GCM',
		iv: nonce,
		additionalData: aad,
		tagLength: 128
	}, key, base64UrlDecode(ciphertext));
	return JSON.parse(bytesToUtf8(new Uint8Array(plaintext)));
}

export function makeClientId() {
	return base64UrlEncode(randomBytes(16));
}
