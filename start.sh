#!/bin/bash
# 启动独立编辑器

WORKSPACE="${1:-/tmp/my-notes}"

echo "📁 工作空间：$WORKSPACE"
mkdir -p "$WORKSPACE"

echo ""
echo "🚀 启动后端 (端口 5557)..."
cd "$(dirname "$0")/backend" && node src/index.js --workspace "$WORKSPACE" &
BACKEND_PID=$!

echo "🚀 启动前端 (端口 5558)..."
cd "$(dirname "$0")/frontend" && npm run dev &
FRONTEND_PID=$!

echo ""
echo "✅ 服务已启动"
echo "   后端：http://localhost:5557"
echo "   前端：http://localhost:5558"
echo "   工作空间：$WORKSPACE"
echo ""
echo "按 Ctrl+C 停止所有服务"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo '已停止'" INT TERM
wait
