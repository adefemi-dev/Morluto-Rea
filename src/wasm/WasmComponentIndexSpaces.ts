import type { ComponentSort } from "../domain/wasm/wasmComponentTypes.js";

/** How an index-space entry was introduced; used to trace canonical relationships. */
export type IndexOrigin =
  | { readonly kind: "import"; readonly name: string }
  | { readonly kind: "export"; readonly of: number }
  | {
      readonly kind: "alias-export";
      readonly instance: number;
      readonly name: string;
    }
  | {
      readonly kind: "alias-core-export";
      readonly instance: number;
      readonly name: string;
    }
  | {
      readonly kind: "core-instantiate";
      readonly module: number;
      readonly args: readonly { name: string; instance: number }[];
    }
  | {
      readonly kind: "core-inline-exports";
      readonly exports: readonly {
        name: string;
        sort: ComponentSort;
        index: number;
      }[];
    }
  | { readonly kind: "canon"; readonly canon: number }
  | { readonly kind: "other" };

const OTHER: IndexOrigin = { kind: "other" };

interface IndexSpace {
  length: number;
  /** Only traceable origins are stored; every other known index is `other`. */
  readonly origins: Map<number, IndexOrigin>;
}

/**
 * Index spaces of one component. Counts are numbers, so file-controlled
 * counts such as start results cost no per-entry memory. A sort becomes
 * unknown after an undecoded definition.
 */
export class ComponentIndexSpaces {
  readonly #spaces = new Map<ComponentSort, IndexSpace>();
  readonly #unknown = new Set<ComponentSort>();
  #allUnknown = false;

  #space(sort: ComponentSort): IndexSpace {
    let space = this.#spaces.get(sort);
    if (space === undefined) {
      space = { length: 0, origins: new Map() };
      this.#spaces.set(sort, space);
    }
    return space;
  }

  #known(sort: ComponentSort): boolean {
    return !this.#allUnknown && !this.#unknown.has(sort);
  }

  /** Append one entry; its index is null once the sort's count is unknown. */
  add(sort: ComponentSort, origin: IndexOrigin = OTHER): number | null {
    const space = this.#space(sort);
    const index = space.length;
    space.length += 1;
    if (origin.kind !== "other") space.origins.set(index, origin);
    return this.#known(sort) ? index : null;
  }

  /** Append `count` entries without traceable origins in constant time. */
  addAnonymous(sort: ComponentSort, count: number): void {
    this.#space(sort).length += count;
  }

  /** Origin at a known index, or undefined when it is unknown or absent. */
  origin(sort: ComponentSort, index: number): IndexOrigin | undefined {
    if (!this.#known(sort)) return undefined;
    const space = this.#spaces.get(sort);
    if (space === undefined || index >= space.length) return undefined;
    return space.origins.get(index) ?? OTHER;
  }

  invalidate(sorts: readonly ComponentSort[] | "all"): void {
    if (sorts === "all") this.#allUnknown = true;
    else for (const sort of sorts) this.#unknown.add(sort);
  }
}
