# Investigation notes

Support has flagged stale lookups coming back from the cache layer in
`cache.py`. Our working theory is that the TTL expiry logic in `TTLCache`
is broken — entries seem to survive well past the configured
`ttl_seconds` and callers keep getting values that should have expired
long ago. Please focus the fix on the expiry check in `get()`.
