import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export interface WalkedFile {
  absolutePath: string;
  relativePath: string;
  content: Uint8Array;
  mode: number;
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

export async function walkFiles(root: string): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error(`Source symlinks are not supported: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`Expected a source directory: ${root}`);

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`Source symlinks are not supported: ${path}`);
      }
      if (stat.isDirectory()) {
        await visit(path);
      } else if (stat.isFile()) {
        files.push({
          absolutePath: path,
          relativePath: relative(root, path),
          content: await readFile(path),
          mode: stat.mode & 0o777,
        });
      }
    }
  }

  await visit(root);
  return files;
}

export function lexicalSort<T>(values: T[], key: (value: T) => string): T[] {
  return values.sort((left, right) => {
    const a = key(left);
    const b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
