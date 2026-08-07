import asyncio
import time
from urllib.parse import parse_qs
from dataclasses import dataclass, field
from typing import Dict, Set, Optional, Any

# Graceful Fallback for Event Loop (uvloop)
try:
    import uvloop
    uvloop.install()
except ImportError:
    pass

# Graceful Fallback for Fast JSON Parser (orjson)
try:
    import orjson as json
    def json_dumps(data: Any) -> bytes:
        return json.dumps(data)
    def json_loads(data: bytes | str) -> dict:
        return json.loads(data)
except ImportError:
    import json
    def json_dumps(data: Any) -> bytes:
        return json.dumps(data).encode('utf-8')
    def json_loads(data: bytes | str) -> dict:
        return json.loads(data)


@dataclass(slots=True)
class UserProfile:
    id: str = ""
    name: str = ""
    photo_b64: str = ""
    color: str = ""

    def to_dict(self) -> dict:
        d = {"id": self.id, "name": self.name, "color": self.color}
        if self.photo_b64:
            d["photo_b64"] = self.photo_b64
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "UserProfile":
        if not isinstance(d, dict):
            return cls()
        return cls(
            id=d.get("id", ""),
            name=d.get("name", ""),
            photo_b64=d.get("photo_b64", ""),
            color=d.get("color", "")
        )


class Client:
    __slots__ = ('id', 'user_id', 'room_id', 'user', 'send_queue')

    def __init__(self, client_id: str, user_id: str, room_id: str):
        self.id = client_id
        self.user_id = user_id
        self.room_id = room_id
        self.user = UserProfile()
        self.send_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=256)


@dataclass(slots=True)
class Poll:
    poll_id: str
    room_id: str
    candidate_id: str
    candidate_name: str
    yes_votes: int
    total_votes: int
    votes_cast: set = field(default_factory=set)
    active: bool = True

    def to_dict(self) -> dict:
        return {
            "poll_id": self.poll_id,
            "room_id": self.room_id,
            "candidate_id": self.candidate_id,
            "candidate_name": self.candidate_name,
            "yes_votes": self.yes_votes,
            "total_votes": self.total_votes,
            "active": self.active,
        }


class Hub:
    def __init__(self):
        self.rooms: Dict[str, Set[Client]] = {}
        self.polls: Dict[str, Poll] = {}

    def broadcast_room_peers(self, room_id: str):
        if not room_id or room_id not in self.rooms:
            return
        room_clients = self.rooms[room_id]

        # De-duplicate online users by user ID
        unique_peers: Dict[str, dict] = {}
        for c in room_clients:
            if c.user.id:
                unique_peers[c.user.id] = c.user.to_dict()

        peers = list(unique_peers.values())

        peer_msg = {
            "type": "room_peers",
            "room_id": room_id,
            "peers": peers
        }
        data = json_dumps(peer_msg)

        for c in list(room_clients):
            self._safe_send(c, data)

    def register(self, client: Client):
        if client.room_id not in self.rooms:
            self.rooms[client.room_id] = set()

        # Clean up lingering stale connections for the same user_id in this room
        stale_clients = [c for c in self.rooms[client.room_id] if c.user_id == client.user_id and c.id != client.id]
        for stale in stale_clients:
            self.rooms[client.room_id].discard(stale)

        self.rooms[client.room_id].add(client)
        self.broadcast_room_peers(client.room_id)

    def unregister(self, client: Client):
        old_room = client.room_id
        if old_room in self.rooms:
            room_clients = self.rooms[old_room]
            if client in room_clients:
                room_clients.remove(client)
                if not room_clients:
                    del self.rooms[old_room]
                else:
                    self.broadcast_room_peers(old_room)

    def _safe_send(self, client: Client, data: bytes):
        """Attempts non-blocking send; drops client if send buffer is full."""
        try:
            client.send_queue.put_nowait(data)
        except asyncio.QueueFull:
            self.unregister(client)

    def handle_broadcast(self, msg: dict):
        msg_type = msg.get("type")
        room_id = msg.get("room_id", "")
        sender_id = msg.get("sender_id", "")

        if msg_type == "join_room":
            pass
        elif msg_type == "request_join":
            room_clients = self.rooms.get(room_id, set())
            total = len(room_clients)

            if total == 0:
                resp = {
                    "type": "poll_result",
                    "room_id": room_id,
                    "accepted": True,
                    "candidate_id": sender_id
                }
                b = json_dumps(resp)
                for c in self.rooms.get("", set()):
                    if c.user_id == sender_id:
                        self._safe_send(c, b)
            else:
                poll_id = f"poll_{room_id}_{sender_id}"
                poll = Poll(
                    poll_id=poll_id,
                    room_id=room_id,
                    candidate_id=sender_id,
                    candidate_name=msg.get("sender_name", ""),
                    yes_votes=0,
                    total_votes=total,
                    votes_cast=set(),
                    active=True
                )
                self.polls[poll_id] = poll

                poll_msg = {
                    "type": "join_request_poll",
                    "room_id": room_id,
                    "poll": poll.to_dict()
                }
                pb = json_dumps(poll_msg)
                for c in room_clients:
                    self._safe_send(c, pb)

        elif msg_type == "vote_cast":
            poll_id = msg.get("poll_id", "")
            poll = self.polls.get(poll_id)

            if poll and poll.active:
                if sender_id not in poll.votes_cast:
                    poll.votes_cast.add(sender_id)
                    if msg.get("vote"):
                        poll.yes_votes += 1

                    ratio = poll.yes_votes / poll.total_votes
                    if ratio >= 0.70:
                        poll.active = False
                        result_msg = {
                            "type": "poll_result",
                            "room_id": poll.room_id,
                            "accepted": True,
                            "candidate_id": poll.candidate_id
                        }
                        rb = json_dumps(result_msg)
                        for c in self.rooms.get(poll.room_id, set()):
                            self._safe_send(c, rb)

        else:
            data = json_dumps(msg)
            room_clients = self.rooms.get(room_id, set())
            for c in list(room_clients):
                self._safe_send(c, data)

    def process_send(self, msg: dict):
        msg_type = msg.get("type")
        room_id = msg.get("room_id", "")
        sender_id = msg.get("sender_id", "")
        user_data = msg.get("user")

        if msg_type == "join_room" and user_data:
            user_prof = UserProfile.from_dict(user_data)
            room_clients = self.rooms.get(room_id, set())
            for c in room_clients:
                if c.user_id == sender_id:
                    c.user = user_prof
            self.broadcast_room_peers(room_id)

        self.handle_broadcast(msg)


