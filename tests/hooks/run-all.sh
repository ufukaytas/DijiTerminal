#!/bin/sh
# Tüm Faz 1 hook testleri: shell testleri + node:test (installer)
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
rc=0
for t in hook statusline notify; do
  printf '\n━━ %s.test.sh ━━\n' "$t"
  sh "$ROOT/tests/hooks/$t.test.sh" || rc=1
done
printf '\n━━ installer.test.mjs ━━\n'
node --test "$ROOT/tests/hooks/installer.test.mjs" || rc=1
[ "$rc" -eq 0 ] && printf '\nTüm hook testleri geçti.\n' || printf '\nBazı testler başarısız.\n'
exit "$rc"
