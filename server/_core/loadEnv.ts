import crypto from "node:crypto";
import dotenv from "dotenv";

// jose signs with the Web Crypto global, which Node 18 does not expose.
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto as Crypto;
}

// Vite 7 calls crypto.hash, which Node 18 does not have (added in 20.12).
if (typeof crypto.hash !== "function") {
  Object.defineProperty(crypto, "hash", {
    configurable: true,
    value: (
      algorithm: string,
      data: crypto.BinaryLike,
      outputEncoding?: crypto.BinaryToTextEncoding | "buffer"
    ) => {
      const digest = crypto.createHash(algorithm).update(data).digest();
      return outputEncoding && outputEncoding !== "buffer"
        ? digest.toString(outputEncoding)
        : digest;
    },
  });
}

dotenv.config();
// Fill in anything the process did not already set. `pnpm start` sets
// NODE_ENV=production before this runs; .env.local must not flip it back.
dotenv.config({ path: ".env.local" });
