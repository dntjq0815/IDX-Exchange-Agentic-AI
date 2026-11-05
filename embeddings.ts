import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pool, query } from "./db.ts";

const MODEL = "text-embedding-3-small";
const DIMENSIONS = 256;
const BATCH = 64;
const INDEX_PATH = resolve(dirname(fileURLToPath(import.meta.url)), ".listing-embeddings");

interface SourceRow {
  L_ListingID: string;
  L_Type_: string | null;
  L_City: string | null;
  L_Address: string | null;
  L_Keyword2: number | null;
  LM_Dec_3: number | null;
  LM_Int2_3: number | null;
  YearBuilt: number | null;
  L_SystemPrice: number | null;
  L_Remarks: string | null;
  ModificationTimestamp: string | Date | null;
}

interface IndexRow {
  id: string;
  stamp: string;
  city: string;
  address: string;
  price: number;
  beds: string;
  baths: string;
}

interface EmbeddingIndex {
  model: string;
  dim: number;
  rows: IndexRow[];
  vectors: Float32Array;
}

export interface SimilarHit {
  id: string;
  city: string;
  address: string;
  price: number;
  beds: string;
  baths: string;
  score: number;
}

export function isSimilarQuestion(text: string): boolean {
  return /\b(similar homes|similar listings|homes like|listings like|something like|show me similar|more like this)\b/i.test(text)
    || /^(similar|more like (this|that))$/i.test(text.trim());
}

export function listingText(row: {
  L_Type_?: string | null;
  L_City?: string | null;
  L_Keyword2?: number | null;
  LM_Dec_3?: number | null;
  LM_Int2_3?: number | null;
  YearBuilt?: number | null;
  L_SystemPrice?: number | null;
  L_Remarks?: string | null;
  type?: string | null;
  city?: string | null;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  price?: number | null;
}): string {
  const type = row.L_Type_ ?? row.type ?? "Home";
  const city = row.L_City ?? row.city ?? "California";
  const beds = row.L_Keyword2 ?? row.beds ?? "?";
  const baths = row.LM_Dec_3 ?? row.baths ?? "?";
  const sqft = row.LM_Int2_3 ?? row.sqft ?? "?";
  const year = row.YearBuilt ?? "unknown";
  const price = Number(row.L_SystemPrice ?? row.price ?? 0);
  const remarks = (row.L_Remarks ?? "").replace(/\s+/g, " ").trim().slice(0, 1200);
  return [
    `${type} in ${city}, CA.`,
    `${beds} beds, ${baths} baths.`,
    `${sqft} sq ft. Built ${year}.`,
    `Price: $${price.toLocaleString("en-US")}.`,
    remarks,
  ].join(" ").replace(/\s+/g, " ").trim().slice(0, 8000);
}

function stampOf(row: SourceRow): string {
  const remarks = row.L_Remarks ?? "";
  const when = row.ModificationTimestamp instanceof Date
    ? row.ModificationTimestamp.toISOString()
    : String(row.ModificationTimestamp ?? "");
  return `${when}|${row.L_SystemPrice ?? ""}|${remarks.length}`;
}

function loadIndex(): EmbeddingIndex | null {
  if (!existsSync(INDEX_PATH)) return null;
  const file = readFileSync(INDEX_PATH);
  const metaBytes = file.readUInt32LE(0);
  const meta = JSON.parse(file.subarray(4, 4 + metaBytes).toString("utf8")) as {
    model: string;
    dim: number;
    rows: IndexRow[];
  };
  if (meta.model !== MODEL || meta.dim !== DIMENSIONS) return null;
  const dataStart = 4 + metaBytes + ((4 - ((4 + metaBytes) % 4)) % 4);
  const vectors = new Float32Array(
    file.buffer,
    file.byteOffset + dataStart,
    meta.rows.length * meta.dim
  );
  return { model: meta.model, dim: meta.dim, rows: meta.rows, vectors };
}

function saveIndex(index: EmbeddingIndex): void {
  const meta = Buffer.from(JSON.stringify({
    model: index.model,
    dim: index.dim,
    rows: index.rows,
  }));
  const pad = (4 - ((4 + meta.length) % 4)) % 4;
  const header = Buffer.alloc(4 + meta.length + pad);
  header.writeUInt32LE(meta.length, 0);
  meta.copy(header, 4);
  const body = Buffer.from(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength);
  const tmp = INDEX_PATH + ".tmp";
  writeFileSync(tmp, Buffer.concat([header, body]));
  renameSync(tmp, INDEX_PATH);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is missing");
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, dimensions: DIMENSIONS, input: texts }),
    });
    if (response.status === 429) {
      await pause(20000 * (attempt + 1));
      continue;
    }
    if (!response.ok) {
      const detail = (await response.text()).replace(/sk-[A-Za-z0-9_-]+/g, "sk-...").slice(0, 180);
      throw new Error(`Embedding request failed (${response.status}). ${detail}`);
    }
    const payload = await response.json() as {
      data: { index: number; embedding: number[] }[];
    };
    return payload.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }
  throw new Error("Embedding request kept hitting the rate limit");
}

function indexRow(row: SourceRow): IndexRow {
  return {
    id: String(row.L_ListingID),
    stamp: stampOf(row),
    city: row.L_City ?? "",
    address: row.L_Address ?? "",
    price: Number(row.L_SystemPrice ?? 0),
    beds: row.L_Keyword2 == null ? "n/a" : String(row.L_Keyword2),
    baths: row.LM_Dec_3 == null ? "n/a" : String(row.LM_Dec_3),
  };
}

