import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { z } from "zod";

import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { writeApplicationZip } from "../../support/applicationSessionFixture.js";

const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

const harmonyEntries = [
  { path: "module.json", content: '{"module":{"name":"entry"}}' },
  { path: "ets/modules.abc", content: "panda bytecode" },
  { path: "libs/arm64-v8a/libentry.so", content: elf },
  { path: "resources.index", content: "resource index" },
] as const;

it.each([
  { filename: "Fixture.hap", format: "hap" },
  { filename: "Fixture.hsp", format: "hsp" },
  { filename: "Fixture.app", format: "app-pack" },
] as const)(
  "opens a HarmonyOS $format root through the public session opener",
  async ({ filename, format }) => {
    const path = await writeApplicationZip(
      "rea-harmony-session-format-",
      filename,
      harmonyEntries,
    );
    const session = createTestBinarySession(new ArtifactProvider(process.env));
    const server = createServer({ kind: "session", session });
    const client = new Client({
      name: "harmony-session-format-test",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      expect(opened.isError).not.toBe(true);
      expect(
        z
          .object({ result: z.object({ format: z.string() }) })
          .parse(opened.structuredContent).result.format,
      ).toBe(format);

      const status = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(status.isError).not.toBe(true);
      expect(
        z
          .object({
            result: z.object({ open: z.literal(true), format: z.string() }),
          })
          .parse(status.structuredContent).result.format,
      ).toBe(format);
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  },
);
