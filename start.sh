#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EDITOR_PORT_VALUE="${EDITOR_PORT:-5557}"
FRONTEND_PORT_VALUE="${FRONTEND_PORT:-5558}"
EDITOR_HOST_VALUE="${EDITOR_HOST:-127.0.0.1}"
EDITOR_MODE_VALUE="${EDITOR_MODE:-development}"

if ! NODE_VERSION="$(node --version 2>/dev/null)"; then
  NODE_VERSION="未安装"
  echo "❌ 需要 Node.js 22.17.0 或更新的 22.x 版本（当前：${NODE_VERSION}）" >&2
  exit 1
fi
if [[ ! "$NODE_VERSION" =~ ^v?22\.([0-9]+)\.[0-9]+$ ]] || (( ${BASH_REMATCH[1]:-0} < 17 )); then
  echo "❌ 需要 Node.js 22.17.0 或更新的 22.x 版本（当前：${NODE_VERSION}）" >&2
  exit 1
fi

case "$EDITOR_MODE_VALUE" in
  development|production) ;;
  *) echo "EDITOR_MODE 必须是 development 或 production" >&2; exit 2 ;;
esac

if [[ "$EDITOR_MODE_VALUE" == "production" && ! -f "$SCRIPT_DIR/frontend/dist/index.html" ]]; then
  echo "❌ 未找到 frontend/dist/index.html。请先运行 (cd frontend && npm ci && npm run build)" >&2
  exit 1
fi

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

start_backend() {
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
}

start_frontend_dev() {
  echo "🚀 启动前端 (端口 $FRONTEND_PORT_VALUE)..."
  (
    cd -- "$SCRIPT_DIR/frontend"
    exec env EDITOR_PORT="$EDITOR_PORT_VALUE" FRONTEND_PORT="$FRONTEND_PORT_VALUE" node_modules/.bin/vite --host 127.0.0.1 --strictPort
  ) &
  FRONTEND_PID=$!
}

BACKEND_PID=""
FRONTEND_PID=""
start_backend
if [[ "$EDITOR_MODE_VALUE" == "development" ]]; then
  start_frontend_dev
fi

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
    if [[ -n "$pid" ]]; then wait "$pid" 2>/dev/null || true; fi
  done
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
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      echo "❌ $label 启动失败：后端进程已退出" >&2
      return 1
    fi
    if [[ -n "$FRONTEND_PID" ]] && ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
      echo "❌ $label 启动失败：前端进程已退出" >&2
      return 1
    fi
    if curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    attempts=$((attempts + 1))
    sleep 0.25
  done
  echo "❌ $label 健康检查超时：$url" >&2
  return 1
}

case "$EDITOR_HOST_VALUE" in
  0.0.0.0) HEALTH_HOST="127.0.0.1" ;;
  ::) HEALTH_HOST="::1" ;;
  *) HEALTH_HOST="$EDITOR_HOST_VALUE" ;;
esac
if [[ "$HEALTH_HOST" == *:* && "$HEALTH_HOST" != \[*\] ]]; then
  HEALTH_URL_HOST="[$HEALTH_HOST]"
else
  HEALTH_URL_HOST="$HEALTH_HOST"
fi

# Health reports process readiness, while the workspace check intentionally
# remains a separate UI flow so an offline saved disk can be explained.
wait_for_service "http://$HEALTH_URL_HOST:$EDITOR_PORT_VALUE/api/health" "后端"

if [[ "$EDITOR_MODE_VALUE" == "production" ]]; then
  echo "✅ 正式构建已启动"
  echo "   应用：http://$HEALTH_URL_HOST:$EDITOR_PORT_VALUE"
  echo "   健康：http://$HEALTH_URL_HOST:$EDITOR_PORT_VALUE/api/health"
  echo "   工作空间：$WORKSPACE_LABEL"
  echo "按 Ctrl+C 停止服务"
  wait "$BACKEND_PID"
else
  wait_for_service "http://127.0.0.1:$FRONTEND_PORT_VALUE/" "前端"
  echo "✅ 开发服务已启动"
  echo "   后端：http://$HEALTH_URL_HOST:$EDITOR_PORT_VALUE"
  echo "   前端：http://127.0.0.1:$FRONTEND_PORT_VALUE"
  echo "   工作空间：$WORKSPACE_LABEL"
  echo ""
  echo "按 Ctrl+C 停止所有服务"

  # Bash 3.2 on the macOS system shell has no `wait -n`. `jobs -pr` works on
  # both the macOS and Linux shells and lets either child ending stop the pair.
  job_is_running() {
    local candidate
    for candidate in $(jobs -pr); do
      if [[ "$candidate" == "$1" ]]; then return 0; fi
    done
    return 1
  }

  while :; do
    if ! job_is_running "$BACKEND_PID"; then
      if wait "$BACKEND_PID"; then exit_code=0; else exit_code=$?; fi
      echo "后端进程已退出，正在停止前端" >&2
      exit "$exit_code"
    fi
    if ! job_is_running "$FRONTEND_PID"; then
      if wait "$FRONTEND_PID"; then exit_code=0; else exit_code=$?; fi
      echo "前端进程已退出，正在停止后端" >&2
      exit "$exit_code"
    fi
    sleep 0.25
  done
fi
