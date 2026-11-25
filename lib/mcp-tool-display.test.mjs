import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { mcpToolLabel } = await jiti.import("./mcp-tool-display.ts");

test("an MCP call reads server/tool only from its result's details", () => {
  assert.deepEqual(
    mcpToolLabel("mcp__docs_v2__search_pages", { server: "docs.v2", tool: "search.pages" }),
    { server: "docs.v2", tool: "search.pages" },
  );
  assert.deepEqual(mcpToolLabel("mcp__a__b__c", { server: "a__b", tool: "c" }), { server: "a__b", tool: "c" });
  // The registered name is never split: sanitizing and hashing make that guesswork.
  assert.equal(mcpToolLabel("mcp__github__create_issue"), null);
  assert.equal(mcpToolLabel("mcp__docs__search", { server: 1, tool: "search" }), null);
  assert.equal(mcpToolLabel("mcp__docs__search", { server: "", tool: "search" }), null);
  // Other tools may carry such details; only MCP tools are relabelled.
  assert.equal(mcpToolLabel("read", { server: "docs", tool: "search" }), null);
});
