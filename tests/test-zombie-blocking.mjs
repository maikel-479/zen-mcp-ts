import WebSocket from "ws";

const PORT = parseInt(process.env.ZEN_DEBUG_PORT || "9222");
const URL = `ws://127.0.0.1:${PORT}/session`;

function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 100000);
    const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 10000);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function createSessionWithoutEnding() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once("open", async () => {
      try {
        const resp = await send(ws, "session.new", { capabilities: {} });
        const sid = resp.result.sessionId;
        console.log(`  Zombie session created: ${sid}`);
        // Deliberately DON'T end the session — just close the WebSocket
        ws.terminate(); // abrupt close, no session.end
        resolve(true);
      } catch (e) {
        console.log(`  session.new FAILED: ${e.message}`);
        ws.close();
        resolve(false);
      }
    });
    ws.once("error", (e) => reject(e));
  });
}

function tryNewSession() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once("open", async () => {
      try {
        const resp = await send(ws, "session.new", { capabilities: {} });
        const sid = resp.result.sessionId;
        console.log(`  New session OK: ${sid}`);
        await send(ws, "session.end", {});
        ws.close();
        resolve(true);
      } catch (e) {
        console.log(`  New session FAILED: ${e.message}`);
        ws.close();
        resolve(false);
      }
    });
    ws.once("error", (e) => reject(e));
  });
}

async function main() {
  console.log("Step 1: Create a zombie session (session.new + abrupt ws.terminate)");
  await createSessionWithoutEnding();
  console.log("  Zombie left behind.\n");

  console.log("Step 2: Try to create a new session (should fail with zombie)");
  const r = await tryNewSession();
  console.log(`  Result: ${r ? "PASS" : "FAIL — zombie blocks new session"}\n`);

  process.exit(r ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
