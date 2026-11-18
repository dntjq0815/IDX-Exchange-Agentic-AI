import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pool } from "./db.ts";

const MODEL = "text-embedding-3-small";
const DIMENSIONS = 256;
const CHUNK_SIZE = 600;
const OVERLAP = 100;

const KNOWLEDGE_DIR = resolve("knowledge");
const INDEX_DIR = resolve(".rag");
const INDEX_PATH = resolve(INDEX_DIR, "index.json");

const DOCUMENTS = [
  "real-estate-glossary.md",
  "trestle-metadata.md",
  "week5-market-summaries.md",
  "idx-schema.md",
  "california-sold-schema.md",
];

export interface RagChunk {
  id: string;
  source: string;
  text: string;
  embedding: number[];
}

export interface RagIndex {
  model: string;
  dimensions: number;
  chunks: RagChunk[];
  createdAt: string;
}

export function chunkText(
  text: string,
  chunkSize = CHUNK_SIZE,
  overlap = OVERLAP
): string[] {
  if (
    chunkSize <= 0 ||
    overlap < 0 ||
    overlap >= chunkSize
  ) {
    throw new Error("Invalid chunk configuration");
  }

  const chunks: string[] = [];
  const clean = text.trim();

  for (
    let start = 0;
    start < clean.length;
    start += chunkSize - overlap
  ) {
    const chunk = clean.slice(start, start + chunkSize);

    if (chunk.trim()) {
      chunks.push(chunk);
    }

    if (start + chunkSize >= clean.length) {
      break;
    }
  }

  return chunks;
}

export async function getRagEmbeddings(
  texts: string[]
): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  if (texts.length === 0) return [];

  const response = await fetch(
    "https://api.openai.com/v1/embeddings",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        dimensions: DIMENSIONS,
        input: texts,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Embedding API failed: ${response.status}`
    );
  }

  const data = (await response.json()) as {
    data: {
      index: number;
      embedding: number[];
    }[];
  };

  return data.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

export async function buildRagIndex(): Promise<RagIndex> {
  const chunks: RagChunk[] = [];

  for (const filename of DOCUMENTS) {
    const filePath = resolve(KNOWLEDGE_DIR, filename);

    if (!existsSync(filePath)) {
      throw new Error(`Missing knowledge file: ${filename}`);
    }

    const content = readFileSync(filePath, "utf8");

    if (!content.trim()) {
      throw new Error(`Knowledge file is empty: ${filename}`);
    }

    const parts = chunkText(content);

    console.log(`${filename}: ${parts.length} chunks`);

    for (let i = 0; i < parts.length; i++) {
      chunks.push({
        id: `${filename}:${i}`,
        source: filename,
        text: parts[i]!,
        embedding: [],
      });
    }
  }

  console.log(`Total chunks: ${chunks.length}`);

  // Batch embeddings to avoid oversized requests.
  const BATCH_SIZE = 32;

  for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
    const batch = chunks.slice(start, start + BATCH_SIZE);

    const vectors = await getRagEmbeddings(
      batch.map((chunk) => chunk.text)
    );

    if (vectors.length !== batch.length) {
      throw new Error("Embedding count mismatch");
    }

    batch.forEach((chunk, index) => {
      const vector = vectors[index];

      if (!vector || vector.length !== DIMENSIONS) {
        throw new Error("Invalid embedding dimensions");
      }

      chunk.embedding = vector;
    });

    console.log(
      `Embedded ${Math.min(start + BATCH_SIZE, chunks.length)}/${chunks.length}`
    );
  }

  const index: RagIndex = {
    model: MODEL,
    dimensions: DIMENSIONS,
    chunks,
    createdAt: new Date().toISOString(),
  };

  mkdirSync(INDEX_DIR, { recursive: true });

  writeFileSync(
    INDEX_PATH,
    JSON.stringify(index),
    "utf8"
  );

  console.log(`RAG index saved: ${INDEX_PATH}`);

  return index;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    await buildRagIndex();
  } finally {
    await pool.end();
  }
}
