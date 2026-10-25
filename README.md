# Jelopathy

A local-first desktop messenger built with **Tauri 2, React, TypeScript, Tailwind CSS v4, Rust and SQLite**, with a small Python relay for live room events.

> **Security note:** The relay is not end-to-end encrypted. Use HTTPS/TLS when traffic crosses an untrusted network. The server stores live events and connected clients in memory; it cannot promise that hosting providers, reverse proxies, or endpoints retain no metadata.

## Features

- Local SQLite message history and locally stored profile.
- Real-time room messages via Server-Sent Events and HTTP POST.
- Text, images converted/resized to WebP, typing status and peer presence.
- RTL/Persian-friendly interface with mixed-direction text and code blocks.
- Tailwind-based dark interface with subtle animated icon interactions and reduced-motion support.
- Relay shared access token plus per-SSE session tokens, sender/session binding, room admission before joining a room, bounded request sizes, basic rate limiting, origin checks, health endpoint and safer JSON validation.
- Windows portable executable and installer plus Linux AppImage release workflow.

## Run the desktop app

Requirements: Node.js 22+, Rust stable, and the Tauri platform prerequisites for your OS.

```bash
npm ci
npm run tauri dev
```

Production build:

```bash
npm run tauri build
```

## Install and run one relay server

### Linux

From the repository root, run this one command:

```bash
bash server/install.sh
```

The script creates a Python virtual environment, installs dependencies, creates `server/.env` with a generated secret token, and starts the relay. Keep `server/.env` private. The script runs the service in the foreground; use a service manager or container orchestrator for production uptime.

### Windows PowerShell

```powershell
.\server\install.ps1
```

Requirements: Python 3.10+. The first run generates `server/.env` and starts the server. The token is required by the desktop client when authentication is enabled.

### Desktop connection settings

- **Server URL:** `http://YOUR_SERVER_IP:8080`
- **Access token:** copy `JELOPATHY_SERVER_TOKEN` from `server/.env`
- **Room code:** choose the same room code as the other participants

For local-only development, run `python server/server.py` without setting a token. The relay binds to `127.0.0.1` by default. It refuses a public `0.0.0.0` bind if no token is configured.

Check health from the server machine:

```bash
curl http://127.0.0.1:8080/health
```

**Production deployment:** Put the relay behind HTTPS/TLS, configure a firewall, rotate tokens if exposed, and restrict inbound access. Do not expose the raw HTTP listener directly to the public internet. The token is a shared access secret, not user identity or end-to-end encryption.

## Automatic tag and release

Every push to `main` or `master` automatically increments the patch version, updates the project version files, commits that version bump, creates and pushes a new `vMAJOR.MINOR.PATCH` tag, builds Windows and Linux packages, and publishes a GitHub Release. No manual tag is needed.

For a deliberate minor or major version increment, open **Actions → Auto Tag, Build and Publish Jelopathy → Run workflow** and select `minor` or `major`. The default is `patch`.

The workflow needs repository **Contents: Read and write** permission. If the default branch is protected, allow GitHub Actions to push version-bump commits or adapt the workflow to tag the commit without pushing the version bump. The workflow intentionally has no tag-push trigger, preventing a release loop.

The workflow synchronizes the app, Rust and npm package versions, then publishes:

- `Jelopathy-vX.Y.Z-windows-x64-portable.exe`
- `Jelopathy-vX.Y.Z-windows-x64-setup.exe`
- `Jelopathy-vX.Y.Z-linux-x86_64.AppImage`
- `SHA256SUMS.txt`

The first release should be treated as a validation run. macOS artifacts are not currently built.

## Tests

Python relay tests:

```bash
python -m unittest discover -s server/tests -v
```

Desktop build/type check:

```bash
npm ci
npm run build
```

## Security and architecture limitations

- The relay's shared token controls access to the service but does not authenticate each human user independently. Per-connection session tokens prevent a client from simply changing the sender ID in a POST, but a user ID is still initially self-asserted. Add real account/device authentication before using it for sensitive groups.
- Room IDs are not cryptographic secrets. Admission is enforced before the normal room SSE connection opens, and approvals are held in memory only. After a relay restart, members must rejoin; add persistent membership and signed invites if this is needed for production.
- Messages are not end-to-end encrypted. Do not advertise E2EE or absolute zero metadata retention.
- The UI uses inline SVG icon paths with CSS micro-animation rather than loading third-party icon JavaScript at runtime. This avoids a remote CDN becoming a runtime dependency; the Lucide Animated catalogue can be used as a design/reference source at https://lucide-animated.com/.
