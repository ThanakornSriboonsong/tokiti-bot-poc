import assert from "node:assert/strict";
import { test } from "node:test";
import { retrievalReport } from "./retrieval.ts";

// Free and offline: word search over the eval questions. Guards against tuning that loses sources.
test("word search finds the sources the eval questions need", async () => {
  const { summary, misses } = await retrievalReport();
  assert.ok(summary.coverage >= 0.97, `coverage ${summary.coverage}: ${misses.map((miss) => miss.text).join(" | ")}`);
  assert.ok(summary.avg_sources_sent < summary.total_sources, "retrieval should send fewer sources than all of them");
});
