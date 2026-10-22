import { pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface PropertyFilters {
  city: string | null;
  maxPrice: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  type: string | null;
  pool: string | null;
  hasView: string | null;
}

const PRICE_WORDS =
  "under|below|less than|at most|max(?:imum)?|budget(?:\\s+is)?|around|about";
const PRICE_AMOUNT = "\\$?\\s*([\\d,.]+)\\s*(k|m|mil|million)?";

function matchMaxPrice(query: string): RegExpMatchArray | null {
  const explicit = query.match(
    new RegExp(`\\b(?:${PRICE_WORDS})\\b\\s*${PRICE_AMOUNT}\\b`, "i")
  );
  if (explicit) return explicit;
  return query
    .trim()
    .match(new RegExp(`^${PRICE_AMOUNT}\\s*\\.?\\s*$`, "i"));
}

function matchPropertyType(query: string): string | null {
  const text = query.toLowerCase();
  if (/single[\s-]*family/.test(text)) return "SingleFamilyResidence";
  if (/town[\s-]*ho(?:me|use)/.test(text)) return "Townhouse";
  if (/\bcondos?\b|\bcondominiums?\b/.test(text)) return "Condominium";
  if (/\bhouses?\b/.test(text)) return "SingleFamilyResidence";
  if (/\bland\b/.test(text)) return "UnimprovedLand";
  return null;
}

function scalePrice(amount: string, suffix?: string): number | null {
  const value = Number(amount.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const unit = suffix?.toLowerCase();
  if (unit === "k") return value * 1_000;
  if (unit === "m" || unit === "mil" || unit === "million") return value * 1_000_000;
  // 1.2 means $1.2M. 900 and 1,200 mean $900k and $1.2M.
  if (value < 20) return value * 1_000_000;
  if (value < 10_000) return value * 1_000;
  return value;
}

export async function parsePropertyQuery(
  query: string
): Promise<PropertyFilters> {
  const cityMatch = query.match(
    /in ([A-Za-z\s]+?)(?:\s+under|\s+with|\s+at|$)/i
  );

  const priceMatch = matchMaxPrice(query);

  const bedsMatch = query.match(
    /(\d+)[\s-]*(bed|beds|bedroom|bedrooms)\b/i
  );

  const bathsMatch = query.match(
    /(\d+(?:\.\d+)?)[\s-]*(bath|baths|bathroom|bathrooms)\b/i
  );

  const sqftMatch = query.match(
    /([\d,]+)\s*(sqft|sq ft|square feet)\b/i
  );

  const poolMatch = /\bpool\b/i.test(query);
  const viewMatch = /\bview\b/i.test(query);

  const type = matchPropertyType(query);

  const maxPrice = priceMatch ? scalePrice(priceMatch[1] ?? "", priceMatch[2]) : null;

  return {
    city: cityMatch?.[1]?.trim() || null,
    maxPrice,
    beds: bedsMatch ? Number(bedsMatch[1]) : null,
    baths: bathsMatch ? Number(bathsMatch[1]) : null,
    sqft: sqftMatch
      ? Number((sqftMatch[1] ?? "").replace(/,/g, ""))
      : null,
    type,
    pool: poolMatch ? "True" : null,
    hasView: viewMatch ? "True" : null,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  let query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    const rl = readline.createInterface({ input, output });
    query = (await rl.question("Sentence: ")).trim();
    rl.close();
  }
  console.log(JSON.stringify(await parsePropertyQuery(query), null, 2));
}
