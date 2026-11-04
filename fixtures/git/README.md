# fixtures/git

Git senaryoları repoya konmaz; `tests/engine/projects.test.ts` her çalıştırmada geçici klasörde üretir:

1. `git init repo` + bir commit
2. `repo/lib` alt klasörü (aynı proje)
3. `git worktree add repo/.claude/worktrees/x` (worktree → ana repoya bağlanır)

Makinede `git` yoksa bu testler `skip` olur.
