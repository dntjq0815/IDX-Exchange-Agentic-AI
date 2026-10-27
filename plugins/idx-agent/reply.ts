import { pool } from "../../db.ts";
import { handleMessage } from "../../chat.ts";

const userId = process.argv[2] || "whatsapp";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString("utf8").trim();
if (text) process.stdout.write(await handleMessage(userId, text));
await pool.end();
