import {
	PROTOCOL_VERSION,
	aesGcmDecrypt,
	aesGcmEncrypt,
	base64UrlDecode,
	base64UrlEncode,
	concatBytes,
	deriveEcdhSecret,
	deriveRoomSecrets,
	exportEcdhPublicKey,
	generateEcdhKeyPair,
	hkdfBytes,
	importEcdhPublicKey,
	makeClientId,
	nonceFrom,
	sha256Bytes,
	stableBytes
} from './crypto.v2.js';

const MAX_RELAY_SIZE = 8 * 1024 * 1024;
const MAX_PENDING_RELAY_PER_PEER = 32;

class NodeCrypt {
	constructor(config = {}, callbacks = {}) {
		this.config = {
			wsAddress: config.wsAddress || '',
			reconnectDelay: config.reconnectDelay || 3000,
			pingInterval: config.pingInterval || 20000,
			debug: config.debug || false
		};
		this.callbacks = {
			onServerClosed: callbacks.onServerClosed || null,
			onServerSecured: callbacks.onServerSecured || null,
			onClientSecured: callbacks.onClientSecured || null,
			onClientList: callbacks.onClientList || null,
			onClientLeft: callbacks.onClientLeft || null,
			onClientMessage: callbacks.onClientMessage || null
		};
		this.credentials = null;
		this.connection = null;
		this.reconnect = null;
		this.ping = null;
		this.roomId = null;
		this.roomPsk = null;
		this.clientId = null;
		this.ecdhKeys = null;
			this.publicKey = null;
			this.channel = {};
			this.pendingRelays = {};
			this.isDestroyed = false;
			this.connecting = false;
		}

	setCredentials(username, channel, password) {
		this.credentials = {
			username: String(username || '').trim(),
			channel: String(channel || '').trim(),
			password: String(password || '')
		};
		return Boolean(this.credentials.username && this.credentials.channel);
	}

	connect() {
		if (!this.credentials || this.connecting) return false;
		this.connecting = true;
		this.isDestroyed = false;
		this.stopReconnect();
		this.stopPing();
		this.prepareAndConnect().catch(error => {
			this.connecting = false;
			this.logEvent('connect', error, 'error');
			this.handleServerClosed();
		});
		return true;
	}

		async prepareAndConnect() {
			this.channel = {};
			this.pendingRelays = {};
			const room = await deriveRoomSecrets(this.credentials.channel, this.credentials.password);
		this.roomId = room.roomId;
		this.roomPsk = room.roomPsk;
		this.clientId = makeClientId();
		this.ecdhKeys = await generateEcdhKeyPair();
		this.publicKey = await exportEcdhPublicKey(this.ecdhKeys.publicKey);
		const wsUrl = this.makeWebSocketUrl();
		this.connection = new WebSocket(wsUrl);
		this.connection.onopen = () => this.onOpen();
		this.connection.onmessage = event => this.onMessage(event);
		this.connection.onerror = event => this.onError(event);
		this.connection.onclose = event => this.onClose(event);
	}

	makeWebSocketUrl() {
		const url = new URL(this.config.wsAddress, window.location.href);
		url.pathname = '/ws';
		url.searchParams.set('room', this.roomId);
		url.searchParams.set('v', String(PROTOCOL_VERSION));
		return url.toString();
	}

	onOpen() {
		this.connecting = false;
		this.startPing();
		this.sendMessage({
			v: PROTOCOL_VERSION,
			t: 'join',
			roomId: this.roomId,
			clientId: this.clientId,
			dhPub: this.publicKey
		});
		if (this.callbacks.onServerSecured) {
			this.callbacks.onServerSecured();
		}
	}

