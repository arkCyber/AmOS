/**
 * DOM tests for the authentication section of Settings ▸ 企业功能 ▸ API 集成 (REQ-A801).
 *
 * **The defect these pin.** `APISettings.svelte` rendered the auth method as a `disabled` select
 * with one hard-coded English option, `"Bearer Token"`, and a hint reading
 * 「当前仅支持 Bearer Token 认证」 / "Only Bearer Token authentication is supported today".
 * Both sentences were **false**:
 *   * `APIClient.buildHeaders` implemented three methods — `api_key` (→ `X-API-Key`),
 *     `bearer_token` and `basic` — and `DEFAULT_API_CONFIG.authType` was `api_key`, **not** bearer;
 *   * the credential inputs the other two read (`bearerToken`, `username`, `password`) had **no
 *     control anywhere in the app**, so the two working methods could not be configured even if
 *     the user disbelieved the sentence;
 *   * `oauth2` was declared in `APIAuthType` but had no branch in the chain, so a config naming it
 *     sent requests with **no auth header at all** — a 401 with nothing on screen to explain it.
 *
 * This is F-SH-001's third form: not a control that does nothing, but a **greyed control whose
 * stated reason is false**. It is self-certifying — the screen looks honest (it even explains
 * itself) and the capability is switched off by a sentence. So the tests below assert two things
 * at once: what the screen *says*, and what the app *does* when the user acts on it.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import APISettings from "../src/svelte/modules/APISettings.svelte";
import { setLocale } from "../src/svelte/locale.svelte";
import { apiClient } from "../src/lib/enterprise/api";

const STORE_KEY = "amos.shortcuts.api.config";

/** The two spellings of the retired false sentence, inlined as literals on purpose: a test that
 *  imported them from the dictionary would stop failing the moment someone deleted the key, and
 *  the point is that the *sentence* is gone from the rendered screen. */
const FALSE_SENTENCE = {
  en: "Only Bearer Token authentication is supported today",
  zh: "当前仅支持 Bearer Token 认证",
};

/** Mount the panel with a usable client, the way the section is reached in the app. */
function mountEnabled() {
  apiClient.configure({
    enabled: true,
    baseUrl: "https://api.example.test",
    authType: "api_key",
    apiKey: "",
    bearerToken: "",
    username: "",
    password: "",
  });
  return render(APISettings);
}

beforeEach(() => {
  localStorage.clear();
  setLocale("en");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setLocale("en");
});

