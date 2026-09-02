// src/web/session.ts [A] — owner-passphrase primitives shared by the consent page (§13), the static-token door (§8.1)
// and the owner console (E): constant-time compare, the homcp_owner cookie, KV-backed session revocation, rate limits.
import type { Env } from "../types";

export const OWNER_COOKIE = "homcp_owner";
/** Owner-console session lifetime in seconds (cookie Max-Age and KV TTL). */
export const OWNER_SESSION_TTL = 43_200;
const SESSION_PREFIX = "owner-session:";
const enc = new TextEncoder();

/** SHA-256 both sides, then timingSafeEqual — the comparison never depends on where the strings differ. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** Best-effort client address for rate-limit keys (Cloudflare sets cf-connecting-ip; tests may pass it explicitly). */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/** `Sec-Fetch-Site: same-origin` or an Origin header equal to this deployment's origin. Every owner POST requires it. */
export function isSameOrigin(request: Request, origin: string): boolean {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  const o = request.headers.get("origin");
  return !!o && o === origin;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export interface OwnerSession { id: string; issuedAt: number }
export interface MintedSession extends OwnerSession { /** the raw cookie value `<issuedAt>.<uuid>.<hmac>` */ value: string; /** ready-to-use Set-Cookie header */ setCookie: string }

/** Issues `homcp_owner=<issuedAt>.<uuid>.<hmac-sha256(issuedAt.uuid, OWNER_PASSPHRASE)>` and records the uuid in KV. Null when no passphrase is configured. */
export async function mintOwnerSession(env: Env): Promise<MintedSession | null> {
  if (!env.OWNER_PASSPHRASE) return null;
  const issuedAt = Date.now();
  const id = crypto.randomUUID();
  const value = `${issuedAt}.${id}.${await hmac(env.OWNER_PASSPHRASE, `${issuedAt}.${id}`)}`;
  await env.OAUTH_KV.put(`${SESSION_PREFIX}${id}`, String(issuedAt), { expirationTtl: OWNER_SESSION_TTL });
  return { id, issuedAt, value, setCookie: `${OWNER_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/owner; Max-Age=${OWNER_SESSION_TTL}` };
}

/** Verifies the cookie's age, HMAC (constant time) and KV presence (revocation). Null on any failure. */
export async function verifyOwnerSession(request: Request, env: Env): Promise<OwnerSession | null> {
  if (!env.OWNER_PASSPHRASE) return null;
  const raw = readCookie(request, OWNER_COOKIE);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [issuedAtRaw, id, mac] = parts as [string, string, string];
  const issuedAt = Number.parseInt(issuedAtRaw, 10);
  if (!Number.isFinite(issuedAt) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (Date.now() - issuedAt > OWNER_SESSION_TTL * 1000 || issuedAt > Date.now() + 60_000) return null;
  const expected = await hmac(env.OWNER_PASSPHRASE, `${issuedAtRaw}.${id}`);
  if (!(await constantTimeEqual(expected, mac))) return null;
  if ((await env.OAUTH_KV.get(`${SESSION_PREFIX}${id}`)) === null) return null;
  return { id, issuedAt };
}

/** Deletes the KV session named by the request's cookie (if any). Returns the Set-Cookie header that clears the cookie. */
export async function revokeOwnerSession(request: Request, env: Env): Promise<string> {
  const raw = readCookie(request, OWNER_COOKIE);
  const id = raw?.split(".")[1];
  if (id) await env.OAUTH_KV.delete(`${SESSION_PREFIX}${id}`).catch(() => {});
  return clearOwnerCookie();
}
export function clearOwnerCookie(): string {
  return `${OWNER_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/owner; Max-Age=0`;
}

export interface RateLimit {
  /** true when `max` failures were already recorded inside the window — the caller should answer 429 before doing any work */
  limited: boolean;
  count: number;
  /** records one failure (counter TTL = window) */
  fail(): Promise<void>;
}
/** KV counter: `key` → failures within `ttl` seconds; `limited` once `count >= max`. Keys: ratelimit:authorize:<ip>, ratelimit:owner-login:<ip>. */
export async function rateLimit(kv: KVNamespace, key: string, max = 10, ttl = 600): Promise<RateLimit> {
  const count = Number.parseInt((await kv.get(key)) ?? "0", 10) || 0;
  return {
    limited: count >= max,
    count,
    async fail() { await kv.put(key, String(count + 1), { expirationTtl: Math.max(60, ttl) }); }
  };
}
