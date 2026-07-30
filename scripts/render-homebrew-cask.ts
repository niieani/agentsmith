import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const checksum = /^[0-9a-f]{64}$/;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const version = argument("--version");
const sha256 = argument("--sha256");
const output = argument("--output");

if (!version || !semver.test(version)) fail("--version must be a semantic version without a leading v");
if (!sha256 || !checksum.test(sha256)) fail("--sha256 must be a lowercase SHA-256 checksum");
if (!output) fail("--output is required");

const content = `cask "agentsmith" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/niieani/agentsmith/releases/download/v#{version}/agentsmith_#{version}_darwin_arm64.tar.gz"
  name "agentsmith"
  desc "Assemble agent instructions and skills from reusable, scope-aware sources"
  homepage "https://github.com/niieani/agentsmith"

  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  binary "asmith"
end
`;

const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
await Bun.write(destination, content);
console.log(destination);
