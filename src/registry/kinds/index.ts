// src/registry/kinds/index.ts [C] — the define_tool kind registry (§12.3). dispatch.ts runs KINDS[kind].run; forge.ts
// parses KINDS[kind].specSchema, then validate() and defaultAnnotations().
import type { DefinedKind, KindModule } from "../../types";
import { templateKind } from "./template";
import { httpKind } from "./http";
import { mcpKind } from "./mcp";
import { composeKind } from "./compose";

export const KINDS: Record<DefinedKind, KindModule> = {
  template: templateKind as unknown as KindModule,
  http: httpKind as unknown as KindModule,
  mcp: mcpKind as unknown as KindModule,
  compose: composeKind as unknown as KindModule
};
export { templateKind, httpKind, mcpKind, composeKind };
