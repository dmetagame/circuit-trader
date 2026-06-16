import { describe, expect, it } from "vitest";
import { unwrapToolResult } from "../src/index";

describe("unwrapToolResult", () => {
  it("prefers structuredContent", () => {
    expect(unwrapToolResult({ structuredContent: { price: 600 }, content: [{ type: "text", text: "ignore" }] })).toEqual({ price: 600 });
  });

  it("parses a JSON text block", () => {
    expect(unwrapToolResult({ content: [{ type: "text", text: '{"quoteId":"q1","price":600}' }] })).toEqual({ quoteId: "q1", price: 600 });
  });

  it("wraps non-JSON text as { text }", () => {
    expect(unwrapToolResult({ content: [{ type: "text", text: "hello" }] })).toEqual({ text: "hello" });
  });

  it("throws on isError, surfacing the text", () => {
    expect(() => unwrapToolResult({ isError: true, content: [{ type: "text", text: "rate limited" }] })).toThrow(/rate limited/);
  });

  it("returns content when there is no text block", () => {
    const content = [{ type: "image" }];
    expect(unwrapToolResult({ content })).toEqual(content);
  });
});
