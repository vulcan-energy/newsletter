import { expect, it, vi } from "vitest";
import { screenAddresses, type MailResolver } from "./screening.js";

const failure = (code: string) => Object.assign(new Error(code), { code });
function resolver(records: Record<string, string[] | string>): MailResolver {
  const lookup = async (domain: string) => {
    const found = records[domain];
    if (found === undefined) throw failure("ENOTFOUND");
    if (typeof found === "string") throw failure(found);
    return found;
  };
  return {
    resolveMx: vi.fn(async (domain: string) =>
      (await lookup(domain)).map((exchange) => ({ exchange, priority: 10 })),
    ),
    resolve4: vi.fn(async (domain: string) => {
      const a = records[`a:${domain}`];
      if (!Array.isArray(a)) throw failure("ENODATA");
      return a;
    }),
    resolve6: vi.fn(async () => {
      throw failure("ENODATA");
    }),
  };
}

it("accepts ordinary addresses and flags shared role inboxes", async () => {
  const dns = resolver({ "assessors.example.co.uk": ["mx.example.net"] });
  const [person, role] = await screenAddresses(
    ["Jo.Bloggs@Assessors.Example.co.uk", "info+news@assessors.example.co.uk"],
    dns,
  );
  expect(person).toEqual({
    email: "jo.bloggs@assessors.example.co.uk",
    ok: true,
    role: false,
    mail_checked: true,
  });
  expect(role).toMatchObject({ ok: true, role: true });
  expect(dns.resolveMx).toHaveBeenCalledTimes(1);
});

it("rejects malformed, misspelled, throwaway and unattended addresses", async () => {
  const dns = resolver({ "gmial.com": ["mx.parked.example"] });
  const results = await screenAddresses(
    [
      "not-an-address",
      "two@@example.com",
      ".dot@example.com",
      "person@gmial.com",
      "person@example.con",
      "person@example.couk",
      "person@mailinator.com",
      "noreply@example.com",
      "postmaster@example.com",
    ],
    dns,
  );
  expect(results.map((r) => [r.ok, r.reason, r.suggestion])).toEqual([
    [false, "invalid", undefined],
    [false, "invalid", undefined],
    [false, "invalid", undefined],
    [false, "typo", "person@gmail.com"],
    [false, "typo", "person@example.com"],
    [false, "typo", "person@example.co.uk"],
    [false, "disposable", undefined],
    [false, "not_a_person", undefined],
    [false, "not_a_person", undefined],
  ]);
  expect(dns.resolveMx).not.toHaveBeenCalled();
});

it("rejects domains that cannot receive mail but keeps addresses it could not check", async () => {
  const dns = resolver({
    "nullmx.example": ["."],
    "nomx.example": "ENODATA",
    "a:fallback.example": ["192.0.2.1"],
    "fallback.example": "ENODATA",
    "slow.example": "ETIMEOUT",
  });
  const results = await screenAddresses(
    [
      "a@missing.example",
      "a@nullmx.example",
      "a@nomx.example",
      "a@fallback.example",
      "a@slow.example",
    ],
    dns,
  );
  expect(results.map((r) => [r.ok, r.reason, r.mail_checked])).toEqual([
    [false, "no_mail", true],
    [false, "no_mail", true],
    [false, "no_mail", true],
    [true, undefined, true],
    [true, undefined, false],
  ]);
});

it("stops looking up domains once its time budget is spent and keeps those addresses", async () => {
  const hanging: MailResolver = {
    resolveMx: () => new Promise(() => {}),
    resolve4: () => new Promise(() => {}),
    resolve6: () => new Promise(() => {}),
  };
  const started = Date.now();
  const results = await screenAddresses(
    Array.from({ length: 40 }, (_, i) => `a@slow-${i}.example`),
    hanging,
    50,
  );
  expect(Date.now() - started).toBeLessThan(2000);
  expect(results.every((r) => r.ok && r.mail_checked === false)).toBe(true);
});
