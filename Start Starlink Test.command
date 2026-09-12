#!/bin/bash
# Double-click this file to start the Starlink Test agent and open it in your browser.
cd "$(dirname "$0")" || exit 1

PORT=8790
URL="http://localhost:$PORT/"

if curl -s -m 2 -o /dev/null "$URL/api/health"; then
  echo "Agent already running — opening $URL"
  open "$URL"
  exit 0
fi

# Open the browser a moment after the server starts.
( sleep 2; open "$URL" ) &

echo "Starting Starlink Test agent on $URL"
echo "Leave this window open while you use the app. Press Ctrl-C to stop."
echo
exec python3 tools/starlink-agent.py --port "$PORT"
