import type { DecodedComponent } from "../domain/wasm/wasmComponent.js";
import type { ComponentSort } from "../domain/wasm/wasmComponentTypes.js";
import type {
  ComponentIndexSpaces,
  IndexOrigin,
} from "./WasmComponentIndexSpaces.js";

/** Bounds export-of-export chains, which validation would reject if cyclic. */
const MAX_EXPORT_HOPS = 64;
/**
 * Bindings of lowered functions to core imports can grow multiplicatively.
 * At roughly 170 bytes each, more than this exceeds the 8 MiB inline budget.
 */
export const MAX_CORE_IMPORT_BINDINGS = 65_536;

/** Remaining core import bindings for one whole decode, shared by nested components. */
export interface RelationshipBudget {
  remaining: number;
}

export const createRelationshipBudget = (): RelationshipBudget => ({
  remaining: MAX_CORE_IMPORT_BINDINGS,
});

/** The complete relationship facts would exceed the inline output budget. */
export class WasmComponentRelationshipLimit extends Error {
  constructor() {
    super(
      `Canonical lower bindings exceed ${String(MAX_CORE_IMPORT_BINDINGS)} entries`,
    );
    this.name = "WasmComponentRelationshipLimit";
  }
}

type CoreBinding = DecodedComponent["lowers"][number]["satisfies"][number];

/** Follow export re-aliases back to the entry that defined the index. */
const definingEntry = (
  spaces: ComponentIndexSpaces,
  sort: ComponentSort,
  index: number,
): { readonly index: number; readonly origin: IndexOrigin } | undefined => {
  let current = index;
  for (let hop = 0; hop < MAX_EXPORT_HOPS; hop += 1) {
    const origin = spaces.origin(sort, current);
    if (origin === undefined) return undefined;
    if (origin.kind !== "export") return { index: current, origin };
    current = origin.of;
  }
  return undefined;
};

const append = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const values = map.get(key);
  if (values === undefined) map.set(key, [value]);
  else values.push(value);
};

/** Decoded function import and export names of each core module, by index. */
interface ModuleInterfaces {
  readonly imports: Map<number, Set<string>>;
  readonly exports: Map<number, Set<string>>;
}

const importKey = (module: string, name: string): string =>
  JSON.stringify([module, name]);

const moduleInterfaces = (component: DecodedComponent): ModuleInterfaces => {
  const imports = new Map<number, Set<string>>();
  const exports = new Map<number, Set<string>>();
  for (const module of component.core_modules) {
    if (module.index === null || module.interface.status !== "decoded")
      continue;
    imports.set(
      module.index,
      new Set(
        module.interface.imports
          .filter(({ type }) => type.kind === "func")
          .map(({ module: from, name }) => importKey(from, name)),
      ),
    );
    exports.set(
      module.index,
      new Set(
        module.interface.exports
          .filter(({ kind }) => kind === "func")
          .map(({ name }) => name),
      ),
    );
  }
  return { imports, exports };
};

/** Component export names of each defining function index. */
const exportNamesByFunc = (
  component: DecodedComponent,
  spaces: ComponentIndexSpaces,
): Map<number, string[]> => {
  const names = new Map<number, string[]>();
  for (const { target, name } of component.exports) {
    if (target.sort !== "func") continue;
    const defining = definingEntry(spaces, "func", target.index);
    if (defining !== undefined) append(names, defining.index, name);
  }
  return names;
};

