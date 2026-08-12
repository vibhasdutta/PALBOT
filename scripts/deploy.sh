#!/usr/bin/env bash
# Deploys palworld-bot only -- never touches the palworld game server process.
# If the bot is already registered with PM2, restarts it in place instead of
# `pm2 start deploy/ecosystem.config.js`, which has been observed to send the
# *other* app a stray SIGINT when run against an already-running process.
set -euo pipefail
cd "$(dirname "$0")/.."

npm test

if pm2 describe palworld-bot > /dev/null 2>&1; then
  echo "palworld-bot already running -- restarting in place"
  pm2 restart palworld-bot
else
  echo "palworld-bot not running -- starting fresh"
  pm2 start deploy/ecosystem.config.js --only palworld-bot
fi

pm2 save
