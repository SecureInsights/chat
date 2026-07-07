const PROTOCOL_VERSION = 2;
const MAX_RELAY_SIZE = 8 * 1024 * 1024;
const CLIENT_TIMEOUT_MS = 90000;
const MAX_ROOM_MEMBERS = 64;
const MAX_MESSAGES_PER_WINDOW = 120;
const RATE_WINDOW_MS = 10000;
const MAX_BAD_MESSAGES = 10;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{40,256}$/;
const SMALL_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SECURITY_HEADERS = {
	'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
	'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
	'Cross-Origin-Opener-Policy': 'same-origin'
};

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const upgradeHeader = request.headers.get('Upgrade');
		if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
			if (url.pathname !== '/ws') {
				return withSecurityHeaders(new Response('Not found', { status: 404 }));
			}
			const roomId = url.searchParams.get('room') || '';
			if (!ROOM_ID_RE.test(roomId)) {
				return withSecurityHeaders(new Response('Invalid room', { status: 400 }));
			}
			const id = env.CHAT_ROOM.idFromName(`room:${roomId}`);
			return env.CHAT_ROOM.get(id).fetch(request);
		}
		if (url.pathname === '/api/health') {
			return jsonResponse({ ok: true, protocol: PROTOCOL_VERSION });
		}
		if (url.pathname.startsWith('/api/')) {
			return jsonResponse({ ok: false, error: 'not_found' }, 404);
		}
		return withSecurityHeaders(await env.ASSETS.fetch(request));
	}
};

export class ChatRoom {
	constructor(state) {
		this.state = state;
		this.roomId = null;
		this.clients = new Map();
	}

	async fetch(request) {
		const url = new URL(request.url);
		const roomId = url.searchParams.get('room') || '';
		if (!ROOM_ID_RE.test(roomId)) {
			return withSecurityHeaders(new Response('Invalid room', { status: 400 }));
		}
		if (!this.roomId) this.roomId = roomId;
		if (this.roomId !== roomId) {
			return withSecurityHeaders(new Response('Room mismatch', { status: 409 }));
		}
		const upgradeHeader = request.headers.get('Upgrade');
		if (url.pathname !== '/ws' || !upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
			return withSecurityHeaders(new Response('Expected WebSocket Upgrade', { status: 426 }));
		}
		this.cleanupOldConnections();
		if (this.clients.size >= MAX_ROOM_MEMBERS) {
			return withSecurityHeaders(new Response('Room full', { status: 429 }));
		}
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.handleSession(server);
		return new Response(null, {
			status: 101,
			webSocket: client
		});
	}

	handleSession(connection) {
		connection.accept();
		let clientId = null;
		let badMessages = 0;
		const rateWindow = [];
		connection.addEventListener('message', event => {
			const raw = event.data;
			if (raw === 'ping') {
				this.send(connection, 'pong');
				return;
			}
			if (!allowRate(rateWindow)) {
				this.close(connection);
				return;
			}
			if (typeof raw !== 'string' || raw.length > MAX_RELAY_SIZE) {
				badMessages += 1;
				if (badMessages >= MAX_BAD_MESSAGES) this.close(connection);
				return;
			}
			let message;
			try {
				message = JSON.parse(raw);
			} catch {
				badMessages += 1;
				if (badMessages >= MAX_BAD_MESSAGES) this.close(connection);
				return;
			}
			if (!message || message.v !== PROTOCOL_VERSION || message.roomId !== this.roomId) {
				badMessages += 1;
				if (badMessages >= MAX_BAD_MESSAGES) this.close(connection);
				return;
			}
			if (message.t === 'join') {
				if (clientId) {
					this.close(connection);
					return;
				}
				const joinedId = this.handleJoin(connection, message);
				if (joinedId) clientId = joinedId;
			} else if (message.t === 'relay' && clientId) {
				this.handleRelay(clientId, message, raw);
			} else {
				badMessages += 1;
				if (badMessages >= MAX_BAD_MESSAGES) this.close(connection);
			}
		});
		connection.addEventListener('close', () => {
			const current = clientId ? this.clients.get(clientId) : null;
			if (current && current.connection === connection) {
				this.clients.delete(clientId);
				this.broadcastMembers();
			}
		});
	}

	handleJoin(connection, message) {
		if (
			!CLIENT_ID_RE.test(message.clientId || '') ||
			!PUBLIC_KEY_RE.test(message.dhPub || '')
		) {
			this.close(connection);
			return null;
		}
		if (!this.clients.has(message.clientId) && this.clients.size >= MAX_ROOM_MEMBERS) {
			this.close(connection);
			return null;
		}
		const oldClient = this.clients.get(message.clientId);
		if (oldClient && oldClient.connection !== connection) {
			this.close(oldClient.connection);
		}
		this.clients.set(message.clientId, {
			connection,
			clientId: message.clientId,
			dhPub: message.dhPub,
			seen: Date.now()
		});
		this.broadcastMembers();
		return message.clientId;
	}

	handleRelay(clientId, message, raw) {
		const from = this.clients.get(clientId);
		const target = this.clients.get(message.to);
		if (
			!from ||
			!target ||
			message.from !== clientId ||
			!CLIENT_ID_RE.test(message.to || '') ||
			!SMALL_TOKEN_RE.test(message.kind || '') ||
			!SMALL_TOKEN_RE.test(message.nonce || '') ||
			typeof message.ct !== 'string' ||
			message.ct.length > MAX_RELAY_SIZE ||
			!Number.isSafeInteger(message.seq) ||
			message.seq < 1
		) {
			return;
		}
		from.seen = Date.now();
		this.send(target.connection, raw);
	}

	broadcastMembers() {
		const members = Array.from(this.clients.values()).map(client => ({
			clientId: client.clientId,
			dhPub: client.dhPub
		}));
		const payload = JSON.stringify({
			v: PROTOCOL_VERSION,
			t: 'members',
			roomId: this.roomId,
			members
		});
		for (const client of this.clients.values()) {
			this.send(client.connection, payload);
		}
	}

	cleanupOldConnections() {
		const threshold = Date.now() - CLIENT_TIMEOUT_MS;
		for (const [clientId, client] of this.clients) {
			if (client.seen < threshold) {
				this.close(client.connection);
				this.clients.delete(clientId);
			}
		}
	}

	send(connection, message) {
		try {
			if (connection.readyState === 1) connection.send(message);
		} catch {}
	}

	close(connection) {
		try {
			connection.close();
		} catch {}
	}
}

function allowRate(timestamps, now = Date.now()) {
	while (timestamps.length && now - timestamps[0] > RATE_WINDOW_MS) {
		timestamps.shift();
	}
	if (timestamps.length >= MAX_MESSAGES_PER_WINDOW) return false;
	timestamps.push(now);
	return true;
}

function jsonResponse(value, status = 200) {
	return withSecurityHeaders(Response.json(value, { status }));
}

function withSecurityHeaders(response) {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
		headers.set(key, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