	async onMessage(event) {
		if (!event || typeof event.data !== 'string') return;
		if (event.data === 'pong') return;
		let message;
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}
		if (!message || message.v !== PROTOCOL_VERSION) return;
		try {
			if (message.t === 'members') {
				await this.handleMembers(message);
			} else if (message.t === 'relay') {
				await this.handleRelay(message);
			} else if (message.t === 'error') {
				this.logEvent('server-error', message.code || 'unknown', 'error');
			}
		} catch (error) {
			this.logEvent('message-handler', error, 'error');
		}
	}

	onError(event) {
		this.logEvent('onError', event, 'error');
		this.disconnect();
		this.handleServerClosed();
	}

	onClose(event) {
		this.logEvent('onClose', event);
		this.stopPing();
		this.connection = null;
		if (!this.isDestroyed) {
			this.handleServerClosed();
			if (this.credentials) this.startReconnect();
		}
	}

	handleServerClosed() {
		if (this.callbacks.onServerClosed) {
			try {
				this.callbacks.onServerClosed();
			} catch (error) {
				this.logEvent('server-closed-callback', error, 'error');
			}
		}
	}

	async handleMembers(message) {
		if (message.roomId !== this.roomId || !Array.isArray(message.members)) return;
		const seen = new Set();
		for (const member of message.members) {
			if (!member || typeof member.clientId !== 'string' || typeof member.dhPub !== 'string') continue;
				if (member.clientId === this.clientId) continue;
				seen.add(member.clientId);
				await this.ensurePeer(member.clientId, member.dhPub);
				await this.flushPendingRelays(member.clientId);
			}
			for (const clientId of Object.keys(this.channel)) {
				if (!seen.has(clientId)) {
					delete this.channel[clientId];
					delete this.pendingRelays[clientId];
				}
			}
		for (const clientId of Object.keys(this.channel)) {
			const peer = this.channel[clientId];
			if (!peer.profileSent) {
				peer.profileSent = true;
				this.sendEncryptedTo(clientId, 'profile', {
					username: this.credentials.username
				}).catch(error => {
					peer.profileSent = false;
					this.logEvent('profile-send', error, 'error');
				});
			}
		}
		this.emitClientList();
	}

	async ensurePeer(clientId, dhPub) {
		const current = this.channel[clientId];
		if (current && current.dhPub === dhPub) return current;
		const peerPublic = await importEcdhPublicKey(dhPub);
		const dhSecret = await deriveEcdhSecret(this.ecdhKeys.privateKey, peerPublic);
		const ordered = [this.clientId, clientId].sort();
		const keyMap = {
			[this.clientId]: this.publicKey,
			[clientId]: dhPub
		};
		const transcript = stableBytes({
			v: PROTOCOL_VERSION,
			roomId: this.roomId,
			clients: ordered,
			keys: ordered.map(id => keyMap[id])
		});
		const pairMaster = await hkdfBytes(
			concatBytes(dhSecret, transcript),
			'nodecrypt/v2/pair-master',
			this.roomPsk,
			32
		);
		const sendLabel = `${this.clientId}->${clientId}`;
		const recvLabel = `${clientId}->${this.clientId}`;
			const peer = {
				clientId,
				dhPub,
				fingerprint: base64UrlEncode(await sha256Bytes('nodecrypt/v2/peer-fingerprint/', dhPub)).slice(0, 12),
				username: current ? current.username : null,
			secured: current ? current.secured : false,
			shared: true,
			sendSeq: 0,
			lastRecvSeq: 0,
			profileSent: false,
			sendKey: await hkdfBytes(pairMaster, `nodecrypt/v2/msg-key/${sendLabel}`, transcript, 32),
			recvKey: await hkdfBytes(pairMaster, `nodecrypt/v2/msg-key/${recvLabel}`, transcript, 32),
			sendNoncePrefix: await hkdfBytes(pairMaster, `nodecrypt/v2/nonce/${sendLabel}`, transcript, 4),
			recvNoncePrefix: await hkdfBytes(pairMaster, `nodecrypt/v2/nonce/${recvLabel}`, transcript, 4)
		};
		this.channel[clientId] = peer;
		return peer;
	}

	async sendEncryptedTo(clientId, type, data) {
		const peer = this.channel[clientId];
		if (!peer || !this.isOpen()) return false;
		peer.sendSeq += 1;
		const aadObject = {
			v: PROTOCOL_VERSION,
			t: 'relay',
			roomId: this.roomId,
			from: this.clientId,
			to: clientId,
			kind: type,
			seq: peer.sendSeq
		};
		const nonce = nonceFrom(peer.sendNoncePrefix, peer.sendSeq);
		const ct = await aesGcmEncrypt(peer.sendKey, nonce, stableBytes(aadObject), {
			type,
			data
		});
		const envelope = {
			...aadObject,
			nonce: base64UrlEncode(nonce),
			ct
		};
		if (JSON.stringify(envelope).length > MAX_RELAY_SIZE) return false;
		return this.sendMessage(envelope);
	}

	async handleRelay(message) {
		if (
			message.roomId !== this.roomId ||
			message.to !== this.clientId ||
			typeof message.from !== 'string' ||
			typeof message.kind !== 'string' ||
			typeof message.ct !== 'string' ||
			typeof message.nonce !== 'string' ||
			!Number.isSafeInteger(message.seq)
		) {
			return;
			}
			const peer = this.channel[message.from];
			if (!peer) {
				this.queuePendingRelay(message);
				return;
			}
			if (message.seq <= peer.lastRecvSeq) return;
		const aadObject = {
			v: PROTOCOL_VERSION,
			t: 'relay',
			roomId: this.roomId,
			from: message.from,
			to: this.clientId,
			kind: message.kind,
			seq: message.seq
		};
		let payload;
		try {
			payload = await aesGcmDecrypt(peer.recvKey, base64UrlDecode(message.nonce), stableBytes(aadObject), message.ct);
		} catch (error) {
			this.logEvent('relay-auth-failed', message.from, 'error');
			return;
		}
		peer.lastRecvSeq = message.seq;
		if (!payload || payload.type !== message.kind) return;
		if (payload.type === 'profile') {
			this.handlePeerProfile(message.from, payload.data);
		} else {
			this.handlePeerMessage(message.from, payload.type, payload.data);
			}
		}

		queuePendingRelay(message) {
			const queued = this.pendingRelays[message.from] || [];
			queued.push(message);
			if (queued.length > MAX_PENDING_RELAY_PER_PEER) {
				queued.splice(0, queued.length - MAX_PENDING_RELAY_PER_PEER);
			}
			this.pendingRelays[message.from] = queued;
		}

		async flushPendingRelays(clientId) {
			const queued = this.pendingRelays[clientId];
			if (!queued || queued.length === 0) return;
			delete this.pendingRelays[clientId];
			queued.sort((a, b) => a.seq - b.seq);
			for (const message of queued) {
				await this.handleRelay(message);
			}
		}

		handlePeerProfile(clientId, data) {
		const peer = this.channel[clientId];
		if (!peer) return;
		const username = String((data && data.username) || '').trim().slice(0, 64) || 'Anonymous';
		const wasSecured = peer.secured;
		peer.username = username;
		peer.secured = true;
		if (!wasSecured && this.callbacks.onClientSecured) {
			this.callbacks.onClientSecured({
				clientId,
				username
			});
		}
		this.emitClientList();
	}

	handlePeerMessage(clientId, type, data) {
		const peer = this.channel[clientId];
		if (!peer) return;
		if (this.callbacks.onClientMessage) {
			this.callbacks.onClientMessage({
				clientId,
				username: peer.username || 'Anonymous',
				type,
				data
			});
		}
	}

	emitClientList() {
		if (!this.callbacks.onClientList) return;
		const selfName = this.credentials ? this.credentials.username : 'Me';
		const clients = [{
			clientId: this.clientId,
			username: selfName,
			userName: selfName,
			secured: true,
			isSelf: true
		}];
		for (const peer of Object.values(this.channel)) {
			if (!peer.shared) continue;
			const displayName = peer.username || `Peer ${peer.clientId.slice(0, 6)}`;
			clients.push({
				clientId: peer.clientId,
				username: displayName,
				userName: displayName,
				fingerprint: peer.fingerprint,
				secured: Boolean(peer.secured),
				pending: !peer.secured
			});
		}
		this.callbacks.onClientList(clients, this.clientId);
	}

	sendChannelMessage(type, data) {
		if (!this.isOpen()) return false;
		for (const peer of Object.values(this.channel)) {
			if (!peer.shared) continue;
			this.sendEncryptedTo(peer.clientId, type, data).catch(error => {
				this.logEvent('channel-send', error, 'error');
			});
		}
		return true;
	}

	sendPrivateMessage(clientId, type, data) {
		const peer = this.channel[clientId];
		if (!peer || !peer.shared) return false;
		this.sendEncryptedTo(clientId, type, data).catch(error => {
			this.logEvent('private-send', error, 'error');
		});
		return true;
	}

	encryptServerMessage() {
		this.logEvent('legacy-encryptServerMessage', 'not available in protocol v2', 'error');
		return '';
	}

	decryptServerMessage() {
		return {};
	}

	encryptClientMessage() {
		this.logEvent('legacy-encryptClientMessage', 'not available in protocol v2', 'error');
		return '';
	}

	decryptClientMessage() {
		return {};
	}

	isOpen() {
		return Boolean(this.connection && this.connection.readyState === WebSocket.OPEN);
	}

	isClosed() {
		return !this.connection || this.connection.readyState === WebSocket.CLOSED;
	}

	sendMessage(message) {
		if (!this.isOpen()) return false;
		try {
			this.connection.send(typeof message === 'string' ? message : JSON.stringify(message));
			return true;
		} catch (error) {
			this.logEvent('sendMessage', error, 'error');
			return false;
		}
	}

	startReconnect() {
		this.stopReconnect();
		this.reconnect = setTimeout(() => {
			this.reconnect = null;
			this.connecting = false;
			this.connect();
		}, this.config.reconnectDelay);
	}

	stopReconnect() {
		if (this.reconnect) {
			clearTimeout(this.reconnect);
			this.reconnect = null;
		}
	}

	startPing() {
		this.stopPing();
		this.ping = setInterval(() => {
			this.sendMessage('ping');
		}, this.config.pingInterval);
	}

	stopPing() {
		if (this.ping) {
			clearInterval(this.ping);
			this.ping = null;
		}
	}

	disconnect() {
		this.stopReconnect();
		this.stopPing();
		if (this.connection && !this.isClosed()) {
			try {
				this.connection.close();
			} catch (error) {
				this.logEvent('disconnect', error, 'error');
			}
		}
	}

	destruct() {
		this.isDestroyed = true;
		this.disconnect();
		if (this.connection) {
			this.connection.onopen = null;
			this.connection.onmessage = null;
			this.connection.onerror = null;
			this.connection.onclose = null;
		}
			this.connection = null;
			this.channel = {};
			this.pendingRelays = {};
			this.credentials = null;
		this.roomId = null;
		this.roomPsk = null;
		this.clientId = null;
		this.ecdhKeys = null;
		this.publicKey = null;
		return true;
	}

	logEvent(source, message, level) {
		if (!this.config.debug) return;
		const date = new Date();
		const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
		console.log(`[${stamp}]`, level ? level.toUpperCase() : 'INFO', source, message || '');
	}
}

if (typeof window !== 'undefined') {
	window.NodeCrypt = NodeCrypt;
}
