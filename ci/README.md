# CI configuration

The live workflow is installed at `.github/workflows/ci.yml`. It runs two
jobs on every push to `main` and every pull request:

- **check** — `just check` (fmt + clippy + test)
- **cargo-deny** — `cargo deny check` (supply-chain audit)

`github-workflow-example.yml` in this directory is kept as a mirrored
fallback in case the live workflow file needs to be re-installed. To
(re)install it:

```bash
mkdir -p .github/workflows
cp ci/github-workflow-example.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "ci: install GitHub Actions workflow"
```

This fallback exists because a GitHub App that lacks the `workflows`
permission cannot create workflow files directly — a maintainer with repo
write access has to install it. Keep both files in sync when editing
either one.
