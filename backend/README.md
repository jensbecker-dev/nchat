# Backend (Go)

## Responsibilities

- Key exchange endpoint using RSA public keys.
- Ciphertext-only message persistence (SQLite).
- Realtime relay via WebSocket.
- Protobuf contract in `api/proto` for gRPC interoperability.

## Run

```bash
cp .env.example .env
go mod tidy
go run ./cmd/nchatd
```

Default listeners:

- HTTP API: `:8080`
- gRPC API: `:9090`

## Generate Protobuf Stubs

```bash
cd ..
make proto
```

## API

- `GET /healthz`
- `POST /api/v1/key-exchange`
- `GET /api/v1/messages?limit=200`
- `POST /api/v1/messages`
- `GET /api/v1/users?query=<nameOrId>&excludeClientId=<myId>`
- `GET /ws`

## gRPC Service

- Service: `chat.v1.ChatRelayService`
- Methods:
	- `SendMessage`
	- `ListMessages`
	- `StreamMessages`

## gRPC CLI (nchatctl)

```bash
# show usage
go run ./cmd/nchatctl

# install binary (then use `nchatctl ...` directly)
cd ..
make install-nchatctl

# send encrypted payload metadata
go run ./cmd/nchatctl send -addr localhost:9090 -sender op1 -ciphertext BASE64_CIPHERTEXT -nonce BASE64_NONCE

# list encrypted messages
go run ./cmd/nchatctl list -addr localhost:9090 -limit 20

# stream encrypted messages
go run ./cmd/nchatctl stream -addr localhost:9090
```

## Security Notes

- The backend never receives plaintext messages.
- Browser clients decrypt room keys and message payloads locally.
