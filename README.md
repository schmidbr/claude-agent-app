# claude-agent-app

A lightweight local gateway that exposes the [Claude Code](https://claude.ai/code) CLI as an HTTP server. Provides a built-in chat UI and an OpenAI-compatible API endpoint for use with third-party frontends.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Web chat UI |
| `POST /run` | Run a Claude task, streams SSE events |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions (streaming + non-streaming) |

## Requirements

- [Node.js](https://nodejs.org) 18+
- [Claude Code CLI](https://claude.ai/code) installed at `~/.local/bin/claude`

## Setup

```bash
npm install
npm run dev
```

Server starts at `http://localhost:3001`.

## Using with a hosted frontend

Since the server runs over HTTP locally, a hosted HTTPS frontend (e.g. [thrulines.app](https://thrulines.app)) cannot call it directly due to browser mixed content rules. Use a tunnel to expose it over HTTPS:

```bash
# Download cloudflared (Apple Silicon)
curl -L https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/cloudflared-darwin-arm64.tgz | tar -xz
chmod +x cloudflared

# Start the tunnel (in a separate terminal while npm run dev is running)
./cloudflared tunnel --url http://localhost:3001
```

Use the `https://xxxx.trycloudflare.com` URL printed by cloudflared as your gateway URL in the frontend. The URL changes each restart — use `cloudflared tunnel login` for a persistent URL.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with hot reload (tsx watch) |
| `npm start` | Start without hot reload |
