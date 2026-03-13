# Frontend (React + TypeScript)

## Responsibilities

- Generates local RSA-4096 keys per operator session.
- Decrypts room key locally (never exports private key).
- Encrypts/decrypts message payloads with AES-256-GCM.
- Renders realtime operator chat feed.

## Run

```bash
cp .env.example .env
npm install
npm run dev
```

## Security Notes

- Private key remains in browser memory.
- Backend only receives ciphertext and nonce.
