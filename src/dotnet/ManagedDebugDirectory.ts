import { inflateRawSync } from "node:zlib";

import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";

import type { ManagedPeLayout } from "./ManagedPeReader.js";

const DEBUG_DIRECTORY_ENTRY_SIZE = 28;
/** IMAGE_DEBUG_TYPE_CODEVIEW. */
const DEBUG_TYPE_CODEVIEW = 2;
/** IMAGE_DEBUG_TYPE_EMBEDDED_PORTABLE_PDB. */
const DEBUG_TYPE_EMBEDDED_PORTABLE_PDB = 17;
/** Upper bound on MPDB inflation so a forged size field cannot expand memory. */
const MAX_EMBEDDED_PDB_BYTES = 128 * 1024 * 1024;
/** Retained issue cap; overflow is counted and summarized, not retained. */
const MAX_DEBUG_DIRECTORY_ISSUES = 64;
/** Enumerated entry cap; real images carry a handful of debug entries. */
const MAX_DEBUG_DIRECTORY_ENTRIES = 4096;

export interface CodeViewIdentity {
  readonly kind: "rsds" | "nb10" | "other";
  readonly signature: number;
  readonly guid: string | null;
  readonly age: number | null;
  readonly declaredPath: string | null;
}

export interface ManagedDebugDeclaration {
  readonly codeview: CodeViewIdentity | null;
  readonly embeddedPortablePdb: {
    readonly offset: number;
    readonly size: number;
  } | null;
  readonly issues: readonly ManagedParseIssue[];
}

const scope = "pe.debug-directory";

/** Return false once the retained bound is reached; callers summarize overflow. */
const pushIssue = (
  issues: ManagedParseIssue[],
  detail: string,
  offset: number | null,
): boolean => {
  if (issues.length >= MAX_DEBUG_DIRECTORY_ISSUES) return false;
  issues.push({ code: "invalid-directory", scope, detail, offset });
  return true;
};

const guidString = (bytes: Buffer, offset: number): string =>
  `${bytes.readUInt32LE(offset).toString(16).padStart(8, "0")}-` +
  `${bytes
    .readUInt16LE(offset + 4)
    .toString(16)
    .padStart(4, "0")}-` +
  `${bytes
    .readUInt16LE(offset + 6)
    .toString(16)
    .padStart(4, "0")}-` +
  bytes.subarray(offset + 8, offset + 10).toString("hex") +
  "-" +
  bytes.subarray(offset + 10, offset + 16).toString("hex");

const readEntryDataOffset = (
  bytes: Buffer,
  pe: ManagedPeLayout,
  entryOffset: number,
  dataRva: number,
  dataPointer: number,
  dataSize: number,
  issues: ManagedParseIssue[],
): number | null => {
  if (dataPointer > 0 && dataPointer <= bytes.length - dataSize)
    return dataPointer;
  if (dataRva === 0) return null;
  try {
    return pe.rvaToOffset(dataRva, dataSize, `${scope}.entry-data`);
  } catch {
    return null;
  }
};

const readCodeView = (
  bytes: Buffer,
  entryOffset: number,
  dataOffset: number,
  dataSize: number,
  issues: ManagedParseIssue[],
): CodeViewIdentity | null => {
  if (dataSize < 4) {
    pushIssue(
      issues,
      "CodeView entry data is shorter than its signature",
      dataOffset,
    );
    return null;
  }
  const signature = bytes.readUInt32LE(dataOffset);
  if (signature === 0x5344_5352) {
    // "RSDS"
    if (dataSize < 24) {
      pushIssue(issues, "RSDS entry is shorter than GUID + age", dataOffset);
      return null;
    }
    const pathBytes = bytes.subarray(dataOffset + 24, dataOffset + dataSize);
    const terminator = pathBytes.indexOf(0);
    const declaredPath =
      pathBytes
        .subarray(0, terminator === -1 ? pathBytes.length : terminator)
        .toString("utf8") || null;
    return {
      kind: "rsds",
      signature,
      guid: guidString(bytes, dataOffset + 4),
      age: bytes.readUInt32LE(dataOffset + 20),
      declaredPath,
    };
  }
  return {
    kind: signature === 0x3031_424e ? "nb10" : "other",
    signature,
    guid: null,
    age: null,
    declaredPath: null,
  };
};

