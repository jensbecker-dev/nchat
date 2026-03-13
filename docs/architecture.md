# NCHAT Architecture

## Overview

NCHAT is split into two deployable units:

- `backend` (Go): key exchange, encrypted payload relay, persistence of encrypted messages.
- `frontend` (React + TypeScript): key management in browser, local message encryption/decryption, operator UX.

## Security Flow

1. Browser generates an RSA key pair (private key stays local).
2. Frontend sends the public key to backend `/api/v1/key-exchange`.
3. Backend encrypts a shared room key (AES-256) with that public key and returns it.
4. Frontend decrypts room key locally and uses AES-GCM for message payload encryption.
5. Backend stores and relays only ciphertext + nonce metadata.

## Realtime Flow

- Historical encrypted messages are fetched via `/api/v1/messages` or `ListMessages` (gRPC).
- New encrypted messages are sent via `/api/v1/messages` or `SendMessage` (gRPC).
- Realtime fan-out is handled via WebSocket `/ws` or `StreamMessages` (gRPC stream).

## Protocol Buffers

The `backend/api/proto` folder defines protobuf contracts, and generated stubs are served by the backend gRPC listener.
