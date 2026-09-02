// src/tools/builtin/index.ts [B] — the built-in catalog (§11): 22 tools, 15 listed by default, 7 hidden.
// PROTECTED and HIDDEN_BY_DEFAULT are the source of truth for the `protected` / `hiddenByDefault` flags.
import type { BuiltinSpec } from "../../types";
import { forgeTools } from "./forge";
import { identityTools } from "./identity";
import { memoryTools } from "./memory";
import { metaTools } from "./meta";
import { upstreamTools } from "./upstreams";

/** Always enabled + promoted; toggle/promote/demote refuse them with protected_tool (§10.1). */
export const PROTECTED: ReadonlySet<string> = new Set(["list_tools", "describe_tool", "call_tool", "toggle_tool", "promote_tool", "demote_tool"]);
/** Registered but disable()d by default: absent from tools/list, callable via call_tool, promotable (§11). */
export const HIDDEN_BY_DEFAULT: ReadonlySet<string> = new Set(["override_tool", "remove_tool", "add_upstream", "remove_upstream", "list_upstreams", "upstream_tools", "set_identity"]);

export const BUILTINS: BuiltinSpec[] = [...metaTools, ...forgeTools, ...identityTools, ...upstreamTools, ...memoryTools]
  .map((b) => ({ ...b, protected: PROTECTED.has(b.name), hiddenByDefault: HIDDEN_BY_DEFAULT.has(b.name) }));
