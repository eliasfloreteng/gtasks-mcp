import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(process.cwd(), ".env");

let cachedKey: string | null = null;

export async function loadOrCreateApiKey(): Promise<{ key: string; generated: boolean }> {
  const existing = process.env.API_KEY?.trim();
  if (existing) {
    cachedKey = existing;
    return { key: existing, generated: false };
  }

  const key = crypto.randomBytes(32).toString("hex");
  const line = `API_KEY=${key}\n`;

  let current = "";
  try {
    current = await fs.readFile(ENV_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const trimmed = current.replace(/API_KEY=\s*\n?/g, "");
  const next = trimmed.length > 0 && !trimmed.endsWith("\n") ? trimmed + "\n" + line : trimmed + line;
  await fs.writeFile(ENV_PATH, next, { mode: 0o600 });

  process.env.API_KEY = key;
  cachedKey = key;
  return { key, generated: true };
}

export function getApiKey(): string {
  if (!cachedKey) throw new Error("API key not initialised — call loadOrCreateApiKey() first.");
  return cachedKey;
}

export function checkApiKey(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const expected = getApiKey();
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function extractKeyFromHeader(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1]!.trim() : null;
}
