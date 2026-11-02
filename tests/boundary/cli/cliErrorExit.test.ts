import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// Writes a line to stderr whenever the CLI calls process.exit().
const exitProbe = pathToFileURL(
  resolve("tests/fixtures/processExitProbe.mjs"),
).href;

describe("compiled CLI error exits", () => {
  // On Node 24, process.exit() can deadlock while a V8 background compile waits
  // for a main-thread garbage collection (nodejs/node#64274); on macOS CI this
  // validation error printed its result and then never exited.
  cliTest(
    "ends a validation error by draining the event loop",
    async ({ cli }) => {
      const missingTarget = join(
        await createTestTempDirectory("rea-cli-error-exit-"),
        "absent",
      );
      const result = await cli.run({
        arguments: [
          "demangle-swift",
          missingTarget,
          "$s4main3FooV",
          "$s4main\n3FooV",
          "--json",
        ],
        environment: {
          REA_LOG_LEVEL: "silent",
          NODE_OPTIONS: `--import=${exitProbe}`,
        },
        timeoutMs: 20_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(result.stderr, "the CLI ended through process.exit()").toBe("");
    },
  );
});
