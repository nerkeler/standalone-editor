#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EDITOR_PORT_VALUE="${EDITOR_PORT:-5557}"
FRONTEND_PORT_VALUE="${FRONTEND_PORT:-5558}"
EDITOR_HOST_VALUE="${EDITOR_HOST:-127.0.0.1}"

# Passing a workspace explicitly updates the backend's persisted config. With
# no argument the backend loads that config (and its persistent default) on its
# own, rather than silently switching back to /tmp on every launch.
WORKSPACE_PATH=""
if [[ $# -gt 0 ]]; then
  WORKSPACE_PATH="$1"
  mkdir -p -- "$WORKSPACE_PATH"
  WORKSPACE_LABEL="$WORKSPACE_PATH"
else
  WORKSPACE_LABEL="${EDITOR_DEFAULT_WORKSPACE:-已保存的工作空间}"
fi

echo "📁 工作空间：$WORKSPACE_LABEL"
echo "🚀 启动后端 (端口 $EDITOR_PORT_VALUE)..."
(
  cd -- "$SCRIPT_DIR/backend"
  if [[ -n "$WORKSPACE_PATH" ]]; then
    exec env PORT="$EDITOR_PORT_VALUE" HOST="$EDITOR_HOST_VALUE" node src/index.js --workspace "$WORKSPACE_PATH"
  else
    exec env PORT="$EDITOR_PORT_VALUE" HOST="$EDITOR_HOST_VALUE" node src/index.js
  fi
) &
BACKEND_PID=$!

echo "🚀 启动前端 (端口 $FRONTEND_PORT_VALUE)..."
(
  cd -- "$SCRIPT_DIR/frontend"
  exec env EDITOR_PORT="$EDITOR_PORT_VALUE" FRONTEND_PORT="$FRONTEND_PORT_VALUE" node_modules/.bin/vite --host 127.0.0.1 --strictPort
) &
FRONTEND_PID=$!

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  done
  wait "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
  echo "已停止"
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_service() {
  local url="$1"
  local label="$2"
  local attempts=0
  while (( attempts < 60 )); do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null || ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
      echo "❌ $label 启动失败：服务进程已退出" >&2
      exit 1
    fi
    if curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    attempts=$((attempts + 1))
    sleep 0.25
  done
  echo "❌ $label 健康检查超时：$url" >&2
  exit 1
}

wait_for_service "http://$EDITOR_HOST_VALUE:$EDITOR_PORT_VALUE/api/workspace/check" "后端"
wait_for_service "http://127.0.0.1:$FRONTEND_PORT_VALUE/" "前端"

echo "✅ 服务已启动"
echo "   后端：http://$EDITOR_HOST_VALUE:$EDITOR_PORT_VALUE"
echo "   前端：http://127.0.0.1:$FRONTEND_PORT_VALUE"
echo "   工作空间：$WORKSPACE_LABEL"
echo ""
echo "按 Ctrl+C 停止所有服务"

wait "$BACKEND_PID"
