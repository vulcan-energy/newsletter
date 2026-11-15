import { parse, type DefaultTreeAdapterMap } from "parse5";
import { NewsletterError } from "./errors.js";
// Counts HTML anchors whose raw source href is the placeholder (the provider substitutes
// raw text). Rebuilt mis-nested nodes have no position; SVG/MathML anchors don't render.
export function unsubscribeLinks(html: string) {
  const found = new Set<number>();
  function visit(node: DefaultTreeAdapterMap["node"]) {
    const span = "tagName" in node ? node.sourceCodeLocation?.attrs?.href : undefined;
    if (
      span &&
      "tagName" in node &&
      node.tagName === "a" &&
      node.namespaceURI === "http://www.w3.org/1999/xhtml" &&
      /^href\s*=\s*(["']?)\{\{unsubscribe_url\}\}\1$/i.test(
        html.slice(span.startOffset, span.endOffset),
      )
    )
      found.add(span.startOffset);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  }
  visit(parse(html, { sourceCodeLocationInfo: true }));
  return found.size;
}
// Edit source spans so email-client conditionals and layout stay byte-for-byte intact.
export function renderTracking(
  html: string,
  campaignId: string,
  baseUrl: string,
) {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new NewsletterError(
      "Tracking base must be an HTTPS URL without credentials or query",
    );
  const prefix = `${base.href.replace(/\/$/, "")}/${encodeURIComponent(campaignId)}`;
  const url = (part: string) => `${prefix}/${part}?token={{tracking_token}}`;
  const links: string[] = [];
  const edits = new Map<number, { end: number; text: string }>();
  let footerAt = html.length;
  function visit(node: DefaultTreeAdapterMap["node"]) {
    if ("tagName" in node && node.tagName === "body")
      footerAt = node.sourceCodeLocation?.endTag?.startOffset ?? html.length;
    if ("tagName" in node && ["a", "area"].includes(node.tagName)) {
      const href = node.attrs.find((a) => a.name === "href")?.value;
      if (
        href &&
        href !== "{{unsubscribe_url}}" &&
        !/^(?:#|mailto:|tel:)/i.test(href)
      ) {
        const destination = URL.parse(href);
        if (!destination) throw new NewsletterError(`Links must be full URLs: ${href.slice(0, 80)}`);
        if (
          !["https:", "http:"].includes(destination.protocol) ||
          destination.username ||
          destination.password
        )
          throw new NewsletterError("Links require HTTP(S) without credentials");
        let index = links.indexOf(destination.href);
        if (index < 0) index = links.push(destination.href) - 1;
        const span = node.sourceCodeLocation?.attrs?.href;
        if (span)
          // Reconstructed formatting nodes can share the same original attribute span.
          edits.set(span.startOffset, {
            end: span.endOffset,
            text: `href="${url(String(index))}"`,
          });
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  }
  visit(parse(html, { sourceCodeLocationInfo: true }));
  const footer = `<p><a href="${url("preferences")}">Stop open and click tracking</a></p><img src="${url("open")}" width="1" height="1" alt="" style="display:none">`;
  edits.set(footerAt, { end: footerAt, text: footer });
  for (const [start, edit] of [...edits].sort((a, b) => b[0] - a[0]))
    html = html.slice(0, start) + edit.text + html.slice(edit.end);
  if (
    Buffer.byteLength(html.replaceAll("{{tracking_token}}", "0".repeat(36))) >=
    102 * 1024
  )
    throw new NewsletterError("Tracked HTML must be under 102 KB");
  return { html, links };
}
