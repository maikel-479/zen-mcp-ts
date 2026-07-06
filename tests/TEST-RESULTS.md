# Test Results — Full MCP Server Feature Test

**Date:** 2026-07-06
**Result:** 26/26 PASS

## Test Plan

All 22 MCP tools tested end-to-end against live Zen Browser (v1.21.5b, Windows).

## Results

| #   | Tool                    | Status | Notes                                         |
| --- | ----------------------- | ------ | --------------------------------------------- |
| 1   | initialize              | PASS   | MCP protocol handshake OK                     |
| 2   | initialized             | PASS   | Notification accepted                         |
| 3   | tools/list              | PASS   | 22 tools registered                           |
| 4   | zen_navigate            | PASS   | Navigated to example.com                      |
| 5   | zen_list_pages          | PASS   | Listed all tabs with context IDs              |
| 6   | zen_snapshot            | PASS   | 4 elements found on example.com               |
| 7   | zen_screenshot          | PASS   | PNG image data returned                       |
| 8   | zen_get_page_text       | PASS   | Deserialized JSON with title/url/text         |
| 9   | zen_get_form_fields     | PASS   | 0 fields on example.com (expected)            |
| 10  | zen_click               | PASS   | Clicked `<a>` element successfully            |
| 11  | zen_evaluate            | PASS   | Returned "Example Domain"                     |
| 12  | zen_new_tab             | PASS   | Created tab at example.org                    |
| 13  | zen_list_pages (2 tabs) | PASS   | Both tabs listed                              |
| 14  | zen_select_page         | PASS   | Switched agent to user tab                    |
| 15  | zen_peek_text           | PASS   | Read text from user tab                       |
| 16  | zen_peek_screenshot     | PASS   | Screenshot from user tab                      |
| 17  | zen_wait                | PASS   | Waited 509ms                                  |
| 18  | zen_wait_for            | PASS   | Found `body` selector                         |
| 19  | zen_scroll              | PASS   | Scrolled down 200px                           |
| 20  | zen_press_key           | PASS   | Pressed Escape                                |
| 21  | zen_fill                | PASS   | Filled input with "hello world"               |
| 22  | zen_check               | PASS   | Checked checkbox                              |
| 23  | zen_select_option       | PASS   | Selected option "b"                           |
| 24  | zen_fill_form           | PASS   | Multi-field form fill (fill, select, uncheck) |
| 25  | zen_close_tab           | PASS   | Closed tab                                    |
| 26  | zen_reconnect           | PASS   | Reconnected to new session                    |

## Bugs Found and Fixed

### Bug 1: `extractValue` double-wrapping (CRITICAL)

- **Symptom:** `zen_get_page_text`, `zen_peek_text`, `zen_get_form_fields` returned raw BiDi format
- **Root cause:** Zen's BiDi returns double-wrapped responses: `{ type: "success", result: { type: "success", result: { type: "object", value: [...] } } }`. The old `extractValue` only unwrapped one level.
- **Fix:** Changed to a `while` loop that recursively unwraps until reaching a non-success type.
- **File:** `src/tools/see.ts:165`

### Bug 2: `zen_click` timing (MODERATE)

- **Symptom:** `zen_click` failed on elements that existed but weren't loaded yet
- **Root cause:** Single `querySelector` call with no retry
- **Fix:** Added retry loop (5 attempts, 200ms apart) with null-check
- **File:** `src/tools/interact.ts:8`

### Bug 3: `zen_evaluate` parameter name (MINOR)

- **Symptom:** `zen_evaluate` threw validation error when called with `expression` parameter
- **Root cause:** Schema defines `script` not `expression`
- **Fix:** Test harness updated to use correct parameter name
- **File:** `tests/test-all-features.cjs`

## Test Harness

`tests/test-all-features.cjs` — Comprehensive MCP test harness that:

- Spawns the server process
- Sends MCP protocol messages over stdio
- Tests all 22 tools in sequence
- Validates output format and content
- Writes results to `tests/test-results.json`
