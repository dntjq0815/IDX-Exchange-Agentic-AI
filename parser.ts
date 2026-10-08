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

export async function parsePropertyQuery(
  query: string
): Promise<PropertyFilters> {
  const cityMatch = query.match(
    /in ([A-Za-z\s]+?)(?:\s+under|\s+with|\s+at|$)/i
  );

  const priceMatch = query.match(
    /under \$?([\d,.]+)\s*(k|m)?\b/i
  );

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

  const typeMap: Record<string, string> = {
    condo: "Condominium",
    condominium: "Condominium",
    townhome: "Townhouse",
    townhouse: "Townhouse",
    "single family": "SingleFamilyResidence",
    land: "UnimprovedLand",
  };

  const typeKey = Object.keys(typeMap).find((key) =>
    query.toLowerCase().includes(key)
  );

  let maxPrice: number | null = null;

  if (priceMatch) {
    maxPrice = Number((priceMatch[1] ?? "").replace(/,/g, ""));

    if (priceMatch[2]?.toLowerCase() === "k") {
      maxPrice *= 1000;
    }

    if (priceMatch[2]?.toLowerCase() === "m") {
      maxPrice *= 1_000_000;
    }
  }

  return {
    city: cityMatch?.[1]?.trim() || null,
    maxPrice,
    beds: bedsMatch ? Number(bedsMatch[1]) : null,
    baths: bathsMatch ? Number(bathsMatch[1]) : null,
    sqft: sqftMatch
      ? Number((sqftMatch[1] ?? "").replace(/,/g, ""))
      : null,
    type: typeKey ? (typeMap[typeKey] ?? null) : null,
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
