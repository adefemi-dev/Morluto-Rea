import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  runDoctor,
  systemDoctorHost,
} from "../../../src/application/Doctor.js";
import { existingMaintenanceScope } from "../../../src/application/UpdateMaintenance.js";
import { installCanonicalSkill } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";

const pinned = `${PRODUCT_IDENTITY.packageName}@${PRODUCT_IDENTITY.packageVersion}`;

/** A home with a Claude Code configuration directory and a separate project. */
const claudeCodeHome = async (prefix: string) => {
  const root = await createTestTempDirectory(prefix);
  const home = join(root, "home");
  const configDirectory = join(home, ".claude");
  const projectDirectory = join(root, "project");
  await mkdir(configDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });
  const environment = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: configDirectory,
  };
  const client = supportedClients(home, process.platform, environment).find(
    ({ name }) => name === "claude_code",
  );
  if (client === undefined) throw new Error("Claude Code is not supported");
  const doctor = async () =>
    runDoctor(undefined, systemDoctorHost({ environment, projectDirectory }), {
      clients: ["claude_code"],
      skill: true,
    });
  return {
    home,
    configDirectory,
    projectDirectory,
    environment,
    userConfigPath: client.configPath,
    doctor,
  };
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const server = (...args: string[]) => ({ command: "npx", args });

/** Install the packaged skill, then move it to where Claude Code syncs it. */
const installAccountSyncedSkill = async (
  context: Awaited<ReturnType<typeof claudeCodeHome>>,
  account: string,
): Promise<string> => {
  const installed = await installCanonicalSkill(
    context.home,
    ["claude_code"],
    context.environment,
  );
  expect(installed).toMatchObject({ ok: true });
  const skills = join(context.configDirectory, "skills");
  const synced = join(skills, "synced", account, PRODUCT_IDENTITY.skillName);
  await mkdir(dirname(synced), { recursive: true });
  await rename(join(skills, PRODUCT_IDENTITY.skillName), synced);
  return synced;
};

describe("doctor Claude Code account-synced skill", () => {
  it("accepts a current account-synced copy when no personal copy exists", async () => {
    const context = await claudeCodeHome("rea-doctor-synced-skill-");
    const synced = await installAccountSyncedSkill(context, "account-a");

    const report = await context.doctor();

    expect(report.identity?.skill).toMatchObject({
      state: "aligned",
      installed_version: PRODUCT_IDENTITY.skillVersion,
      account_synced_path: synced,
      remediation: null,
    });
    expect(report.checks.map(({ name }) => name)).not.toContain(
      "skill:identity",
    );
  });

  it("prefers a current synced copy over an earlier account's stale one", async () => {
    const context = await claudeCodeHome("rea-doctor-synced-choice-");
    const stale = join(
      context.configDirectory,
      "skills/synced/account-a",
      PRODUCT_IDENTITY.skillName,
    );
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "SKILL.md"), "---\nname: stale\n---\n");
    const current = await installAccountSyncedSkill(context, "account-b");

    expect((await context.doctor()).identity?.skill).toMatchObject({
      state: "aligned",
      account_synced_path: current,
    });
  });

  it("reports a stale synced copy with the path it inspected", async () => {
    const context = await claudeCodeHome("rea-doctor-synced-stale-");
    const synced = await installAccountSyncedSkill(context, "account-a");
    await writeFile(join(synced, "SKILL.md"), "---\nname: changed\n---\n");

    const report = await context.doctor();

    expect(report.identity?.skill).toMatchObject({
      state: "stale",
      account_synced_path: synced,
    });
    expect(report.checks.map(({ name }) => name)).toContain("skill:identity");
  });

  it("judges an existing personal copy instead of a synced one", async () => {
    const context = await claudeCodeHome("rea-doctor-personal-skill-");
    await installAccountSyncedSkill(context, "account-a");
    const personal = join(
      context.configDirectory,
      "skills",
      PRODUCT_IDENTITY.skillName,
    );
    await mkdir(personal, { recursive: true });
    await writeFile(join(personal, "SKILL.md"), "---\nname: personal\n---\n");

    const skill = (await context.doctor()).identity?.skill;

    expect(skill?.state).toBe("stale");
    expect(skill).not.toHaveProperty("account_synced_path");
  });
});