describe("API 集成的认证方式（REQ-A801）", () => {
  test("下拉是活的，选项就是词表本身，一个不多一个不少", () => {
    const { getByTestId } = mountEnabled();
    const select = getByTestId("api-auth-method") as HTMLSelectElement;

    expect(select.disabled).toBe(false);
    const options = Array.from(select.querySelectorAll("option"));
    // The rendered list and `AUTH_TYPES` are the same vocabulary: `AUTH_TYPE_LABEL_KEY` is a
    // `Record<APIAuthType, string>`, so a member cannot exist in the type without a label here.
    expect(options.map((o) => o.value)).toEqual([
      "api_key",
      "bearer_token",
      "oauth2",
      "basic",
    ]);
  });

  test("三个能用的方法都是可选的，唯独 oauth2 是灰的 —— 而它的理由写在标签里", () => {
    const { getByTestId } = mountEnabled();
    const select = getByTestId("api-auth-method") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option"));
    const byValue = (v: string) => options.find((o) => o.value === v)!;

    for (const live of ["api_key", "bearer_token", "basic"]) {
      expect(byValue(live).disabled, `${live} must be selectable`).toBe(false);
    }
    // The unimplemented member stays in the list rather than being hidden (hiding it would be
    // the other half of the same defect: the vocabulary declares it and the screen never says
    // so), and its label carries the true reason where the user meets it.
    expect(byValue("oauth2").disabled).toBe(true);
    expect(byValue("oauth2").textContent ?? "").toContain("not implemented in this build");
    expect(byValue("oauth2").textContent ?? "").toContain("sends no auth header");
  });

  test("「只支持 Bearer Token」这句话不再出现在屏幕上（两种语言都查）", () => {
    const en = mountEnabled();
    const enText = en.getByTestId("api-auth-method").closest(".form-group")?.textContent ?? "";
    // Present-and-true: the hint that replaced it must actually be rendering, or "absent" is
    // just a screen that failed to draw.
    expect(enText).toContain("The method decides which credential travels in the request header");
    expect(document.body.textContent ?? "").not.toContain(FALSE_SENTENCE.en);
    cleanup();

    setLocale("zh");
    const zh = mountEnabled();
    expect(zh.getByTestId("api-auth-method").closest(".form-group")?.textContent ?? "").toContain(
      "认证方式",
    );
    expect(document.body.textContent ?? "").not.toContain(FALSE_SENTENCE.zh);
    expect(document.body.textContent ?? "").not.toContain(FALSE_SENTENCE.en);
  });

  test("关掉 API 集成时下拉是灰的 —— 这次理由是**真的**", () => {
    apiClient.configure({ enabled: false });
    const { getByTestId } = render(APISettings);
    expect((getByTestId("api-auth-method") as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("API 集成的认证方式：选了之后真的能用（REQ-A801）", () => {
  test("basic 显示用户名 + 密码两个输入框，而且不显示 bearer 的那个", async () => {
    const { getByTestId, queryByTestId } = mountEnabled();
    await fireEvent.change(getByTestId("api-auth-method"), { target: { value: "basic" } });

    expect(getByTestId("api-auth-field-username")).toBeTruthy();
    expect(getByTestId("api-auth-field-password")).toBeTruthy();
    // The rendered inputs are `AUTH_TYPE_INFO[type].fields` — one declaration, so a field that
    // the request path does not read cannot appear, and vice versa.
    expect(queryByTestId("api-auth-field-bearerToken")).toBeNull();
    expect(queryByTestId("api-auth-field-apiKey")).toBeNull();

    await fireEvent.change(getByTestId("api-auth-method"), { target: { value: "api_key" } });
    expect(getByTestId("api-auth-field-apiKey")).toBeTruthy();
    expect(queryByTestId("api-auth-field-username")).toBeNull();
  });

  test("填好 bearer token 并保存 → 配置与落盘都真的变了（不是只改了屏幕）", async () => {
    const { getByTestId, getByText } = mountEnabled();

    await fireEvent.change(getByTestId("api-auth-method"), { target: { value: "bearer_token" } });
    await fireEvent.input(getByTestId("api-auth-field-bearerToken"), {
      target: { value: "t-456" },
    });
    await fireEvent.click(getByText("Save configuration"));

    expect(apiClient.getConfig().authType).toBe("bearer_token");
    expect(apiClient.getConfig().bearerToken).toBe("t-456");

    // The claim the user is actually shown is 「配置已保存」 — "it will still be there next time".
    // So assert it the way the next launch would find out: reload from the store and read the
    // config back. (Asserting the raw `localStorage` bytes instead would pin this key's on-disk
    // *encoding*, which is `writeStoreValueChecked`'s business, not the screen's — and that
    // encoding is not obvious here: this key round-trips through an extra `JSON.stringify`.)
    expect(localStorage.getItem(STORE_KEY)).not.toBeNull();
    await apiClient.initialize();
    expect(apiClient.getConfig().authType).toBe("bearer_token");
    expect(apiClient.getConfig().bearerToken).toBe("t-456");
  });

  test("凭据空着时点出来：会**不带认证发出请求**这件事，在请求发出之前就说", () => {
    const { getByTestId, queryByTestId } = mountEnabled();
    // Enabled + api_key with an empty key: every request would go out unauthenticated and the
    // server's 401 is the first the user would hear of it. Said here, where the fix is.
    expect(getByTestId("api-auth-incomplete").textContent ?? "").toContain("API key");
    expect(queryByTestId("api-auth-incomplete")).toBeTruthy();
  });

  test("填上凭据之后那句提醒自己消失，换成 oauth2 时换成「本版本没实现」", async () => {
    const { getByTestId, queryByTestId } = mountEnabled();

    await fireEvent.input(getByTestId("api-auth-field-apiKey"), { target: { value: "k-1" } });
    expect(queryByTestId("api-auth-incomplete")).toBeNull();
    expect(queryByTestId("api-auth-unimplemented")).toBeNull();

    // `oauth2` is greyed in the select, so this state is not reachable *by the select* — but it
    // is reachable from a stored config written by an older build, which is exactly why the
    // panel has to render the reason rather than trust that the select prevents it.
    apiClient.configure({ authType: "oauth2" });
    cleanup();
    const revived = render(APISettings);
    expect(revived.getByTestId("api-auth-unimplemented").textContent ?? "").toContain(
      "requests carry no auth header",
    );
    // And the credential inputs of the method it fell back from are gone: oauth2 reads none.
    expect(revived.queryByTestId("api-auth-field-apiKey")).toBeNull();
  });
});
