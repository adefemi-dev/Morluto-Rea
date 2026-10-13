import { describe, expect, it } from "vitest";

import { managedMemberInspectionSchema } from "../domain/managed/managedArtifact.js";

import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";
import {
  buildPortablePdbFixture,
  portablePdbGuidBytes,
  PORTABLE_PDB_FIXTURE_AGE,
  PORTABLE_PDB_FIXTURE_GUID,
  portablePdbStamp,
} from "./PortablePdb.fixture.js";

const matchingCodeview = {
  guid: portablePdbGuidBytes(PORTABLE_PDB_FIXTURE_GUID),
  age: PORTABLE_PDB_FIXTURE_AGE,
  path: "/src/fixture.pdb",
};

const memberInspection = (
  pe: Buffer,
  pdb?:
    | { kind: "external"; path: string; bytes: Buffer; sha256: string }
    | {
        kind: "embedded";
      },
) =>
  managedMemberInspectionSchema.parse(
    inspectManagedMembersBytes(pe, managedPeFixtureTarget(pe), (pdb === undefined ? {} : { pdb })),
  );

const externalPdb = (bytes: Buffer, path = "/src/fixture.pdb") => ({
  kind: "external" as const,
  path,
  bytes,
  sha256: "0".repeat(64),
});

describe("Portable PDB debug map binding", () => {
  it("reports debug_map as null when no PDB selector is supplied", () => {
    const result = memberInspection(buildManagedPeFixture());
    expect(result.debug_map).toBeNull();
  });

  it("binds a matching external Portable PDB to build-local method tokens", () => {
    const pdb = buildPortablePdbFixture({
      documents: [
        {
          name: "/src/Program.cs",
          hashAlgorithm: "sha-256",
          hash: Buffer.from("11".repeat(32), "hex"),
          language: "csharp",
        },
      ],
      methods: [
        {
          document: 1,
          points: [
            {
              il: 0,
              startLine: 10,
              startColumn: 5,
              endLine: 10,
              endColumn: 30,
            },
            { il: 3, hidden: true },
            { il: 5, startLine: 12, startColumn: 9, endLine: 14, endColumn: 2 },
          ],
        },
      ],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    expect(result.debug_map).toMatchObject({
      status: "bound",
      source: { kind: "external", path: "/src/fixture.pdb" },
      identity: {
        status: "matched",
        declared: {
          codeview: {
            guid: PORTABLE_PDB_FIXTURE_GUID,
            age: PORTABLE_PDB_FIXTURE_AGE,
            declared_path: "/src/fixture.pdb",
          },
        },
      },
      documents: [
        expect.objectContaining({
          token: "0x30000001",
          name: "/src/Program.cs",
          hash_algorithm: "sha-256",
          hash: "11".repeat(32),
          language: "csharp",
        }),
      ],
      methods: [
        expect.objectContaining({
          token: "0x06000001",
          state: "decoded",
          document_token: "0x30000001",
          sequence_points: [
            expect.objectContaining({
              il_offset: 0,
              start_line: 10,
              start_column: 5,
              end_line: 10,
              end_column: 30,
              hidden: false,
              document_token: "0x30000001",
            }),
            expect.objectContaining({
              il_offset: 3,
              hidden: true,
              start_line: 0xfe_efee,
              document_token: "0x30000001",
            }),
            expect.objectContaining({
              il_offset: 5,
              start_line: 12,
              start_column: 9,
              end_line: 14,
              end_column: 2,
              hidden: false,
            }),
          ],
        }),
      ],
    });
    expect(result.debug_map?.pdb?.entry_point_token).toBe("0x06000001");
    expect(result.debug_map?.identity.checks).toContainEqual(
      expect.objectContaining({ name: "rsds-stamp", result: "matched" }),
    );
    expect(result.debug_map?.identity.checks).toContainEqual(
      expect.objectContaining({ name: "entry-point", result: "matched" }),
    );
    expect(result.debug_map?.identity.checks).toContainEqual(
      expect.objectContaining({ name: "methoddef-rows", result: "matched" }),
    );
    expect(result.coverage.state).toBe("complete");
  });

  it("tracks document switches inside a method spanning multiple documents", () => {
    const pdb = buildPortablePdbFixture({
      documents: [{ name: "/src/A.cs" }, { name: "/src/B.cs" }],
      methods: [
        {
          document: 0,
          points: [
            {
              il: 0,
              document: 1,
              startLine: 1,
              startColumn: 1,
              endLine: 1,
              endColumn: 10,
            },
            {
              il: 2,
              document: 2,
              startLine: 5,
              startColumn: 1,
              endLine: 5,
              endColumn: 8,
            },
            { il: 9, startLine: 7, startColumn: 1, endLine: 7, endColumn: 4 },
          ],
        },
      ],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    const method = result.debug_map?.methods[0];
    expect(method?.state).toBe("decoded");
    expect(method?.document_token).toBeNull();
    expect(
      method?.sequence_points.map((point) => point.document_token),
    ).toEqual(["0x30000001", "0x30000002", "0x30000002"]);
    expect(
      result.debug_map?.documents.map((document) => document.name),
    ).toEqual(["/src/A.cs", "/src/B.cs"]);
  });
});

describe("Portable PDB identity reporting", () => {
  it("keeps a GUID/age mismatch explicit while still reporting PDB evidence", () => {
    const pdb = buildPortablePdbFixture({
      pdbId: portablePdbStamp("99999999-8888-7777-6666-555555555555", 3),
      documents: [{ name: "/src/Program.cs" }],
      methods: [
        { document: 1, points: [{ il: 0, startLine: 1, startColumn: 1 }] },
      ],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    expect(result.debug_map?.status).toBe("bound");
    expect(result.debug_map?.identity.status).toBe("mismatched");
    expect(result.debug_map?.identity.checks).toContainEqual(
      expect.objectContaining({ name: "rsds-stamp", result: "mismatched" }),
    );
    expect(result.limitations.join("\n")).toContain(
      "does not share the assembly's declared CodeView identity",
    );
  });

  it("reports identity as undeclared when the PE has no CodeView entry", () => {
    const pdb = buildPortablePdbFixture({
      documents: [{ name: "/src/Program.cs" }],
      methods: [
        { document: 1, points: [{ il: 0, startLine: 1, startColumn: 1 }] },
      ],
    });
    const result = memberInspection(buildManagedPeFixture(), externalPdb(pdb));
    expect(result.debug_map?.status).toBe("bound");
    expect(result.debug_map?.identity).toMatchObject({
      status: "undeclared",
      declared: { codeview: null, embedded_portable_pdb: false },
    });
  });

  it("marks a Windows MSF PDB as malformed instead of misreading it", () => {
    const msf = Buffer.concat([
      Buffer.from("Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0", "latin1"),
      Buffer.alloc(64),
    ]);
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(msf),
    );
    expect(result.debug_map?.status).toBe("malformed");
    expect(result.debug_map?.coverage.issues[0]?.detail).toContain(
      "Windows (MSF) PDB",
    );
    expect(result.debug_map?.identity.status).toBe("unverifiable");
    expect(result.methods[0]?.token).toBe("0x06000001");
  });

  it("extracts and binds the embedded Portable PDB when selected", () => {
    const pdb = buildPortablePdbFixture({
      documents: [{ name: "/src/Program.cs" }],
      methods: [
        { document: 1, points: [{ il: 0, startLine: 3, startColumn: 2 }] },
      ],
    });
    const result = memberInspection(
      buildManagedPeFixture({
        codeview: matchingCodeview,
        embeddedPortablePdb: pdb,
      }),
      { kind: "embedded" },
    );
    expect(result.debug_map).toMatchObject({
      status: "bound",
      source: { kind: "embedded" },
      identity: { status: "matched" },
      methods: [
        expect.objectContaining({
          token: "0x06000001",
          state: "decoded",
          sequence_points: [
            expect.objectContaining({ il_offset: 0, start_line: 3 }),
          ],
        }),
      ],
    });
    expect(result.debug_map?.source.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("reports absent when pdb_embedded is requested but none is declared", () => {
    const result = memberInspection(buildManagedPeFixture(), {
      kind: "embedded",
    });
    expect(result.debug_map?.status).toBe("absent");
    expect(result.debug_map?.identity.declared.embedded_portable_pdb).toBe(
      false,
    );
  });
});

describe("Portable PDB malformed and partial inputs", () => {
  it("marks a sub-header PDB as malformed instead of crashing inspection", () => {
    for (const tiny of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(12)]) {
      const result = memberInspection(
        buildManagedPeFixture({ codeview: matchingCodeview }),
        externalPdb(tiny),
      );
      expect(result.debug_map?.status).toBe("malformed");
      expect(result.debug_map?.identity.status).toBe("unverifiable");
      expect(result.methods[0]?.token).toBe("0x06000001");
    }
  });

  it("marks a truncated sequence-point blob malformed without losing the method", () => {
    const pdb = buildPortablePdbFixture({
      documents: [{ name: "/src/Program.cs" }],
      referencedStandaloneSignatures: 1,
      methods: [
        {
          document: 1,
          sequencePoints: Buffer.from([0x01, 0x00, 0x80]),
        },
      ],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    const method = result.debug_map?.methods[0];
    expect(method?.state).toBe("malformed");
    expect(result.debug_map?.coverage.issues).toContainEqual(
      expect.objectContaining({ scope: "pdb.MethodDebugInformation" }),
    );
    expect(result.debug_map?.documents[0]?.name).toBe("/src/Program.cs");
  });

  it("keeps an out-of-range Document column as an explicit issue", () => {
    const pdb = buildPortablePdbFixture({
      documents: [{ name: "/src/Program.cs" }],
      referencedStandaloneSignatures: 1,
      methods: [
        {
          document: 9,
          sequencePoints: Buffer.from([0x01, 0x00, 0x01]),
        },
      ],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    expect(result.debug_map?.methods[0]?.state).toBe("malformed");
    expect(
      result.debug_map?.coverage.issues.some((issue) =>
        issue.detail.includes("beyond the 1-row Document table"),
      ),
    ).toBe(true);
  });

  it("keeps an unreadable document name blob separate from a decoded checksum", () => {
    const pdb = buildPortablePdbFixture({
      documents: [
        {
          name: "/src/Program.cs",
          hashAlgorithm: "sha-384",
          language: "fsharp",
        },
      ],
      methods: [
        { document: 1, points: [{ il: 0, startLine: 2, startColumn: 2 }] },
      ],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    const document = result.debug_map?.documents[0];
    expect(document?.hash_algorithm).toBe("sha-384");
    expect(document?.language).toBe("fsharp");
    expect(document?.name).toBe("/src/Program.cs");
  });

  it("keeps unknown checksum algorithm GUIDs visible instead of dropping them", () => {
    const pdb = buildPortablePdbFixture({
      documents: [
        {
          name: "/src/Program.cs",
          hashAlgorithm: "01020304-0506-0708-090a-0b0c0d0e0f10",
          language: "01020304-0506-0708-090a-0b0c0d0e0f10",
        },
      ],
      methods: [
        { document: 1, points: [{ il: 0, startLine: 2, startColumn: 2 }] },
      ],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    const document = result.debug_map?.documents[0];
    expect(document?.hash_algorithm).toBeNull();
    expect(document?.hash_algorithm_guid).toBe(
      "01020304-0506-0708-090a-0b0c0d0e0f10",
    );
    expect(document?.language).toBeNull();
    expect(document?.language_guid).toBe(
      "01020304-0506-0708-090a-0b0c0d0e0f10",
    );
  });

  it("flags a MethodDebugInformation row-count disagreement as identity evidence", () => {
    const pdb = buildPortablePdbFixture({
      documents: [{ name: "/src/Program.cs" }],
      methods: [
        { document: 1, points: [{ il: 0, startLine: 1, startColumn: 1 }] },
      ],
      referencedMethodDefs: 2,
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    expect(result.debug_map?.identity.checks).toContainEqual(
      expect.objectContaining({ name: "methoddef-rows", result: "mismatched" }),
    );
    expect(result.debug_map?.coverage.issues).toContainEqual(
      expect.objectContaining({ scope: "pdb.MethodDebugInformation" }),
    );
  });

  it("degrades debug_map to malformed at the representation budget while keeping member evidence", () => {
    // Each hidden point costs 3 encoded bytes but reserves 128 bytes of
    // projection, so ~530k points trip the 64 MiB PDB budget.
    const blob = Buffer.alloc(1 + 3 * 600_000, 0);
    blob[0] = 0x00; // local signature row 0
    for (let offset = 1; offset < blob.length; offset += 3) blob[offset] = 0x01;
    const pdb = buildPortablePdbFixture({
      documents: [{ name: "/src/Program.cs" }],
      methods: [{ document: 1, sequencePoints: blob }],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    expect(result.debug_map?.status).toBe("malformed");
    expect(result.debug_map?.coverage.issues).toContainEqual(
      expect.objectContaining({ code: "resource-limit" }),
    );
    expect(result.methods[0]?.token).toBe("0x06000001");
    expect(result.coverage.state).toBe("complete");
  });
});

describe("Portable PDB sequence-point encoding edge cases", () => {
  it("decodes ECMA-335 signed compressed line and column deltas", () => {
    // Known-answer bytes: localSig 1; p1 il=0 ΔLines=2 ΔColumns=-2 (0x7d)
    // startLine=10 startColumn=5; p2 δil=6 ΔLines=0 ΔColumns=5 startLine
    // delta -2 (0x7d) startColumn delta -3 (0x7b).
    const sequencePoints = Buffer.from([
      0x01, 0x00, 0x02, 0x7d, 0x0a, 0x05, 0x06, 0x00, 0x05, 0x7d, 0x7b,
    ]);
    const pdb = buildPortablePdbFixture({
      documents: [{ name: "/src/Program.cs" }],
      referencedStandaloneSignatures: 1,
      methods: [{ document: 1, sequencePoints }],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    const method = result.debug_map?.methods[0];
    expect(method?.state).toBe("decoded");
    expect(method?.local_signature_token).toBe("0x11000001");
    expect(method?.sequence_points).toEqual([
      {
        il_offset: 0,
        start_line: 10,
        start_column: 5,
        end_line: 12,
        end_column: 3,
        hidden: false,
        document_token: "0x30000001",
      },
      {
        il_offset: 6,
        start_line: 8,
        start_column: 2,
        end_line: 8,
        end_column: 7,
        hidden: false,
        document_token: "0x30000001",
      },
    ]);
  });

  it("rejects a mid-blob document record naming a row outside the table", () => {
    const sequencePoints = Buffer.from([
      0x01, 0x00, 0x02, 0x7d, 0x0a, 0x05, 0x00, 0x09,
    ]);
    const pdb = buildPortablePdbFixture({
      documents: [{ name: "/src/Program.cs" }],
      referencedStandaloneSignatures: 1,
      methods: [{ document: 1, sequencePoints }],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    expect(result.debug_map?.methods[0]?.state).toBe("malformed");
    expect(
      result.debug_map?.coverage.issues.some((issue) =>
        issue.detail.includes("beyond the 1-row Document table"),
      ),
    ).toBe(true);
  });

  it("flags a compressed integer reserved prefix as malformed", () => {
    const pdb = buildPortablePdbFixture({
      documents: [{ name: "/src/Program.cs" }],
      referencedStandaloneSignatures: 1,
      methods: [
        { document: 1, sequencePoints: Buffer.from([0x01, 0xe0, 0x00]) },
      ],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    expect(result.debug_map?.methods[0]?.state).toBe("malformed");
    expect(
      result.debug_map?.coverage.issues.some((issue) =>
        issue.detail.includes("reserved prefix"),
      ),
    ).toBe(true);
  });

  it("reports an entry-point mismatch as identity evidence", () => {
    const pdb = buildPortablePdbFixture({
      entryPointToken: 0x0600_0009,
      documents: [{ name: "/src/Program.cs" }],
      methods: [
        { document: 1, points: [{ il: 0, startLine: 1, startColumn: 1 }] },
      ],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    expect(result.debug_map?.identity.status).toBe("matched");
    expect(result.debug_map?.identity.checks).toContainEqual(
      expect.objectContaining({ name: "entry-point", result: "mismatched" }),
    );
  });

  it("marks an embedded payload that is not a Portable PDB as malformed", () => {
    const result = memberInspection(
      buildManagedPeFixture({
        codeview: matchingCodeview,
        embeddedPortablePdb: Buffer.from("not a pdb at all"),
      }),
      { kind: "embedded" },
    );
    expect(result.debug_map?.status).toBe("malformed");
    expect(
      result.debug_map?.coverage.issues.some((issue) =>
        issue.detail.includes("not BSJB"),
      ),
    ).toBe(true);
  });

  it("marks a truncated Portable PDB root as malformed", () => {
    const pdb = buildPortablePdbFixture({
      documents: [{ name: "/src/Program.cs" }],
      methods: [
        { document: 1, points: [{ il: 0, startLine: 1, startColumn: 1 }] },
      ],
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb.subarray(0, 40)),
    );
    expect(result.debug_map?.status).toBe("malformed");
  });

  it("counts methods outside the admitted MDI rows without stub entries", () => {
    const pdb = buildPortablePdbFixture({
      documents: [{ name: "/src/Program.cs" }],
      methods: [],
      methodDefRows: 0,
      referencedMethodDefs: 1,
    });
    const result = memberInspection(
      buildManagedPeFixture({ codeview: matchingCodeview }),
      externalPdb(pdb),
    );
    expect(result.debug_map?.methods).toEqual([]);
    expect(result.debug_map?.methods_without_debug_information).toBe(1);
  });
});
