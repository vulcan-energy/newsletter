import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
// Finds dependencies wherever npm put them: in this package or a parent workspace.
const resolve = createRequire(join(root, "package.json")).resolve;
// Some packages (parse5, @types/node) do not export package.json, so fall back to
// their entry point and walk up to the folder that names them.
function packageDir(name) {
  try {
    return dirname(resolve(`${name}/package.json`));
  } catch {
    let dir = dirname(resolve(name));
    while (
      !existsSync(join(dir, "package.json")) ||
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== name
    ) {
      if (dirname(dir) === dir) throw new Error(`Cannot locate ${name}`);
      dir = dirname(dir);
    }
    return dir;
  }
}

test("the packed package installs and runs its standalone host example using fakes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "newsletter-package-"));
  try {
    const [packed] = JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          "--dry-run",
          "--ignore-scripts",
          "--offline",
          "--json",
          "--cache",
          join(temporary, "cache"),
        ],
        { cwd: root, encoding: "utf8" },
      ),
    );
    const files = packed.files.map(({ path }) => path);
    assert(files.includes("examples/host.ts"), "ship the standalone example");
    assert(files.includes("schema.sql"), "ship the installation schema");
    assert(files.includes("dist/index.d.ts"), "ship declarations");
    assert(files.includes("dist/cli.js"), "ship the CLI");
    assert(files.includes("LICENSE") && files.includes("AGENTS.md"));
    assert(
      !files.some(
        (path) =>
          path.startsWith("src/") ||
          path.startsWith("fixtures/") ||
          path.startsWith("tests/") ||
          /(?:\.test\.|\/testing\/)/.test(path),
      ),
    );
    const manifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    const modules = join(temporary, "node_modules");
    const installed = join(modules, manifest.name);
    for (const path of files) {
      await mkdir(dirname(join(installed, path)), { recursive: true });
      await cp(join(root, path), join(installed, path));
    }
    for (const dependency of [
      "@supabase/supabase-js",
      "@supabase/postgrest-js",
      "@supabase/storage-js",
      "@supabase/auth-js",
      "@supabase/functions-js",
      "@supabase/realtime-js",
      "@supabase/node-fetch",
      "@modelcontextprotocol/sdk",
      "@types/node",
      "undici-types",
      "zod",
      "parse5",
      "entities",
    ]) {
      let source;
      try {
        source = packageDir(dependency);
      } catch {
        continue; // Optional transitive packages differ between versions.
      }
      await mkdir(dirname(join(modules, dependency)), { recursive: true });
      await symlink(source, join(modules, dependency));
    }
    await cp(join(installed, "examples/host.ts"), join(temporary, "host.ts"));
    await cp(
      join(root, "tests/testing/consumer.ts"),
      join(temporary, "consumer.ts"),
    );
    await writeFile(
      join(temporary, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      join(temporary, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          types: ["node"],
          outDir: "build",
        },
        include: ["host.ts", "consumer.ts"],
      }),
    );
    execFileSync(
      process.execPath,
      [resolve("typescript/bin/tsc"), "-p", temporary],
      { stdio: "pipe" },
    );
    execFileSync(process.execPath, [join(temporary, "build/consumer.js")], {
      stdio: "pipe",
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
