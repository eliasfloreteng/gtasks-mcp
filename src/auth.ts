import { google } from "googleapis";
import type { OAuth2Client, Credentials } from "google-auth-library";
import { promises as fs } from "node:fs";
import path from "node:path";

const TOKENS_PATH = path.resolve(process.cwd(), "tokens.json");
const SCOPES = ["https://www.googleapis.com/auth/tasks.readonly"];

export class NotAuthenticatedError extends Error {
  constructor(public readonly authUrl: string) {
    super(`Not authenticated with Google. Visit ${authUrl} to authorize.`);
    this.name = "NotAuthenticatedError";
  }
}

let oauth2Client: OAuth2Client | null = null;
let tokensLoaded = false;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. See .env.example.`);
  return v;
}

export function getRedirectUri(): string {
  const override = process.env.OAUTH_REDIRECT_URI?.trim();
  if (override) return override;
  const port = process.env.PORT ?? "8787";
  return `http://localhost:${port}/auth/callback`;
}

export function getOAuth2Client(): OAuth2Client {
  if (oauth2Client) return oauth2Client;
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const client = new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());

  client.on("tokens", (incoming) => {
    void persistTokens(incoming, /* merge */ true);
  });

  oauth2Client = client;
  return client;
}

async function readTokensFile(): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(TOKENS_PATH, "utf8");
    return JSON.parse(raw) as Credentials;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function persistTokens(next: Credentials, merge: boolean): Promise<void> {
  const existing = merge ? ((await readTokensFile()) ?? {}) : {};
  const merged: Credentials = { ...existing, ...next };
  await fs.writeFile(TOKENS_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
  const client = getOAuth2Client();
  client.setCredentials(merged);
}

export async function loadStoredTokens(): Promise<boolean> {
  if (tokensLoaded) return true;
  const stored = await readTokensFile();
  if (!stored) return false;
  getOAuth2Client().setCredentials(stored);
  tokensLoaded = true;
  return true;
}

export function generateAuthUrl(): string {
  return getOAuth2Client().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  await persistTokens(tokens, /* merge */ true);
  tokensLoaded = true;
}

export async function getAuthedClient(): Promise<OAuth2Client> {
  const ok = await loadStoredTokens();
  if (!ok) {
    throw new NotAuthenticatedError(`http://localhost:${process.env.PORT ?? "8787"}/auth/start`);
  }
  return getOAuth2Client();
}
