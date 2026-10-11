#!/usr/bin/env bash
# Start/stop Kafka (KRaft) and RabbitMQ as project-local processes on macOS/Linux
# hosts WITHOUT Docker. PostgreSQL and Redis are expected to already be running
# (e.g. `brew services start postgresql@16 redis`). All broker data lives in
# ./.local so nothing is written to system service directories.
#
# Usage: scripts/local-infra.sh start|stop|status|reset
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL="$ROOT/.local"
KAFKA_HOME="${KAFKA_HOME:-$(brew --prefix kafka 2>/dev/null || echo /opt/kafka)}"
RABBIT_HOME="${RABBIT_HOME:-$(brew --prefix rabbitmq 2>/dev/null || echo /usr/lib/rabbitmq)}"

if [[ -f "$ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$ROOT/.env"; set +a
fi

# Extract RabbitMQ credentials from RABBITMQ_URL (amqp://user:pass@host:port/vhost)
RABBIT_URL="${RABBITMQ_URL:?RABBITMQ_URL must be set (see .env.example)}"
RABBIT_USER="$(echo "$RABBIT_URL" | sed -E 's#amqps?://([^:]+):.*#\1#')"
RABBIT_PASS="$(echo "$RABBIT_URL" | sed -E 's#amqps?://[^:]+:([^@]+)@.*#\1#')"
RABBIT_VHOST="$(echo "$RABBIT_URL" | sed -E 's#.*/([^/]*)$#\1#')"

rabbit_env() {
  export HOME="$LOCAL/rabbitmq"            # keeps .erlang.cookie inside the project
  export RABBITMQ_NODENAME="zetheta@localhost"
  export RABBITMQ_MNESIA_BASE="$LOCAL/rabbitmq/mnesia"
  export RABBITMQ_LOG_BASE="$LOCAL/rabbitmq/log"
  export RABBITMQ_ENABLED_PLUGINS_FILE="$LOCAL/rabbitmq/enabled_plugins"
  export RABBITMQ_CONFIG_FILE="$LOCAL/rabbitmq/rabbitmq"
  export RABBITMQ_NODE_IP_ADDRESS=127.0.0.1
  export RABBITMQ_NODE_PORT=5672
  export CONF_ENV_FILE=/dev/null
}

kafka_start() {
  mkdir -p "$LOCAL/kafka/data" "$LOCAL/kafka/logs"
  local props="$LOCAL/kafka/server.properties"
  cat > "$props" <<EOF
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@127.0.0.1:9093
listeners=PLAINTEXT://127.0.0.1:9092,CONTROLLER://127.0.0.1:9093
advertised.listeners=PLAINTEXT://127.0.0.1:9092
controller.listener.names=CONTROLLER
listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
inter.broker.listener.name=PLAINTEXT
log.dirs=$LOCAL/kafka/data
num.partitions=6
offsets.topic.replication.factor=1
transaction.state.log.replication.factor=1
transaction.state.log.min.isr=1
group.initial.rebalance.delay.ms=0
auto.create.topics.enable=false
log.retention.hours=168
EOF
  if [[ ! -f "$LOCAL/kafka/data/meta.properties" ]]; then
    "$KAFKA_HOME/bin/kafka-storage" format -t "$("$KAFKA_HOME/bin/kafka-storage" random-uuid)" -c "$props" >/dev/null
  fi
  if nc -z 127.0.0.1 9092 2>/dev/null; then echo "kafka: already listening on 9092"; return; fi
  LOG_DIR="$LOCAL/kafka/logs" KAFKA_HEAP_OPTS="-Xmx512m -Xms256m" \
    "$KAFKA_HOME/bin/kafka-server-start" -daemon "$props"
  for _ in $(seq 1 60); do nc -z 127.0.0.1 9092 2>/dev/null && { echo "kafka: up on 9092"; return; }; sleep 1; done
  echo "kafka: failed to start, see $LOCAL/kafka/logs" >&2; exit 1
}

rabbit_start() {
  mkdir -p "$LOCAL/rabbitmq/mnesia" "$LOCAL/rabbitmq/log"
  echo "[rabbitmq_management]." > "$LOCAL/rabbitmq/enabled_plugins"
  cat > "$LOCAL/rabbitmq/rabbitmq.conf" <<EOF
listeners.tcp.default = 127.0.0.1:5672
management.tcp.port = 15672
management.tcp.ip = 127.0.0.1
loopback_users.guest = true
EOF
  rabbit_env
  if nc -z 127.0.0.1 5672 2>/dev/null; then echo "rabbitmq: already listening on 5672"; else
    "$RABBIT_HOME/sbin/rabbitmq-server" -detached
    for _ in $(seq 1 60); do "$RABBIT_HOME/sbin/rabbitmqctl" -q await_startup >/dev/null 2>&1 && break; sleep 1; done
    echo "rabbitmq: up on 5672 (management on 15672)"
  fi
  local ctl="$RABBIT_HOME/sbin/rabbitmqctl"
  "$ctl" -q add_vhost "$RABBIT_VHOST" 2>/dev/null || true
  "$ctl" -q add_user "$RABBIT_USER" "$RABBIT_PASS" 2>/dev/null || "$ctl" -q change_password "$RABBIT_USER" "$RABBIT_PASS"
  "$ctl" -q set_user_tags "$RABBIT_USER" management
  "$ctl" -q set_permissions -p "$RABBIT_VHOST" "$RABBIT_USER" ".*" ".*" ".*"
  # Test suites create isolated vhosts under the same user.
  "$ctl" -q set_user_tags "$RABBIT_USER" management policymaker
}

case "${1:-}" in
  start) kafka_start; rabbit_start ;;
  stop)
    "$KAFKA_HOME/bin/kafka-server-stop" 2>/dev/null || true
    (rabbit_env; "$RABBIT_HOME/sbin/rabbitmqctl" -q stop 2>/dev/null || true)
    echo "stopped" ;;
  status)
    nc -z 127.0.0.1 9092 && echo "kafka: up" || echo "kafka: down"
    nc -z 127.0.0.1 5672 && echo "rabbitmq: up" || echo "rabbitmq: down"
    pg_isready -q && echo "postgres: up" || echo "postgres: down"
    redis-cli ping >/dev/null 2>&1 && echo "redis: up" || echo "redis: down" ;;
  reset)
    "$0" stop; rm -rf "$LOCAL/kafka" "$LOCAL/rabbitmq"; echo "local broker data removed" ;;
  *) echo "usage: $0 start|stop|status|reset" >&2; exit 2 ;;
esac