hub = Hub()


# Raw ASGI Application Handler
async def app(scope, receive, send):
    if scope["type"] != "http":
        return

    path = scope["path"]
    method = scope["method"]

    # --- HTTP SSE Endpoint: GET /events ---
    if path == "/events" and method == "GET":
        query_string = scope.get("query_string", b"").decode("utf-8")
        parsed_query = parse_qs(query_string)
        room_id = parsed_query.get("room_id", [""])[0]
        user_id = parsed_query.get("user_id", [""])[0]

        client = Client(
            client_id=f"{user_id}_{time.time_ns()}",
            user_id=user_id,
            room_id=room_id
        )
        hub.register(client)

        headers = [
            (b"access-control-allow-origin", b"*"),
            (b"content-type", b"text/event-stream"),
            (b"cache-control", b"no-cache"),
            (b"connection", b"keep-alive"),
        ]

        await send({
            "type": "http.response.start",
            "status": 200,
            "headers": headers,
        })

        try:
            while True:
                try:
                    msg = await asyncio.wait_for(client.send_queue.get(), timeout=15.0)
                    chunk = b"data: " + msg + b"\n\n"
                    await send({
                        "type": "http.response.body",
                        "body": chunk,
                        "more_body": True,
                    })
                except asyncio.TimeoutError:
                    await send({
                        "type": "http.response.body",
                        "body": b": heartbeat\n\n",
                        "more_body": True,
                    })
        except (asyncio.CancelledError, Exception):
            pass
        finally:
            hub.unregister(client)
        return

    # --- HTTP POST Endpoint: POST /send ---
    if path == "/send":
        headers = [
            (b"access-control-allow-origin", b"*"),
            (b"access-control-allow-headers", b"Content-Type"),
        ]

        if method == "OPTIONS":
            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": headers,
            })
            await send({"type": "http.response.body", "body": b""})
            return

        if method != "POST":
            await send({
                "type": "http.response.start",
                "status": 405,
                "headers": headers,
            })
            await send({"type": "http.response.body", "body": b"Method not allowed"})
            return

        body = bytearray()
        while True:
            message = await receive()
            body.extend(message.get("body", b""))
            if not message.get("more_body", False):
                break

        try:
            msg = json_loads(body)
        except Exception:
            await send({
                "type": "http.response.start",
                "status": 400,
                "headers": headers,
            })
            await send({"type": "http.response.body", "body": b"Invalid JSON"})
            return

        hub.process_send(msg)

        await send({
            "type": "http.response.start",
            "status": 200,
            "headers": headers,
        })
        await send({"type": "http.response.body", "body": b""})
        return

    # Fallback 404
    await send({
        "type": "http.response.start",
        "status": 404,
        "headers": [],
    })
    await send({"type": "http.response.body", "body": b"Not Found"})


if __name__ == "__main__":
    import uvicorn
    print("Jelopathy Standard HTTP SSE/POST Relay Server listening on :8080...")
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8080,
        loop="auto",
        http="auto",
        access_log=False
    )
