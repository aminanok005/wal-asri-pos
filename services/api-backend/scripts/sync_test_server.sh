#!/usr/bin/env bash
# Sync E2E test server manager for walasri_sync_e2e database on 127.0.0.1:8081
# Usage: ./sync_test_server.sh {start|stop|status|logs}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$PROJECT_ROOT"
DB_NAME="walasri_sync_e2e"
PORT=8081
BIND_ADDR="127.0.0.1:$PORT"
PID_FILE="/tmp/walasri_sync_test_server.pid"
LOG_FILE="/tmp/walasri_sync_test_server.log"
DB_URL="postgres://wasri_user:${WALASRI_PG_PW}@127.0.0.1:5433/${DB_NAME}?sslmode=disable"

cd "$API_DIR"

start() {
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "Server already running (PID: $(cat "$PID_FILE"))"
        return 0
    fi

    echo "Starting sync test server on $BIND_ADDR (database: $DB_NAME)..."
    DATABASE_URL="$DB_URL" \
    nohup go run ./cmd/api -addr="$BIND_ADDR" > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"

    # Wait for ready
    for i in {1..30}; do
        if grep -q "greentable pos api listening" "$LOG_FILE" 2>/dev/null; then
            echo "Server started (PID: $(cat "$PID_FILE"))"
            echo "Logs: $LOG_FILE"
            return 0
        fi
        sleep 0.5
    done

    echo "ERROR: Server failed to start. Check $LOG_FILE"
    cat "$LOG_FILE"
    rm -f "$PID_FILE"
    return 1
}

stop() {
    if [[ ! -f "$PID_FILE" ]] || ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "Server not running"
        rm -f "$PID_FILE"
        return 0
    fi

    echo "Stopping server (PID: $(cat "$PID_FILE"))..."
    kill "$(cat "$PID_FILE")"

    for i in {1..10}; do
        if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
            echo "Server stopped"
            rm -f "$PID_FILE"
            return 0
        fi
        sleep 0.5
    done

    echo "Force killing..."
    kill -9 "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "Server force stopped"
}

status() {
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "RUNNING (PID: $(cat "$PID_FILE"), listening on $BIND_ADDR)"
        return 0
    else
        echo "STOPPED"
        return 1
    fi
}

logs() {
    if [[ -f "$LOG_FILE" ]]; then
        tail -f "$LOG_FILE"
    else
        echo "No log file at $LOG_FILE"
    fi
}

case "${1:-}" in
    start)   start ;;
    stop)    stop ;;
    status)  status ;;
    logs)    logs ;;
    *)       echo "Usage: $0 {start|stop|status|logs}" ; exit 1 ;;
esac