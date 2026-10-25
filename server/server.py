"""Jelopathy ephemeral relay.

The relay keeps live connections/messages in memory only. Local chat history is stored by
clients. Set JELOPATHY_SERVER_TOKEN before exposing this service to a network.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from urllib.parse import parse_qs
from typing import Any

try:
    import uvloop  # type: ignore
    uvloop.install()
except ImportError:
    pass

try:
    import orjson  # type: ignore
    def dumps(value: Any) -> bytes:
        return orjson.dumps(value)
    def loads(value: bytes) -> Any:
        return orjson.loads(value)
except ImportError:
    def dumps(value: Any) -> bytes:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    def loads(value: bytes) -> Any:
        return json.loads(value.decode("utf-8"))

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("jelopathy-relay")
MAX_BODY_BYTES = int(os.getenv("JELOPATHY_MAX_BODY_BYTES", str(12 * 1024 * 1024)))
MAX_FIELD_CHARS = 100_000
POLL_TTL_SECONDS = 90
RATE_LIMIT_PER_MINUTE = 240
TOKEN = os.getenv("JELOPATHY_SERVER_TOKEN", "").strip()
ALLOWED_ORIGINS = {
    "http://localhost:1420", "http://127.0.0.1:1420",
    "tauri://localhost", "https://tauri.localhost", "http://tauri.localhost",
}

@dataclass(slots=True, eq=False)
class Client:
    id: str
    user_id: str
    room_id: str
    user: dict[str, str] = field(default_factory=dict)
    session_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    send_queue: asyncio.Queue[bytes] = field(default_factory=lambda: asyncio.Queue(maxsize=256))

@dataclass(slots=True)
class Poll:
    poll_id: str
    room_id: str
    candidate_id: str
    candidate_name: str
    total_votes: int
    expires_at: float
    votes: dict[str, bool] = field(default_factory=dict)
    active: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "poll_id": self.poll_id, "room_id": self.room_id,
            "candidate_id": self.candidate_id, "candidate_name": self.candidate_name,
            "yes_votes": sum(self.votes.values()), "total_votes": self.total_votes,
            "active": self.active,
        }

class Hub:
    def __init__(self) -> None:
        self.rooms: dict[str, set[Client]] = defaultdict(set)
        self.polls: dict[str, Poll] = {}
        self.approved_users: dict[str, set[str]] = defaultdict(set)
        self.rate_events: dict[str, deque[float]] = defaultdict(deque)

    def register(self, client: Client) -> None:
        # Replace stale connections for the same user in this room.
        for old in list(self.rooms[client.room_id]):
            if old.user_id and old.user_id == client.user_id:
                self.unregister(old)
        self.rooms[client.room_id].add(client)
        self.safe_send(client, dumps({"type": "session", "session_token": client.session_token}))
        self.broadcast_peers(client.room_id)

    def unregister(self, client: Client) -> None:
        clients = self.rooms.get(client.room_id)
        if clients and client in clients:
            clients.discard(client)
            if not clients:
                self.rooms.pop(client.room_id, None)
            else:
                self.broadcast_peers(client.room_id)

    def safe_send(self, client: Client, payload: bytes) -> None:
        try:
            client.send_queue.put_nowait(payload)
        except asyncio.QueueFull:
            log.warning("Disconnecting slow client from room %s", client.room_id[:64])
            self.unregister(client)

    def send_room(self, room_id: str, payload: dict[str, Any]) -> None:
        encoded = dumps(payload)
        for client in list(self.rooms.get(room_id, set())):
            self.safe_send(client, encoded)

    def send_user(self, user_id: str, payload: dict[str, Any]) -> None:
        encoded = dumps(payload)
        for clients in list(self.rooms.values()):
            for client in list(clients):
                if client.user_id == user_id:
                    self.safe_send(client, encoded)

    def find_session(self, token: str) -> Client | None:
        if not token:
            return None
        for clients in self.rooms.values():
            for client in clients:
                if secrets.compare_digest(client.session_token, token):
                    return client
        return None

    def broadcast_peers(self, room_id: str) -> None:
        clients = self.rooms.get(room_id, set())
        unique: dict[str, dict[str, str]] = {}
        for client in clients:
            if client.user.get("id"):
                unique[client.user["id"]] = client.user
        self.send_room(room_id, {"type": "room_peers", "room_id": room_id, "peers": list(unique.values())})

    async def expire_poll(self, poll_id: str) -> None:
        await asyncio.sleep(POLL_TTL_SECONDS)
        poll = self.polls.get(poll_id)
        if poll and poll.active and time.monotonic() >= poll.expires_at:
            poll.active = False
            result = {"type": "poll_result", "room_id": poll.room_id, "accepted": False, "candidate_id": poll.candidate_id, "reason": "expired"}
            self.send_room(poll.room_id, result)
            self.send_user(poll.candidate_id, result)
            self.polls.pop(poll_id, None)

    def rate_ok(self, client_ip: str) -> bool:
        now = time.monotonic()
        events = self.rate_events[client_ip]
        while events and now - events[0] > 60:
            events.popleft()
        if len(events) >= RATE_LIMIT_PER_MINUTE:
            return False
        events.append(now)
        return True

    def handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        room_id = msg.get("room_id", "")
        sender_id = msg.get("sender_id", "")
        if kind == "join_room":
            user = msg.get("user")
            if isinstance(user, dict):
                for client in self.rooms.get(room_id, set()):
                    if client.user_id == sender_id:
                        client.user = {
                            "id": str(user.get("id", ""))[:128],
                            "name": str(user.get("name", ""))[:80],
                            "color": str(user.get("color", ""))[:32],
                        }
                        photo = user.get("photo_b64")
                        if isinstance(photo, str) and len(photo) <= 3_000_000:
                            client.user["photo_b64"] = photo
                self.broadcast_peers(room_id)
            self.send_room(room_id, msg)
            return

        if kind == "request_join":
            room_clients = self.rooms.get(room_id, set())
            # Candidate remains in a private lobby SSE stream until the room approves them.
            if not sender_id:
                return
            existing_poll = next((p for p in self.polls.values() if p.active and p.room_id == room_id and p.candidate_id == sender_id), None)
            if existing_poll:
                self.send_room(room_id, {"type": "join_request_poll", "room_id": room_id, "poll": existing_poll.to_dict()})
                return
            poll_id = f"poll_{secrets.token_urlsafe(18)}"
            if not room_clients:
                self.approved_users[room_id].add(sender_id)
                self.send_user(sender_id, {"type": "poll_result", "room_id": room_id, "accepted": True, "candidate_id": sender_id})
                return
            poll = Poll(
                poll_id=poll_id, room_id=room_id, candidate_id=sender_id,
                candidate_name=str(msg.get("sender_name", "Guest"))[:80],
                total_votes=len(room_clients), expires_at=time.monotonic() + POLL_TTL_SECONDS,
            )
            self.polls[poll_id] = poll
            try:
                asyncio.get_running_loop().create_task(self.expire_poll(poll_id))
            except RuntimeError:
                # Unit-test or embedded synchronous use has no event loop; production ASGI does.
                pass
            self.send_room(room_id, {"type": "join_request_poll", "room_id": room_id, "poll": poll.to_dict()})
            return

        if kind == "vote_cast":
            poll = self.polls.get(str(msg.get("poll_id", "")))
            voter_id = sender_id
            if not poll or not poll.active or not voter_id or voter_id == poll.candidate_id:
                return
            if not any(client.user_id == voter_id for client in self.rooms.get(poll.room_id, set())):
                return
            if time.monotonic() >= poll.expires_at:
                poll.active = False
                self.send_room(poll.room_id, {"type": "poll_result", "room_id": poll.room_id, "accepted": False, "candidate_id": poll.candidate_id, "reason": "expired"})
                self.send_user(poll.candidate_id, {"type": "poll_result", "room_id": poll.room_id, "accepted": False, "candidate_id": poll.candidate_id, "reason": "expired"})
                self.polls.pop(poll.poll_id, None)
                return
            if voter_id in poll.votes:
                return
            poll.votes[voter_id] = bool(msg.get("vote"))
            yes = sum(poll.votes.values())
            no = len(poll.votes) - yes
            required = max(1, (poll.total_votes * 70 + 99) // 100)
            if yes >= required:
                poll.active = False
                self.approved_users[poll.room_id].add(poll.candidate_id)
                self.send_room(poll.room_id, {"type": "poll_result", "room_id": poll.room_id, "accepted": True, "candidate_id": poll.candidate_id})
                self.send_user(poll.candidate_id, {"type": "poll_result", "room_id": poll.room_id, "accepted": True, "candidate_id": poll.candidate_id})
                self.polls.pop(poll.poll_id, None)
            elif no > poll.total_votes - required or len(poll.votes) >= poll.total_votes:
                poll.active = False
                self.send_room(poll.room_id, {"type": "poll_result", "room_id": poll.room_id, "accepted": False, "candidate_id": poll.candidate_id})
                self.send_user(poll.candidate_id, {"type": "poll_result", "room_id": poll.room_id, "accepted": False, "candidate_id": poll.candidate_id})
                self.polls.pop(poll.poll_id, None)
            else:
                self.send_room(poll.room_id, {"type": "join_request_poll", "room_id": poll.room_id, "poll": poll.to_dict()})
            return

        # Only broadcast well-formed room messages and small control events.
        if room_id:
            self.send_room(room_id, msg)

hub = Hub()

def response(status: int, body: bytes = b"", headers: list[tuple[bytes, bytes]] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    base = [(b"content-type", b"text/plain; charset=utf-8"), (b"cache-control", b"no-store")]
    return {"type": "http.response.start", "status": status, "headers": base + (headers or [])}, {"type": "http.response.body", "body": body}

def authorized(scope: dict[str, Any], query: dict[str, list[str]]) -> bool:
    if not TOKEN:
        return True
    if query.get("token", [""])[0] == TOKEN:
        return True
    headers = {k.lower(): v for k, v in scope.get("headers", [])}
    auth = headers.get(b"authorization", b"").decode("latin1")
    return secrets.compare_digest(auth.removeprefix("Bearer "), TOKEN)

async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
    if scope.get("type") != "http":
        return
    path, method = scope.get("path", "/"), scope.get("method", "GET")
    query = parse_qs(scope.get("query_string", b"").decode("utf-8", "replace"))
    origin = dict(scope.get("headers", [])).get(b"origin", b"").decode("latin1")
    cors: list[tuple[bytes, bytes]] = []
    if origin in ALLOWED_ORIGINS:
        cors = [(b"access-control-allow-origin", origin.encode("latin1")), (b"vary", b"Origin")]
    cors += [(b"access-control-allow-headers", b"Authorization, Content-Type"), (b"access-control-allow-methods", b"GET, POST, OPTIONS")]

    if path == "/health" and method == "GET":
        start, body = response(200, b'{"status":"ok","storage":"memory-only"}', [(b"content-type", b"application/json")])
        await send(start); await send(body); return

    if method == "OPTIONS" and path == "/send":
        start, body = response(204, b"", cors)
        await send(start); await send(body); return

    if path == "/events" and method == "GET":
        if origin and origin not in ALLOWED_ORIGINS:
            start, body = response(403, b"Origin not allowed", cors)
            await send(start); await send(body); return
        if not authorized(scope, query):
            start, body = response(401, b"Unauthorized", cors)
            await send(start); await send(body); return
        room_id = query.get("room_id", [""])[0].strip()
        user_id = query.get("user_id", [""])[0].strip()
        if not room_id or len(room_id) > 128 or len(user_id) > 128:
            start, body = response(400, b"Invalid room or user id", cors)
            await send(start); await send(body); return
        # Normal rooms require explicit admission. New users first connect to __join__:<room>.
        if not room_id.startswith("__join__:") and user_id not in hub.approved_users.get(room_id, set()):
            start, body = response(403, b"Room admission required", cors)
            await send(start); await send(body); return
        client = Client(id=f"{user_id}_{time.time_ns()}", user_id=user_id, room_id=room_id)
        hub.register(client)
        headers = cors + [(b"content-type", b"text/event-stream"), (b"cache-control", b"no-cache, no-transform"), (b"x-accel-buffering", b"no")]
        await send({"type": "http.response.start", "status": 200, "headers": headers})
        try:
            while True:
                try:
                    data = await asyncio.wait_for(client.send_queue.get(), timeout=15)
                    await send({"type": "http.response.body", "body": b"data: " + data + b"\n\n", "more_body": True})
                except asyncio.TimeoutError:
                    await send({"type": "http.response.body", "body": b": heartbeat\n\n", "more_body": True})
        except (asyncio.CancelledError, ConnectionError, OSError):
            pass
        except Exception:
            log.exception("Unexpected SSE failure")
        finally:
            hub.unregister(client)
        return

    if path == "/send":
        if method != "POST":
            start, body = response(405, b"Method not allowed", cors)
            await send(start); await send(body); return
        if origin and origin not in ALLOWED_ORIGINS:
            start, body = response(403, b"Origin not allowed", cors)
            await send(start); await send(body); return
        if not authorized(scope, query):
            start, body = response(401, b"Unauthorized", cors)
            await send(start); await send(body); return
        client_ip = str(scope.get("client", ("unknown", 0))[0])
        if not hub.rate_ok(client_ip):
            start, body = response(429, b"Rate limit exceeded", cors)
            await send(start); await send(body); return
        content_length = dict(scope.get("headers", [])).get(b"content-length", b"0")
        try:
            if int(content_length or b"0") > MAX_BODY_BYTES:
                start, body = response(413, b"Payload too large", cors)
                await send(start); await send(body); return
        except ValueError:
            start, body = response(400, b"Invalid content length", cors)
            await send(start); await send(body); return
        body_buffer = bytearray()
        while True:
            chunk = await receive()
            body_buffer.extend(chunk.get("body", b""))
            if len(body_buffer) > MAX_BODY_BYTES:
                start, body = response(413, b"Payload too large", cors)
                await send(start); await send(body); return
            if not chunk.get("more_body", False):
                break
        try:
            msg = loads(bytes(body_buffer))
        except (ValueError, TypeError, UnicodeDecodeError):
            start, body = response(400, b"Invalid JSON", cors)
            await send(start); await send(body); return
        if not isinstance(msg, dict):
            start, body = response(400, b"JSON body must be an object", cors)
            await send(start); await send(body); return
        kind = msg.get("type")
        room_id = msg.get("room_id", "")
        sender_id = msg.get("sender_id", "")
        if not sender_id and isinstance(msg.get("message"), dict):
            sender_id = msg["message"].get("sender_id", "")
            msg["sender_id"] = sender_id
        session_header = dict(scope.get("headers", [])).get(b"x-jelopathy-session", b"").decode("latin1")
        session_client = hub.find_session(session_header)
        if session_client is None:
            start, body = response(401, b"Valid client session required", cors)
            await send(start); await send(body); return
        if not isinstance(sender_id, str) or not sender_id or sender_id != session_client.user_id:
            start, body = response(403, b"Sender identity does not match this session", cors)
            await send(start); await send(body); return
        if not isinstance(room_id, str) or not isinstance(kind, str):
            start, body = response(400, b"Invalid event envelope", cors)
            await send(start); await send(body); return
        if kind == "request_join":
            if session_client.room_id != f"__join__:{room_id}":
                start, body = response(403, b"Join requests must originate from the room lobby", cors)
                await send(start); await send(body); return
        elif session_client.room_id != room_id:
            start, body = response(403, b"Session is not connected to this room", cors)
            await send(start); await send(body); return
        if kind not in {"join_room", "request_join", "vote_cast", "chat_message", "sync_request", "sync_response", "typing", "sending_image"}:
            start, body = response(400, b"Unsupported event type", cors)
            await send(start); await send(body); return
        if not isinstance(kind, str) or not re.fullmatch(r"[a-z_]{1,40}", kind):
            start, body = response(400, b"Invalid event type", cors)
            await send(start); await send(body); return
        if not isinstance(room_id, str) or len(room_id) > 128 or not isinstance(sender_id, str) or len(sender_id) > 128:
            start, body = response(400, b"Invalid room or sender id", cors)
            await send(start); await send(body); return
        if kind == "chat_message":
            nested = msg.get("message")
            if not isinstance(nested, dict) or nested.get("sender_id") != session_client.user_id or nested.get("room_id") != room_id:
                start, body = response(403, b"Message identity or room mismatch", cors)
                await send(start); await send(body); return
        # Protect the relay from arbitrarily large nested text/base64 fields.
        nested_message = msg.get("message") if isinstance(msg.get("message"), dict) else {}
        content = nested_message.get("content", msg.get("content", ""))
        message_type = nested_message.get("msg_type", msg.get("msg_type", "text"))
        content_limit = MAX_BODY_BYTES if message_type == "image" else MAX_FIELD_CHARS
        if not isinstance(content, str) or len(content) > content_limit:
            start, body = response(413, b"Message content too large", cors)
            await send(start); await send(body); return
        if kind == "chat_message" and message_type not in {"text", "image", "code"}:
            start, body = response(400, b"Unsupported message type", cors)
            await send(start); await send(body); return
        hub.handle(msg)
        start, body = response(202, b"", cors)
        await send(start); await send(body); return

    start, body = response(404, b"Not found", cors)
    await send(start); await send(body)

if __name__ == "__main__":
    import uvicorn
    host = os.getenv("JELOPATHY_HOST", "127.0.0.1")
    port = int(os.getenv("JELOPATHY_PORT", "8080"))
    if host not in {"127.0.0.1", "localhost", "0.0.0.0", "::"}:
        raise SystemExit("JELOPATHY_HOST must be a valid bind address")
    if host in {"0.0.0.0", "::"} and not TOKEN:
        raise SystemExit("Refusing public bind without JELOPATHY_SERVER_TOKEN. Set a strong token first.")
    log.info("Jelopathy relay starting on %s:%s; token_auth=%s", host, port, bool(TOKEN))
    uvicorn.run(app, host=host, port=port, loop="auto", access_log=False, server_header=False)
