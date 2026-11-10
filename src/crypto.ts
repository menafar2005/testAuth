// AES-256-GCM for the installation ApiKey. Output: base64(iv[12] || ciphertext).
let cached: Promise<CryptoKey> | null = null;

function key(base64Key: string): Promise<CryptoKey> {
  if (!cached) {
    const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
    if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (base64)");
    cached = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  return cached;
}

export async function encryptSecret(base64Key: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(base64Key), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return btoa(String.fromCharCode(...out));
}

export async function decryptSecret(base64Key: string, packed: string): Promise<string> {
  const bytes = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await key(base64Key), bytes.slice(12));
  return new TextDecoder().decode(pt);
}
