# Captured log excerpt (nightly export job)

```
2026-08-15 09:14:02 ERROR database connection lost (db_stub.connect)
2026-08-15 09:14:02 WARNING retrying in 5s...
2026-08-15 09:14:07 ERROR database connection lost (db_stub.connect)
2026-08-15 09:14:07 WARNING retrying in 5s...
2026-08-15 09:14:12 ERROR database connection lost (db_stub.connect)
```

The export still finishes and a CSV file gets written despite the noise
above. The complaint we actually need to fix is about that CSV's
contents, not the connection errors -- see the mission description.
