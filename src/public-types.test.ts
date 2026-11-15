import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
it("checks external consumers against the generated public declarations", () => {
  execFileSync(
    process.execPath,
    [
      // Resolves the package's own TypeScript, wherever node_modules lives.
      createRequire(import.meta.url).resolve("typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      fileURLToPath(new URL("./testing/public-types.ts", import.meta.url)),
    ],
    { stdio: "pipe" },
  );
});
