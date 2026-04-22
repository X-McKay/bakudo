# CI configuration

The file `github-workflow-example.yml` is a ready-to-use GitHub Actions
workflow that runs the full `just check` gate on PRs and release builds on
pushes to `main`.

To activate it, copy the file into place:

```bash
mkdir -p .github/workflows
cp ci/github-workflow-example.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "ci: install GitHub Actions workflow"
```

(It lives here rather than in `.github/workflows/` because a GitHub App that
lacks the `workflows` permission cannot create workflow files directly. A
maintainer with repo write access needs to install it.)
