// Cursor hook entry: forwards one hook event to the background learner and
// never blocks or fails the agent. Usage: node hook.mjs <hookEventName>
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.HERMES_LEARNER_PORT ?? 37791);
const LEARNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "learner.mjs");

const reply = (event) => new Promise((resolve) => {
  const out = event === "beforeSubmitPrompt" ? JSON.stringify({ continue: true }) : "{}";
  process.stdout.write(out, () => resolve());
});

const readStdin = () => new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", () => resolve(data));
});

const post = (body) => new Promise((resolve, reject) => {
  const req = http.request({
    host: "127.0.0.1",
    port: PORT,
    path: "/event",
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    timeout: 1500,
  }, (res) => { res.resume(); res.on("end", resolve); });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", reject);
  req.end(body);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw.replace(/^\uFEFF/, "").trim()); } catch { await reply(process.argv[2]); return; }
  const event = process.argv[2] ?? payload.hook_event_name;
  await reply(event);
  if (process.env.HERMES_LEARNER_DISABLED === "1") return;

  const body = JSON.stringify({ event, payload });
  try {
    await post(body);
    return;
  } catch {}

  spawn(process.execPath, [LEARNER], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    try {
      await post(body);
      return;
    } catch {}
  }
}

main().catch(() => {}).finally(() => process.exit(0));
