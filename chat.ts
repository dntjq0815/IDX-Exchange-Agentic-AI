import { pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pool, query } from "./db.ts";
import {
  searchActiveListings,
  type ListingRow,
} from "./listings.ts";
import {
  answerMarketQuestion,
  cityNameOnly,
  formatTable,
  isMarketQuestion,
} from "./market.ts";
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

function clip(value: string, max = 34): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

export function sampleQuestions(): string {
  return [
    "A few questions you can ask:",
    "",
    "How's the trend in Irvine?",
    "Is the price rising or decreasing in Pasadena?",
    "How's the average price from Mar 2026 to May 2026 in Pasadena?",
    "What's the average price per sqft in San Diego?",
    "How many days are homes sitting in Irvine?",
    "Is it a good time to buy in Irvine?",
    "3-bedroom condos in Irvine under $1.5M with a pool",
  ].join("\n");
}

function wantsExamples(text: string): boolean {
  if (/^(hi|hello|hey|help|examples?|menu|\?)$/i.test(text)) return true;
  if (text.length > 80) return false;
  return /\b(sample questions|example questions|what can i ask|what can you do|what should i ask)\b/i.test(text);
}

function listingTable(rows: ListingRow[]): string {
  return formatTable(
    ["Price", "Bd", "Ba", "Address"],
    rows.map((listing) => [
      `$${Number(listing.price).toLocaleString("en-US")}`,
      count(listing.beds),
      count(listing.baths),
      clip(`${listing.L_Address}, ${listing.L_City}`),
    ])
  );
}

export async function handleMessage(
  userId: string,
  message: string
): Promise<string> {
  const text = message.trim();
  if (!text) return `Tell me what you're looking for.\n\n${sampleQuestions()}`;
  if (wantsExamples(text)) return sampleQuestions();
  if (/^(clear|reset|start over)$/i.test(text)) {
    clearSession(userId);
    return `Started a new search. Which city are you looking in?\n\n${sampleQuestions()}`;
  }

  const before = getSession(userId);
  if (isMarketQuestion(text)) {
    const answer = await answerMarketQuestion(text);
    if (!answer) {
      updateSession(userId, { awaiting: "market", marketQuestion: text });
      return "Which city do you want the market stats for?";
    }
    updateSession(userId, { awaiting: undefined, marketQuestion: undefined });
    return answer;
  }
  if (before.awaiting === "market") {
    const city = await cityNameOnly(text);
    if (city) {
      const question = before.marketQuestion ? `${before.marketQuestion} ${city}` : city;
      updateSession(userId, { awaiting: undefined, marketQuestion: undefined });
      return (await answerMarketQuestion(question)) ?? `I don't have sales for ${city}.`;
    }
    updateSession(userId, { awaiting: undefined, marketQuestion: undefined });
  }

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
    if (before.conversationStep === 0 && !before.city && before.maxPrice == null) {
      return `${question}\n\n${sampleQuestions()}`;
    }
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
  return `${describe(session)}\n${rows.length} active listings\n\n${listingTable(rows)}`;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const userId = "local";
  const rl = readline.createInterface({ input, output });
  console.log(`${sampleQuestions()}\n`);
  console.log("Property search. 'clear' starts over, 'help' shows the examples, 'quit' exits.\n");
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
