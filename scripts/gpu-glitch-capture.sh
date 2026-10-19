#!/bin/zsh
# Run this IMMEDIATELY after a screen glitch / EasyEDA WebGL crash.
# Captures the kernel's GPU-restart attribution before the unified log rotates
# (high-volume kernel categories can rotate within hours — speed matters).
set -u
OUT="$HOME/Desktop/gpu-glitch-$(date +%Y%m%d-%H%M%S).txt"
{
  echo "=== capture: $(date) ==="
  echo; echo "--- kernel: who was denied GPU submissions (offender attribution) ---"
  log show --last 30m --predicate 'eventMessage CONTAINS "Deny submissions" OR eventMessage CONTAINS "retireCommandBuffer" OR eventMessage CONTAINS "GPURestart"' --style compact 2>/dev/null | grep -v "^Filtering"
  echo; echo "--- kernel: IOGPU activity ---"
  log show --last 30m --predicate 'process == "kernel" AND eventMessage CONTAINS[c] "gpu"' --style compact 2>/dev/null | grep -iE "restart|deny|fault|lockup|hang|timeout" | head -60
  echo; echo "--- gpuEvent reports (last 60 min) ---"
  find /Library/Logs/DiagnosticReports "$HOME/Library/Logs/DiagnosticReports" -name 'gpuEvent-*' -mmin -60 2>/dev/null | while read -r f; do
    echo "· $f"
    head -c 3000 "$f" | tr ',' '\n' | grep -E '"(process_name|restart_reason_desc)"'
  done
  echo; echo "--- EasyEDA GPU child-process exits (today) ---"
  grep -h "child-process-gone" "$HOME/Documents/EasyEDA-Pro/logs/warn/$(date +%Y%m%d).log" 2>/dev/null | tail -10
  echo; echo "--- GPU memory pressure right now ---"
  ps -Ao rss,command | grep -iE "Electron Helper \(GPU\)|Claude|WindowServer" | grep -v grep
} > "$OUT" 2>&1
echo "Saved: $OUT"
