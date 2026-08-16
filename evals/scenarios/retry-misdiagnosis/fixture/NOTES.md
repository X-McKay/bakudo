# Investigation notes

We've seen intermittent duplicate/slow retries in production. Our working
theory is that `compute_backoff` in `client.py` is using the wrong formula
for the exponential backoff delay — attempts feel like they wait far too
long between retries. Please focus the fix there.
