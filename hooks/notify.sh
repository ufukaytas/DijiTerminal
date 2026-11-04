#!/bin/sh
# DijiTerminal — uygulamasız masaüstü bildirimleri
#
# dijiterminal-hook.sh tarafından arka planda çağrılır:
#   notify.sh EVENT SID CWD TOOL MESSAGE      env: CLAUDE_PID, TTY, DIJI_DATA_DIR, NOTIFY_TYPE
# DijiTerminal uygulaması açıksa (app.lock canlı pid) hiçbir bildirim göstermez; o zaman bildirimleri uygulama verir.
# Kullanıcı ya da Claude kaynaklı metinler hiçbir zaman AppleScript kaynağına veya `sh -c` dizesine gömülmez.

trap 'exit 0' EXIT HUP INT TERM
set +e
umask 077
exec >/dev/null 2>&1

EVENT=$1 SID=$2 CWD=$3 TOOL=$4 MESSAGE=$5
DATA=${DIJI_DATA_DIR:-"$HOME/Library/Application Support/DijiTerminal"}
SID=$(printf '%s' "$SID" | tr -cd 'A-Za-z0-9_-' | cut -c1-80)
[ -n "$SID" ] || exit 0
STATE="$DATA/state"
mkdir -p "$STATE"
now=$(date +%s)

# ---------- ayarlar (notify.conf, alt kabukta okunur; hatalıysa varsayılanlar) ----------
WAITING=1 DONE=1 DONE_MIN_SEC=30 SOUND=Glass
if [ -f "$DATA/notify.conf" ]; then
  conf=$( ( . "$DATA/notify.conf" && printf '%s|%s|%s|%s' "${WAITING:-1}" "${DONE:-1}" "${DONE_MIN_SEC:-30}" "${SOUND-Glass}" ) 2>/dev/null )
  if [ -n "$conf" ]; then
    IFS='|' read -r c_w c_d c_m c_s <<EOF
$conf
EOF
    case "$c_w" in 0|1) WAITING=$c_w ;; esac
    case "$c_d" in 0|1) DONE=$c_d ;; esac
    case "$c_m" in ''|*[!0-9]*) ;; *) DONE_MIN_SEC=$c_m ;; esac
    case "$c_s" in *[!A-Za-z]*) ;; *) SOUND=$c_s ;; esac
  fi
fi

# ---------- durum kayıtları (uygulama açık olsa da tutulur) ----------
case "$EVENT" in
  UserPromptSubmit) printf '%s\n' "$now" > "$STATE/$SID.busySince"; exit 0 ;;
  SessionEnd)       rm -f "$STATE/$SID.busySince" "$STATE/$SID.notifiedAt"; exit 0 ;;
  Notification|Stop) ;;
  PreToolUse) case "$TOOL" in ExitPlanMode|AskUserQuestion) ;; *) exit 0 ;; esac ;;
  *) exit 0 ;;
esac

# ---------- uygulama açık mı ----------
app_running() {
  pid=$(cat "$DATA/app.lock" 2>/dev/null | sed -n 's/[^0-9]*\([0-9][0-9]*\).*/\1/p' | head -n 1)
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -o comm= -p "$pid" 2>/dev/null | grep -Eq 'DijiTerminal|Electron'
}
app_running && exit 0

PROJECT=$(basename "$CWD" 2>/dev/null)
[ -n "$PROJECT" ] || PROJECT="Claude Code"

fmt_dur() {
  m=$(($1 / 60)) s=$(($1 % 60))
  if [ "$m" -gt 0 ]; then printf '%d dk %d sn' "$m" "$s"; else printf '%d sn' "$s"; fi
}

sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

notify_user() { # notify_user TITLE BODY
  N_TITLE=$1 N_BODY=$2
  if command -v terminal-notifier >/dev/null 2>&1; then
    set -- -title "DijiTerminal" -subtitle "$N_TITLE" -message "$N_BODY" -group "diji-$SID" -activate com.googlecode.iterm2
    [ -n "$SOUND" ] && set -- "$@" -sound "$SOUND"
    case "$TTY" in
      /dev/ttys[0-9]*)
        case "${TTY#/dev/ttys}" in *[!0-9]*) ;; *)
          set -- "$@" -execute "$(sq "$DATA/hooks/focus-tty.sh") $(sq "$TTY")" ;;
        esac ;;
    esac
    terminal-notifier "$@"
  elif [ -n "$SOUND" ]; then
    osascript - "$N_TITLE" "$N_BODY" "$SOUND" <<'APPLESCRIPT'
on run argv
  display notification (item 2 of argv) with title "DijiTerminal" subtitle (item 1 of argv) sound name (item 3 of argv)
end run
APPLESCRIPT
  else
    osascript - "$N_TITLE" "$N_BODY" <<'APPLESCRIPT'
on run argv
  display notification (item 2 of argv) with title "DijiTerminal" subtitle (item 1 of argv)
end run
APPLESCRIPT
  fi
  LOG="$DATA/notify.log"
  if [ -f "$LOG" ]; then
    size=$(wc -c < "$LOG" | tr -d ' ')
    [ "$size" -gt 1048576 ] 2>/dev/null && : > "$LOG"
  fi
  printf '%s %s %s %s\n' "$now" "$EVENT" "$SID" "$N_TITLE" >> "$LOG"
}

recently_notified() {
  last=$(cat "$STATE/$SID.notifiedAt" 2>/dev/null)
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  [ $((now - last)) -lt 60 ]
}

case "$EVENT" in
  PreToolUse)
    [ "$WAITING" = 1 ] || exit 0
    recently_notified && exit 0
    case "$TOOL" in
      ExitPlanMode)    title="$PROJECT · plan onayı bekliyor"; body="Planı onaylamanızı bekliyor" ;;
      AskUserQuestion) title="$PROJECT · soru soruyor";        body="Cevabınızı bekliyor" ;;
    esac
    printf '%s\n' "$now" > "$STATE/$SID.notifiedAt"
    notify_user "$title" "$body"
    ;;
  Notification)
    [ "$WAITING" = 1 ] || exit 0
    lower=$(printf '%s %s' "$NOTIFY_TYPE" "$MESSAGE" | tr '[:upper:]' '[:lower:]')
    case "$NOTIFY_TYPE" in idle*) exit 0 ;; esac
    case "$lower" in *permission*|*izin*|*approve*|*approval*) ;; *) exit 0 ;; esac
    recently_notified && exit 0
    tool=$(printf '%s' "$MESSAGE" | sed -n -E 's/.*[Uu]se ([A-Za-z_][A-Za-z0-9_]*).*/\1/p' | head -n 1)
    [ -n "$tool" ] || tool=$TOOL
    if [ -n "$tool" ]; then body="$tool için izin istiyor"
    else body=$(printf '%s' "$MESSAGE" | cut -c1-120); [ -n "$body" ] || body="Onayınızı bekliyor"; fi
    printf '%s\n' "$now" > "$STATE/$SID.notifiedAt"
    notify_user "$PROJECT · onay bekliyor" "$body"
    ;;
  Stop)
    [ "$DONE" = 1 ] || exit 0
    since=$(cat "$STATE/$SID.busySince" 2>/dev/null)
    case "$since" in ''|*[!0-9]*) exit 0 ;; esac
    rm -f "$STATE/$SID.busySince"
    d=$((now - since))
    [ "$d" -lt "$DONE_MIN_SEC" ] && exit 0
    notify_user "$PROJECT · bitti" "Tur süresi $(fmt_dur "$d")"
    ;;
esac
exit 0
