import { describe, expect, test } from "bun:test";
import {
  CLOUD_PROVIDERS,
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  LOCAL_OLLAMA_HOST,
  OPENAI_ENDPOINT,
  OPENAI_MODEL,
  cloudDefaultEndpoint,
  cloudDefaultModel,
  envFor,
  isCloudProvider,
  readAiConfig,
  setAiConfig,
} from "../lib/providers";

describe("AI provider config", () => {
  test("readAiConfig defaults to local and tolerates garbage", () => {
    expect(readAiConfig(undefined)).toEqual({ provider: "local" });
    expect(readAiConfig({})).toEqual({ provider: "local" });
    expect(readAiConfig({ aiProvider: "nonsense", aiModel: "m" })).toEqual({ provider: "local" });
    expect(readAiConfig({ aiProvider: 5 })).toEqual({ provider: "local" });
  });

  test("readAiConfig recognises openai / deepseek / custom with preset defaults", () => {
    expect(readAiConfig({ aiProvider: "deepseek", aiModel: "m", aiApiKey: "k" })).toEqual({
      provider: "deepseek",
      model: "m",
      apiKey: "k",
      endpoint: DEEPSEEK_ENDPOINT,
    });
    // OpenAI preset: no stored fields → the OpenAI defaults fill in.
    expect(readAiConfig({ aiProvider: "openai" })).toEqual({
      provider: "openai",
      model: OPENAI_MODEL,
      endpoint: OPENAI_ENDPOINT,
    });
    // Custom has no safe default → missing endpoint/model stay undefined so the
    // UI can prompt the user instead of silently hitting the wrong server.
    expect(readAiConfig({ aiProvider: "custom" })).toEqual({ provider: "custom" });
    expect(readAiConfig({ aiProvider: "custom", aiModel: "x", aiEndpoint: "e" })).toEqual({
      provider: "custom",
      model: "x",
      endpoint: "e",
    });
  });

  test("setAiConfig round-trips cloud fields but never stores the API key", () => {
    const cfg = {
      provider: "openai",
      model: "gpt-4o",
      endpoint: OPENAI_ENDPOINT,
      apiKey: "sk-x",
    } as const;
    const stored = setAiConfig({ wallpaper: "w" }, cfg);
    expect(stored.aiProvider).toBe("openai");
    expect(stored.aiModel).toBe("gpt-4o");
    expect(stored.wallpaper).toBe("w"); // unrelated keys preserved
    expect("aiApiKey" in stored).toBe(false); // key is NOT persisted to settings

    // readback has no key (it lives only in the 0600 Rust key file)
    const cfgOut = readAiConfig(stored);
    expect(cfgOut).toMatchObject({ provider: "openai", model: "gpt-4o", endpoint: OPENAI_ENDPOINT });
    expect(cfgOut.apiKey).toBeUndefined();

    const local = setAiConfig(stored, { provider: "local" });
    expect(local.aiProvider).toBe("local");
    expect("aiApiKey" in local).toBe(false);
    expect("aiModel" in local).toBe(false);
    expect("aiEndpoint" in local).toBe(false);
  });

  test("custom round-trip keeps whatever endpoint/model were supplied", () => {
    const stored = setAiConfig({}, { provider: "custom", model: "my-model", endpoint: "https://gw/v1/chat/completions" });
    expect(stored).toMatchObject({ aiProvider: "custom", aiModel: "my-model", aiEndpoint: "https://gw/v1/chat/completions" });
  });

  test("envFor maps local → Ollama and each cloud → generic api backend", () => {
    // "Local" prefers a real on-device Ollama engine (never a silent mock).
    expect(envFor({ provider: "local" })).toEqual({
      AMOS_BACKEND: "ollama",
      AMOS_OLLAMA_HOST: LOCAL_OLLAMA_HOST,
    });
    const native = new Set<string>(["anthropic", "gemini"]);
    for (const p of CLOUD_PROVIDERS) {
      if (native.has(p)) continue; // native backends asserted below
      const cfg = { provider: p, model: "m", endpoint: "https://x/v1/chat/completions", apiKey: "sk-t" };
      const e = envFor(cfg);
      expect(e.AMOS_BACKEND).toBe("api");
      expect(e.AMOS_API_ENDPOINT).toBe("https://x/v1/chat/completions");
      expect(e.AMOS_MODEL).toBe("m");
      expect(e.AMOS_API_KEY).toBe("sk-t");
    }
    // Native (Claude / Gemini) backends use their own daemon engine and no
    // endpoint by default — the provider's official endpoint is implied.
    expect(envFor({ provider: "anthropic", model: "m", apiKey: "sk-t" })).toEqual({
      AMOS_BACKEND: "anthropic",
      AMOS_MODEL: "m",
      AMOS_API_KEY: "sk-t",
    });
    expect(envFor({ provider: "gemini", model: "m", apiKey: "sk-t" })).toEqual({
      AMOS_BACKEND: "gemini",
      AMOS_MODEL: "m",
      AMOS_API_KEY: "sk-t",
    });
    const ds = envFor({ provider: "deepseek" });
    expect(ds.AMOS_API_ENDPOINT).toBe(DEEPSEEK_ENDPOINT);
    expect(ds.AMOS_MODEL).toBe(DEEPSEEK_MODEL);
    // no key configured → no AMOS_API_KEY key at all
    expect(envFor({ provider: "openai" }).AMOS_API_KEY).toBeUndefined();
  });

  test("preset helpers expose deepseek/openai defaults and an empty custom", () => {
    expect(cloudDefaultEndpoint("deepseek")).toBe(DEEPSEEK_ENDPOINT);
    expect(cloudDefaultModel("deepseek")).toBe(DEEPSEEK_MODEL);
    expect(cloudDefaultEndpoint("openai")).toBe(OPENAI_ENDPOINT);
    expect(cloudDefaultModel("openai")).toBe(OPENAI_MODEL);
    expect(cloudDefaultEndpoint("custom")).toBe("");
    expect(cloudDefaultModel("custom")).toBe("");
    expect(isCloudProvider("local")).toBe(false);
    for (const p of CLOUD_PROVIDERS) expect(isCloudProvider(p)).toBe(true);
    expect(CLOUD_PROVIDERS).toEqual([
      "openai",
      "deepseek",
      "moonshot",
      "qwen",
      "zhipu",
      "groq",
      "mistral",
      "anthropic",
      "gemini",
      "custom",
    ]);
    // Newer OpenAI-compatible presets carry real defaults…
    expect(cloudDefaultEndpoint("moonshot")).toContain("api.moonshot.cn");
    expect(cloudDefaultModel("moonshot")).toBe("moonshot-v1-8k");
    expect(cloudDefaultEndpoint("groq")).toContain("api.groq.com");
    // …native Claude / Gemini presets default their model but leave the official
    // endpoint empty (the daemon uses it internally).
    expect(cloudDefaultModel("anthropic")).toBe("claude-3-5-sonnet-latest");
    expect(cloudDefaultEndpoint("anthropic")).toBe("");
    expect(cloudDefaultModel("gemini")).toBe("gemini-2.0-flash");
    expect(cloudDefaultEndpoint("gemini")).toBe("");
    // …while custom still requires a user-supplied endpoint/model.
    expect(cloudDefaultEndpoint("custom")).toBe("");
    expect(cloudDefaultModel("custom")).toBe("");
  });

  test("setAiConfig tolerates a non-object settings blob", () => {
    expect(
      setAiConfig(null as unknown as Record<string, unknown>, { provider: "local" }),
    ).toEqual({ aiProvider: "local" });
    const ds = setAiConfig(["x"] as unknown as Record<string, unknown>, {
      provider: "openai",
      model: "m",
      endpoint: "e",
    });
    expect(ds).toEqual({ aiProvider: "openai", aiModel: "m", aiEndpoint: "e" });
    expect("aiApiKey" in ds).toBe(false);
  });
});
