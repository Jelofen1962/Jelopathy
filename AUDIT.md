# Jelopathy implementation audit

This report describes changes in this source pack and what still requires validation. Static source review and Python unit tests were performed; the full desktop build could not be verified in this environment because dependency installation timed out and Rust/Cargo was unavailable.

## Existing feature inventory

- Tauri 2 desktop application with React 19, TypeScript, Vite and Tailwind CSS v4.
- Local SQLite storage for messages, indexed by room/time; local JSON profile persistence.
- Room-based live messaging using HTTP POST and Server-Sent Events.
- Text and image messages, image conversion/resizing to WebP, typing status and online peer display.
- Persian/RTL text, mixed-direction English/code content, inline code, fenced code blocks, copy/collapse controls, and scroll/history controls.
- Join-request poll UI and a 70% positive-vote admission rule.
- Python ASGI relay with in-memory connection state, SSE heartbeat, optional `uvloop` and `orjson`.
- GitHub Actions release workflow for Windows and Linux.

## Fixes applied in this pack

### UI and accessibility
- Reworked the global visual tokens and neutral palette into a dark indigo/mint design system with clearer surface hierarchy, more polished inputs, buttons, message bubbles, overlays and responsive behavior.
- Increased the default desktop window to a practical chat size and made it resizable.
- Replaced the old filled icon glyphs with compact inline Lucide-style SVGs and subtle motion. The app does not execute remote icon JavaScript at runtime, keeping packaged builds usable offline and reducing CDN supply-chain risk. The Lucide Animated site is documented as the design reference.
- Added connection status, admission-pending feedback, active error feedback and reduced-motion handling.
- Updated the document title, language and metadata.

### Client correctness
- Uses `crypto.randomUUID()` for profile/message IDs.
- Catches malformed SSE JSON instead of letting it break event processing.
- Checks HTTP status codes and reports failed relay requests.
- Adds a configurable access-token field and sends the token to the relay.
- Adds image MIME/size checks before reading the file.
- Cleans up EventSource connections, session state, room state and status timers on exit/unmount.
- Adds a private admission lobby flow: a candidate waits in a lobby stream, requests access, and only connects to the target room after approval. Message sending and image upload are disabled while waiting.
- Sends the correct `sender_id` for votes.

### Relay security and reliability
- Added shared-token authentication support. The installer generates a strong token and refuses a public bind without one.
- Added per-SSE session tokens and validates that POST sender IDs and room IDs match the live session. Nested chat messages are also checked against the authenticated session envelope.
- Enforces room admission before a normal room SSE connection is registered.
- Corrected empty-room approval delivery and routes join results back to the candidate's lobby connection.
- Added vote deduplication, eligibility checks, a deterministic 70% threshold, rejection when approval becomes impossible, and poll expiry/cleanup.
- Added request-body and message-size limits, content-type checks, request rate limiting, origin allowlisting, safer error handling, and `/health`.
- Avoids broad silent exception swallowing in the SSE loop.
- Added `server/install.sh`, `server/install.ps1`, requirements, and `.env.example` for a one-command relay setup.

### Rust/local storage
- Database initialization now returns a useful error instead of panicking at each setup operation.
- Message pagination clamps limits and offsets; row-read errors are surfaced instead of silently dropped.
- Profile replacement uses a temporary file and backup fallback to handle Windows rename semantics more safely.
- Image conversion rejects oversized encoded inputs before decoding.

### Build and release
- Git tag release workflow builds a Windows portable EXE, NSIS installer, and Linux x86_64 AppImage on platform-specific runners.
- Release assets are named using the actual version tag and include SHA-256 checksums and generated release notes.
- Added setup and release documentation.

## Remaining limitations / follow-up work

1. **Full build validation:** run `npm ci`, `npm run build`, `cargo check`, and a real tag build on GitHub Actions. These could not be completed in this environment.
2. **Identity model:** shared-token authentication is service-level access control, not user account authentication. A user ID is initially self-asserted. Use account/device authentication or cryptographically bound identity keys before relying on identity for sensitive rooms.
3. **TLS:** deploy behind HTTPS. Do not expose the relay's plain HTTP listener directly to the public internet.
4. **Membership persistence:** approved users and active polls are in-memory. A server restart clears them. Add a persistent membership database if long-lived room access is required.
5. **End-to-end encryption:** messages are not end-to-end encrypted. Do not claim E2EE or absolute metadata privacy.
6. **Storage privacy:** local SQLite/profile files are not encrypted by this patch. Consider OS keychain integration and local database encryption if threat model requires it.
7. **History sync:** current sync still broadcasts a request and can send up to 500 messages per response. Replace with targeted, cursor-based synchronization to reduce traffic and exposure.
8. **Delivery guarantees:** POST acceptance is not a delivery receipt. Add message IDs/idempotency, server acknowledgements, retry queue and pending/sent/failed UI states.
9. **Image transport:** images are base64 payloads. Limits are in place, but a dedicated binary upload or object store is more efficient at scale.
10. **Testing:** five Python relay unit tests are included. Add ASGI integration tests, frontend component tests, Rust tests, fuzzing and security review before public deployment.
11. **Release signing:** Windows code signing, macOS signing/notarization, SBOM and build provenance are not included. macOS artifacts are not built by the current workflow.
12. **Lucide Animated integration:** the current build uses local inline Lucide-style SVG paths with CSS motion rather than an unverified remote icon bundle. If the exact Lucide Animated package/API is desired, integrate it as a pinned dependency after confirming its official installation instructions, not as an unrestricted runtime script.

## Validation performed

- `python -m py_compile server/server.py server/tests/test_server.py`: passed.
- `python -m unittest discover -s server/tests -v`: 5 tests passed.
- `npm ci`: timed out while installing dependencies in this environment.
- `npm run build`: could not pass because the interrupted install left incomplete `node_modules` type packages.
- `cargo fmt` / `cargo check`: unavailable because Cargo is not installed in this environment.


## Automatic release correction

The release workflow no longer calls `scripts/set_version.py`, so a missing/untracked script cannot fail the release. The `create-tag` job calculates the next stable semantic version from existing `vMAJOR.MINOR.PATCH` tags, updates package/Cargo/Tauri version metadata inline, commits the version bump, creates and pushes the tag, and passes that tag to the Windows and Linux build jobs. Pushes to `main`/`master` automatically create patch releases; manual workflow dispatch supports patch/minor/major. The workflow does not listen for tag pushes, avoiding a recursive release loop.
