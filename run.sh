#!/usr/bin/env bash
#
# 协议阅读器 启停脚本
#
#   ./run.sh start     后台启动（关掉终端也不会停）
#   ./run.sh stop      停止
#   ./run.sh restart   重启
#   ./run.sh status    查看状态
#   ./run.sh logs      实时查看日志（Ctrl+C 退出，不影响服务）
#   ./run.sh fg        前台运行（调试用，Ctrl+C 即停）
#
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

LOG_FILE="$DIR/server.log"

# 端口优先取 .env 里的 PORT
PORT="$(grep -E '^[[:space:]]*PORT=' "$DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d ' \r\t' || true)"
PORT="${PORT:-8787}"
URL="http://127.0.0.1:${PORT}"

# PID 文件按端口区分，避免多实例互相覆盖
PID_FILE="$DIR/.server-linux-${PORT}.pid"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    red "没有找到 node。请先安装 Node.js（版本需 ≥ 20）。"
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 20 ]; then
    red "Node.js 版本过低（当前 $(node -v)），需要 ≥ 20。"
    exit 1
  fi
}

pid_alive() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

port_in_use() {
  # 优先用 bash 内置的 /dev/tcp，避免依赖 ss / lsof
  (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null && { exec 3>&- 2>/dev/null; return 0; }
  return 1
}

wait_health() {
  local i
  for i in $(seq 1 40); do
    if curl -fsS -m 2 "${URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

cmd_start() {
  check_node
  if pid_alive; then
    green "已经在运行了（PID $(cat "$PID_FILE")）"
    echo "  ${URL}"
    return 0
  fi
  if port_in_use; then
    red "端口 ${PORT} 已被其它程序占用。"
    echo "  换个端口：编辑 .env 里的 PORT，或临时用  PORT=8899 ./run.sh start"
    return 1
  fi

  # setsid + nohup：脱离当前终端，关掉窗口也不会被 SIGHUP 带走
  rm -f "$PID_FILE"
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup node server.js >>"$LOG_FILE" 2>&1 &
  else
    nohup node server.js >>"$LOG_FILE" 2>&1 &
  fi
  local launcher_pid=$!

  # PID 文件交给 server.js 自己写：$! 拿到的是包装进程的 PID，
  # 而 setsid 在需要新建会话时会 fork，那个 PID 并不是真正的 node 进程，
  # 用它去 stop 会杀错对象。这里只等 server.js 把真实 PID 写出来。
  local i
  for i in $(seq 1 60); do
    [ -s "$PID_FILE" ] && break
    kill -0 "$launcher_pid" 2>/dev/null || break
    sleep 0.2
  done

  if wait_health; then
    green "启动成功"
    echo "  地址：${URL}"
    dim "  日志：./run.sh logs　　停止：./run.sh stop"
    return 0
  fi

  red "启动后健康检查未通过，最近日志："
  tail -n 20 "$LOG_FILE" 2>/dev/null | sed 's/^/  /'
  rm -f "$PID_FILE"
  return 1
}

cmd_stop() {
  if ! pid_alive; then
    dim "没有在运行。"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null

  local i
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    dim "优雅退出超时，强制结束。"
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$PID_FILE"
  green "已停止"
}

cmd_status() {
  if pid_alive; then
    green "运行中"
    echo "  PID ：$(cat "$PID_FILE")"
    echo "  地址：${URL}"
    # Windows 侧如果打不开 127.0.0.1（WSL2 端口转发失效），用这个对外地址
    local wslip
    wslip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "$wslip" ] && echo "  备用：http://${wslip}:${PORT}  ← Windows 浏览器若连不上 127.0.0.1 就用这个"
    if curl -fsS -m 2 "${URL}/api/health" >/dev/null 2>&1; then
      echo "  健康检查：通过"
      curl -fsS -m 2 "${URL}/api/health" | sed 's/^/  /'
      echo
    else
      red "  健康检查：失败"
    fi
  else
    dim "未运行。"
    if port_in_use; then
      red "  但端口 ${PORT} 被别的程序占用了。"
    fi
  fi
}

cmd_fg() {
  check_node
  green "前台运行中，按 Ctrl+C 停止"
  echo "  地址：${URL}"
  exec node server.js
}

case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; echo; cmd_start ;;
  status)  cmd_status ;;
  fg)      cmd_fg ;;
  logs)
    if [ -f "$LOG_FILE" ]; then
      tail -n 50 -f "$LOG_FILE"
    else
      dim "还没有日志文件（服务尚未启动过）。"
    fi
    ;;
  *)
    cat <<EOF
协议阅读器 启停脚本

  ./run.sh start     后台启动（关掉终端也不会停）
  ./run.sh stop      停止
  ./run.sh restart   重启
  ./run.sh status    查看状态
  ./run.sh logs      实时查看日志（Ctrl+C 退出，不影响服务）
  ./run.sh fg        前台运行（调试用，Ctrl+C 即停）

当前端口：${PORT}（取自 .env，可用 PORT=8899 ./run.sh start 临时覆盖）
EOF
    ;;
esac
