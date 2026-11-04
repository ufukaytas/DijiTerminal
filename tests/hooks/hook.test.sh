#!/bin/sh
# tests/hooks/hook.test.sh — 01/01 dijiterminal-hook.sh testleri (bağımlılıksız POSIX sh)
# Çalıştır: sh tests/hooks/hook.test.sh   (ya da npm run test:hooks)

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HOOK="$ROOT/hooks/dijiterminal-hook.sh"
FX="$ROOT/fixtures/hooks"
. "$ROOT/tests/hooks/lib.sh"

DATA=$(mktemp -d)
TTYF="$DATA/fake-tty"
export DIJI_DATA_DIR="$DATA"
trap 'rm -rf "$DATA"' EXIT

run() { # run <fixture> → stdout/stderr ayrı dosyalara
  DIJI_TEST_TTY="$TTYF" sh "$HOOK" < "$FX/$1" > "$DATA/out" 2> "$DATA/err"
  echo $? > "$DATA/rc"
}

section "Her fixture: çıkış kodu 0, stdout ve stderr boş"
for f in session-start user-prompt-submit pre-tool-use post-tool-use notification-permission notification-idle notification-tricky stop session-end invalid empty; do
  run "$f.json"
  check "$f: exit 0" [ "$(cat "$DATA/rc")" = 0 ]
  check "$f: stdout boş" [ ! -s "$DATA/out" ]
  check "$f: stderr boş" [ ! -s "$DATA/err" ]
done

section "JSONL: 9 geçerli satır, şema alanları, prompt metni yok"
LOG="$DATA/hook-events.jsonl"
check "satır sayısı 9" [ "$(wc -l < "$LOG" | tr -d ' ')" = 9 ]
check "her satır geçerli JSON ve şemada" node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
  for (const l of lines) {
    const o = JSON.parse(l);
    if (o.v !== 1 || typeof o.ts !== "number" || !o.event || !o.sessionId || typeof o.cwd !== "string"
        || !(o.tty === null || typeof o.tty === "string") || typeof o.claudePid !== "number") throw new Error(l);
    if (o.message && o.message.length > 200) throw new Error("message > 200");
  }' "$LOG"
check "prompt metni loglanmadı" sh -c "! grep -q 'GİZLİ' '$LOG'"
check "Bash aracı loglandı" grep -q '"tool":"Bash"' "$LOG"

section "Durum geçişleri ve sekme rengi"
rm -rf "$DATA/state" "$TTYF"
SID=5f3c2a10-8b7e-4c1d-9a2f-0e6b7d4c3a21
state() { cat "$DATA/state/$SID" 2>/dev/null; }
run session-start.json;           check "SessionStart → idle" [ "$(state)" = idle ]
run user-prompt-submit.json;      check "UserPromptSubmit → busy" [ "$(state)" = busy ]
: > "$TTYF"
run pre-tool-use.json;            check "PreToolUse (zaten busy) → tty'ye yazılmadı" [ ! -s "$TTYF" ]
run notification-permission.json; check "izin bildirimi → waiting" [ "$(state)" = waiting ]
check "amber kodu yazıldı" grep -q 'red;brightness;242' "$TTYF"
: > "$TTYF"
run post-tool-use.json;           check "onay sonrası PostToolUse → busy" [ "$(state)" = busy ]
check "mavi kodu yazıldı" grep -q 'blue;brightness;255' "$TTYF"
run notification-idle.json;       check "girdi hatırlatması → idle" [ "$(state)" = idle ]
run user-prompt-submit.json
run stop.json;                    check "Stop → idle" [ "$(state)" = idle ]
check "yeşil kodu yazıldı" grep -q 'green;brightness;195' "$TTYF"
: > "$TTYF"
run session-end.json;             check "SessionEnd → durum dosyası silindi" [ ! -f "$DATA/state/$SID" ]
check "sekme varsayılana döndü" grep -q 'bg;\*;default' "$TTYF"

section "Plan onayı ve soru: PreToolUse'ta doğrudan waiting"
rm -rf "$DATA/state"; : > "$TTYF"
run user-prompt-submit.json
run pre-tool-use-exitplan.json;   check "ExitPlanMode PreToolUse → waiting" [ "$(state)" = waiting ]
check "amber kodu yazıldı" grep -q 'red;brightness;242' "$TTYF"
run post-tool-use.json;           check "onaydan sonra PostToolUse → busy" [ "$(state)" = busy ]
run session-end.json

section "Güvenlik: tuzaklı girdi"
run notification-tricky.json
check "session_id temizlendi (path traversal yok)" [ -f "$DATA/state/etcx" ]
check "veri dizini dışına dosya yazılmadı" [ ! -e "$DATA/../etc" ]
check "tırnaklı cwd ve mesaj geçerli JSON" node -e '
  const l = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").pop();
  const o = JSON.parse(l);
  if (!o.message.includes("$(rm -rf ~)")) throw new Error("mesaj bozuldu");
  if (!o.cwd.includes("\"quoted\"")) throw new Error("cwd bozuldu");
  if (o.notificationType !== "permission_prompt") throw new Error("notificationType yok");' "$LOG"

section "notify.sh çağrısı (01/03 kancası)"
mkdir -p "$DATA/hooks"
cat > "$DATA/hooks/notify.sh" <<'EOF'
#!/bin/sh
printf '%s|%s|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" "$5" "$TTY" >> "$DIJI_DATA_DIR/notify-calls"
EOF
chmod 755 "$DATA/hooks/notify.sh"
run notification-permission.json
i=0; while [ ! -s "$DATA/notify-calls" ] && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done
check "notify.sh argümanlarla çağrıldı" grep -q '^Notification|5f3c2a10-8b7e-4c1d-9a2f-0e6b7d4c3a21|/Users/demo/Projects/demo-app||Claude needs your permission to use Bash|' "$DATA/notify-calls"
rm -f "$DATA/hooks/notify.sh"

section "Log döndürme (5 MB)"
head -c 5300000 /dev/zero | tr '\0' 'x' > "$LOG"
run stop.json
check "eski log .1'e taşındı" [ -f "$LOG.1" ]
check "yeni log tek satır" [ "$(wc -l < "$LOG" | tr -d ' ')" = 1 ]

section "Performans: 200 çalıştırma"
LIMIT=${PERF_P95_MS:-150}
p95=$(perl -MTime::HiRes=time -e '
  my ($hook, $fx) = @ARGV; my @d;
  for (1..200) { my $t = time; system("sh \"$hook\" < \"$fx\" >/dev/null 2>&1"); push @d, (time - $t) * 1000; }
  @d = sort { $a <=> $b } @d; printf "%.0f", $d[int(@d * 0.95)];' "$HOOK" "$FX/pre-tool-use.json")
echo "  p95 = ${p95} ms (sınır ${LIMIT} ms)"
check "p95 < ${LIMIT} ms" [ "$p95" -lt "$LIMIT" ]

finish
