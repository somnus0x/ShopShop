#!/bin/sh
set -eu
export POC_DATA_DIR=/Users/timeff/Code/sea-hackathon/.data
exec /usr/local/bin/node /Users/timeff/Code/sea-hackathon/src/server.mjs --stdio
