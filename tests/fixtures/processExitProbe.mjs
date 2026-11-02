// Preloaded with --import: records each process.exit() call on stderr, so a
// test can tell a process that ended by draining its event loop from one that
// was forced to exit. The write is synchronous so it survives the exit.
import { writeSync } from "node:fs";

const originalExit = process.exit;
process.exit = function exitWithRecord(code) {
  writeSync(2, `[process-exit-probe] process.exit(${String(code)})\n`);
  return originalExit.call(this, code);
};
