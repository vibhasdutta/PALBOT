#!/usr/bin/env bash
# Thin wrapper around deploy.mjs -- the interactive component picker and all
# actual deploy logic live there now. This just gives you a stable
# `bash scripts/deploy.sh` entry point (e.g. muscle memory, other tooling
# that shells out to it) without duplicating anything.
set -euo pipefail
cd "$(dirname "$0")/.."

exec node scripts/deploy.mjs "$@"
