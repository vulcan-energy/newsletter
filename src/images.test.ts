import { expect, it, vi } from "vitest";
import { publicAddress, imageResponse } from "./images.js";
import { EventEmitter } from "node:events";
vi.mock("node:dns", () => ({
  lookup: (_host: unknown, _options: unknown, callback: any) =>
    callback(null, [{ address: "127.0.0.1", family: 4 }]),
}));
vi.mock("node:https", () => ({
  request: (_url: unknown, options: any) => {
    const request = new EventEmitter() as any;
    request.end = () =>
      options.lookup("example.com", {}, (error: Error) =>
        request.emit("error", error),
      );
    request.destroy = () => {};
    return request;
  },
}));
it.each([
  "127.0.0.1",
  "10.1.2.3",
  "192.168.0.1",
  "169.254.169.254",
  "100.64.0.1",
  "0.0.0.0",
  "::1",
  "fe80::1",
  "::ffff:127.0.0.1",
  "fc00::1",
])("rejects non-public address %s", (address) =>
  expect(publicAddress(address)).toBe(false),
);
it.each(["93.184.216.34", "2606:4700:4700::1111"])(
  "allows public address %s",
  (address) => expect(publicAddress(address)).toBe(true),
);
it("checks DNS at the actual connection lookup, blocking private destinations", async () => {
  await expect(imageResponse("https://example.com/image.png")).rejects.toThrow(
    "public",
  );
});
it.each(["https://127.0.0.1/image", "https://[::1]/image"])(
  "blocks literal private IPs before connecting: %s",
  async (url) => {
    await expect(imageResponse(url)).rejects.toThrow("public");
  },
);
