// vault.ts - encrypts each instructor's Anthropic key at rest (AES-256-GCM).
// The master key (KEK) lives only in the function's secrets (env AI_INSTRUCTOR_KEK, base64 of 32 random bytes).
// The owner id is bound in as additional authenticated data, so a ciphertext copied to another owner's row will not decrypt.
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function importKek(kekB64: string): Promise<CryptoKey> {
  const raw = unb64(kekB64);
  if (raw.length !== 32) throw new Error("AI_INSTRUCTOR_KEK must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptKey(plain: string, ownerId: string, kekB64: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(ownerId) }, await importKek(kekB64), enc.encode(plain));
  return { ciphertext: b64(new Uint8Array(ct)), iv: b64(iv) };
}
export async function decryptKey(ciphertext: string, iv: string, ownerId: string, kekB64: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(ownerId) }, await importKek(kekB64), unb64(ciphertext));
  return dec.decode(pt);
}
export const last4 = (k: string) => k.slice(-4);
export function looksLikeAnthropicKey(k: string): boolean { return /^sk-ant-[A-Za-z0-9_-]{16,}$/.test(k); }
/** Shape check only (no network): printable, no whitespace, plausible length, and the provider's usual prefix. Real validation is the live ping in setKey. */
export function looksLikeKeyFor(provider: string, k: string, prefix: string): boolean {
  if (provider === "anthropic") return looksLikeAnthropicKey(k);
  return /^[\x21-\x7e]{16,300}$/.test(k) && (!prefix || k.startsWith(prefix));
}
