---
name: commit
description: Zkontroluje změny v gitu a udělá commit s dobrou zprávou (bez push)
---
Commit the current working-tree changes with a clear message.

1. In ONE turn run `git status --short`, `git diff`, `git diff --cached` and `git log --oneline -10`
   (one command per `<run>`). If the text after /commit names files or a scope, limit yourself to that.
2. Do not commit secrets, build output, large binaries or unrelated debug leftovers; leave those out and
   mention them in `<done>`. If the changes are clearly several independent topics, make several commits.
3. Message style: follow the repository's history (Conventional Commits if it uses them). Subject in the
   imperative, at most 72 characters, then a blank line and a short body saying what and why, not how.
4. Stage with `git add <paths>` (never `git add -A` unless the user asked for everything), then commit
   with `git commit -m "<subject>" -m "<body>"`; one command per `<run>`. Do not push and do not amend
   unless the user explicitly asked.
5. Verify with `git log --oneline -1` and `git status --short`, then `<done>` with the commit hash and
   what was left uncommitted. The commit and the verification may be in the same reply as the diff review
   when the diff is small enough to judge from the first results.
