import { query } from "./db.ts";
import { findSimilarToListing, type SimilarHit } from "./embeddings.ts";
import type { ListingRow } from "./listings.ts";

export interface Recommendation {
  id: string;
  address: string;
  city: string;
  price: number;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  match: number;
  compLine: string;
}

function money(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

async function loadActive(ids: string[]): Promise<Map<string, ListingRow>> {
  if (!ids.length) return new Map();
  const marks = ids.map(() => "?").join(", ");
  const rows = await query<ListingRow>(
    `SELECT
      L_ListingID, L_DisplayId, L_Address, L_City, L_Zip,
      L_SystemPrice AS price, L_Keyword2 AS beds, LM_Dec_3 AS baths,
      LM_Int2_3 AS sqft, L_Type_ AS type, L_Status AS status,
      LMD_MP_Latitude AS lat, LMD_MP_Longitude AS lng,
      YearBuilt, AssociationFee, DaysOnMarket,
      PoolPrivateYN, ViewYN, FireplaceYN, PhotoCount,
      LA1_UserFirstName, LA1_UserLastName, LO1_OrganizationName
    FROM rets_property
    WHERE L_Status = 'Active' AND L_ListingID IN (${marks})`,
    ids
  );
  return new Map(rows.map((row) => [String(row.L_ListingID), row]));
}

async function sqlNeighbors(anchor: ListingRow): Promise<ListingRow[]> {
  const sqft = anchor.sqft == null ? null : Number(anchor.sqft);
  const beds = anchor.beds == null ? null : Number(anchor.beds);
  const price = Number(anchor.price);

  const hasSqft = sqft != null && Number.isFinite(sqft) && sqft > 0;
  const hasBeds = beds != null && Number.isFinite(beds);
  let sql = `
    SELECT
      L_ListingID, L_DisplayId, L_Address, L_City, L_Zip,
      L_SystemPrice AS price, L_Keyword2 AS beds, LM_Dec_3 AS baths,
      LM_Int2_3 AS sqft, L_Type_ AS type, L_Status AS status,
      LMD_MP_Latitude AS lat, LMD_MP_Longitude AS lng,
      YearBuilt, AssociationFee, DaysOnMarket,
      PoolPrivateYN, ViewYN, FireplaceYN, PhotoCount,
      LA1_UserFirstName, LA1_UserLastName, LO1_OrganizationName
    FROM rets_property
    WHERE L_Status = 'Active'
      AND LOWER(L_City) = LOWER(?)
      AND L_ListingID <> ?
  `;
  const params: unknown[] = [anchor.L_City, String(anchor.L_ListingID)];
  if (hasSqft && sqft !== null) {
    sql += " AND LM_Int2_3 BETWEEN ? AND ?";
    params.push(Math.round(sqft * 0.75), Math.round(sqft * 1.25));
  }
  
  if (hasBeds && beds !== null) {
    sql += " AND L_Keyword2 BETWEEN ? AND ?";
    params.push(beds - 1, beds + 1);
  }
  sql += " ORDER BY ABS(L_SystemPrice - ?) LIMIT 30";
  params.push(price);
  return query<ListingRow>(sql, params);
}

export interface CompValidation {
  compPrice: number | null;
  listPrice: number;
  compCount: number;
  deltaPct: number | null;
}

export async function validateWithComps(
  city: string,
  sqft: number | null,
  listPrice: number
): Promise<CompValidation> {
  const empty: CompValidation = {
    compPrice: null,
    listPrice,
    compCount: 0,
    deltaPct: null,
  };

  if (sqft == null || !Number.isFinite(sqft) || sqft <= 0) {
    return empty;
  }

  const low = sqft * 0.8;
  const high = sqft * 1.2;

  const rows = await query<{
    avg_ppsf: number | null;
    comp_count: number;
  }>(
    `SELECT
      AVG(ClosePrice / NULLIF(LivingArea, 0)) AS avg_ppsf,
      COUNT(*) AS comp_count
    FROM california_sold
    WHERE LOWER(City) = LOWER(?)
      AND PropertyType = 'Residential'
      AND CloseDate BETWEEN DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
                  AND CURDATE()
      AND ClosePrice > 0
      AND LivingArea BETWEEN ? AND ?`,
    [city, low, high]
  );

  const result = rows[0];
  const avgPpsf = Number(result?.avg_ppsf ?? 0);
  const compCount = Number(result?.comp_count ?? 0);

  if (compCount === 0 || avgPpsf <= 0) {
    return empty;
  }

  const compPrice = Math.round(avgPpsf * sqft);
  const deltaPct =
    Math.round(((listPrice - compPrice) / compPrice) * 1000) / 10;

  return {
    compPrice,
    listPrice,
    compCount,
    deltaPct,
  };
}


export async function compLine(
  city: string,
  sqft: number | null,
  listPrice: number
): Promise<string> {
  if (sqft == null || !Number.isFinite(sqft) || sqft <= 0) {
    return "No valid square footage available for comparable-sales analysis.";
  }

  const result = await validateWithComps(city, sqft, listPrice);

  if (result.compPrice === null || result.deltaPct === null) {
    return `No qualifying sold comps found in ${city} over the last 6 months.`;
  }

  const direction =
    result.deltaPct > 0
      ? "above"
      : result.deltaPct < 0
        ? "below"
        : "equal to";

  return (
    `Estimated comp value: $${result.compPrice.toLocaleString("en-US")} ` +
    `(${result.compCount} recent sales). ` +
    `Listed ${Math.abs(result.deltaPct).toFixed(1)}% ${direction} comp value.`
  );
}


export async function recommendFor(anchor: ListingRow): Promise<Recommendation[]> {
  let cosineHits: SimilarHit[] = [];
  try {
    cosineHits = await findSimilarToListing(String(anchor.L_ListingID), 30);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message !== "NO_INDEX" && message !== "NOT_IN_INDEX") throw err;
  }
  const cosineById = new Map(cosineHits.map((hit) => [hit.id, hit.score]));
  const details = await loadActive([...cosineById.keys()]);
  if (details.size < 5) {
    for (const row of await sqlNeighbors(anchor)) {
      details.set(String(row.L_ListingID), row);
    }
  }

  const ranked = [...details.values()]
    .map((row) => {
      const cosine = cosineById.get(String(row.L_ListingID)) ?? 0;
      const match = calculateSimilarityScore(anchor, row, cosine) / 100;
      return { row, match };
    })
    .sort((a, b) => b.match - a.match)
    .slice(0, 5);

  return Promise.all(ranked.map(async ({ row, match }) => ({
    id: String(row.L_ListingID),
    address: row.L_Address,
    city: row.L_City,
    price: Number(row.price),
    beds: row.beds == null ? null : Number(row.beds),
    baths: row.baths == null ? null : Number(row.baths),
    sqft: row.sqft == null ? null : Number(row.sqft),
    match,
    compLine: await compLine(row.L_City, row.sqft == null ? null : Number(row.sqft), Number(row.price)),
  })));
}


export function calculateSimilarityScore(
  target: ListingRow,
  candidate: ListingRow,
  cosineSimilarity: number
): number {
  let structured = 0;

  if (target.price != null && candidate.price != null) {
    const priceDiff = Math.abs(
      Number(target.price) - Number(candidate.price)
    );

    if (priceDiff < 50_000) structured += 20;
    else if (priceDiff < 150_000) structured += 12;
    else if (priceDiff < 300_000) structured += 5;
  }

  if (
    target.beds != null &&
    candidate.beds != null &&
    Number(target.beds) === Number(candidate.beds)
  ) {
    structured += 15;
  }

  if (
    target.L_City.toLowerCase() ===
    candidate.L_City.toLowerCase()
  ) {
    structured += 15;
  }

  if (target.sqft != null && candidate.sqft != null) {
    const sqftDiff = Math.abs(
      Number(target.sqft) - Number(candidate.sqft)
    );

    if (sqftDiff < 300) structured += 10;
    else if (sqftDiff < 700) structured += 5;
  }

  const semantic =
    Math.max(0, Math.min(1, cosineSimilarity)) * 40;

  return Math.round((structured + semantic) * 100) / 100;
}
