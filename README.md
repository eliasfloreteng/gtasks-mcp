# gtasks-mcp

A small, read-only Google Tasks server for personal use. Built for a single user. Exposes the same data two ways:

- **MCP server over HTTP/SSE** — for Claude Desktop / Claude Code as a remote MCP server.
- **HTTP REST API** — for `curl` / scripts.

Scope: only `https://www.googleapis.com/auth/tasks.readonly`. The server can't modify your tasks.

## Authentication model

There are **two separate credentials**:

1. **Google OAuth** — you do this **once** in the browser. The resulting refresh token is stored in `./tokens.json` (gitignored) and the server silently refreshes access tokens forever afterwards.
2. **Server API key** — a long-lived random secret generated on first run and stored in `./.env` (gitignored). All `/tasks`, `/lists`, and `/mcp/*` routes require it. Use it as `Authorization: Bearer <KEY>` (REST) or as a path segment (MCP URL).

## One-time setup

### 1. Install

```sh
bun install
```

### 2. Create an OAuth client in Google Cloud Console

1. Go to https://console.cloud.google.com/, create (or pick) a project.
2. **APIs & Services → Library** → enable **Google Tasks API**.
3. **APIs & Services → OAuth consent screen** → set up an *External* app, add yourself as a test user.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web application**. Add this Authorized redirect URI:

   ```
   http://localhost:8787/auth/callback
   ```
5. Copy `client_id` and `client_secret`.

### 3. Configure `.env`

```sh
cp .env.example .env
# edit .env, fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
```

Leave `API_KEY` blank — it's generated on first boot and appended to `.env`.

### 4. Start the server

```sh
bun run dev
```

First boot prints the generated API key and the MCP URL **exactly once**:

```
┌── gtasks-mcp ──
│ Generated server API key and saved to .env.
│   MCP (SSE):  http://localhost:8787/mcp/<KEY>/sse
│   REST:       Authorization: Bearer <KEY>
│ The key lives in ./.env (gitignored). Don't commit it.
└────
```

### 5. Authorize with Google (one time)

Open http://localhost:8787/auth/start in your browser, complete the consent screen ("See your Google Tasks"). You should see *✓ Authenticated*. A `tokens.json` file appears in the project directory; don't commit it.

That's it — from here on, the server self-refreshes its Google access token.

## Using the REST API

```sh
KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

# Grouped JSON: one entry per task list, tasks nested by parent
curl -H "Authorization: Bearer $KEY" http://localhost:8787/tasks | jq

# Same thing rendered as markdown
curl -H "Authorization: Bearer $KEY" 'http://localhost:8787/tasks?format=markdown'

# Include completed tasks
curl -H "Authorization: Bearer $KEY" 'http://localhost:8787/tasks?include_completed=true' | jq

# Just the task-list metadata
curl -H "Authorization: Bearer $KEY" http://localhost:8787/lists | jq
```

For one-off `curl`-ing you can also pass the key as `?key=$KEY`.

### Response shape

```jsonc
{
  "fetchedAt": "2026-05-14T12:34:56.000Z",
  "lists": [
    {
      "id": "MDQzNTYy...",
      "title": "My Tasks",
      "updated": "2026-05-14T11:00:00.000Z",
      "tasks": [
        {
          "id": "...", "title": "Buy groceries", "due": "2026-05-15", "status": "needsAction", "position": "...",
          "children": [
            { "id": "...", "title": "Milk", "status": "needsAction", "position": "...", "children": [] }
          ]
        }
      ]
    }
  ]
}
```

## Using the MCP server

Add it as a remote MCP server in Claude Code:

```sh
KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
claude mcp add --transport sse gtasks "http://localhost:8787/mcp/$KEY/sse"
```

Or wire it into Claude Desktop's MCP config with the same URL.

Tools exposed:

- `list_tasks` — every task in every list, grouped (markdown + JSON).
- `list_task_lists` — just the list metadata.
- `get_tasks_in_list` — `{ list_id, include_completed? }`.

Resources:

- `gtasks://lists`
- `gtasks://lists/{listId}/tasks`

## Files in this repo

| Path             | Tracked? | Purpose                              |
| ---------------- | -------- | ------------------------------------ |
| `src/`           | yes      | Source code                          |
| `.env.example`   | yes      | Template                             |
| `.env`           | **no**   | Your `GOOGLE_*` + `API_KEY`          |
| `tokens.json`    | **no**   | Google refresh token (mode 0600)     |

## Revoking access

To fully disconnect: delete `tokens.json`, then revoke the app at https://myaccount.google.com/permissions. To rotate the server API key: delete the `API_KEY=` line from `.env` and restart — a new key is generated and the old MCP URL stops working.
