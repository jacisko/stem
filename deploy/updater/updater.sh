#!/bin/sh
# Upgrades the stem container to the version the server asks for.
#
# The server (src/server/upgrade.ts) cannot replace its own image, so it writes
# the version it wants to request.json in a volume the two share, and this
# script does the rest with the docker socket:
#
#   1. pull the release image for that version (the old server keeps running)
#   2. stop the server and back its state up with the OLD image, into
#      $STEM_BACKUP_DIR (the newest three are kept)
#   3. pin STEM_TAG in .env to the new version and start the server again
#   4. wait for the new server to say, in server.json, that it is that version;
#      if it does not within two minutes, pin the old tag back and start that
#
# What it reports goes to status.json, rewritten every few seconds so the server
# can tell a working updater from one that is gone.
#
# The request is the only input from the server, and it is a version string, so
# it is checked against a strict pattern before it gets near a command line.

set -u

DIR=/run/stem-updater
PROJECT=${STEM_DIR:?the compose project directory, mounted at the same path}
IMAGE=${STEM_IMAGE:-ghcr.io/join3r/stem-server}
ENV_FILE="$PROJECT/.env"
LOG=/tmp/stem-updater.log
READY_TIMEOUT=120

STATE=idle
VERSION=
DETAIL=

dc() { docker compose --project-directory "$PROJECT" "$@"; }

# Keep a detail JSON-safe: we write status.json with printf, not a JSON tool.
clean() { printf '%s' "$1" | tr -d '"\\' | tr '\n\r\t' '   ' | cut -c1-300; }

write_status() {
  printf '{"state":"%s","version":"%s","detail":"%s","heartbeat":%s}\n' \
    "$STATE" "$VERSION" "$(clean "$DETAIL")" "$(date +%s)" >"$DIR/status.json.tmp" &&
    mv "$DIR/status.json.tmp" "$DIR/status.json"
}

say() {
  STATE=$1 VERSION=$2 DETAIL=$3
  echo "[stem-updater] $STATE $VERSION $DETAIL"
  write_status
}

last_line() { tail -n 1 "$LOG" 2>/dev/null; }

current_tag() {
  tag=$(sed -n 's/^STEM_TAG=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
  echo "${tag:-latest}"
}

set_tag() {
  touch "$ENV_FILE"
  if grep -q '^STEM_TAG=' "$ENV_FILE"; then
    sed -i "s/^STEM_TAG=.*/STEM_TAG=$1/" "$ENV_FILE"
  else
    printf '\nSTEM_TAG=%s\n' "$1" >>"$ENV_FILE"
  fi
}

running_version() {
  sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$DIR/server.json" 2>/dev/null
}

wait_for() {
  i=0
  while [ "$i" -lt "$READY_TIMEOUT" ]; do
    [ "$(running_version)" = "$1" ] && return 0
    sleep 2
    i=$((i + 2))
    write_status
  done
  return 1
}

upgrade() {
  v=$1
  old=$(current_tag)

  say working "$v" "Downloading $v"
  if ! docker pull "$IMAGE:$v" >"$LOG" 2>&1; then
    say failed "$v" "Could not download $IMAGE:$v. $(last_line)"
    return
  fi

  say working "$v" "Backing up"
  dc stop stem >"$LOG" 2>&1
  stamp=$(date +%Y%m%d-%H%M%S)
  if ! dc run --rm --no-deps -T --entrypoint sh stem -c \
    "node dist/main/server.js export /var/lib/stem/backups/before-$v-$stamp.tar &&
     ls -1t /var/lib/stem/backups/before-*.tar | tail -n +4 | xargs -r rm -f" >"$LOG" 2>&1; then
    dc up -d --no-build stem >/dev/null 2>&1
    say failed "$v" "The backup failed, so nothing was changed. $(last_line)"
    return
  fi

  say working "$v" "Starting $v"
  set_tag "$v"
  if dc up -d --no-build stem >"$LOG" 2>&1 && wait_for "$v"; then
    say idle "$v" "Upgraded from $old"
    return
  fi

  # Whatever the new server last said is the likeliest reason it did not come up.
  reason=$(dc logs --no-log-prefix --tail 1 stem 2>/dev/null | tail -n 1)
  set_tag "$old"
  dc up -d --no-build stem >/dev/null 2>&1
  say failed "$v" "$v did not start, so the server went back to $old. $reason"
}

mkdir -p "$DIR"
say idle "" ""

while :; do
  if [ -f "$DIR/request.json" ]; then
    v=$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$DIR/request.json")
    rm -f "$DIR/request.json"
    if printf '%s' "$v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
      upgrade "$v"
    else
      say failed "" "Ignored a request for a version that is not one"
    fi
  fi
  write_status
  sleep 5
done