/** Core import bindings of each lowered core function, found in linear time. */
const coreImportBindings = (
  component: DecodedComponent,
  interfaces: ModuleInterfaces,
  budget: RelationshipBudget,
): ((coreFunc: number) => CoreBinding[]) => {
  const providers = new Map<number, { instance: number; name: string }[]>();
  const consumers = new Map<
    number,
    { instance: number; module: number; argument: string }[]
  >();
  for (const instance of component.core_instances) {
    const index = instance.index;
    if (index === null) continue;
    if (instance.kind === "inline-exports") {
      for (const exported of instance.exports)
        if (exported.sort === "core func")
          append(providers, exported.index, {
            instance: index,
            name: exported.name,
          });
    } else
      for (const argument of instance.args)
        append(consumers, argument.instance, {
          instance: index,
          module: instance.module,
          argument: argument.name,
        });
  }
  return (coreFunc) => {
    const bindings: CoreBinding[] = [];
    for (const provider of providers.get(coreFunc) ?? [])
      for (const consumer of consumers.get(provider.instance) ?? []) {
        budget.remaining -= 1;
        if (budget.remaining < 0) throw new WasmComponentRelationshipLimit();
        const declared = interfaces.imports.get(consumer.module);
        bindings.push({
          core_instance: consumer.instance,
          core_module: consumer.module,
          import_module: consumer.argument,
          import_name: provider.name,
          declared_by_module:
            declared === undefined
              ? null
              : declared.has(importKey(consumer.argument, provider.name)),
        });
      }
    return bindings;
  };
};

const coreSource = (
  spaces: ComponentIndexSpaces,
  interfaces: ModuleInterfaces,
  coreFunc: number,
): DecodedComponent["lifts"][number]["core_source"] => {
  const origin = spaces.origin("core func", coreFunc);
  if (origin?.kind !== "alias-core-export") return null;
  const instance = spaces.origin("core instance", origin.instance);
  const module = instance?.kind === "core-instantiate" ? instance.module : null;
  const declared = module === null ? undefined : interfaces.exports.get(module);
  return {
    core_instance: origin.instance,
    name: origin.name,
    core_module: module,
    declared_by_module:
      declared === undefined ? null : declared.has(origin.name),
  };
};

const componentSource = (
  spaces: ComponentIndexSpaces,
  func: number,
): DecodedComponent["lowers"][number]["component_source"] => {
  const defining = definingEntry(spaces, "func", func);
  if (defining?.origin.kind === "import")
    return { kind: "import", name: defining.origin.name };
  if (defining?.origin.kind !== "alias-export") return null;
  const instance = definingEntry(spaces, "instance", defining.origin.instance);
  return {
    kind: "instance-export",
    instance: defining.origin.instance,
    name: defining.origin.name,
    instance_import:
      instance?.origin.kind === "import" ? instance.origin.name : null,
  };
};

/**
 * Trace each canonical lift to the core export it wraps, and each lower to
 * its component source and the core imports it is bound to. Lookup tables
 * keep the work linear; unknown index spaces leave facts null or empty.
 */
export const resolveCanonRelationships = (
  component: DecodedComponent,
  spaces: ComponentIndexSpaces,
  budget: RelationshipBudget,
): Pick<DecodedComponent, "lifts" | "lowers"> => {
  const interfaces = moduleInterfaces(component);
  const exportedAs = exportNamesByFunc(component, spaces);
  const bindingsOf = coreImportBindings(component, interfaces, budget);
  const lifts: DecodedComponent["lifts"] = [];
  const lowers: DecodedComponent["lowers"] = [];
  for (const [position, canon] of component.canons.entries()) {
    if (
      canon.kind === "lift" &&
      canon.core_func !== undefined &&
      canon.type !== undefined
    ) {
      const func = canon.defines.index;
      lifts.push({
        canon: position,
        func,
        core_func: canon.core_func,
        type: canon.type,
        core_source: coreSource(spaces, interfaces, canon.core_func),
        exported_as: func === null ? [] : (exportedAs.get(func) ?? []),
      });
    }
    if (canon.kind === "lower" && canon.func !== undefined) {
      const coreFunc = canon.defines.index;
      lowers.push({
        canon: position,
        func: canon.func,
        core_func: coreFunc,
        component_source: componentSource(spaces, canon.func),
        satisfies: coreFunc === null ? [] : bindingsOf(coreFunc),
      });
    }
  }
  return { lifts, lowers };
};