describe("doctor Claude Code registration scopes", () => {
  it("accepts a project .mcp.json entry with an npx --prefix and leaves its approval unknown", async () => {
    const context = await claudeCodeHome("rea-doctor-project-scope-");
    const mcpJson = join(context.projectDirectory, ".mcp.json");
    await writeJson(mcpJson, {
      mcpServers: { rea: server("-y", "--prefix=/", pinned, "mcp") },
    });

    const report = await context.doctor();

    expect(report.identity?.registrations).toEqual([
      {
        client: "claude_code",
        config_path: mcpJson,
        scope: "project",
        approval: "unknown",
        command: ["npx", "-y", "--prefix=/", pinned, "mcp"],
        package_reference: pinned,
        state: "aligned",
        remediation: null,
      },
    ]);
    expect(report.checks.map(({ name }) => name)).not.toContain(
      "registration:claude_code",
    );
  });

  it("uses a local-scope entry ahead of project and user entries", async () => {
    const context = await claudeCodeHome("rea-doctor-local-scope-");
    await writeJson(join(context.projectDirectory, ".mcp.json"), {
      mcpServers: { rea: server("-y", pinned, "mcp") },
    });
    await writeJson(context.userConfigPath, {
      mcpServers: { rea: server("-y", pinned, "mcp") },
      projects: {
        [context.projectDirectory]: {
          mcpServers: { rea: server("-y", "rea-agents@0.0.1", "mcp") },
        },
      },
    });

    const report = await context.doctor();

    expect(report.identity?.registrations).toMatchObject([
      {
        config_path: context.userConfigPath,
        scope: "local",
        state: "stale",
        remediation: expect.stringContaining("rea-agents@0.0.1"),
      },
    ]);
    expect(report.identity?.registrations[0]).not.toHaveProperty("approval");
    expect(report.checks.map(({ name }) => name)).toContain(
      "registration:claude_code",
    );
  });

  it("reports a stale project entry ahead of an aligned user entry", async () => {
    const context = await claudeCodeHome("rea-doctor-project-stale-");
    await writeJson(context.userConfigPath, {
      mcpServers: { rea: server("-y", pinned, "mcp") },
    });
    await writeJson(join(context.projectDirectory, ".mcp.json"), {
      mcpServers: { rea: server("-y", "--prefix=relative", pinned, "mcp") },
    });

    expect((await context.doctor()).identity?.registrations).toMatchObject([
      {
        scope: "project",
        approval: "unknown",
        state: "stale",
        remediation: expect.stringContaining("writes only the user scope"),
      },
    ]);
  });

  it("marks the user scope when no project or local entry exists", async () => {
    const context = await claudeCodeHome("rea-doctor-user-scope-");
    await writeJson(context.userConfigPath, {
      mcpServers: { rea: server("-y", pinned, "mcp") },
      projects: { [context.projectDirectory]: { mcpServers: {} } },
    });

    expect((await context.doctor()).identity?.registrations).toMatchObject([
      {
        config_path: context.userConfigPath,
        scope: "user",
        state: "aligned",
      },
    ]);
  });

  it("keeps a registration missing when no scope has an entry", async () => {
    const context = await claudeCodeHome("rea-doctor-no-scope-");

    const [registration] =
      (await context.doctor()).identity?.registrations ?? [];

    expect(registration).toMatchObject({ state: "missing" });
    expect(registration).not.toHaveProperty("scope");
  });

  it.each([
    ["a malformed .mcp.json", "project", "{"],
    ["a non-object project server table", "project", { mcpServers: [] }],
    [
      "a non-object local server table",
      "local",
      (project: string) => ({ projects: { [project]: { mcpServers: "rea" } } }),
    ],
  ] as const)("reports %s as invalid", async (_label, scope, content) => {
    const context = await claudeCodeHome("rea-doctor-invalid-scope-");
    const path =
      scope === "project"
        ? join(context.projectDirectory, ".mcp.json")
        : context.userConfigPath;
    const value =
      typeof content === "function"
        ? content(context.projectDirectory)
        : content;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      typeof value === "string" ? value : JSON.stringify(value),
    );

    const report = await context.doctor();

    expect(report.identity?.registrations).toMatchObject([
      { config_path: path, scope, state: "invalid" },
    ]);
    expect(report.checks.map(({ name }) => name)).toContain(
      "registration:claude_code",
    );
  });
});

describe("doctor Claude Code scope boundaries", () => {
  it("reads only the user scope when no project directory is selected", async () => {
    // Setup's own verification uses this host; the repository it runs in has
    // a project .mcp.json that must not replace the entry setup wrote.
    const context = await claudeCodeHome("rea-doctor-setup-scope-");
    await writeJson(context.userConfigPath, {
      mcpServers: { rea: server("-y", pinned, "mcp") },
    });

    const report = await runDoctor(
      undefined,
      systemDoctorHost({ environment: context.environment }),
      { clients: ["claude_code"] },
    );

    expect(report.identity?.registrations).toEqual([
      expect.objectContaining({
        config_path: context.userConfigPath,
        state: "aligned",
      }),
    ]);
    expect(report.identity?.registrations[0]).not.toHaveProperty("scope");
  });

  it("leaves update maintenance on the user scope it manages", async () => {
    const context = await claudeCodeHome("rea-doctor-maintenance-scope-");
    await writeJson(join(context.projectDirectory, ".mcp.json"), {
      mcpServers: { rea: server("-y", pinned, "mcp") },
    });
    await writeJson(context.userConfigPath, {
      projects: {
        [context.projectDirectory]: {
          mcpServers: { rea: server("-y", pinned, "mcp") },
        },
      },
    });

    const scope = await existingMaintenanceScope(
      context.home,
      join(context.home, "rea.mjs"),
      context.environment,
    );

    expect(scope.clients).not.toContain("claude_code");
  });
});
