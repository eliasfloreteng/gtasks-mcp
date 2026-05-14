import http from "node:http";
import { URL } from "node:url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  exchangeCodeForTokens,
  generateAuthUrl,
  getAuthedClient,
  loadStoredTokens,
  NotAuthenticatedError,
} from "./auth.js";
import { checkApiKey, extractKeyFromHeader, loadOrCreateApiKey } from "./apikey.js";
import {
  formatGroupedTasksMarkdown,
  getGroupedTasks,
  listTaskLists,
} from "./tasks.js";
import { buildMcpServer } from "./mcp.js";

const PORT = Number(process.env.PORT ?? 8787);

const transports = new Map<string, SSEServerTransport>();

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res: http.ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function unauthorized(res: http.ServerResponse): void {
  sendJson(res, 401, { error: "unauthorized", hint: "Provide Authorization: Bearer <API_KEY> or ?key=<API_KEY>." });
}

function reqKey(url: URL, req: http.IncomingMessage): string | null {
  const fromHeader = extractKeyFromHeader(req.headers["authorization"] as string | undefined);
  if (fromHeader) return fromHeader;
  return url.searchParams.get("key");
}

async function handleRestTasks(url: URL, res: http.ServerResponse): Promise<void> {
  try {
    const auth = await getAuthedClient();
    const includeCompleted = url.searchParams.get("include_completed") === "true";
    const grouped = await getGroupedTasks(auth, includeCompleted);
    if (url.searchParams.get("format") === "markdown") {
      sendText(res, 200, formatGroupedTasksMarkdown(grouped), "text/markdown; charset=utf-8");
    } else {
      sendJson(res, 200, grouped);
    }
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      sendJson(res, 503, { error: "not_authenticated", authUrl: err.authUrl });
    } else {
      sendJson(res, 500, { error: "internal", message: (err as Error).message });
    }
  }
}

async function handleRestLists(res: http.ServerResponse): Promise<void> {
  try {
    const auth = await getAuthedClient();
    const lists = await listTaskLists(auth);
    sendJson(res, 200, { lists });
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      sendJson(res, 503, { error: "not_authenticated", authUrl: err.authUrl });
    } else {
      sendJson(res, 500, { error: "internal", message: (err as Error).message });
    }
  }
}

async function handleAuthCallback(url: URL, res: http.ServerResponse): Promise<void> {
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) {
    sendText(res, 400, `OAuth error: ${err}`);
    return;
  }
  if (!code) {
    sendText(res, 400, "Missing ?code parameter.");
    return;
  }
  try {
    await exchangeCodeForTokens(code);
    sendText(
      res,
      200,
      `<!doctype html><meta charset="utf-8"><title>gtasks-mcp</title>
<body style="font-family:system-ui;padding:2rem;max-width:40rem">
<h2>✓ Authenticated</h2>
<p>The server now holds a refresh token for Google Tasks (read-only).</p>
<p>You can close this tab.</p>
</body>`,
      "text/html; charset=utf-8",
    );
  } catch (e) {
    sendText(res, 500, `Failed to exchange code: ${(e as Error).message}`);
  }
}

async function handleIndex(res: http.ServerResponse): Promise<void> {
  const authed = await loadStoredTokens();
  const status = authed ? "linked to Google" : "NOT linked to Google";
  const body = `<!doctype html><meta charset="utf-8"><title>gtasks-mcp</title>
<body style="font-family:system-ui;padding:2rem;max-width:40rem;line-height:1.5">
<h2>gtasks-mcp</h2>
<p><b>Status:</b> ${status}.</p>
${authed ? "" : `<p><a href="/auth/start">→ Authorize with Google</a> (one time).</p>`}
<p>REST: <code>GET /tasks</code> &middot; <code>GET /lists</code> (Authorization: Bearer &lt;API_KEY&gt;)</p>
<p>MCP (SSE): <code>http://localhost:${PORT}/mcp/&lt;API_KEY&gt;/sse</code></p>
<p>The API key lives in <code>./.env</code>.</p>
</body>`;
  sendText(res, 200, body, "text/html; charset=utf-8");
}

async function handleSse(key: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkApiKey(key)) {
    unauthorized(res);
    return;
  }
  const postEndpoint = `/mcp/${encodeURIComponent(key)}/messages`;
  const transport = new SSEServerTransport(postEndpoint, res);
  const server = buildMcpServer();
  transports.set(transport.sessionId, transport);
  transport.onclose = () => {
    transports.delete(transport.sessionId);
  };
  req.on("close", () => {
    transports.delete(transport.sessionId);
  });
  await server.connect(transport);
}

async function handleSseMessage(
  key: string,
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!checkApiKey(key)) {
    unauthorized(res);
    return;
  }
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    sendJson(res, 400, { error: "missing sessionId" });
    return;
  }
  const transport = transports.get(sessionId);
  if (!transport) {
    sendJson(res, 404, { error: "unknown sessionId" });
    return;
  }
  await transport.handlePostMessage(req, res);
}

async function router(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/") return handleIndex(res);
  if (method === "GET" && pathname === "/auth/start") {
    res.writeHead(302, { location: generateAuthUrl() });
    res.end();
    return;
  }
  if (method === "GET" && pathname === "/auth/callback") return handleAuthCallback(url, res);

  const mcpMatch = /^\/mcp\/([^/]+)\/(sse|messages)$/.exec(pathname);
  if (mcpMatch) {
    const [, rawKey, leaf] = mcpMatch;
    const key = decodeURIComponent(rawKey!);
    if (leaf === "sse" && method === "GET") return handleSse(key, req, res);
    if (leaf === "messages" && method === "POST") return handleSseMessage(key, url, req, res);
    res.writeHead(405);
    res.end();
    return;
  }

  if ((pathname === "/tasks" || pathname === "/lists") && method === "GET") {
    if (!checkApiKey(reqKey(url, req))) return unauthorized(res);
    if (pathname === "/tasks") return handleRestTasks(url, res);
    return handleRestLists(res);
  }

  sendJson(res, 404, { error: "not_found", path: pathname });
}

async function main(): Promise<void> {
  const { key, generated } = await loadOrCreateApiKey();
  await loadStoredTokens().catch(() => false);

  const server = http.createServer((req, res) => {
    router(req, res).catch((err) => {
      try {
        sendJson(res, 500, { error: "internal", message: (err as Error).message });
      } catch {
        /* response already sent */
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`gtasks-mcp listening on http://localhost:${PORT}`);
    if (generated) {
      console.log("┌── gtasks-mcp ──");
      console.log("│ Generated server API key and saved to .env.");
      console.log(`│   MCP (SSE):  http://localhost:${PORT}/mcp/${key}/sse`);
      console.log(`│   REST:       Authorization: Bearer ${key}`);
      console.log("│ The key lives in ./.env (gitignored). Don't commit it.");
      console.log("└────");
    } else {
      console.log(`MCP URL:  http://localhost:${PORT}/mcp/<API_KEY>/sse`);
      console.log("(API_KEY is in ./.env)");
    }
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      console.warn("⚠ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in .env. Create an OAuth client first; see README.");
    } else {
      console.log(`Authorize once at http://localhost:${PORT}/auth/start`);
    }
  });
}

void main();
