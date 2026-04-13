#!/bin/sh
trap 'kill 0' EXIT

npm run dev &
./cloudflared tunnel --url http://localhost:3001 &

wait
