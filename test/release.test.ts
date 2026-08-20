import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import manifest from "../package.json" with { type: "json" };
import releaseManifest from "../.release-please-manifest.json" with { type: "json" };
import releaseConfig from "../release-please-config.json" with { type: "json" };
import { VERSION } from "../src/version.ts";

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const projectRoot = resolve(import.meta.dir, "..");

describe("release metadata", () => {
  test("keeps the CLI and Release Please on the package version", () => {
    expect(manifest.name).toBe("asmith");
    expect("private" in manifest).toBeFalse();
    expect(manifest.version).toMatch(semver);
    expect(VERSION).toBe(manifest.version);
    expect(releaseManifest["."]).toBe(manifest.version);
    expect(releaseConfig.packages["."]["release-type"]).toBe("node");
    expect(releaseConfig.packages["."]["package-name"]).toBe(manifest.name);
  });

  test("builds a minimal executable npm package", async () => {
    const build = Bun.spawn(["bun", "run", "npm:build"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
    const [buildError, buildCode] = await Promise.all([new Response(build.stderr).text(), build.exited]);
    expect(buildCode, buildError).toBe(0);

    const pack = Bun.spawn(["npm", "pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(pack.stdout).text(), new Response(pack.stderr).text(), pack.exited]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout) as Array<{ name: string; size: number; files: Array<{ path: string }> }>;
    expect(result[0]?.name).toBe("asmith");
    expect(result[0]?.size).toBeLessThan(200_000);
    expect(result[0]?.files.map((file) => file.path).sort()).toEqual(["LICENSE", "README.md", "dist/npm/asmith.js", "package.json"]);

    const cli = Bun.spawn(["node", "dist/npm/asmith.js", "--version"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
    const [cliOut, cliError, cliCode] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    expect(cliCode, cliError).toBe(0);
    expect(cliOut.trim()).toBe(manifest.version);
  });

  for (const runtime of ["bun", "node"]) {
    test(`reports the package version from the CLI under ${runtime}`, async () => {
      const child = Bun.spawn([runtime, "src/cli.ts", "--version"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe(manifest.version);
    });
  }
});
