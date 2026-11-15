import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";
it("stays portable: no host imports, one provider module, and a small implementation", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  let lines = 0;
  function scan(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(path);
        continue;
      }
      if (!/\.(?:ts|mjs|js)$/.test(entry.name)) continue;
      const text = readFileSync(path, "utf8");
      expect(text).not.toMatch(/from ['"](?:@repo\/|apps\/)/);
      if (!path.endsWith("/providers/resend.ts"))
        expect(text).not.toMatch(/from ['"]resend['"]/);
      if (path.includes("/src/") && !path.endsWith(".test.ts") && !path.includes("/testing/"))
        lines += text.split("\n").length;
    }
  }
  scan(root);
  expect(lines).toBeLessThan(3000);
  expect(existsSync(join(root, "LICENSE"))).toBe(true);
});
