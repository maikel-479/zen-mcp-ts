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

async function testSession() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once("open", async () => {
      try {
        const resp = await send(ws, "session.new", { capabilities: {} });
        const sid = resp.result.sessionId;
        console.log(`  session.new OK: ${sid}`);
        await send(ws, "session.end", {});
        console.log("  session.end OK");
        ws.close();
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

async function main() {
  console.log("Test 1: Fresh session (should pass)");
  const r1 = await testSession();
  console.log(`  Result: ${r1 ? "PASS" : "FAIL"}\n`);

  console.log("Test 2: Second session without ending first (simulates zombie)");
  const r2 = await testSession();
  console.log(`  Result: ${r2 ? "PASS (no zombie)" : "FAIL (zombie blocks new session)"}\n`);

  console.log("Test 3: Third attempt after zombie");
  const r3 = await testSession();
  console.log(`  Result: ${r3 ? "PASS" : "FAIL"}\n`);

  process.exit(r1 && r2 && r3 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
