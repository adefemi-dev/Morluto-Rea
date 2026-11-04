import { join } from "node:path";

import { PRODUCT_IDENTITY } from "../identity.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { readConfigurationFile } from "./ClientConfigurationFiles.js";
import { clientRegistrationEnvironment } from "./ClientRegistrationEnvironment.js";
import {
  scopedClaudeCodeRegistrationStatus,
  type ClientRegistrationStatus,
  type ScopedClaudeCodeRegistrationSource,
} from "./ClientRegistrationStatus.js";
import type { SetupClient } from "./SupportedClients.js";

/** Where doctor looks for Claude Code's scoped `rea` registrations. */
export interface ClaudeCodeRegistrationContext {
  readonly client: SetupClient;
  /** Absolute project directory; Claude Code keys local scope by its path. */
  readonly projectDirectory: string;
  readonly resources?: ArtifactResourceScope;
}

/**
 * Apply Claude Code's documented precedence for one server name: local scope
 * (`~/.claude.json` under the project's path), then project scope
 * (`.mcp.json` in the project directory), then the user scope that
 * `readClientRegistrationStatuses` already inspected. Doctor-only: update
 * maintenance keeps the user-scope inspection so it never rewrites the user
 * configuration because of a project file.
 */
export const resolveClaudeCodeRegistration = async (
  user: ClientRegistrationStatus,
  context: ClaudeCodeRegistrationContext,
): Promise<ClientRegistrationStatus> => {
  // An unreadable or malformed user configuration stays the reported fact.
  if (user.state === "invalid") return user;
  const local = await scopedEntry(
    context.client.configPath,
    { scope: "local", configPath: context.client.configPath },
    context,
  );
  if (local !== undefined) return local;
  const projectConfigPath = join(context.projectDirectory, ".mcp.json");
  const project = await scopedEntry(
    projectConfigPath,
    { scope: "project", configPath: projectConfigPath },
    context,
  );
  if (project !== undefined) return project;
  return user.state === "aligned" || user.state === "stale"
    ? { ...user, scope: "user" }
    : user;
};

/** The scope's `rea` entry status, or undefined when the scope has none. */
const scopedEntry = async (
  path: string,
  source: ScopedClaudeCodeRegistrationSource,
  context: ClaudeCodeRegistrationContext,
): Promise<ClientRegistrationStatus | undefined> => {
  const parsed = await readConfigurationFile(path, "json", context.resources);
  const invalid = (remediation: string): ClientRegistrationStatus => ({
    client: context.client.name,
    config_path: path,
    scope: source.scope,
    ...(source.scope === "project" ? { approval: "unknown" as const } : {}),
    command: [],
    state: "invalid",
    remediation,
  });
  if (!parsed.ok) return invalid(parsed.error.detail);
  if (parsed.value === undefined) return undefined;
  const servers =
    source.scope === "project"
      ? parsed.value.servers
      : localScopeServers(parsed.value.document, context.projectDirectory);
  if (typeof servers === "string") return invalid(`${servers} in ${path}.`);
  if (servers === undefined || !Object.hasOwn(servers, serverKey))
    return undefined;
  // REA rejects an invalid server environment at startup, as for user scope.
  const environment = clientRegistrationEnvironment({
    ...parsed.value,
    servers,
    legacyServers: {},
  });
  if (!environment.ok)
    return invalid(
      `Configuration ${path} has an invalid REA server environment: ${environment.error.settings.map(({ setting, constraint }) => `${setting}: ${constraint}`).join("; ")}. Repair it, then restart Claude Code.`,
    );
  return scopedClaudeCodeRegistrationStatus(
    servers[serverKey],
    source,
    context.client,
  );
};

const serverKey = PRODUCT_IDENTITY.mcpServerKey;

/**
 * Local-scope servers for an exact project path: the server table, undefined
 * when the project has none, or a description of the malformed member.
 */
const localScopeServers = (
  document: Record<string, unknown>,
  projectDirectory: string,
): Record<string, unknown> | string | undefined => {
  const projects = document.projects;
  if (projects === undefined) return undefined;
  if (!isRecord(projects)) return `"projects" is not an object`;
  if (!Object.hasOwn(projects, projectDirectory)) return undefined;
  const project = projects[projectDirectory];
  const member = `"projects"[${JSON.stringify(projectDirectory)}]`;
  if (!isRecord(project)) return `${member} is not an object`;
  const servers = project.mcpServers;
  if (servers === undefined) return undefined;
  return isRecord(servers) ? servers : `${member}.mcpServers is not an object`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
