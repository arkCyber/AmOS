import { describe, expect, test } from "bun:test";
import {
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  readAiConfig,
  setAiConfig,
  envFor,
} from "../lib/providers";

describe("AI provider config", () => {
  test("readAiConfig defaults to local and tolerates garbage", () => {
    expect(readAiConfig(undefined)).toEqual({ provider: "local" });
    expect(readAiConfig({})).toEqual({ provider: "local" });
    expect(readAiConfig({ aiProvider: "deepseek", aiModel: "m", aiApiKey: "k" })).toEqual({
      provider: "deepseek",
      model: "m",
      apiKey: "k",
      endpoint: DEEPSEEK_ENDPOINT, // endpoint falls back to the DeepSeek default
    });
  });

  test("setAiConfig round-trips cloud fields but never stores the API key", () => {
    const cfg = { provider: "deepseek", model: "deepseek-chat", endpoint: DEEPSEEK_ENDPOINT, apiKey: "sk-x" } as const;
    const stored = setAiConfig({ wallpaper: "w" }, cfg);
    expect(stored.aiProvider).toBe("deepseek");
    expect(stored.aiModel).toBe("deepseek-chat");
    expect(stored.wallpaper).toBe("w"); // unrelated keys preserved
    expect("aiApiKey" in stored).toBe(false); // key is NOT persisted to settings

    // readback has no key (it lives only in the 0600 Rust key file)
    const cfgOut = readAiConfig(stored);
    expect(cfgOut).toMatchObject({ provider: "deepseek", model: "deepseek-chat", endpoint: DEEPSEEK_ENDPOINT });
    expect(cfgOut.apiKey).toBeUndefined();

    const local = setAiConfig(stored, { provider: "local" });
    expect(local.aiProvider).toBe("local");
    expect("aiApiKey" in local).toBe(false);
    expect("aiModel" in local).toBe(false);
  });

  test("envFor maps local → mock and deepseek → api + endpoint/model/key", () => {
    expect(envFor({ provider: "local" })).toEqual({ AMOS_BACKEND: "mock" });
    const ds = envFor({
      provider: "deepseek",
      model: DEEPSEEK_MODEL,
      endpoint: DEEPSEEK_ENDPOINT,
      apiKey: "sk-test",
    });
    expect(ds.AMOS_BACKEND).toBe("api");
    expect(ds.AMOS_API_ENDPOINT).toBe(DEEPSEEK_ENDPOINT);
    expect(ds.AMOS_MODEL).toBe(DEEPSEEK_MODEL);
    expect(ds.AMOS_API_KEY).toBe("sk-test");
    // no key configured → no AMOS_API_KEY key at all
    expect(envFor({ provider: "deepseek" }).AMOS_API_KEY).toBeUndefined();
  });

  test("setAiConfig tolerates a non-object settings blob", () => {
    expect(
      setAiConfig(null as unknown as Record<string, unknown>, { provider: "local" }),
    ).toEqual({ aiProvider: "local" });
    const ds = setAiConfig(["x"] as unknown as Record<string, unknown>, {
      provider: "deepseek",
      model: "m",
      endpoint: "e",
    });
    expect(ds).toEqual({ aiProvider: "deepseek", aiModel: "m", aiEndpoint: "e" });
    expect("aiApiKey" in ds).toBe(false);
  });
});
