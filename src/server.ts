import express, { Request, Response } from 'express';
import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import { existsSync, statSync, readFileSync } from 'fs';
import https from 'https';
import path from 'path';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Allow cross-origin requests from hosted frontends
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

const log = (endpoint: string, label: string, extra?: Record<string, unknown>) => {
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const extras = extra ? '  ' + Object.entries(extra).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : '';
  console.log(`[${time}] ${endpoint.padEnd(24)} ${label}${extras}`);
};

const CLAUDE_BIN = '/Users/schmidbr/.local/bin/claude';
const CLAUDE_BASE_ARGS = ['--output-format', 'stream-json', '--verbose'];
const CLAUDE_CHAT_ARGS = ['--output-format', 'stream-json', '--verbose', '--tools', '', '--no-session-persistence'];
const SPAWN_OPTS: SpawnOptionsWithoutStdio = { stdio: ['ignore', 'pipe', 'pipe'] };

// ─── Webapp endpoint ──────────────────────────────────────────────────────────

app.post('/run', (req: Request, res: Response) => {
  const { prompt, directory, session_id } = req.body as { prompt?: string; directory?: string; session_id?: string };

  if (!prompt?.trim()) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  const cwd = directory?.trim()
    ? path.resolve(directory.trim().replace(/^~/, process.env.HOME ?? ''))
    : process.cwd();

  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    res.status(400).json({ error: `Directory not found: ${cwd}` });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  log('POST /run', '→ claude', { cwd, session_id, prompt: prompt.slice(0, 80) });

  const args = ['-p', prompt, ...CLAUDE_BASE_ARGS, '--include-partial-messages'];
  if (session_id) args.push('--resume', session_id);

  const claude = spawn(CLAUDE_BIN, args, { ...SPAWN_OPTS, cwd });

  claude.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);
        // Surface session ID to the client on init
        if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
          send({ type: 'session', session_id: evt.session_id });
        }
        send(evt);
      } catch { send({ type: 'raw', text: trimmed }); }
    }
  });

  claude.stderr.on('data', (chunk: Buffer) => {
    send({ type: 'stderr', text: chunk.toString() });
  });

  claude.on('close', (code, signal) => {
    log('POST /run', '← done', { code, signal });
    send({ type: 'done', code });
    res.end();
  });

  res.on('close', () => claude.kill());
});

// ─── OpenAI-compatible endpoint ───────────────────────────────────────────────

interface OAIMessage { role: string; content: string }

app.post('/v1/chat/completions', (req: Request, res: Response) => {
  const { messages, stream, model } = req.body as {
    messages?: OAIMessage[];
    stream?: boolean;
    model?: string;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
    return;
  }

  const prompt = messages
    .map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System'}: ${m.content}`)
    .join('\n');

  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const responseModel = model ?? 'claude';
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';

  log('POST /v1/chat/completions', '→ claude', { stream: !!stream, model: responseModel, msg: lastUserMsg.slice(0, 80) });

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendChunk = (delta: { role?: string; content?: string }, finish_reason: string | null = null) => {
      const chunk = { id, object: 'chat.completion.chunk', created, model: responseModel, choices: [{ index: 0, delta, finish_reason }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    sendChunk({ role: 'assistant', content: '' });

    const heartbeat = setInterval(() => sendChunk({}), 5000);

    const claude = spawn(CLAUDE_BIN, ['-p', prompt, ...CLAUDE_CHAT_ARGS, '--include-partial-messages'], SPAWN_OPTS);

    claude.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          // Real-time deltas come via stream_event → content_block_delta
          if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta') {
            const text = evt.event.delta?.text;
            if (text) sendChunk({ content: text });
          }
        } catch { /* ignore */ }
      }
    });

    claude.stderr.on('data', (chunk: Buffer) => {
      log('POST /v1/chat/completions', 'stderr', { text: chunk.toString().trim() });
    });

    claude.on('close', (code, signal) => {
      clearInterval(heartbeat);
      log('POST /v1/chat/completions', '← done', { stream: true, code, signal });
      sendChunk({}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
    });

    res.on('close', () => { clearInterval(heartbeat); claude.kill(); });

  } else {
    // Use chunked encoding + periodic whitespace to prevent client timeouts
    res.setHeader('Content-Type', 'application/json');
    const heartbeat = setInterval(() => res.write(' '), 5000);

    const claude = spawn(CLAUDE_BIN, ['-p', prompt, ...CLAUDE_CHAT_ARGS], SPAWN_OPTS);

    let fullText = '';
    let errText = '';
    let costUsd: number | undefined;

    claude.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          if (evt.type === 'result') {
            fullText = evt.result ?? '';
            costUsd = evt.total_cost_usd;
          } else if (evt.type === 'assistant') {
            for (const block of evt.message?.content ?? [])
              if (block.type === 'text') fullText = block.text;
          }
        } catch { /* ignore */ }
      }
    });

    claude.stderr.on('data', (chunk: Buffer) => { errText += chunk.toString(); });

    claude.on('close', (code) => {
      clearInterval(heartbeat);
      if (code !== 0 && !fullText) {
        log('POST /v1/chat/completions', '← error', { code, err: errText.slice(0, 120) });
        res.end(JSON.stringify({ error: { message: errText || `Claude exited with code ${code}`, type: 'server_error' } }));
        return;
      }
      log('POST /v1/chat/completions', '← done', { stream: false, code, cost: costUsd != null ? `$${costUsd.toFixed(4)}` : 'unknown' });
      res.end(JSON.stringify({
        id, object: 'chat.completion', created, model: responseModel,
        choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    });

  }
});

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const CERT = process.env.TLS_CERT;
const KEY  = process.env.TLS_KEY;

if (CERT && KEY) {
  https.createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, app).listen(PORT, () => {
    console.log(`claude-agent-app running at https://localhost:${PORT}`);
    console.log(`OpenAI-compatible:          https://localhost:${PORT}/v1/chat/completions`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`claude-agent-app running at http://localhost:${PORT}`);
    console.log(`OpenAI-compatible:          http://localhost:${PORT}/v1/chat/completions`);
  });
}
