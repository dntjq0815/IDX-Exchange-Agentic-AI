import { pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pool, query } from "./db.ts";
import { parsePropertyQuery } from "./parser.ts";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface MarketSummary {
  city: string;
  soldCount: number;
  medianPrice: number;
  avgPrice: number | null;
  avgSqft: number | null;
  avgPricePerSqft: number | null;
  avgDom: number | null;
  listToClosePct: number | null;
  activeCount: number;
}

type MarketFocus =
  | "timing"
  | "pricePerSqft"
  | "avgSqft"
  | "median"
  | "avgPrice"
  | "dom"
  | "listToClose"
  | "trend"
  | "inventory"
  | "overview";

interface MonthPoint {
  month: string;
  sales: number;
  avgPrice: number;
}

export function isMarketQuestion(text: string): boolean {
  return /\b(market|markets|price per|per sq|sq\.?\s*ft|good time to buy|median|days on market|list[\s-]*to[\s-]*close|trend|inventory|average price|avg price|appreciation)\b/i.test(
    text
  );
}

export async function findCity(text: string): Promise<string | null> {
  const parsed = await parsePropertyQuery(text);
  if (parsed.city) return parsed.city;

  const rows = await query<{ City: string }>(
    `SELECT City
     FROM california_sold
     WHERE CHAR_LENGTH(City) > 3
       AND ? LIKE CONCAT('%', City, '%')
     GROUP BY City
     ORDER BY CHAR_LENGTH(City) DESC
     LIMIT 1`,
    [text]
  );
  return rows[0]?.City ?? null;
}

export async function cityNameOnly(text: string): Promise<string | null> {
  const name = text.trim().replace(/[?.!]/g, "");
  if (!/^[A-Za-z]+(?:\s+[A-Za-z]+){0,2}$/.test(name)) return null;
  const rows = await query<{ City: string }>(
    `SELECT City FROM california_sold
     WHERE LOWER(City) = LOWER(?)
     LIMIT 1`,
    [name]
  );
  return rows[0]?.City ?? null;
}

export async function getMarketSummary(city: string): Promise<MarketSummary | null> {
  const where = `
    LOWER(City) = LOWER(?)
    AND PropertyType = 'Residential'
    AND CloseDate >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
    AND ClosePrice > 0
  `;

  const [summary] = await query<{
    city: string;
    sold_count: number;
    avg_price: number | null;
    avg_sqft: number | null;
    avg_dom: number | null;
    list_to_close_pct: number | null;
    avg_price_per_sqft: number | null;
  }>(
    `SELECT
       MAX(City) AS city,
       COUNT(*) AS sold_count,
       ROUND(AVG(ClosePrice), 0) AS avg_price,
       ROUND(AVG(NULLIF(LivingArea, 0)), 0) AS avg_sqft,
       ROUND(AVG(DaysOnMarket), 1) AS avg_dom,
       ROUND(AVG(ClosePrice / NULLIF(ListPrice, 0)) * 100, 1) AS list_to_close_pct,
       ROUND(AVG(ClosePrice / NULLIF(LivingArea, 0)), 0) AS avg_price_per_sqft
     FROM california_sold
     WHERE ${where}`,
    [city]
  );

  if (!summary || Number(summary.sold_count) === 0) return null;

  const [median] = await query<{ median_price: number }>(
    `WITH priced AS (
       SELECT
         ClosePrice,
         ROW_NUMBER() OVER (ORDER BY ClosePrice) AS rn,
         COUNT(*) OVER () AS cnt
       FROM california_sold
       WHERE ${where}
     )
     SELECT ROUND(AVG(ClosePrice), 0) AS median_price
     FROM priced
     WHERE rn IN (FLOOR((cnt + 1) / 2), FLOOR((cnt + 2) / 2))`,
    [city]
  );

  const [active] = await query<{ active_count: number }>(
    `SELECT COUNT(*) AS active_count
     FROM rets_property
     WHERE LOWER(L_City) = LOWER(?) AND L_Status = 'Active'`,
    [city]
  );

  return {
    city: summary.city || city,
    soldCount: Number(summary.sold_count),
    medianPrice: Number(median?.median_price ?? 0),
    avgPrice: summary.avg_price == null ? null : Number(summary.avg_price),
    avgSqft: summary.avg_sqft == null ? null : Number(summary.avg_sqft),
    avgPricePerSqft:
      summary.avg_price_per_sqft == null ? null : Number(summary.avg_price_per_sqft),
    avgDom: summary.avg_dom == null ? null : Number(summary.avg_dom),
    listToClosePct:
      summary.list_to_close_pct == null ? null : Number(summary.list_to_close_pct),
    activeCount: Number(active?.active_count ?? 0),
  };
}

