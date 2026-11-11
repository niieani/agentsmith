// Tests compare paths with what Git and realpath report. On macOS the default temp directory sits behind the
// /var -> /private/var symlink, so give every test, and every process it spawns, the canonical temp directory.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

process.env.TMPDIR = realpathSync(tmpdir());
