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
  awaiting?: "city" | "budget" | "type";
  lastResults?: ListingRow[];
  conversationStep: number;
}

const sessions = new Map<string, UserSession>();

export function getSession(userId: string): UserSession {
  if (!sessions.has(userId)) {
    sessions.set(userId, { conversationStep: 0 });
  }
  return sessions.get(userId)!;
}

export function updateSession(
  userId: string,
  updates: Partial<UserSession>
): UserSession {
  const session = getSession(userId);
  const next = { ...session, ...updates };
  sessions.set(userId, next);
  return next;
}

export function clearSession(userId: string): void {
  sessions.delete(userId);
}
