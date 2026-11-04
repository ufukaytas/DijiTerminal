#!/bin/sh
# tests/hooks/notify.test.sh — 01/03 notify.sh testleri (terminal-notifier ve osascript stub'larıyla)
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NOTIFY="$ROOT/hooks/notify.sh"
. "$ROOT/tests/hooks/lib.sh"

DATA=$(mktemp -d)
export DIJI_DATA_DIR="$DATA"
BIN="$DATA/bin"; OSA_ONLY="$DATA/bin-osa"
mkdir -p "$BIN" "$OSA_ONLY" "$DATA/state"
APP_PID=
trap '[ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null; rm -rf "$DATA"' EXIT

# Stub'lar argümanları her satıra bir tane olacak şekilde CALLS dosyasına yazar.
for name in terminal-notifier osascript; do
  cat > "$BIN/$name" <<EOF
#!/bin/sh
{ echo "== $name"; for a in "\$@"; do printf '%s\n' "\$a"; done; } >> "$DATA/calls"
# osascript script'i stdin'den (heredoc) okur; terminal-notifier stdin okumaz.
[ "$name" = osascript ] && cat >/dev/null
EOF
  chmod 755 "$BIN/$name"
done
cp "$BIN/osascript" "$OSA_ONLY/osascript"

SYS_PATH=$PATH
CALLS="$DATA/calls"
SID=5f3c2a10-8b7e-4c1d-9a2f-0e6b7d4c3a21
PERM="Claude needs your permission to use Bash"
ncalls() { grep -c '^== ' "$CALLS" 2>/dev/null || echo 0; }
reset() { rm -f "$CALLS" "$DATA/state/"* "$DATA/notify.conf" "$DATA/app.lock"; }
n() { PATH="$BIN:$SYS_PATH" TTY="${TTY_ENV-/dev/ttys004}" sh "$NOTIFY" "$@"; }

section "İzin bildirimi ve 60 sn tekilleştirme"
reset
n Notification "$SID" /Users/demo/Projects/youcms "" "$PERM"
check "bir terminal-notifier çağrısı" [ "$(ncalls)" = 1 ]
check "başlık: proje · onay bekliyor" grep -qx 'youcms · onay bekliyor' "$CALLS"
check "gövde: Bash için izin istiyor" grep -qx 'Bash için izin istiyor' "$CALLS"
check "-group session'a özel" grep -qx "diji-$SID" "$CALLS"
check "-execute focus-tty.sh ve tty tırnaklı" grep -q "^'$DATA/hooks/focus-tty.sh' '/dev/ttys004'\$" "$CALLS"
n Notification "$SID" /Users/demo/Projects/youcms "" "$PERM"
check "60 sn içinde ikinci izin → çağrı yok" [ "$(ncalls)" = 1 ]
echo $(( $(date +%s) - 61 )) > "$DATA/state/$SID.notifiedAt"
n Notification "$SID" /Users/demo/Projects/youcms "" "$PERM"
check "60 sn sonra → yeni çağrı" [ "$(ncalls)" = 2 ]

section "Plan onayı (PreToolUse ExitPlanMode)"
reset
n PreToolUse "$SID" /Users/demo/Projects/youcms ExitPlanMode ""
check "bildirim gönderildi" [ "$(ncalls)" = 1 ]
check "başlık: plan onayı bekliyor" grep -qx 'youcms · plan onayı bekliyor' "$CALLS"
n Notification "$SID" /Users/demo/Projects/youcms "" "$PERM"
check "hemen ardından gelen izin bildirimi tekilleşti" [ "$(ncalls)" = 1 ]
reset
n PreToolUse "$SID" /tmp/x Bash ""
check "sıradan PreToolUse → bildirim yok" [ "$(ncalls)" = 0 ]

section "Girdi hatırlatması bildirim üretmez"
reset
n Notification "$SID" /tmp/x "" "Claude is waiting for your input"
check "hatırlatma → çağrı yok" [ "$(ncalls)" = 0 ]
# Alt kabuk şart: macOS /bin/sh (bash, POSIX kipi) fonksiyon çağrısından önceki atamayı kalıcı yapar;
# yoksa NOTIFY_TYPE sonraki tüm testlere sızar ve izin bildirimlerini susturur.
(NOTIFY_TYPE=idle_prompt n Notification "$SID" /tmp/x "" "$PERM")
check "notification_type=idle_prompt → çağrı yok" [ "$(ncalls)" = 0 ]

