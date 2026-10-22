import { pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pool, query } from "./db.ts";
import {
  searchActiveListings,
  type ListingRow,
} from "./listings.ts";
import { parsePropertyQuery, type PropertyFilters } from "./parser.ts";
import {
  clearSession,
  getSession,
  updateSession,
  type UserSession,
} from "./session.ts";

function missingQuestion(session: UserSession): string | null {
  if (!session.city) return "Which city are you looking in?";
  if (session.maxPrice == null) return "What is your budget?";
  if (!session.type && !session.anyType) {
    return "Any preferences — condo, townhome, or single family?";
  }
  return null;
}

function questionKind(question: string): UserSession["awaiting"] {
  if (question.startsWith("Which city")) return "city";
  if (question.startsWith("What is your budget")) return "budget";
  return "type";
}

function typeFromAnswer(text: string): string | "any" | null {
  const q = text.toLowerCase();
  if (/single[\s-]*family|\bhouses?\b/.test(q)) return "SingleFamilyResidence";
  if (/town[\s-]*ho(?:me|use)/.test(q)) return "Townhouse";
  if (/\bcondos?\b|\bcondominiums?\b/.test(q)) return "Condominium";
  if (/\b(any|either|anything|no preference|whatever)\b/.test(q)) return "any";
  return null;
}

async function cityFromText(text: string): Promise<string | null> {
  const name = text.trim().replace(/[?.!]/g, "");
  if (!/^[A-Za-z]+(?:\s+[A-Za-z]+){0,2}$/.test(name)) return null;
  const rows = await query<{ c: number }>(
    "SELECT COUNT(*) AS c FROM rets_property WHERE LOWER(L_City) = LOWER(?)",
    [name]
  );
  return Number(rows[0]?.c) > 0 ? name : null;
}

function remembered(session: UserSession): string {
  return JSON.stringify({
    city: session.city ?? null,
    maxPrice: session.maxPrice ?? null,
    beds: session.beds ?? null,
    baths: session.baths ?? null,
    sqft: session.sqft ?? null,
    type: session.type ?? null,
    anyType: session.anyType ?? false,
    pool: session.pool ?? null,
    hasView: session.hasView ?? null,
  });
}

function describe(session: UserSession): string {
  const bits = [
    session.city,
    session.maxPrice != null
      ? `under $${Number(session.maxPrice).toLocaleString("en-US")}`
      : null,
    session.type ?? (session.anyType ? "any type" : null),
    session.beds ? `${session.beds}+ beds` : null,
    session.baths ? `${session.baths}+ baths` : null,
    session.sqft ? `${Number(session.sqft).toLocaleString("en-US")}+ sqft` : null,
    session.pool ? "pool" : null,
    session.hasView ? "view" : null,
  ];
  return bits.filter(Boolean).join(", ");
}

function applyTurn(userId: string, filters: PropertyFilters): UserSession {
  const current = getSession(userId);
  return updateSession(userId, {
    ...(filters.city ? { city: filters.city } : {}),
    ...(filters.maxPrice ? { maxPrice: filters.maxPrice } : {}),
    ...(filters.beds ? { beds: filters.beds } : {}),
    ...(filters.baths ? { baths: filters.baths } : {}),
    ...(filters.sqft ? { sqft: filters.sqft } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.pool ? { pool: filters.pool } : {}),
    ...(filters.hasView ? { hasView: filters.hasView } : {}),
    conversationStep: current.conversationStep + 1,
  });
}

function count(value: number | null): string {
  if (value == null) return "n/a";
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : String(n);
}

function card(listing: ListingRow): string {
  const price = `$${Number(listing.price).toLocaleString("en-US")}`;
  const photos = listing.PhotoCount ?? 0;
  return `${listing.L_Address}, ${listing.L_City}\n${price} | ${count(listing.beds)} bd / ${count(listing.baths)} ba | ${photos} photos`;
}

export async function handleMessage(
  userId: string,
  message: string
): Promise<string> {
  const text = message.trim();
  if (!text) return "Tell me what you're looking for.";
  if (/^(clear|reset|start over)$/i.test(text)) {
    clearSession(userId);
    return "Started a new search. Which city are you looking in?";
  }

  const before = getSession(userId);
  let filters = await parsePropertyQuery(text);

  if (!filters.city) {
    const city = await cityFromText(text);
    if (city) filters = { ...filters, city };
  }

  const answeredType = before.awaiting === "type" ? typeFromAnswer(text) : null;
  if (answeredType && answeredType !== "any") {
    filters = { ...filters, type: answeredType };
  }

  const cityChanged =
    filters.city != null &&
    before.city != null &&
    filters.city.toLowerCase() !== before.city.toLowerCase();
  if (before.lastResults && cityChanged) clearSession(userId);

  let session = applyTurn(userId, filters);
  if (answeredType === "any") {
    session = updateSession(userId, { type: undefined, anyType: true });
  } else if (filters.type) {
    session = updateSession(userId, { anyType: false });
  }

  if (before.lastResults && remembered(before) === remembered(session)) {
    return "That didn't change the search. Give a city, a budget like $900k, a bed count, or condo, townhome, or single family.";
  }

  const question = missingQuestion(session);
  if (question) {
    updateSession(userId, { awaiting: questionKind(question) });
    return question;
  }

  const searchFilters: PropertyFilters = {
    city: session.city ?? null,
    maxPrice: session.maxPrice ?? null,
    beds: session.beds ?? null,
    baths: session.baths ?? null,
    sqft: session.sqft ?? null,
    type: session.anyType ? null : (session.type ?? null),
    pool: session.pool ?? null,
    hasView: session.hasView ?? null,
  };
  const rows = await searchActiveListings(searchFilters);
  updateSession(userId, { lastResults: rows, awaiting: undefined });
  if (!rows.length) {
    return `${describe(session)}\n\nNo active listings matched. You can change the budget, beds, or property type.`;
  }
  return `${describe(session)}\n\n${rows.map(card).join("\n\n")}`;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const userId = "local";
  const rl = readline.createInterface({ input, output });
  console.log("Property search. 'clear' starts over, 'quit' exits.\n");
  rl.setPrompt("You: ");
  rl.prompt();
  for await (const line of rl) {
    if (/^(quit|exit)$/i.test(line.trim())) break;
    console.log(`Agent: ${await handleMessage(userId, line)}\n`);
    if (!input.readableEnded) rl.prompt();
  }
  rl.close();
  await pool.end();
}
