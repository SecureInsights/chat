#!/usr/bin/env node

'use strict';

const ws = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
const DIST_DIR = path.resolve(process.env.NODECRYPT_DIST || path.join(__dirname, '..', 'dist'));
const MIME_TYPES = {
	'.css': 'text/css; charset=utf-8',
	'.gif': 'image/gif',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.webp': 'image/webp'
};
const SECURITY_HEADERS = {
	'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
	'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
	'Cross-Origin-Opener-Policy': 'same-origin'
};

const config = {
	wsHost: process.env.NODECRYPT_HOST || '127.0.0.1',
	wsPort: Number(process.env.NODECRYPT_PORT || 8088),
	debug: process.env.NODECRYPT_DEBUG === '1'
};

const rooms = new Map();
const httpServer = http.createServer(handleHttpRequest);

const wss = new ws.Server({
	server: httpServer,
	perMessageDeflate: false,
	maxPayload: MAX_RELAY_SIZE
});

httpServer.listen(config.wsPort, config.wsHost, () => {
	log('server-started', `http://${config.wsHost}:${config.wsPort}`);
});

wss.on('connection', (connection, request) => {
	let roomId = '';
	let clientId = null;
	try {
		const url = new URL(request.url || '/', 'ws://localhost');
		if (url.pathname !== '/ws' && url.pathname !== '/') {
			close(connection, 1008, 'invalid-path');
			return;
		}
		roomId = url.searchParams.get('room') || '';
	} catch {
		close(connection, 1008, 'invalid-url');
		return;
	}
	if (!ROOM_ID_RE.test(roomId)) {
		close(connection, 1008, 'invalid-room');
		return;
	}
	const room = getRoom(roomId);
	cleanupRoom(room);
	if (room.clients.size >= MAX_ROOM_MEMBERS) {
		close(connection, 1013, 'room-full');
		return;
	}
	let badMessages = 0;
	const rateWindow = [];

	connection.on('message', raw => {
		const text = normalizeMessage(raw);
		if (!text) return;
		if (text === 'ping') {
			send(connection, 'pong');
			return;
		}
		if (!allowRate(rateWindow)) {
			close(connection, 1008, 'rate-limit');
			return;
		}
		let message;
		try {
			message = JSON.parse(text);
		} catch {
			badMessages += 1;
			if (badMessages >= MAX_BAD_MESSAGES) close(connection, 1008, 'bad-message');
			return;
		}
		if (!message || message.v !== PROTOCOL_VERSION || message.roomId !== roomId) {
			badMessages += 1;
			if (badMessages >= MAX_BAD_MESSAGES) close(connection, 1008, 'bad-message');
			return;
		}
		if (message.t === 'join') {
			if (clientId) {
				close(connection, 1008, 'duplicate-join');
				return;
			}
			const joinedId = handleJoin(room, connection, message);
			if (joinedId) clientId = joinedId;
		} else if (message.t === 'relay' && clientId) {
			handleRelay(room, clientId, message, text);
		} else {
			badMessages += 1;
			if (badMessages >= MAX_BAD_MESSAGES) close(connection, 1008, 'bad-message');
		}
	});

	connection.on('close', () => {
		const current = clientId ? room.clients.get(clientId) : null;
		if (current && current.connection === connection) {
			room.clients.delete(clientId);
			broadcastMembers(room);
			if (room.clients.size === 0) rooms.delete(roomId);
		}
	});
});

