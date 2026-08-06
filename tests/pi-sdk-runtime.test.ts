import assert from "node:assert/strict";
import test from "node:test";
import { capProviderOutputTokens, forceProviderToolChoice } from "../src/core/pi-sdk-runtime.ts";

test("required tool choice uses the Anthropic wire contract", () => {
  const payload = forceProviderToolChoice({ model: "fixture", tools: [{ name: "submit" }] }, "anthropic-messages", "submit");
  assert.deepEqual(payload, {
    model: "fixture",
    tools: [{ name: "submit" }],
    tool_choice: { type: "tool", name: "submit", disable_parallel_tool_use: true },
  });
  assert.deepEqual(
    forceProviderToolChoice({
      thinking: { type: "enabled", budget_tokens: 1_024 },
      output_config: { effort: "low" },
      tools: [{ name: "submit" }],
    }, "anthropic-messages", "submit"),
    {
      thinking: { type: "disabled" },
      tools: [{ name: "submit" }],
      tool_choice: { type: "tool", name: "submit", disable_parallel_tool_use: true },
    },
  );
});

test("required tool choice uses the OpenAI chat and responses wire contracts", () => {
  assert.deepEqual(
    forceProviderToolChoice({ tools: [] }, "openai-completions", "submit"),
    {
      tools: [],
      tool_choice: { type: "function", function: { name: "submit" } },
      parallel_tool_calls: false,
    },
  );
  assert.deepEqual(
    forceProviderToolChoice({ tools: [] }, "openai-responses", "submit"),
    {
      tools: [],
      tool_choice: { type: "function", name: "submit" },
      parallel_tool_calls: false,
    },
  );
});

test("required tool choice preserves unknown provider payloads", () => {
  const payload = { provider_owned: true };
  assert.equal(forceProviderToolChoice(payload, "future-api", "submit"), payload);
});

test("provider output caps narrow Anthropic and preserve smaller limits", () => {
  assert.deepEqual(
    capProviderOutputTokens({ max_tokens: 131_072, tools: [] }, "anthropic-messages", 4_096),
    { max_tokens: 4_096, tools: [] },
  );
  assert.deepEqual(
    capProviderOutputTokens({ max_tokens: 2_048 }, "anthropic-messages", 4_096),
    { max_tokens: 2_048 },
  );
});

test("provider output caps use nested Google and Bedrock wire contracts", () => {
  assert.deepEqual(
    capProviderOutputTokens({ config: { temperature: 0 } }, "google-generative-ai", 4_096),
    { config: { temperature: 0, maxOutputTokens: 4_096 } },
  );
  assert.deepEqual(
    capProviderOutputTokens({ inferenceConfig: { temperature: 0 } }, "bedrock-converse-stream", 4_096),
    { inferenceConfig: { temperature: 0, maxTokens: 4_096 } },
  );
});
