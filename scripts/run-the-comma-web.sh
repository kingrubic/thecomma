#!/bin/zsh
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
cd /Users/vsc_agent/projects/the-comma-coffee-website
export CONVEX_AGENT_MODE=anonymous
exec /Users/vsc_agent/projects/the-comma-coffee-website/node_modules/.bin/convex dev \
  --typecheck disable \
  --tail-logs disable \
  --local-cloud-port 3240 \
  --local-site-port 3241 \
  --start "/opt/homebrew/bin/node server.mjs"
