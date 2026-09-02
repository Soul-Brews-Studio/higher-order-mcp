// src/version.ts [W0] — single source of truth for the version reported in serverInfo, /health, /api/info and the upstream Client.
import pkg from "../package.json";
export const VERSION: string = pkg.version;
