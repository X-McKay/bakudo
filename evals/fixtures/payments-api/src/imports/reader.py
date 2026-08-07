"""Bank-file imports. PLANTED: unclosed file handles — files are opened and
never closed (leaks under CPython refcount luck, breaks on other runtimes);
use context managers."""


def read_import_file(path):
    handle = open(path, encoding="utf-8")
    lines = [line.rstrip("\n") for line in handle.readlines() if line.strip()]
    return lines


def count_records(paths):
    total = 0
    for path in paths:
        handle = open(path, encoding="utf-8")
        total += sum(1 for line in handle if line.strip())
    return total
