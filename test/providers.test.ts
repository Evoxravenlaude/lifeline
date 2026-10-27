/** The model chain: a retired or rate-limited model falls to the second model, then to the next provider. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/core/config.js";
import { complete, diagnostics, modelsInUse, pickModel, providerChain } from "../src/intent/providers.js";

const saved = { ...config };
afterEach(() => { Object.assign(config, saved); vi.unstubAllGlobals(); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("model chain", () => {
  it("defaults to Groq's current models", () => {
    expect(config.openaiCompatModel).toBe("openai/gpt-oss-120b");
    expect(config.openaiCompatFallbackModel).toBe("openai/gpt-oss-20b");
  });

  it("orders the chosen provider first, then every other configured one", () => {
    Object.assign(config, { modelProvider: "openai", openaiCompatKey: "g", geminiKey: "m", anthropicKey: "" });
    expect(providerChain()).toEqual(["openai", "gemini"]);
  });

  it("a retired model tries the second model, and if that fails too, Gemini answers", async () => {
    Object.assign(config, { modelProvider: "openai", openaiCompatKey: "g", geminiKey: "m", anthropicKey: "", openaiCompatBaseUrl: "https://api.groq.com/openai/v1" });
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      if (url.includes("groq")) { const b = JSON.parse(init.body); seen.push(b.model); expect(b.reasoning_effort).toBe("low"); return json(404, { error: { code: "model_not_found" } }); }
      return json(200, { candidates: [{ content: { parts: [{ text: "Hello from Gemini." }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } });
    }));
    const r = await complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(r?.text).toBe("Hello from Gemini.");
    expect(seen).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    expect(diagnostics.lastProvider).toBe("gemini");
    expect(diagnostics.errors.openai).toMatch(/404/);
  });

  it("a rate limit on the big model is answered by the small one", async () => {
    Object.assign(config, { modelProvider: "openai", openaiCompatKey: "g", geminiKey: "", anthropicKey: "", openaiCompatBaseUrl: "https://api.groq.com/openai/v1" });
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      return b.model === "openai/gpt-oss-120b" ? json(429, { error: { message: "rate limit" } }) : json(200, { choices: [{ message: { content: "Small model here." } }], usage: {} });
    }));
    expect((await complete({ system: "s", messages: [{ role: "user", content: "hi" }] }))?.text).toBe("Small model here.");
  });

  it("when Gemini says the model is gone, it asks Google what exists and remembers the answer", async () => {
    Object.assign(config, { modelProvider: "gemini", openaiCompatKey: "", geminiKey: "m", anthropicKey: "", geminiModel: "gemini-2.5-flash" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url.replace(/\?.*$/, ""));
      if (url.includes("/models?")) return json(200, { models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.5-flash-image", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-005", supportedGenerationMethods: ["embedContent"] },
      ] });
      if (url.includes("gemini-2.5-flash:")) return json(404, { error: { message: "This model models/gemini-2.5-flash is no longer available." } });
      return json(200, { candidates: [{ content: { parts: [{ text: "Back again." }] } }], usageMetadata: {} });
    }));
    expect((await complete({ system: "s", messages: [{ role: "user", content: "hi" }] }))?.text).toBe("Back again.");
    expect(modelsInUse().gemini).toBe("gemini-3.5-flash");
    calls.length = 0;
    await complete({ system: "s", messages: [{ role: "user", content: "again" }] });
    expect(calls).toEqual(["https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"]);
  });

  it("picks sensible models from a provider's list", () => {
    expect(pickModel(["whisper-large-v3", "openai/gpt-oss-20b", "openai/gpt-oss-120b", "meta-llama/llama-guard-4-12b"], [/gpt-oss-120b/, /gpt-oss-20b/])).toBe("openai/gpt-oss-120b");
    expect(pickModel(["gemini-flash-latest", "gemini-3.5-flash"], [/^gemini-flash-latest$/, /^gemini-[\d.]+-flash$/])).toBe("gemini-flash-latest");
    expect(pickModel(["gemini-3-flash", "gemini-3.5-flash-preview", "gemini-3.5-flash"], [/^gemini-[\d.]+-flash/])).toBe("gemini-3.5-flash");
  });
});
