# Skill: Worktree Hygiene for Bakudo

## Trigger

When starting feature work, reconciling branch state, installing the local
binary, or cleaning up stale Bakudo worktrees.

## Process

1. **Use the canonical tree first**
   - Work from `bakudo/` by default.
   - Check status with:
     ```bash
     git status --short --branch
     git worktree list --porcelain
     ```

2. **Create isolated feature work in a worktree**
   - From the canonical repo:
     ```bash
     git fetch origin
     git worktree add -b feature/<name> /abs/path/.worktrees/<name> origin/main
     ```
   - Keep feature worktrees under the parent workspace `.worktrees/` directory.

3. **Install from the canonical repo**
   - Use:
     ```bash
     just install
     ```
   - Do not install Bakudo from a stale or duplicate checkout.

4. **Before closing work**
   - Make sure relevant work is merged or salvaged onto `main`.
   - Verify:
     ```bash
     just check
     ```

5. **Remove stale worktrees**
   - After merge or salvage:
     ```bash
     git worktree remove /abs/path/.worktrees/<name>
     git branch -d feature/<name>
     ```
   - Use `-D` only when the branch is already fully subsumed elsewhere and you
     intentionally want to drop the local ref.
