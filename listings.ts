import { pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pool, query } from "./db.ts";
import { parsePropertyQuery, type PropertyFilters } from "./parser.ts";

const PAGE_SIZE = 10;
const MAX_ROWS = 50;

export interface ListingRow {
  L_ListingID: string;
  L_DisplayId: string;
  L_Address: string;
  L_City: string;
  L_Zip: string;
  price: number;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  type: string | null;
  status: string | null;
  lat: number | null;
  lng: number | null;
  YearBuilt: number | null;
  AssociationFee: number | null;
  DaysOnMarket: number | null;
  PoolPrivateYN: string | null;
  ViewYN: string | null;
  FireplaceYN: string | null;
  PhotoCount: number | null;
  LA1_UserFirstName: string | null;
  LA1_UserLastName: string | null;
  LO1_OrganizationName: string | null;
}

export interface SoldRow {
  ListingKey: number;
  UnparsedAddress: string | null;
  City: string | null;
  CloseDate: string | null;
  ClosePrice: number | null;
  OriginalListPrice: number | null;
  ListPrice: number | null;
  DaysOnMarket: number | null;
  BedroomsTotal: number | null;
  BathroomsTotalInteger: number | null;
  LivingArea: number | null;
  PropertyType: string | null;
  PropertySubType: string | null;
  YearBuilt: number | null;
  ListAgentFullName: string | null;
  ListOfficeName: string | null;
  BuyerOfficeName: string | null;
}

function flag(value: string | null): string | null {
  if (!value) return null;
  if (value.toLowerCase() === "true" || value === "1") return "1";
  return value;
}

export async function searchActiveListings(
  filters: PropertyFilters,
  page = 1,
  limit = PAGE_SIZE
): Promise<ListingRow[]> {
  const safeLimit = Math.min(Math.max(limit, 1), MAX_ROWS);
  const safePage = Math.max(page, 1);
  const offset = (safePage - 1) * safeLimit;

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
  `;
  const params: unknown[] = [];

  if (filters.city) {
    sql += " AND LOWER(L_City) = LOWER(?)";
    params.push(filters.city);
  }
  if (filters.maxPrice) {
    sql += " AND L_SystemPrice <= ?";
    params.push(filters.maxPrice);
  }
  if (filters.beds) {
    sql += " AND L_Keyword2 >= ?";
    params.push(filters.beds);
  }
  if (filters.baths) {
    sql += " AND LM_Dec_3 >= ?";
    params.push(filters.baths);
  }
  if (filters.sqft) {
    sql += " AND LM_Int2_3 >= ?";
    params.push(filters.sqft);
  }
  if (filters.type) {
    sql += " AND L_Type_ = ?";
    params.push(filters.type);
  }
  const poolFlag = flag(filters.pool);
  if (poolFlag) {
    sql += " AND PoolPrivateYN = ?";
    params.push(poolFlag);
  }
  const viewFlag = flag(filters.hasView);
  if (viewFlag) {
    sql += " AND ViewYN = ?";
    params.push(viewFlag);
  }

  sql += " ORDER BY L_SystemPrice ASC LIMIT ? OFFSET ?";
  params.push(safeLimit, offset);
  return query<ListingRow>(sql, params);
}

export async function getSoldComps(
  city: string,
  months = 12
): Promise<SoldRow[]> {
  const sql = `
    SELECT
      ListingKey, UnparsedAddress, City, CloseDate, ClosePrice,
      OriginalListPrice, ListPrice, DaysOnMarket,
      BedroomsTotal, BathroomsTotalInteger, LivingArea,
      PropertyType, PropertySubType, YearBuilt,
      ListAgentFullName, ListOfficeName, BuyerOfficeName
    FROM california_sold
    WHERE LOWER(City) = LOWER(?)
      AND CloseDate >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
      AND PropertyType = 'Residential'
    ORDER BY CloseDate DESC
    LIMIT 50
  `;
  return query<SoldRow>(sql, [city, months]);
}

function money(value: number | null): string {
  if (value == null) return "n/a";
  return `$${Number(value).toLocaleString("en-US")}`;
}

function num(value: number | null): string {
  if (value == null) return "n/a";
  return Number(value).toLocaleString("en-US");
}

export function formatListingCard(listing: ListingRow): string {
  const agent = [listing.LA1_UserFirstName, listing.LA1_UserLastName]
    .filter(Boolean)
    .join(" ");
  const office = listing.LO1_OrganizationName
    ? `${agent ? `${agent}, ` : ""}${listing.LO1_OrganizationName}`
    : agent;

  return [
    `${listing.L_Address}, ${listing.L_City} ${listing.L_Zip}`,
    `${money(listing.price)} | ${num(listing.beds)} bd / ${num(listing.baths)} ba | ${num(listing.sqft)} sqft`,
    `${listing.type ?? "Property"} | ${num(listing.DaysOnMarket)} days on market | ${num(listing.PhotoCount)} photos`,
    office,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatSoldCard(row: SoldRow): string {
  return [
    `${row.UnparsedAddress ?? "Unknown address"}, ${row.City ?? ""}`.trim(),
    `Sold ${money(row.ClosePrice)} on ${row.CloseDate ?? "unknown date"} | list ${money(row.ListPrice)}`,
    `${num(row.BedroomsTotal)} bd / ${num(row.BathroomsTotalInteger)} ba | ${num(row.LivingArea)} sqft | ${num(row.DaysOnMarket)} days on market`,
    row.ListOfficeName ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  let sentence = process.argv.slice(2).join(" ").trim();
  if (!sentence) {
    const rl = readline.createInterface({ input, output });
    sentence = (await rl.question("Sentence: ")).trim();
    rl.close();
  }

  const filters = await parsePropertyQuery(sentence);
  const wantsSold = /\b(sold|comps?|closed)\b/i.test(sentence);

  if (wantsSold) {
    if (!filters.city) {
      console.log("Say which city you want comps for.");
    } else {
      const rows = await getSoldComps(filters.city);
      console.log(
        rows.length
          ? rows.map(formatSoldCard).join("\n\n")
          : `No sold comps in ${filters.city} for the last 12 months.`
      );
    }
  } else {
    const rows = await searchActiveListings(filters);
    console.log(
      rows.length
        ? rows.map(formatListingCard).join("\n\n")
        : "No active listings matched."
    );
  }

  await pool.end();
}
