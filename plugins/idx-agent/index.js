import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

function projectRoot() {
  const candidates = [];
  try {
    const configPath = resolve(homedir(), ".openclaw/openclaw.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    for (const pluginDir of config.plugins?.load?.paths ?? []) {
      candidates.push(resolve(pluginDir, "../.."));
    }
  } catch {
    // Fall through to the path next to this file.
  }
  candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  return (
    candidates.find(
      (dir) =>
        existsSync(resolve(dir, ".env")) &&
        existsSync(resolve(dir, "plugins/idx-agent/reply.ts")),
    ) ?? candidates[0]
  );
}

const root = projectRoot();
const envFile = resolve(root, ".env");
const replyScript = resolve(root, "plugins/idx-agent/reply.ts");
const CURRENT_MESSAGE = "[Current message - respond to this]";
// Only the second linked number replies. The first number is the person's
// own WhatsApp, and answering there echoes every reply back into the chat.
const AGENT_ACCOUNT = "agent";

function messageText(cleanedBody) {
  const at = cleanedBody.lastIndexOf(CURRENT_MESSAGE);
  const body = (at === -1 ? cleanedBody : cleanedBody.slice(at + CURRENT_MESSAGE.length)).trim();
  return body.replace(/^\[[^\]]{0,120}\]\s*/, "").trim();
}

function senderId(ctx) {
  return ctx.senderId || ctx.chatId || ctx.sessionKey || "whatsapp";
}

function runAgent(userId, text) {
  return new Promise((resolveReply, reject) => {
    const child = execFile(
      process.execPath,
      ["--env-file=" + envFile, replyScript, userId],
      { cwd: root, timeout: 25000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
          return;
        }
        resolveReply(String(stdout ?? "").trim());
      },
    );
    child.stdin?.end(text);
  });
}

export default definePluginEntry({
  id: "idx-agent",
  name: "IDX Agent",
  description: "Property search and market stats over WhatsApp.",
  register(api) {
    api.on(
      "before_agent_reply",
      async (event, ctx) => {
        if (ctx.channel && ctx.channel !== "whatsapp") return;
        if (ctx.accountId && ctx.accountId !== AGENT_ACCOUNT) {
          return { handled: true };
        }
        const text = messageText(event.cleanedBody ?? "");
        const userId = senderId(ctx);
        if (!text || text.startsWith("/")) return;
        try {
          const reply = await runAgent(userId, text);
          return { handled: true, reply: { text: reply.slice(0, 4000) } };
        } catch (err) {
          api.logger.error(`IDX agent failed: ${err instanceof Error ? err.message : "unknown error"}`);
          return {
            handled: true,
            reply: { text: "I hit a problem looking that up. Try the question again." },
          };
        }
      },
      { eligibleTriggers: ["user"] },
    );
  },
});
