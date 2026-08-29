#!/bin/bash
# Start / stop the Proton Bridge CLI as a background daemon.
# Only one proton-bridge process can run at a time (upstream constraint).

BRIDGE_BIN="${BRIDGE_BIN:-/protonmail/proton-bridge}"
BRIDGE_LOG="${BRIDGE_LOG:-/root/bridge.log}"
FAKETTY="${FAKETTY:-/tmp/faketty}"

bridge_running() {
    pgrep -f "$BRIDGE_BIN" >/dev/null 2>&1
}

stop_bridge() {
    if bridge_running; then
        pkill -f "$BRIDGE_BIN" >/dev/null 2>&1 || true
        sleep 1
        pkill -9 -f "$BRIDGE_BIN" >/dev/null 2>&1 || true
    fi
}

start_bridge_daemon() {
    stop_bridge
    mkdir -p "$(dirname "$BRIDGE_LOG")"
    rm -f "$FAKETTY"
    mkfifo "$FAKETTY"
    # Fake a terminal so Bridge does not exit on EOF (shenxn pattern).
    # shellcheck disable=SC2094
    cat "$FAKETTY" | "$BRIDGE_BIN" --cli >>"$BRIDGE_LOG" 2>&1 &
    echo $! > /tmp/bridge.pid
}

status_bridge() {
    if bridge_running; then
        echo "daemon: UP (pid $(cat /tmp/bridge.pid 2>/dev/null || echo '?'))"
    else
        echo "daemon: DOWN"
    fi
}