section "Tur bitti: kısa turlar bastırılır"
reset
n UserPromptSubmit "$SID" /tmp/proj
check "UserPromptSubmit busySince yazdı" [ -f "$DATA/state/$SID.busySince" ]
echo $(( $(date +%s) - 10 )) > "$DATA/state/$SID.busySince"
n Stop "$SID" /tmp/proj
check "10 sn'lik tur → çağrı yok" [ "$(ncalls)" = 0 ]
echo $(( $(date +%s) - 252 )) > "$DATA/state/$SID.busySince"
n Stop "$SID" /tmp/proj
check "4 dk'lık tur → çağrı var" [ "$(ncalls)" = 1 ]
check "gövdede süre" grep -q '^Tur süresi 4 dk 1[12] sn$' "$CALLS"
check "busySince tüketildi" [ ! -f "$DATA/state/$SID.busySince" ]
n SessionEnd "$SID" /tmp/proj
check "SessionEnd durum dosyalarını temizledi" sh -c "! ls '$DATA/state' | grep -q '$SID'"

section "Uygulama açıkken susar"
reset
# Kopya değil sembolik bağ: kopyalanan /bin/sleep macOS'ta imza denetiminde SIGKILL ile ölür
# ve test boşuna geçer. Bağla başlatılan sürecin `ps -o comm=` değeri yine .../Electron olur.
ln -s /bin/sleep "$DATA/Electron"
"$DATA/Electron" 30 & APP_PID=$!
printf '{"pid":%d,"startedAt":%d}\n' "$APP_PID" "$(date +%s)" > "$DATA/app.lock"
n Notification "$SID" /tmp/x "" "$PERM"
check "app.lock canlı Electron → çağrı yok" [ "$(ncalls)" = 0 ]
kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=
n Notification "$SID" /tmp/x "" "$PERM"
check "eski app.lock (ölü pid) → bildirim gösterilir" [ "$(ncalls)" = 1 ]
reset
# Çökme sonrası pid başka bir sürece verilmiş: canlı ama DijiTerminal/Electron değil.
sleep 30 & APP_PID=$!
printf '{"pid":%d,"startedAt":%d}\n' "$APP_PID" "$(date +%s)" > "$DATA/app.lock"
n Notification "$SID" /tmp/x "" "$PERM"
check "app.lock pid'i başka bir süreçte (pid reuse) → bildirim gösterilir" [ "$(ncalls)" = 1 ]
kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=
reset
printf 'bozuk' > "$DATA/app.lock"
n Notification "$SID" /tmp/x "" "$PERM"
check "bozuk app.lock → bildirim gösterilir" [ "$(ncalls)" = 1 ]

section "Enjeksiyon güvenliği"
reset
EVIL='needs your permission to use Bash: "$(touch '"$DATA"'/pwned)" `touch '"$DATA"'/pwned2`'
n Notification "$SID" '/tmp/a"b' "" "$EVIL"
check "komut çalışmadı" test ! -e "$DATA/pwned" -a ! -e "$DATA/pwned2"
TTY_ENV='/dev/ttys1;touch /tmp/x' n Notification "x$SID" /tmp/x "" "$PERM"
check "geçersiz tty → -execute eklenmedi" sh -c "! grep -q 'ttys1;' '$CALLS'"
check "geçersiz tty'de de komut yok" [ ! -e "$DATA/pwned" ]

section "terminal-notifier yoksa osascript (metinler argüman olarak)"
reset
PATH="$OSA_ONLY:$SYS_PATH" TTY=/dev/ttys004 sh "$NOTIFY" Notification "$SID" /Users/demo/Projects/youcms "" "$PERM"
check "osascript çağrıldı" grep -qx '== osascript' "$CALLS"
check "başlık argüman olarak geçti" grep -qx 'youcms · onay bekliyor' "$CALLS"
check "ses argüman olarak geçti" grep -qx 'Glass' "$CALLS"

section "notify.conf"
reset
printf 'WAITING=0\n' > "$DATA/notify.conf"
n Notification "$SID" /tmp/x "" "$PERM"
check "WAITING=0 → çağrı yok" [ "$(ncalls)" = 0 ]
printf 'WAITING=1\nSOUND=\nDONE_MIN_SEC=5\n' > "$DATA/notify.conf"
n Notification "$SID" /tmp/x "" "$PERM"
check "SOUND boş → -sound yok" sh -c "! grep -qx -- '-sound' '$CALLS'"
printf 'bu ( geçersiz shell\n' > "$DATA/notify.conf"
rm -f "$DATA/state/$SID.notifiedAt" "$CALLS"
n Notification "$SID" /tmp/x "" "$PERM"
check "bozuk conf → varsayılanlarla bildirim" [ "$(ncalls)" = 1 ]

section "Çıktı yok, çıkış kodu 0"
out=$(n Notification "$SID" /tmp/x "" "$PERM" 2>&1); rc=$?
check "stdout/stderr boş" [ -z "$out" ]
check "exit 0" [ "$rc" = 0 ]

finish
