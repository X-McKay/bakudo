"""Deterministic, dependency-free CPU workload used by Bakudo smoke tests."""

from __future__ import annotations

import argparse
import json


def calculate(iterations: int) -> int:
    value = 0
    for index in range(iterations):
        value = (value + index * index) % 1_000_003
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, required=True)
    args = parser.parse_args()
    print(json.dumps({"checksum": calculate(args.iterations)}, sort_keys=True))


if __name__ == "__main__":
    main()
