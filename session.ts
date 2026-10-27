import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ListingRow } from "./listings.ts";

export interface UserSession {
  city?: string;
  maxPrice?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  type?: string;
  pool?: string;
  hasView?: string;
  anyType?: boolean;
  awaiting?: "city" | "budget" | "type" | "market";
  marketQuestion?: string;
  lastResults?: ListingRow[];
  conversationStep: number;
}

const storePath = resolve(dirname(fileURLToPath(import.meta.url)), ".session-store.json");

function loadSessions(): Map<string, UserSession> {
  if (!existsSync(storePath)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, UserSession>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function saveSessions(sessions: Map<string, UserSession>): void {
  writeFileSync(storePath, JSON.stringify(Object.fromEntries(sessions)));
}

const sessions = loadSessions();

export function getSession(userId: string): UserSession {
  if (!sessions.has(userId)) {
    sessions.set(userId, { conversationStep: 0 });
    saveSessions(sessions);
  }
  return sessions.get(userId)!;
}

export function updateSession(
  userId: string,
  updates: Partial<UserSession>
): UserSession {
  const session = getSession(userId);
  const next = { ...session, ...updates };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete next[key as keyof UserSession];
  }
  sessions.set(userId, next);
  saveSessions(sessions);
  return next;
}

export function clearSession(userId: string): void {
  sessions.delete(userId);
  saveSessions(sessions);
}
