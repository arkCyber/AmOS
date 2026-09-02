import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import App from "../App";

describe("render smoke (server-side, no DOM)", () => {
  test("mounts the whole shell and renders localized labels (zh default)", () => {
    const html = renderToString(<App />);
    expect(html).toContain("设置");
    expect(html).toContain("计算器");
    expect(html).toContain("备忘录");
    expect(html).toContain("天气");
    expect(html).not.toContain("Calculator");
  });
});
