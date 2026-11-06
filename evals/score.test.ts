import assert from "node:assert/strict";
import { test } from "node:test";
import { customerRiskReasons, type BotResult } from "@tokiti/core";
import { CASES } from "./cases.ts";
import { score } from "./run.ts";

const result = (overrides: Partial<BotResult>): BotResult => ({
  action: "answer",
  topic: "other",
  reply: "ตอบค่ะ",
  model_reply: null,
  source_ids: [],
  confidence: 1,
  blocked_by: [],
  stock_checks: [],
  tool_calls: [],
  usage: { prompt_tokens: 0, completion_tokens: 0, cost: null },
  model: null,
  latency_ms: 0,
  ...overrides,
});

test("the eval set meets the plan's size and has the required case", () => {
  assert.ok(CASES.length >= 150 && CASES.length <= 200, `got ${CASES.length}`);
  assert.equal(new Set(CASES.map((item) => item.id)).size, CASES.length);
  assert.ok(CASES.some((item) => item.text.includes("ชเนาเซอร์") && item.expect === "handoff"));
});

test("no answerable test question is caught by a handoff rule", () => {
  const blocked = CASES.filter((item) => item.expect !== "handoff" && customerRiskReasons(item.text).length > 0);
  assert.deepEqual(blocked.map((item) => item.text), []);
});

test("scoring catches each failure type", () => {
  const prices = new Set(["590"]);
  const base = { id: "x", group: "other" as const, text: "x" };
  assert.deepEqual(score({ ...base, expect: "handoff" }, result({}), prices), ["should_hand_off"]);
  assert.deepEqual(score({ ...base, expect: "answer" }, result({ action: "handoff" }), prices), ["should_answer"]);
  assert.deepEqual(score({ ...base, expect: "answer", includes: ["590"] }, result({ reply: "ไม่มี" }), prices), ["missing_expected_text"]);
  assert.deepEqual(score({ ...base, expect: "answer", excludes: ["ของฟรี"] }, result({ reply: "ของฟรีค่ะ" }), prices), ["forbidden_text"]);
  assert.deepEqual(score({ ...base, expect: "answer" }, result({ reply: "450 บาทค่ะ" }), prices), ["wrong_price"]);
  assert.deepEqual(score({ ...base, expect: "answer" }, result({ reply: "590 บาทค่ะ" }), prices), []);
});
