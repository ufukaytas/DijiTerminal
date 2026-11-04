#!/bin/sh
# DijiTerminal — verilen tty'ye sahip iTerm2 session'ını öne getirir.
# Kullanım: focus-tty.sh /dev/ttys004
# Bildirime tıklanınca (terminal-notifier -execute) çalışır. tty AppleScript'e argüman olarak geçer.
# İlk çalıştırmada macOS, iTerm2'yi kontrol etmek için Otomasyon izni ister.

trap 'exit 0' EXIT HUP INT TERM
set +e

TTY=$1
case "$TTY" in /dev/ttys[0-9]*) ;; *) exit 0 ;; esac
case "${TTY#/dev/ttys}" in *[!0-9]*) exit 0 ;; esac
pgrep -xq iTerm2 2>/dev/null || exit 0

osascript - "$TTY" >/dev/null 2>&1 <<'APPLESCRIPT'
on run argv
  set target to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is target then
            tell w to select
            tell t to select
            tell s to select
            activate
            return
          end if
        end repeat
      end repeat
    end repeat
  end tell
end run
APPLESCRIPT
exit 0