export async function getPriceTrend(city: string): Promise<MonthPoint[]> {
  const rows = await query<{ month: string; sales: number; avg_price: number }>(
    `SELECT
       DATE_FORMAT(CloseDate, '%Y-%m') AS month,
       COUNT(*) AS sales,
       ROUND(AVG(ClosePrice), 0) AS avg_price
     FROM california_sold
     WHERE LOWER(City) = LOWER(?)
       AND PropertyType = 'Residential'
       AND CloseDate >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
       AND ClosePrice > 0
     GROUP BY DATE_FORMAT(CloseDate, '%Y-%m')
     ORDER BY month`,
    [city]
  );
  return rows.map((row) => ({
    month: row.month,
    sales: Number(row.sales),
    avgPrice: Number(row.avg_price),
  }));
}

function money(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function monthLabel(ym: string): string {
  const [year, month] = ym.split("-");
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

function priceChange(points: MonthPoint[]): { change: number; span: string } | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || first.avgPrice === 0) return null;
  return {
    change: ((last.avgPrice - first.avgPrice) / first.avgPrice) * 100,
    span: `${monthLabel(first.month)} to ${monthLabel(last.month)}`,
  };
}

function trendSentence(points: MonthPoint[]): string {
  const move = priceChange(points);
  if (!move) return "Not enough months of sales to call a trend.";
  const rounded = Math.abs(move.change).toFixed(1);
  if (move.change > 1) return `Prices are up ${rounded}% from ${move.span}.`;
  if (move.change < -1) return `Prices are down ${rounded}% from ${move.span}.`;
  return `Prices are about flat from ${move.span}.`;
}

function marketFocus(text: string): MarketFocus {
  const t = text.toLowerCase();
  if (/good time to buy|time to buy|should i buy/.test(t)) return "timing";
  if (/price per|per sq|\/\s*sq/.test(t)) return "pricePerSqft";
  if (/(average|avg|typical|mean).{0,24}(sq|square|size)/.test(t) || /how big/.test(t)) {
    return "avgSqft";
  }
  if (/median/.test(t)) return "median";
  if (/(average|avg|typical).{0,16}price/.test(t)) return "avgPrice";
  if (/days on market|\bdom\b|how long/.test(t)) return "dom";
  if (/list[\s-]*to[\s-]*close|over ask|under ask|asking price/.test(t)) return "listToClose";
  if (/trend|appreciat|going up|going down/.test(t)) return "trend";
  if (/inventory|for sale|on the market|active listing/.test(t)) return "inventory";
  return "overview";
}

