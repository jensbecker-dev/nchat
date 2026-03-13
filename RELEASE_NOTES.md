# NCHAT v1.0.0

Release date: 2026-03-13

## Highlights

- Added secure messaging across public, private, and group chats.
- Added end-to-end encryption flow with RSA key exchange and AES-GCM payload protection.
- Added LAN-friendly fallback crypto path for devices without `crypto.subtle`.
- Added role-based moderation controls for broadcast and group chats.
- Added responsive sidebar/chat workspace with conversation threads and contact search.
- Added secure file sharing support in chat workflows.
- Added gRPC service alongside REST and WebSocket interfaces.

## Security and Sync Improvements

- Enforced server-side authorization for destructive chat actions.
- Added session-aware validation for actor/admin operations.
- Improved runtime synchronization for admin-role updates across clients.
- Added clearer API error propagation to frontend UI.

## UX Improvements

- Improved sidebar and collapsed-rail behavior.
- Added admin badges and admin settings panels.
- Added screenshots and improved README onboarding clarity.

## API Surface

- Health: `GET /healthz`
- Key exchange: `POST /api/v1/key-exchange`
- Messages: `GET /api/v1/messages`, `POST /api/v1/messages`
- User discovery: `GET /api/v1/users`
- Presence: `POST /api/v1/presence`
- WebSocket stream: `GET /ws`
- Group admin/actions endpoints
- Broadcast admin/actions endpoints

## Validation Performed

- Backend: `go test ./...`
- Frontend: `npm run build`

## Notes

- This is the first tagged stable release for the current architecture on `main`.
- Existing local data/session state can affect perceived admin ownership until active sessions refresh.
