import crypto from "node:crypto";
import dotenv from "dotenv";

// jose signs with the Web Crypto global, which Node 18 does not expose.
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto as Crypto;
}

// Vite 7 calls crypto.hash, which Node 18 does not have (added in 20.12).
if (typeof crypto.hash !== "function") {
  crypto.hash = (algorithm, data, outputEncoding) => {
    const digest = crypto.createHash(algorithm).update(data).digest();
    if (outputEncoding) return digest.toString(outputEncoding);
    return digest;
  };
}

dotenv.config();
// Fill in anything the process did not already set. `pnpm start` sets
// NODE_ENV=production before this runs; .env.local must not flip it back.
dotenv.config({ path: ".env.local" });
