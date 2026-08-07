"""Webhook fan-out. PLANTED: unbatched — a connection is set up (and torn
down) per event even when consecutive events target the same endpoint;
group by endpoint and reuse the connection."""

import hashlib


class Transport:
    """Fake HTTP transport with a deliberately expensive connection setup."""

    def __init__(self):
        self.connections_opened = 0
        self.sent = []

    def connect(self, endpoint):
        self.connections_opened += 1
        # Simulate TLS/session setup cost, deterministically.
        digest = endpoint.encode()
        for _ in range(600):
            digest = hashlib.sha256(digest).digest()
        return _Connection(self, endpoint)


class _Connection:
    def __init__(self, transport, endpoint):
        self._transport = transport
        self.endpoint = endpoint

    def send(self, event):
        self._transport.sent.append((self.endpoint, event["id"]))

    def close(self):
        pass


def fan_out(transport, events):
    """Deliver each event to its endpoint. Returns the delivery count."""
    delivered = 0
    for event in events:
        connection = transport.connect(event["endpoint"])
        connection.send(event)
        connection.close()
        delivered += 1
    return delivered
