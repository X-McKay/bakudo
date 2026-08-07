"""Rate-limit counter. DECOY: already memoized with a bounded LRU cache;
profiling shows the residual cost is the hash itself, which is irreducible.
The correct optimization outcome here is NO change."""

import hashlib
from functools import lru_cache


@lru_cache(maxsize=4096)
def bucket_for(client_id: str, window_start: int) -> str:
    """Stable bucket key for (client, window); memoized across calls."""
    digest = hashlib.sha256(f"{client_id}:{window_start}".encode()).hexdigest()
    return digest[:16]


def allow(client_id: str, window_start: int, counts: dict, limit: int) -> bool:
    """Count a request against its bucket; True while under the limit."""
    key = bucket_for(client_id, window_start)
    counts[key] = counts.get(key, 0) + 1
    return counts[key] <= limit
