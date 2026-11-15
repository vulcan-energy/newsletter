import { Resolver } from "node:dns/promises";
import { normalizeEmail } from "./subscribers.js";

export type ScreenResult = {
  email: string;
  ok: boolean;
  reason?: "invalid" | "typo" | "disposable" | "not_a_person" | "no_mail";
  suggestion?: string;
  // Shared inboxes such as info@ are common for small firms, so they are flagged, not refused.
  role?: boolean;
  // False when DNS could not answer; the address is kept rather than refused.
  mail_checked?: boolean;
};
export type MailResolver = {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
};

const shape =
  /^(?!\.)(?!.*\.\.)[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}(?<!\.)@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const typos: Record<string, string> = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmal.com": "gmail.com",
  "gamil.com": "gmail.com", "gnail.com": "gmail.com", "gmaill.com": "gmail.com",
  "googlemial.com": "googlemail.com", "hotmial.com": "hotmail.com",
  "hotmal.com": "hotmail.com", "hotmai.com": "hotmail.com", "homail.com": "hotmail.com",
  "hotmial.co.uk": "hotmail.co.uk", "outlok.com": "outlook.com", "outllok.com": "outlook.com",
  "outloo.com": "outlook.com", "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com",
  "yaho.co.uk": "yahoo.co.uk", "iclod.com": "icloud.com", "icoud.com": "icloud.com",
  "btinterent.com": "btinternet.com", "btinternt.com": "btinternet.com",
  "btinternet.co": "btinternet.com",
};
const disposable = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com",
  "10minutemail.com", "temp-mail.org", "tempmail.com", "tempail.com", "yopmail.com",
  "trashmail.com", "getnada.com", "maildrop.cc", "dispostable.com", "throwawaymail.com",
  "fakeinbox.com", "mailnesia.com", "spamgourmet.com", "emailondeck.com", "mohmal.com",
  "mintemail.com",
]);
const roles = new Set([
  "info", "admin", "office", "hello", "contact", "enquiries", "enquiry", "sales",
  "support", "accounts", "team", "mail", "reception", "help",
]);
const unattended = new Set([
  "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "postmaster",
  "abuse", "hostmaster", "bounce", "bounces",
]);

function suggestDomain(domain: string) {
  const fixed =
    typos[domain] ??
    domain.replace(/\.(con|cmo|ocm|comm|vom|xom)$/, ".com").replace(/\.couk$/, ".co.uk");
  return fixed === domain ? undefined : fixed;
}
const code = (error: unknown) => (error as { code?: string })?.code;

// true: can receive; false: DNS says no (no domain, null MX, no MX/A/AAAA); null: no answer.
async function receivesMail(domain: string, dns: MailResolver) {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length === 1 && [".", ""].includes(mx[0].exchange)) return false;
    if (mx.length) return true;
  } catch (error) {
    if (code(error) === "ENOTFOUND") return false;
    if (code(error) !== "ENODATA") return null;
  }
  for (const lookup of [dns.resolve4, dns.resolve6]) {
    try {
      if ((await lookup.call(dns, domain)).length) return true;
    } catch (error) {
      if (!["ENODATA", "ENOTFOUND"].includes(code(error) ?? "")) return null;
    }
  }
  return false;
}

// budgetMs caps the whole batch; domains still unchecked when it runs out are kept.
export async function screenAddresses(
  emails: string[],
  dns: MailResolver = new Resolver({ timeout: 3000, tries: 2 }),
  budgetMs = 60_000,
): Promise<ScreenResult[]> {
  const deadline = Date.now() + budgetMs;
  const domains = new Map<string, Promise<boolean | null>>();
  let active = 0;
  const waiting: (() => void)[] = [];
  async function lookup(domain: string) {
    while (active >= 16) await new Promise<void>((go) => waiting.push(go));
    if (Date.now() >= deadline) {
      waiting.shift()?.();
      return null;
    }
    active++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        receivesMail(domain, dns),
        new Promise<null>((done) => (timer = setTimeout(done, deadline - Date.now(), null))),
      ]);
    } finally {
      clearTimeout(timer);
      active--;
      waiting.shift()?.();
    }
  }
  return Promise.all(
    emails.map(async (raw): Promise<ScreenResult> => {
      const email = normalizeEmail(raw);
      if (!shape.test(email)) return { email, ok: false, reason: "invalid" };
      const [local, domain] = email.split("@") as [string, string];
      const mailbox = local.split("+")[0]!;
      if (unattended.has(mailbox)) return { email, ok: false, reason: "not_a_person" };
      const suggestion = suggestDomain(domain);
      if (suggestion)
        return { email, ok: false, reason: "typo", suggestion: `${local}@${suggestion}` };
      if (disposable.has(domain)) return { email, ok: false, reason: "disposable" };
      if (!domains.has(domain)) domains.set(domain, lookup(domain));
      const receives = await domains.get(domain)!;
      if (receives === false)
        return { email, ok: false, reason: "no_mail", mail_checked: true };
      return { email, ok: true, role: roles.has(mailbox), mail_checked: receives === true };
    }),
  );
}
