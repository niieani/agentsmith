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
    expect(manifest.version).toMatch(semver);
    expect(VERSION).toBe(manifest.version);
    expect(releaseManifest["."]).toBe(manifest.version);
    expect(releaseConfig.packages["."]["release-type"]).toBe("node");
    expect(releaseConfig.packages["."]["package-name"]).toBe(manifest.name);
  });

  test("reports the package version from the CLI", async () => {
    const child = Bun.spawn(["bun", "run", "src/cli.ts", "--version"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(manifest.version);
  });
});
