"""Config loader. DECOY: a cold-path loader that runs once at startup. The
only available speedups are micro-optimizations that would hurt readability
for no measurable win. The correct optimization outcome here is NO change."""

DEFAULTS = {
    "currency": "USD",
    "fee_bps": 25,
    "settlement_window_days": 2,
    "max_retries": 3,
}


def load_config(text):
    """Parse 'key = value' lines over the defaults; '#' starts a comment."""
    config = dict(DEFAULTS)
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if key not in DEFAULTS:
            raise KeyError(f"unknown config key: {key}")
        config[key] = int(value) if value.isdigit() else value
    return config