function handleHttpRequest(request, response) {
	const url = new URL(request.url || '/', 'http://localhost');
	if (url.pathname === '/api/health') {
		writeJson(response, 200, { ok: true, protocol: PROTOCOL_VERSION });
		return;
	}
	if (url.pathname.startsWith('/api/')) {
		writeJson(response, 404, { ok: false, error: 'not_found' });
		return;
	}
	if (url.pathname === '/ws') {
		response.writeHead(426, withSecurityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
		response.end('Expected WebSocket Upgrade');
		return;
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		response.writeHead(405, withSecurityHeaders({ Allow: 'GET, HEAD' }));
		response.end();
		return;
	}
	const filePath = resolveStaticPath(url.pathname);
	serveFile(filePath, request, response, true);
}

function resolveStaticPath(urlPathname) {
	let pathname;
	try {
		pathname = decodeURIComponent(urlPathname);
	} catch {
		return path.join(DIST_DIR, 'index.html');
	}
	if (pathname.includes('\0')) return path.join(DIST_DIR, 'index.html');
	const requested = pathname === '/' ? '/index.html' : pathname;
	const filePath = path.resolve(DIST_DIR, `.${requested}`);
	if (filePath !== DIST_DIR && !filePath.startsWith(`${DIST_DIR}${path.sep}`)) {
		return path.join(DIST_DIR, 'index.html');
	}
	return filePath;
}

function serveFile(filePath, request, response, allowSpaFallback) {
	fs.stat(filePath, (statError, stats) => {
		if (statError || !stats.isFile()) {
			if (allowSpaFallback) {
				serveFile(path.join(DIST_DIR, 'index.html'), request, response, false);
				return;
			}
			response.writeHead(404);
			response.end('Not Found');
			return;
		}
		const headers = {
			'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
			'Content-Length': stats.size,
			'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable'
		};
		response.writeHead(200, withSecurityHeaders(headers));
		if (request.method === 'HEAD') {
			response.end();
			return;
		}
		fs.createReadStream(filePath).pipe(response);
	});
}

function writeJson(response, status, value) {
	response.writeHead(status, withSecurityHeaders({
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store'
	}));
	response.end(JSON.stringify(value));
}

function getRoom(roomId) {
	let room = rooms.get(roomId);
	if (!room) {
		room = {
			roomId,
			clients: new Map()
		};
		rooms.set(roomId, room);
	}
	return room;
}

function handleJoin(room, connection, message) {
	if (
		!CLIENT_ID_RE.test(message.clientId || '') ||
		!PUBLIC_KEY_RE.test(message.dhPub || '')
	) {
		close(connection, 1008, 'invalid-join');
		return null;
	}
	if (!room.clients.has(message.clientId) && room.clients.size >= MAX_ROOM_MEMBERS) {
		close(connection, 1013, 'room-full');
		return null;
	}
	const old = room.clients.get(message.clientId);
	if (old && old.connection !== connection) close(old.connection, 1000, 'replaced');
	room.clients.set(message.clientId, {
		connection,
		clientId: message.clientId,
		dhPub: message.dhPub,
		seen: Date.now()
	});
	broadcastMembers(room);
	return message.clientId;
}

function handleRelay(room, clientId, message, raw) {
	const from = room.clients.get(clientId);
	const target = room.clients.get(message.to);
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
	send(target.connection, raw);
}

function broadcastMembers(room) {
	const payload = JSON.stringify({
		v: PROTOCOL_VERSION,
		t: 'members',
		roomId: room.roomId,
		members: Array.from(room.clients.values()).map(client => ({
			clientId: client.clientId,
			dhPub: client.dhPub
		}))
	});
	for (const client of room.clients.values()) {
		send(client.connection, payload);
	}
}

function cleanupRoom(room) {
	const threshold = Date.now() - CLIENT_TIMEOUT_MS;
	for (const [clientId, client] of room.clients) {
		if (client.seen < threshold || client.connection.readyState !== ws.OPEN) {
			close(client.connection, 1000, 'timeout');
			room.clients.delete(clientId);
		}
	}
	if (room.clients.size > 0) broadcastMembers(room);
}

function normalizeMessage(raw) {
	if (typeof raw === 'string') return raw;
	if (Buffer.isBuffer(raw)) return raw.toString('utf8');
	return '';
}

function allowRate(timestamps, now = Date.now()) {
	while (timestamps.length && now - timestamps[0] > RATE_WINDOW_MS) {
		timestamps.shift();
	}
	if (timestamps.length >= MAX_MESSAGES_PER_WINDOW) return false;
	timestamps.push(now);
	return true;
}

function withSecurityHeaders(headers = {}) {
	return {
		...headers,
		...SECURITY_HEADERS
	};
}

function send(connection, message) {
	try {
		if (connection.readyState === ws.OPEN) connection.send(message);
	} catch (error) {
		log('send-error', error.message);
	}
}

function close(connection, code = 1000, reason = '') {
	try {
		connection.close(code, reason);
	} catch {}
}

function log(source, message) {
	if (config.debug || source === 'server-started') {
		console.log(`[${new Date().toISOString()}]`, source, message || '');
	}
}

setInterval(() => {
	for (const [roomId, room] of rooms) {
		cleanupRoom(room);
		if (room.clients.size === 0) rooms.delete(roomId);
	}
}, 30000);