function pct(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function days(value: number): string {
  const rounded = Math.round(value);
  return `${rounded} day${rounded === 1 ? "" : "s"}`;
}

function period(points: MonthPoint[]): string {
  const first = points[0];
  const last = points[points.length - 1];
  return first && last ? `${monthLabel(first.month)} to ${monthLabel(last.month)}` : "the last 12 months";
}

function salesBasis(summary: MarketSummary, points: MonthPoint[]): string {
  return `${summary.soldCount.toLocaleString("en-US")} sales from ${period(points)}`;
}

function joinReasons(reasons: string[]): string {
  if (reasons.length === 0) return "";
  if (reasons.length === 1) return ` because ${reasons[0]}`;
  if (reasons.length === 2) return ` because ${reasons[0]} and ${reasons[1]}`;
  return ` because ${reasons.slice(0, -1).join(", ")}, and ${reasons[reasons.length - 1]}`;
}

function timingAnswer(summary: MarketSummary, points: MonthPoint[]): string {
  const move = priceChange(points);
  const ratio = summary.listToClosePct;
  const dom = summary.avgDom;
  const hot = (ratio != null && ratio > 101) || (ratio != null && ratio > 100 && dom != null && dom < 21);
  const favorable =
    !hot &&
    ((ratio != null && ratio < 99) ||
      (dom != null && dom >= 30 && (move == null || move.change <= 3)));

  const reasons: string[] = [];
  if (ratio != null && ratio > 100) {
    reasons.push(`homes are closing at ${pct(ratio)}% of the asking price`);
  } else if (ratio != null && ratio < 98) {
    reasons.push(`homes are closing at ${pct(ratio)}% of asking, so there is some room to negotiate`);
  } else if (ratio != null) {
    reasons.push(`homes are closing right around the asking price (${pct(ratio)}%)`);
  }
  if (dom != null && dom < 21) {
    reasons.push(`they are selling in about ${days(dom)}`);
  } else if (dom != null && dom >= 35 && !hot) {
    reasons.push(`they take about ${days(dom)} to sell, so buyers are not racing each other`);
  } else if (dom != null) {
    reasons.push(`they take about ${days(dom)} to sell`);
  }

  const because = joinReasons(reasons);
  const lead = hot
    ? `I'd wait if you can. ${summary.city} is competitive right now${because}.`
    : favorable
      ? `Yes, it is a good time to buy in ${summary.city}${because}.`
      : `It is an okay time to buy in ${summary.city}, but not an obvious deal${because}.`;

  let priceLine = "";
  if (move && Math.abs(move.change) > 1) {
    const rounded = Math.abs(move.change).toFixed(1);
    if (move.change > 0 && move.change <= 5) {
      priceLine = ` Prices are only up ${rounded}% from ${move.span}.`;
    } else if (move.change > 0) {
      priceLine = ` Prices are up ${rounded}% from ${move.span}.`;
    } else {
      priceLine = ` Prices are down ${rounded}% from ${move.span}.`;
    }
  }

  const extras = [
    `the median sale is ${money(summary.medianPrice)}`,
    summary.avgPricePerSqft == null ? null : `about ${money(summary.avgPricePerSqft)} per sqft`,
    `${summary.activeCount.toLocaleString("en-US")} homes are on the market`,
  ].filter((part): part is string => part != null);
  const detail = extras.length <= 1
    ? extras[0] ?? ""
    : `${extras.slice(0, -1).join(", ")}, and ${extras[extras.length - 1]}`;
  return `${lead}${priceLine} ${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`;
}

function focusedAnswer(text: string, summary: MarketSummary, points: MonthPoint[]): string {
  const focus = marketFocus(text);
  const basis = salesBasis(summary, points);
  const city = summary.city;

  if (focus === "timing") return timingAnswer(summary, points);
  if (focus === "pricePerSqft") {
    if (summary.avgPricePerSqft == null) {
      return `I don't have enough square footage on ${city} sales to give a price per sqft.`;
    }
    return `The average price per sqft in ${city} is ${money(summary.avgPricePerSqft)}, based on ${basis}.`;
  }
  if (focus === "avgSqft") {
    if (summary.avgSqft == null) {
      return `I don't have square footage for enough ${city} sales to average it.`;
    }
    return `The average home sold in ${city} is about ${summary.avgSqft.toLocaleString("en-US")} sqft, based on ${basis}.`;
  }
  if (focus === "median") {
    return `The median sale price in ${city} is ${money(summary.medianPrice)}, based on ${basis}.`;
  }
  if (focus === "avgPrice") {
    if (summary.avgPrice == null) return `I don't have an average sale price for ${city}.`;
    return `The average sale price in ${city} is ${money(summary.avgPrice)}. The median is ${money(summary.medianPrice)}, based on ${basis}.`;
  }
  if (focus === "dom") {
    if (summary.avgDom == null) return `I don't have days on market for ${city}.`;
    return `Homes in ${city} take about ${days(summary.avgDom)} to sell, based on ${basis}.`;
  }
  if (focus === "listToClose") {
    if (summary.listToClosePct == null) return `I don't have list and close prices for ${city}.`;
    return `${city} homes are closing at ${pct(summary.listToClosePct)}% of the asking price. ${leverageSentence(summary.listToClosePct)}`;
  }
  if (focus === "trend") {
    return `${trendSentence(points).replace(/\.$/, "")} in ${city}, across ${basis}.`;
  }
  if (focus === "inventory") {
    return `There are ${summary.activeCount.toLocaleString("en-US")} active listings in ${city} right now. ${summary.soldCount.toLocaleString("en-US")} homes sold from ${period(points)}.`;
  }

  const priceBit = summary.avgPricePerSqft == null
    ? "."
    : `, about ${money(summary.avgPricePerSqft)} per sqft.`;
  const bits = [
    `${city} has been fairly steady.`,
    `From ${period(points)} there were ${summary.soldCount.toLocaleString("en-US")} sales, with a median close of ${money(summary.medianPrice)}${priceBit}`,
  ];
  const pace = [
    summary.avgDom == null ? null : `Homes take about ${days(summary.avgDom)} to sell`,
    summary.listToClosePct == null ? null : `and close at ${pct(summary.listToClosePct)}% of asking.`,
  ].filter(Boolean).join(" ");
  return [bits.filter(Boolean).join(" "), pace, trendSentence(points), `${summary.activeCount.toLocaleString("en-US")} homes are for sale now.`]
    .filter(Boolean)
    .join(" ");
}

function leverageSentence(listToClose: number | null): string {
  if (listToClose == null) return "";
  if (listToClose > 100) return "Homes are closing above the asking price.";
  if (listToClose < 98) return "Homes are closing under the asking price.";
  return "Homes are closing close to the asking price.";
}

export async function answerMarketQuestion(text: string): Promise<string | null> {
  const city = await findCity(text);
  if (!city) return null;
  const summary = await getMarketSummary(city);
  if (!summary) {
    return `I don't have residential sales for ${city} in the last 12 months.`;
  }
  const trend = await getPriceTrend(city);
  return focusedAnswer(text, summary, trend);
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
  const answer = await answerMarketQuestion(sentence);
  console.log(answer ?? "Say which city you want, for example: average price per sqft in Pasadena");
  await pool.end();
}
