import { lookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import { NewsletterError } from "./errors.js";
export function publicAddress(address: string) {
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
// Validate the addresses used by the socket, not a separate DNS preflight.
export async function imageResponse(url: string): Promise<Response> {
  const destination = new URL(url);
  const host = destination.hostname.replace(/^\[|\]$/g, "");
  if (destination.protocol !== "https:" || (isIP(host) && !publicAddress(host)))
    throw new NewsletterError("Image destination must be public HTTPS");
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
        lookup(host, options, callback) {
          lookup(host, { all: true }, (error, addresses) => {
            if (error) return callback(error, "", 4);
            if (
              !addresses.length ||
              addresses.some((a) => !publicAddress(a.address))
            )
              return callback(
                new Error("Image destination must be public"),
                "",
                4,
              );
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          });
        },
      },
      (response) => {
        resolve(
          new Response(null, {
            status: response.statusCode,
            headers: { "content-type": response.headers["content-type"] ?? "" },
          }),
        );
        response.destroy();
      },
    );
    req.on("error", () =>
      reject(new Error("Image destination must be public and reachable")),
    );
    req.end();
  });
}