/** Enumerate PE debug-directory declarations without loading target code. */
export const readManagedDebugDirectory = (
  bytes: Buffer,
  pe: ManagedPeLayout,
): ManagedDebugDeclaration => {
  const issues: ManagedParseIssue[] = [];
  let codeview: CodeViewIdentity | null = null;
  let embedded: { offset: number; size: number } | null = null;
  let omitted = 0;
  const done = () => {
    if (omitted > 0)
      issues.push({
        code: "invalid-directory",
        scope,
        detail: `${String(omitted)} further debug-directory issue(s) were omitted by the retained-issue bound`,
        offset: null,
      });
    return { codeview, embeddedPortablePdb: embedded, issues };
  };
  const { rva, size } = pe.debugDirectory;
  if (rva === 0 || size === 0) return done();
  if (size % DEBUG_DIRECTORY_ENTRY_SIZE !== 0) {
    pushIssue(
      issues,
      `Debug directory size ${String(size)} is not a multiple of the 28-byte entry`,
      null,
    );
    return done();
  }
  const declaredCount = size / DEBUG_DIRECTORY_ENTRY_SIZE;
  const count = Math.min(declaredCount, MAX_DEBUG_DIRECTORY_ENTRIES);
  if (declaredCount > MAX_DEBUG_DIRECTORY_ENTRIES)
    pushIssue(
      issues,
      `Debug directory declares ${String(declaredCount)} entries; enumeration stops at ${String(MAX_DEBUG_DIRECTORY_ENTRIES)}`,
      null,
    );
  let tableOffset: number;
  try {
    tableOffset = pe.rvaToOffset(rva, size, scope);
  } catch {
    pushIssue(issues, "Debug directory RVA is not file-backed", null);
    return done();
  }
  for (let index = 0; index < count; index += 1) {
    const entryOffset = tableOffset + index * DEBUG_DIRECTORY_ENTRY_SIZE;
    const type = bytes.readUInt32LE(entryOffset + 12);
    const dataSize = bytes.readUInt32LE(entryOffset + 16);
    const dataRva = bytes.readUInt32LE(entryOffset + 20);
    const dataPointer = bytes.readUInt32LE(entryOffset + 24);
    const dataOffset = readEntryDataOffset(
      bytes,
      pe,
      entryOffset,
      dataRva,
      dataPointer,
      dataSize,
      issues,
    );
    if (dataOffset === null) {
      if (
        !pushIssue(
          issues,
          `Debug entry ${String(index)} data is not file-backed`,
          entryOffset,
        )
      )
        omitted += 1;
      continue;
    }
    if (type === DEBUG_TYPE_CODEVIEW && codeview === null) {
      const parsed = readCodeView(
        bytes,
        entryOffset,
        dataOffset,
        dataSize,
        issues,
      );
      if (parsed?.kind === "rsds") codeview = parsed;
    }
    if (type === DEBUG_TYPE_EMBEDDED_PORTABLE_PDB && embedded === null)
      embedded = { offset: dataOffset, size: dataSize };
  }
  return done();
};

/**
 * Extract an embedded Portable PDB payload (`MPDB` + u32 size + deflate).
 * Returns null when the blob is absent, truncated, or fails to inflate.
 */
export const extractEmbeddedPortablePdb = (
  bytes: Buffer,
  embedded: { readonly offset: number; readonly size: number },
  issues: ManagedParseIssue[],
): Buffer | null => {
  const { offset, size } = embedded;
  if (offset < 0 || size < 8 || offset > bytes.length - size) {
    pushIssue(issues, "Embedded Portable PDB entry is truncated", offset);
    return null;
  }
  if (bytes.readUInt32LE(offset) !== 0x4244_504d) {
    pushIssue(issues, "Embedded Portable PDB does not start with MPDB", offset);
    return null;
  }
  const uncompressedSize = bytes.readUInt32LE(offset + 4);
  if (uncompressedSize > MAX_EMBEDDED_PDB_BYTES) {
    pushIssue(
      issues,
      `Embedded Portable PDB declares ${String(uncompressedSize)} bytes, above the snapshot cap`,
      offset + 4,
    );
    return null;
  }
  try {
    // Embedded Portable PDBs use DeflateStream output: raw RFC 1951 deflate,
    // not the zlib-wrapped form inflateSync expects.
    const result = inflateRawSync(bytes.subarray(offset + 8, offset + size), {
      maxOutputLength: uncompressedSize + 1,
    });
    if (result.length !== uncompressedSize) {
      pushIssue(
        issues,
        `Embedded Portable PDB inflated to ${String(result.length)} bytes, expected ${String(uncompressedSize)}`,
        offset + 4,
      );
      return null;
    }
    return result;
  } catch {
    pushIssue(
      issues,
      "Embedded Portable PDB deflate stream is invalid",
      offset + 8,
    );
    return null;
  }
};
