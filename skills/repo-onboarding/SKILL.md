---
name: repo-onboarding
description: >-
  Onboards a target repository for bakudo measurement and agent work. Use
  when registering a new repo: abox project config, hermetic guest
  dependencies, environment pin, registration, and the acceptance probe.
---

# Target Repository Onboarding

Onboarding makes a repository measurable: an abox guest must be able to run
the repo's code hermetically, and every identity the evidence binds to must
be written down before the first measurement.

## 1. Probe the guest once

Boot one throwaway sandbox from any trusted repo and record facts you will
need below — do not guess them:

```sh
abox run --task onboarding-probe -- sh -c \
  'python3 -c "import platform,os,sysconfig; \
   print(platform.python_version(), platform.release(), os.cpu_count(), \
   __import__(\"os\").path.exists(sysconfig.get_path(\"stdlib\")+\"/EXTERNALLY-MANAGED\"))"'
abox stop onboarding-probe --clean
```

Guest Python version drives wheel selection; `EXTERNALLY-MANAGED: True`
means `pip install` needs `--break-system-packages`.

## 2. Commit the abox onboarding into the target repo

Create `.abox/` on a branch (measurement pins revisions, so the onboarding
must be **committed**, not working-tree state):

- `project.toml` — guest profile (`python-glibc`) and `network.mode = "safe"`.
- `requirements-guest.txt` — the minimal dependency closure the measured
  code imports (lazy imports need not ship), pinned to the repo's lockfile
  versions.
- `wheels/` — `pip download --no-deps --only-binary=:all:` for the guest's
  Python version and platform (for example `--python-version 311
  --platform manylinux_2_17_x86_64 --platform any`).
- `prepare.sh` — hermetic install, safe under `network: none`:

```sh
#!/bin/sh
set -e
python3 -m pip install --quiet --no-index --break-system-packages \
  --find-links /workspace/.abox/wheels \
  --requirement /workspace/.abox/requirements-guest.txt
```

Then `abox project trust` and, when agents will work here, `abox env warm`.

## 3. Author the environment pin

One JSON file per lab machine (operator-side, e.g. `~/.config/bakudo/`),
with values from the probe — never invented: guest Python in
`runtimeVersions` (name `python`), guest kernel, host architecture,
installed `aboxVersion`, and `cpuCount`/`memoryMb` **equal to what the
workloads declare**. Hash the repo lockfile for `dependencyLockDigest`.

## 4. Register and verify

```sh
bakudo repo add /path/to/checkout --name NAME   # durable ledger recommended
bakudo performance preflight --json             # must be ready, fail-closed
```

Acceptance probe — the guest must import the measured code hermetically:

```sh
abox run --base ONBOARDING_BRANCH --task import-probe -- sh -c \
  'sh /workspace/.abox/prepare.sh && cd /workspace && \
   python3 -c "import sys; sys.path.insert(0, \"src\"); import NAME; print(\"OK\")"'
abox stop import-probe --clean
```

Only after this probe passes, author workloads (see the `workload-authoring`
skill) with `subject.repo` set to the registered name, and calibrate the lab
(`bakudo performance calibrate`) before trusting any comparison.