export async function buildEmbeddingIndex(options: { city?: string; limit?: number } = {}): Promise<number> {
  let sql = `
    SELECT L_ListingID, L_Type_, L_City, L_Address, L_Keyword2, LM_Dec_3, LM_Int2_3,
           YearBuilt, L_SystemPrice, L_Remarks, ModificationTimestamp
    FROM rets_property
    WHERE L_Status = 'Active'
  `;
  const params: unknown[] = [];
  if (options.city) {
    sql += " AND LOWER(L_City) = LOWER(?)";
    params.push(options.city);
  }
  sql += " ORDER BY L_ListingID";
  if (options.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }
  const source = await query<SourceRow>(sql, params);
  const previous = loadIndex();
  const byId = new Map<string, { row: IndexRow; vector: Float32Array }>();
  if (previous) {
    previous.rows.forEach((row, index) => {
      byId.set(row.id, {
        row,
        vector: previous.vectors.slice(index * previous.dim, (index + 1) * previous.dim),
      });
    });
  }

  const pending = source.filter((row) => byId.get(String(row.L_ListingID))?.row.stamp !== stampOf(row));
  if (!options.city && !options.limit) {
    const live = new Set(source.map((row) => String(row.L_ListingID)));
    for (const id of byId.keys()) {
      if (!live.has(id)) byId.delete(id);
    }
  }
  console.log(`Active listings read: ${source.length}. Need embeddings: ${pending.length}.`);
  for (let start = 0; start < pending.length; start += BATCH) {
    const chunk = pending.slice(start, start + BATCH);
    const vectors = await embedTexts(chunk.map((row) => listingText(row)));
    chunk.forEach((row, index) => {
      const vector = vectors[index];
      if (!vector || vector.length !== DIMENSIONS) {
        throw new Error("Embedding size did not match the index");
      }
      byId.set(String(row.L_ListingID), {
        row: indexRow(row),
        vector: Float32Array.from(vector),
      });
    });
    console.log(`Embedded ${Math.min(start + chunk.length, pending.length)} / ${pending.length}`);
    await pause(1500);
    if (start / BATCH % 10 === 9) saveIndex(packIndex(byId));
  }

  const packed = packIndex(byId);
  saveIndex(packed);
  console.log(`Index has ${packed.rows.length} listings.`);
  return packed.rows.length;
}

function packIndex(byId: Map<string, { row: IndexRow; vector: Float32Array }>): EmbeddingIndex {
  const rows: IndexRow[] = [];
  const vectors = new Float32Array(byId.size * DIMENSIONS);
  let offset = 0;
  for (const item of byId.values()) {
    rows.push(item.row);
    vectors.set(item.vector, offset);
    offset += DIMENSIONS;
  }
  return { model: MODEL, dim: DIMENSIONS, rows, vectors };
}

function scoreAll(query: Float32Array, index: EmbeddingIndex, city?: string | null, skipId?: string): SimilarHit[] {
  let queryNorm = 0;
  for (const value of query) queryNorm += value * value;
  queryNorm = Math.sqrt(queryNorm) || 1;
  const hits: SimilarHit[] = [];
  for (let rowIndex = 0; rowIndex < index.rows.length; rowIndex++) {
    const row = index.rows[rowIndex];
    if (!row || row.id === skipId) continue;
    if (city && row.city.toLowerCase() !== city.toLowerCase()) continue;
    let dot = 0;
    let norm = 0;
    const base = rowIndex * index.dim;
    for (let i = 0; i < index.dim; i++) {
      const value = index.vectors[base + i] ?? 0;
      dot += (query[i] ?? 0) * value;
      norm += value * value;
    }
    hits.push({ ...row, score: dot / (queryNorm * (Math.sqrt(norm) || 1)) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, 5);
}

export async function findSimilarListings(text: string, city?: string | null, skipId?: string): Promise<SimilarHit[]> {
  const index = loadIndex();
  if (!index || index.rows.length === 0) {
    throw new Error("NO_INDEX");
  }
  const [vector] = await embedTexts([text.replace(/\s+/g, " ").trim().slice(0, 8000)]);
  if (!vector) throw new Error("Embedding request returned nothing");
  return scoreAll(Float32Array.from(vector), index, city, skipId);
}

export async function findSimilarToListing(listingId: string): Promise<SimilarHit[]> {
  const index = loadIndex();
  if (!index || index.rows.length === 0) throw new Error("NO_INDEX");
  const rowIndex = index.rows.findIndex((row) => row.id === listingId);
  if (rowIndex === -1) throw new Error("NOT_IN_INDEX");
  const query = index.vectors.slice(rowIndex * index.dim, (rowIndex + 1) * index.dim);
  const city = index.rows[rowIndex]?.city;
  return scoreAll(query, index, city, listingId);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const command = process.argv[2];
  const cityFlag = process.argv.indexOf("--city");
  const limitFlag = process.argv.indexOf("--limit");
  const city = cityFlag === -1 ? undefined : process.argv[cityFlag + 1];
  const limit = limitFlag === -1 ? undefined : Number(process.argv[limitFlag + 1]);
  if (command === "build") {
    await buildEmbeddingIndex({ city, limit });
  } else if (command === "search") {
    const sentence = process.argv.slice(3).join(" ").replace(/--city\s+\S+|--limit\s+\S+/g, "").trim();
    const hits = await findSimilarListings(sentence, city);
    for (const hit of hits) {
      console.log(`${hit.score.toFixed(3)}  $${hit.price.toLocaleString("en-US")}  ${hit.beds} bd / ${hit.baths} ba  ${hit.address}, ${hit.city}`);
    }
    if (!hits.length) console.log("No listings in the index matched.");
  } else {
    console.log("Use: embeddings.ts build [--city Irvine] [--limit 100]");
    console.log("     embeddings.ts search \"quiet condo with a view in Irvine\"");
  }
  await pool.end();
}
