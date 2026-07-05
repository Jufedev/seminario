# Git and remote

Remote: `git@github.com:Jufedev/seminario.git` (branch `main`).

## Purged the thesis PDF from git history and force-pushed
*bugfix · 2026-07-04*

Removed "info IA - Seminario - Big data.pdf" from the entire git history
(`filter-branch --index-filter` + `refs/original` cleanup + reflog expire + gc)
and force-pushed (`--force-with-lease`); `main` was rewritten to `f5fa67d`. Added
`*.pdf` to `.gitignore`.

**Why:** the PDF was committed in the baseline by accident and pushed; the user
asked to remove it from GitHub.

**Learned:**
- `git filter-branch` ALSO updates the working tree at the end — the PDF vanished
  from disk after the rewrite.
- Recovered it via `git show 'origin/main:<file>'` BEFORE force-pushing (the stale
  remote ref still held the old objects; after force-push that recovery path is
  gone). **Order matters: recover from stale refs first, force-push last.**
- GitHub may cache unreachable objects server-side for a while; for real secrets
  the protocol is rotate + purge, not just purge.
