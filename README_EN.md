# NodeCrypt

🌐 **[中文版 README](README.md)**

## 🚀 Deployment Instructions

### Method 1: One-Click Deploy to Cloudflare Workers

Click the button below for one-click deployment to Cloudflare Workers:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shuaiplus/NodeCrypt)
> Note: This method creates a new project based on the main repository. Future updates to the main repository will not be automatically synchronized.
> Build command: `npm run build`; deploy command: `npm run deploy`; Node.js 22+ is required.

### Method 2: Auto-Sync Fork and Deploy (Recommended for Long-term Maintenance)
1. First, fork this project to your own GitHub account.
2. Open the Cloudflare Workers console, select "Import from GitHub," and choose your forked repository for deployment.
> This project has built-in auto-sync workflow. After forking, no action is required. Updates from the main repository will automatically sync to your fork, and Cloudflare will automatically redeploy without manual maintenance.

### Method 3: Docker One-Click Deployment (Recommended for Self-hosting)

```bash
docker run -d --name nodecrypt -p 8088:8088 ghcr.io/shuaiplus/nodecrypt
```

Access http://localhost:8088

### Method 4: Local Development Deployment
After cloning the project and installing dependencies, use `npm run dev` to start the development server.
Use `npm run deploy` to deploy to Cloudflare Workers.

## 📝 Project Introduction

NodeCrypt is a truly end-to-end encrypted chat system that implements a complete zero-knowledge architecture. The entire system design ensures that servers, network intermediaries, and even system administrators cannot access any plaintext message content. All encryption and decryption operations are performed locally on the client side, with the server serving only as a blind relay for encrypted data.

### System Architecture
- **Frontend**: ES6+ modular JavaScript, no framework dependencies
- **Backend**: Cloudflare Workers + Durable Objects
- **Communication**: Real-time bidirectional WebSocket communication
- **Build**: Vite modern build tool

## 🔐 Zero-Knowledge Architecture Design

### Core Principles
- **Server Blind Relay**: The server can never decrypt message content, only responsible for encrypted data relay
- **No Database Storage**: The system does not use any persistent storage; all data exists only temporarily in memory
- **End-to-End Encryption**: Messages are encrypted from sender to receiver throughout the entire process; no intermediary can decrypt them
- **Session Ephemeral Keys**: Each connection generates fresh ECDH session keys, and newly joined users cannot read historical messages
- **Anonymous Communication**: Users do not need to register real identities; supports temporary anonymous chat
- **Rich Experience**: Support for sending images and files, with optional themes and languages

### Privacy Protection Mechanisms

- **Real-time Member Notifications**: The room online list is completely transparent; any member joining or leaving will notify all members in real-time
- **No Historical Messages**: Newly joined users cannot see any historical chat records
- **Private Chat Encryption**: Clicking on a user's avatar can initiate end-to-end encrypted private conversations that are completely invisible to other room members
- **Safe Sharing**: Invite links use URL fragments, so room names and passwords are not sent to server logs
- **Member Safety Codes**: The member list shows a temporary public-key fingerprint that can be verified through another trusted channel

### Room Password Mechanism

Room passwords serve as **key derivation factors** in end-to-end encryption. Clients derive a room key from the room name and password with PBKDF2-HMAC-SHA-256, then combine it with each peer ECDH shared secret through HKDF to create purpose-separated message keys.

- **Password Error Isolation**: Rooms with different passwords cannot decrypt each other's messages
- **Server Blind Spot**: The server can never know the room password

### V2 Security System

#### Layer 1: Blind Server Relay
- The server only manages WebSocket members by `roomId`, broadcasts member public keys, and forwards ciphertext
- The server never receives room passwords, never derives session keys, and never decrypts chat or file content

#### Layer 2: ECDH-P256 + HKDF Key Agreement
- Each client generates a fresh P-256 ECDH session key pair for each connection
- Clients derive pairwise shared secrets and bind room keys, member IDs, and public-key transcripts through HKDF
- Each sending direction has an independent AEAD key and nonce sequence

#### Layer 3: AES-256-GCM Authenticated Encryption
- Text, images, file metadata, and file chunks are encrypted between clients with AES-GCM
- Each message authenticates AAD that binds protocol version, room, sender, recipient, message type, and sequence
- Any ciphertext or routed-field tampering causes authentication failure and the message is discarded

## 🔄 Complete Encryption Process

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant O as Other Clients

    Note over C,S: Phase 1: Join blind relay room
    C->>S: WebSocket Connection
    C->>S: roomId + clientId + P-256 public key
    S->>C: Member list and member public keys
    
    Note over C,O: Phase 2: Pairwise client key derivation
    Note over C: PBKDF2(roomName,password) => roomPsk
    Note over C: ECDH(P-256) + HKDF(roomPsk, transcript)
    Note over O: Same process derives opposite direction keys
    
    Note over C,O: Phase 3: Secure message transfer
    C->>S: AES-GCM ciphertext + AAD-bound fields
    Note over S: Validate routing fields only and forward ciphertext
    S->>O: Forward ciphertext
    Note over O: Verify AAD and authentication tag, then decrypt
```

## 🛠️ Technical Implementation

- **Web Cryptography API**: Native browser implementation for PBKDF2, HKDF, P-256 ECDH, AES-GCM, and SHA-256

## 🔬 Security Verification

### Encryption Process Verification
Users can observe the complete encryption and decryption process through browser developer tools to verify that messages are indeed encrypted during transmission.

### Network Traffic Analysis
Network packet capture tools can verify that all WebSocket transmitted data is unreadable encrypted content.

### Code Security Audit
All encryption-related code is completely open source, using standard cryptographic algorithms. Security researchers are welcome to conduct independent audits.

## ⚠️ Security Recommendations

- **Use Strong Room Passwords**: Room passwords directly affect end-to-end encryption strength; complex passwords are recommended
- **Password Confidentiality**: If a room password is leaked, all communication content in that room may be decrypted
- **Verify Member Safety Codes**: If identity matters, compare the safety code in the member list through another trusted channel
- **Use Latest Modern Browsers**: Ensure security and performance of cryptographic APIs

## 🤝 Security Contributions

Security researchers are welcome to report vulnerabilities and conduct security audits. Critical security issues will be fixed within 24 hours.

## 📄 Open Source License

This project uses the ISC open source license.

## ⚠️ Disclaimer

This project is for educational and technical research purposes only and must not be used for any illegal or criminal activities. Users should comply with the relevant laws and regulations of their country and region. The project author assumes no legal responsibility for any consequences arising from the use of this software. Please use this project legally and compliantly.

---

**NodeCrypt** - True End-to-End Encrypted Communication 🔐

*"In the digital age, encryption is the last line of defense for privacy"*
