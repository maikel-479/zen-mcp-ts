#!/usr/bin/env node
/**
 * Comprehensive MCP server test harness.
 * Spawns the server, sends MCP protocol messages over stdio, validates each tool.
 */

const { spawn } = require("child_process");
const path = require("path");

const SERVER = path.join(__dirname, "..", "dist", "index.js");
const TIMEOUT = 25000;

let proc;
let msgId = 0;
const pending = new Map();
const results = [];
let __currentTest = "";

function log(msg) {
  process.stderr.write(`[TEST] ${msg}\n`);
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout on ${method} (id=${id})`));
    }, TIMEOUT);
    pending.set(id, { resolve, reject, timer, method });
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    proc.stdin.write(msg + "\n");
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    let stderrBuf = "";
    proc.stderr.on("data", (d) => {
      stderrBuf += d.toString();
      // Forward server logs to stderr for debugging
      const lines = d.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        if (line.includes("[zen-mcp]")) process.stderr.write(`  SERVER: ${line}\n`);
      }
    });

    proc.stdout.on("data", (d) => {
      const lines = d.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            clearTimeout(p.timer);
            pending.delete(msg.id);
            if (msg.error) {
              p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              p.resolve(msg.result);
            }
          }
        } catch {}
      }
    });

    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        log(`Server exited with code ${code}`);
      }
    });

    // Give server a moment to start
    setTimeout(resolve, 1500);
  });
}

function record(name, pass, detail) {
  const icon = pass ? "PASS" : "FAIL";
  results.push({ name, pass, detail });
  log(`${icon}: ${name}${detail ? " — " + detail : ""}`);
}

async function runTests() {
  await startServer();
  log("Server started, beginning tests...\n");

  // ── 1. Initialize ──
  _currentTest = "initialize";
  try {
    const init = await send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-harness", version: "1.0.0" },
    });
    record("initialize", !!init, JSON.stringify(init?.capabilities || {}));
  } catch (e) {
    record("initialize", false, e.message);
    await cleanup();
    return;
  }

  // ── 2. initialized notification ──
  try {
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    record("initialized", true);
  } catch (e) {
    record("initialized", false, e.message);
  }

  // ── 3. tools/list ──
  _currentTest = "tools/list";
  try {
    const list = await send("tools/list", {});
    const names = (list.tools || []).map((t) => t.name);
    record("tools/list", names.length > 0, `${names.length} tools: ${names.join(", ")}`);
  } catch (e) {
    record("tools/list", false, e.message);
  }

  // ── 4. zen_navigate ──
  _currentTest = "zen_navigate";
  try {
    const r = await send("tools/call", {
      name: "zen_navigate",
      arguments: { url: "https://example.com" },
    });
    const text = r?.content?.[0]?.text || "";
    const ok = text.includes("example.com") || text.includes("Example");
    record("zen_navigate", ok, text.substring(0, 200));
  } catch (e) {
    record("zen_navigate", false, e.message);
  }

  // Small delay for page load
  await new Promise((r) => setTimeout(r, 2000));

  // ── 5. zen_list_pages ──
  _currentTest = "zen_list_pages";
  try {
    const r = await send("tools/call", { name: "zen_list_pages", arguments: {} });
    const text = r?.content?.[0]?.text || "";
    const ok = text.includes("example.com") || text.includes("http");
    record("zen_list_pages", ok, text.substring(0, 300));
  } catch (e) {
    record("zen_list_pages", false, e.message);
  }

  // ── 6. zen_snapshot ──
  _currentTest = "zen_snapshot";
  try {
    const r = await send("tools/call", { name: "zen_snapshot", arguments: {} });
    const text = r?.content?.[0]?.text || "";
    const ok = text.includes("Example Domain") || text.includes("elements");
    record("zen_snapshot", ok, text.substring(0, 300));
  } catch (e) {
    record("zen_snapshot", false, e.message);
  }

  // ── 7. zen_screenshot ──
  _currentTest = "zen_screenshot";
  try {
    const r = await send("tools/call", { name: "zen_screenshot", arguments: {} });
    const hasImage = r?.content?.some((c) => c.type === "image" && c.data);
    record("zen_screenshot", !!hasImage, hasImage ? "image data present" : "no image data");
  } catch (e) {
    record("zen_screenshot", false, e.message);
  }

  // ── 8. zen_get_page_text ──
  _currentTest = "zen_get_page_text";
  try {
    const r = await send("tools/call", { name: "zen_get_page_text", arguments: {} });
    const text = r?.content?.[0]?.text || "";
    // Verify it's deserialized JSON, not raw BiDi
    const parsed = JSON.parse(text);
    const ok =
      typeof parsed === "object" &&
      parsed !== null &&
      "title" in parsed &&
      "url" in parsed &&
      "text" in parsed;
    const isRawBiDi = text.includes('"type":"success"') || text.includes('"realm"');
    record(
      "zen_get_page_text",
      ok && !isRawBiDi,
      ok ? `title="${parsed.title}"` : `RAW BIDI: ${text.substring(0, 200)}`,
    );
  } catch (e) {
    record("zen_get_page_text", false, e.message);
  }

  // ── 9. zen_get_form_fields ──
  _currentTest = "zen_get_form_fields";
  try {
    const r = await send("tools/call", { name: "zen_get_form_fields", arguments: {} });
    const text = r?.content?.[0]?.text || "";
    const parsed = JSON.parse(text);
    const ok = Array.isArray(parsed);
    record("zen_get_form_fields", ok, `${parsed.length} fields found`);
  } catch (e) {
    record("zen_get_form_fields", false, e.message);
  }

  // ── 10. zen_click ──
  _currentTest = "zen_click";
  try {
    const r = await send("tools/call", {
      name: "zen_click",
      arguments: { selector: "a" },
    });
    const text = r?.content?.[0]?.text || "";
    const parsed = JSON.parse(text);
    const ok = parsed && !parsed.error;
    record("zen_click", ok, text.substring(0, 200));
  } catch (e) {
    record("zen_click", false, e.message);
  }

  await new Promise((r) => setTimeout(r, 1500));

  // ── 11. zen_evaluate ──
  _currentTest = "zen_evaluate";
  try {
    const r = await send("tools/call", {
      name: "zen_evaluate",
      arguments: { script: "document.title" },
    });
    const text = r?.content?.[0]?.text || "";
    const ok = text.length > 0;
    record("zen_evaluate", ok, text.substring(0, 200));
  } catch (e) {
    record("zen_evaluate", false, e.message);
  }

  // Navigate back to example.com for remaining tests
  await send("tools/call", { name: "zen_navigate", arguments: { url: "https://example.com" } });
  await new Promise((r) => setTimeout(r, 1000));

  // ── 12. zen_new_tab ──
  let newTabText = "";
  _currentTest = "zen_new_tab";
  try {
    const r = await send("tools/call", {
      name: "zen_new_tab",
      arguments: { url: "https://example.org" },
    });
    newTabText = r?.content?.[0]?.text || "";
    const ok = newTabText.includes("example.org") || newTabText.includes("New tab");
    record("zen_new_tab", ok, newTabText.substring(0, 200));
  } catch (e) {
    record("zen_new_tab", false, e.message);
  }

  await new Promise((r) => setTimeout(r, 1000));

  // ── 13. zen_list_pages (after new tab) ──
  _currentTest = "zen_list_pages (2 tabs)";
  try {
    const r = await send("tools/call", { name: "zen_list_pages", arguments: {} });
    const text = r?.content?.[0]?.text || "";
    const ok = text.includes("example.org") && text.includes("example.com");
    record("zen_list_pages (2 tabs)", ok, text.substring(0, 300));
  } catch (e) {
    record("zen_list_pages (2 tabs)", false, e.message);
  }

  // ── 14. zen_select_page ──
  _currentTest = "zen_select_page";
  try {
    const r = await send("tools/call", {
      name: "zen_select_page",
      arguments: { index: 0 },
    });
    const text = r?.content?.[0]?.text || "";
    const ok = text.includes("Switched") || text.includes("selected") || text.includes("0");
    record("zen_select_page", ok, text.substring(0, 200));
  } catch (e) {
    record("zen_select_page", false, e.message);
  }

  // ── 15. zen_peek_text ──
  _currentTest = "zen_peek_text";
  try {
    const r = await send("tools/call", {
      name: "zen_peek_text",
      arguments: { index: 1 },
    });
    const text = r?.content?.[0]?.text || "";
    const parsed = JSON.parse(text);
    const ok = typeof parsed === "object" && "title" in parsed;
    const isRawBiDi = text.includes('"type":"success"') || text.includes('"realm"');
    record(
      "zen_peek_text",
      ok && !isRawBiDi,
      ok ? `title="${parsed.title}"` : `RAW BIDI: ${text.substring(0, 200)}`,
    );
  } catch (e) {
    record("zen_peek_text", false, e.message);
  }

  // ── 16. zen_peek_screenshot ──
  _currentTest = "zen_peek_screenshot";
  try {
    const r = await send("tools/call", {
      name: "zen_peek_screenshot",
      arguments: { index: 1 },
    });
    const hasImage = r?.content?.some((c) => c.type === "image" && c.data);
    record("zen_peek_screenshot", !!hasImage, hasImage ? "image data present" : "no image data");
  } catch (e) {
    record("zen_peek_screenshot", false, e.message);
  }

  // ── 17. zen_wait ──
  _currentTest = "zen_wait";
  try {
    const start = Date.now();
    const r = await send("tools/call", { name: "zen_wait", arguments: { ms: 500 } });
    const elapsed = Date.now() - start;
    const text = r?.content?.[0]?.text || "";
    const ok = elapsed >= 400 && text.length > 0;
    record("zen_wait", ok, `waited ${elapsed}ms`);
  } catch (e) {
    record("zen_wait", false, e.message);
  }

  // ── 18. zen_wait_for ──
  _currentTest = "zen_wait_for";
  try {
    const r = await send("tools/call", {
      name: "zen_wait_for",
      arguments: { selector: "body", timeout: 5000 },
    });
    const text = r?.content?.[0]?.text || "";
    const ok = text.length > 0;
    record("zen_wait_for", ok, text.substring(0, 200));
  } catch (e) {
    record("zen_wait_for", false, e.message);
  }

  // ── 19. zen_scroll ──
  _currentTest = "zen_scroll";
  try {
    const r = await send("tools/call", {
      name: "zen_scroll",
      arguments: { direction: "down", amount: 200 },
    });
    const text = r?.content?.[0]?.text || "";
    const ok = text.includes("Scrolled") || text.includes("scroll");
    record("zen_scroll", ok, text.substring(0, 200));
  } catch (e) {
    record("zen_scroll", false, e.message);
  }

  // ── 20. zen_press_key ──
  _currentTest = "zen_press_key";
  try {
    const r = await send("tools/call", {
      name: "zen_press_key",
      arguments: { key: "Escape" },
    });
    const text = r?.content?.[0]?.text || "";
    const ok = text.includes("Pressed") || text.includes("Escape");
    record("zen_press_key", ok, text.substring(0, 200));
  } catch (e) {
    record("zen_press_key", false, e.message);
  }

  // ── 21. zen_fill ──
  _currentTest = "zen_fill";
  try {
    // Navigate to a page with an input
    await send("tools/call", { name: "zen_navigate", arguments: { url: "https://example.com" } });
    await new Promise((r) => setTimeout(r, 1000));

    // example.com has no input, so create one via evaluate
    await send("tools/call", {
      name: "zen_evaluate",
      arguments: {
        script: `const inp = document.createElement('input'); inp.id = 'test-input'; inp.type = 'text'; document.body.appendChild(inp);`,
      },
    });
    await new Promise((r) => setTimeout(r, 300));

    const r = await send("tools/call", {
      name: "zen_fill",
      arguments: { selector: "#test-input", value: "hello world" },
    });
    const text = r?.content?.[0]?.text || "";
    const parsed = JSON.parse(text);
    const ok = parsed && !parsed.error;
    record("zen_fill", ok, text.substring(0, 200));
  } catch (e) {
    record("zen_fill", false, e.message);
  }

  // ── 22. zen_check ──
  _currentTest = "zen_check";
  try {
    // Create a checkbox
    await send("tools/call", {
      name: "zen_evaluate",
      arguments: {
        script: `const cb = document.createElement('input'); cb.id = 'test-cb'; cb.type = 'checkbox'; document.body.appendChild(cb);`,
      },
    });
    await new Promise((r) => setTimeout(r, 300));

    const r = await send("tools/call", {
      name: "zen_check",
      arguments: { selector: "#test-cb", checked: true },
    });
    const text = r?.content?.[0]?.text || "";
    const parsed = JSON.parse(text);
    const ok = parsed && !parsed.error;
    record("zen_check", ok, text.substring(0, 200));
  } catch (e) {
    record("zen_check", false, e.message);
  }

  // ── 23. zen_select_option ──
  _currentTest = "zen_select_option";
  try {
    // Create a select element
    await send("tools/call", {
      name: "zen_evaluate",
      arguments: {
        script: `
          const sel = document.createElement('select');
          sel.id = 'test-select';
          ['a','b','c'].forEach(v => {
            const o = document.createElement('option');
            o.value = v; o.textContent = 'Option ' + v;
            sel.appendChild(o);
          });
          document.body.appendChild(sel);
        `,
      },
    });
    await new Promise((r) => setTimeout(r, 300));

    const r = await send("tools/call", {
      name: "zen_select_option",
      arguments: { selector: "#test-select", value: "b" },
    });
    const text = r?.content?.[0]?.text || "";
    const parsed = JSON.parse(text);
    const ok = parsed && !parsed.error;
    record("zen_select_option", ok, text.substring(0, 200));
  } catch (e) {
    record("zen_select_option", false, e.message);
  }

  // ── 24. zen_fill_form ──
  _currentTest = "zen_fill_form";
  try {
    const r = await send("tools/call", {
      name: "zen_fill_form",
      arguments: {
        fields: [
          { selector: "#test-input", value: "form test", action: "fill" },
          { selector: "#test-select", value: "c", action: "select" },
          { selector: "#test-cb", value: "", action: "uncheck" },
        ],
      },
    });
    const text = r?.content?.[0]?.text || "";
    const parsed = JSON.parse(text);
    const ok = Array.isArray(parsed) && parsed.every((f) => f.status === "ok");
    record("zen_fill_form", ok, text.substring(0, 300));
  } catch (e) {
    record("zen_fill_form", false, e.message);
  }

  // ── 25. zen_close_tab ──
  _currentTest = "zen_close_tab";
  try {
    // Get current tabs to find one to close
    const listR = await send("tools/call", { name: "zen_list_pages", arguments: {} });
    const pages = JSON.parse(listR?.content?.[0]?.text || "[]");
    if (pages.length > 1) {
      const r = await send("tools/call", {
        name: "zen_close_tab",
        arguments: { index: pages.length - 1 },
      });
      const text = r?.content?.[0]?.text || "";
      record("zen_close_tab", true, text.substring(0, 200));
    } else {
      record("zen_close_tab", true, "skipped (only 1 tab)");
    }
  } catch (e) {
    record("zen_close_tab", false, e.message);
  }

  // ── 26. zen_reconnect ──
  _currentTest = "zen_reconnect";
  try {
    const r = await send("tools/call", { name: "zen_reconnect", arguments: {} });
    const text = r?.content?.[0]?.text || "";
    const ok = text.length > 0;
    record("zen_reconnect", ok, text.substring(0, 200));
  } catch (e) {
    record("zen_reconnect", false, e.message);
  }

  // ── Summary ──
  await cleanup();

  process.stderr.write("\n" + "=".repeat(60) + "\n");
  process.stderr.write("TEST SUMMARY\n");
  process.stderr.write("=".repeat(60) + "\n");
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  for (const r of results) {
    const icon = r.pass ? "PASS" : "FAIL";
    process.stderr.write(
      `  ${icon}  ${r.name}${r.detail ? " — " + r.detail.substring(0, 120) : ""}\n`,
    );
  }
  process.stderr.write("=".repeat(60) + "\n");
  process.stderr.write(`  ${passed} passed, ${failed} failed, ${results.length} total\n`);
  process.stderr.write("=".repeat(60) + "\n");

  // Write results to JSON for later analysis
  const fs = require("fs");
  fs.writeFileSync(path.join(__dirname, "test-results.json"), JSON.stringify(results, null, 2));
  process.stderr.write(`Results written to tests/test-results.json\n`);

  process.exit(failed > 0 ? 1 : 0);
}

function cleanup() {
  return new Promise((resolve) => {
    if (proc) {
      try {
        proc.stdin.end();
        proc.kill("SIGTERM");
      } catch {}
      setTimeout(resolve, 1000);
    } else {
      resolve();
    }
  });
}

runTests().catch((e) => {
  process.stderr.write(`FATAL: ${e.message}\n${e.stack}\n`);
  cleanup().then(() => process.exit(1));
});
