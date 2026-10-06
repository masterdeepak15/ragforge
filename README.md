# RAGForge

A self-hosted knowledge base for your documents. Upload as many files as you like, ask questions and get cited answers, and let other AI tools (Claude, Cursor, any MCP client) search the same knowledge base.

- **Unlimited uploads.** Files stream to disk, so size and count are not capped. Large files resume if the connection drops. Folders can be dropped as a whole.
- **Indexing in the background.** A persistent queue processes files with retries and survives restarts. Progress is live in the UI.
- **Ask your documents.** Hybrid search (meaning and keywords) with citations, using the AI provider you choose: Ollama, OpenAI, Anthropic, Gemini or Groq.
- **Connect other AI tools.** A built-in [MCP](https://modelcontextprotocol.io) endpoint exposes search and read tools. You create, scope and revoke API keys in the UI.
- **Light and dark themes**, keyboard-friendly (press `Ctrl+K`).

## Quick start (Docker)

```bash
cp .env.example .env
# Set JWT_SECRET and ENCRYPTION_KEY in .env (the file explains how to generate them).
docker compose up -d --build
```

Open <http://localhost:8080>. The first visit walks you through creating the admin account. Then:

1. **Settings → Add provider.** An embedding provider is required to index documents (for example Ollama with `nomic-embed-text`).
2. **Knowledge bases → New knowledge base**, then drop files onto it.
3. **Chat** with the knowledge base, or **Connect** other AI tools.

Compose refuses to start without both secrets, so a placeholder password cannot reach production. Uploads and the database live in the `ragforge-data` volume.

## Run from source

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env            # development works without secrets (with warnings)
npm run dev:server              # API on http://localhost:8080
npm run dev:web                 # UI on http://localhost:5173 (proxies /api and /mcp)
```

Production build: `npm run build`, then `node packages/server/bin/ragforge.js`.

```bash
npm test          # server and web test suites
npm run typecheck
```

## Connect other AI tools (MCP)

Open **Connect** in the app. Create an API key, choose which knowledge bases it may read, and copy the setup for your client. The key is shown once.

The endpoint is `POST /mcp` (Streamable HTTP) with `Authorization: Bearer rf_…`. It is read-only and offers:

| Tool | What it does |
|---|---|
| `list_knowledge_bases` | The knowledge bases this key can search, with counts |
| `search_knowledge` | Hybrid search; returns chunks with their source document |
| `list_documents` | Documents in a knowledge base |
| `get_document` | A document's text, chunk by chunk |

Claude Code:

```bash
claude mcp add --transport http ragforge http://localhost:8080/mcp --header "Authorization: Bearer rf_YOUR_KEY"
```

Keys are stored hashed, can be scoped to specific knowledge bases, are rate-limited (60 requests per minute by default) and stop working the moment you revoke them. Put RAGForge behind HTTPS before exposing it beyond your machine or network.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `JWT_SECRET` | none (required in production) | Signs login tokens; 32+ random characters |
| `ENCRYPTION_KEY` | none (required in production) | Encrypts provider credentials; 64 hex characters. Back it up. |
| `PORT` | `8080` | HTTP port |
| `PUBLIC_URL` | `http://localhost:PORT` | Address users reach RAGForge at |
| `DATA_DIR` | `data` (`/data` in Docker) | Where uploaded files are stored |
| `SQLITE_URL` | `file:./ragforge.db` (`file:/data/ragforge.db` in Docker) | Database file |
| `INGEST_CONCURRENCY` | `2` | Files indexed at once |
| `MCP_RATE_LIMIT` | `60` | MCP requests per minute per key |
| `MAX_UPLOAD_BYTES` | unset | Optional cap on one file; unset means unlimited |

In production the server refuses to start with a missing or placeholder `JWT_SECRET` or `ENCRYPTION_KEY` and lists every configuration problem at once.

Health endpoints for load balancers: `GET /api/health` (process is up) and `GET /api/ready` (database reachable and ingestion worker running).

## Scale and limits

- **Uploads:** no artificial limits. Real limits are disk space and your embedding provider's speed and cost. Indexing runs in the background at `INGEST_CONCURRENCY` files at a time; a rate-limited provider slows the queue down instead of failing it.
- **Search speed (SQLite):** each knowledge base is searched with an exact scan, which is fast and always finds the true nearest chunks. Measured on a laptop: about 110 ms at the 95th percentile for 30,000 chunks of 384 dimensions, growing roughly linearly. Expect comfortable speed up to around 100,000 chunks per knowledge base. Larger models (768+ dimensions) are proportionally slower.
- **PDF text:** only PDFs with a text layer are indexed. Scanned documents fail with a clear message ("No extractable text"); OCR is not included.
- **Supported files:** PDF, Word (`.docx`), Markdown and plain text, plus web pages by URL.

### PostgreSQL

The code includes a PostgreSQL + pgvector implementation of the search layer, but **it is not production-ready**: the request handlers still use SQLite-style queries, and the Postgres path has no automated tests. Use SQLite (the default) until that work is done.

## Backup and restore

Everything is in two places: the database and the uploaded files (both under the `ragforge-data` volume in Docker), plus your `.env` (keep `ENCRYPTION_KEY` safe).

```bash
# Backup (stop first so the database file is consistent)
docker compose stop
docker run --rm -v ragforge_ragforge-data:/data -v "$PWD":/backup alpine tar czf /backup/ragforge-backup.tgz -C /data .
docker compose start

# Restore into a fresh volume
docker compose down
docker run --rm -v ragforge_ragforge-data:/data -v "$PWD":/backup alpine sh -c "cd /data && tar xzf /backup/ragforge-backup.tgz"
docker compose up -d
```

## Troubleshooting

- **A document says "Failed … Configure an embedding provider in Settings."** Add an embedding provider in Settings and press Retry.
- **"Embedding dimension mismatch."** The embedding model changed after documents were indexed. Switch back to the original model or create a new knowledge base.
- **MCP client gets 401.** The key is wrong, revoked, or you pasted a login token instead of an `rf_…` key.
- **The page is blank after an update.** Rebuild the image so the web app and server match.

## Project layout

```
packages/
  shared/   types shared by server and web
  server/   Fastify API, ingestion queue, retrieval, MCP endpoint
  web/      React app (Vite, Tailwind, Radix, TanStack Query)
```

## License

MIT
