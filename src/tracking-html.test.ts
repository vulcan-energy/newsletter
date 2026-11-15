import { expect, it } from "vitest";
import { renderTracking } from "./tracking-html.js";
const id = "00000000-0000-4000-8000-000000000001";
const base = "https://example.com/api/newsletter/tracking";
it("rewrites parsed links, decodes entities, preserves email markup and leaves unsubscribe direct", () => {
  const input = `<!doctype html><html><body><!--[if mso]>outlook<![endif]--><a title='a > b' href='https://example.org/?a=1&amp;b=2'>Read</a><a href=https://example.org/?a=1&amp;b=2>Again</a><a href="{{unsubscribe_url}}">Leave</a><a href="mailto:hello@example.org">Reply</a></body></html>`;
  const result = renderTracking(input, id, base);
  expect(result.links).toEqual(["https://example.org/?a=1&b=2"]);
  expect(result.html.match(new RegExp(`${id}/0`, "g"))).toHaveLength(2);
  expect(result.html).toContain("token={{tracking_token}}");
  expect(result.html).toContain('href="{{unsubscribe_url}}"');
  expect(result.html).toContain("<!--[if mso]>outlook<![endif]-->");
  expect(result.html).toContain('href="mailto:hello@example.org"');
  expect(result.html).toContain(`${id}/preferences?token={{tracking_token}}`);
  expect(result.html).toContain(`${id}/open?token={{tracking_token}}`);
  expect(input).not.toContain("/tracking/");
});
it.each([
  "javascript:alert(1)",
  "https://user:password@example.com",
  "/relative",
  "data:text/html,hello",
])("rejects ambiguous or unsafe link %s", (href) => {
  expect(() =>
    renderTracking(`<a href="${href}">link</a>`, id, base),
  ).toThrow();
});
it("checks the final email size and restricts the public tracking origin", () => {
  expect(() => renderTracking("x".repeat(102 * 1024 - 1), id, base)).toThrow(
    /102 KB/,
  );
  expect(() => renderTracking("", id, "http://example.com")).toThrow(/HTTPS/);
  expect(() =>
    renderTracking("", id, "https://example.com/?key=secret"),
  ).toThrow();
});
it("rewrites a misnested anchor source only once when the parser reconstructs it", () => {
  const input = "<p><a href=https://example.com>one</p><p>two</a></p>";
  const result = renderTracking(input, id, base);
  expect(result.links).toEqual(["https://example.com/"]);
  expect(
    result.html.startsWith(
      `<p><a href="${base}/${id}/0?token={{tracking_token}}">one</p><p>two</a></p>`,
    ),
  ).toBe(true);
});
it("inserts the withdrawal footer at the actual body end tag rather than text inside a comment", () => {
  const result = renderTracking(
    "<html><body><!-- Example </body> --> <p>hello</p></body></html>",
    id,
    base,
  );
  expect(result.html).toContain("<!-- Example </body> -->");
  expect(result.html).toContain(
    `<p>hello</p><p><a href="${base}/${id}/preferences?token={{tracking_token}}">`,
  );
  expect(result.html.endsWith("</body></html>")).toBe(true);
});
it("enforces the byte limit after every recipient token expands to a UUID", () => {
  const limit = 102 * 1024;
  const empty = renderTracking("<body></body>", id, base).html;
  const expandedBytes = Buffer.byteLength(
    empty.replaceAll("{{tracking_token}}", "0".repeat(36)),
  );
  const input = (padding: number) => `<body>${"x".repeat(padding)}</body>`;
  expect(() =>
    renderTracking(input(limit - expandedBytes - 1), id, base),
  ).not.toThrow();
  expect(() => renderTracking(input(limit - expandedBytes), id, base)).toThrow(
    /102 KB/,
  );
});
