import forge from "node-forge";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export interface OperatorKeys {
  privateKey: CryptoKey | forge.pki.rsa.PrivateKey | null;
  publicKeyPem: string;
  insecure: boolean;
}

export type RoomKey = CryptoKey | Uint8Array;

function hasSubtleCrypto(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
}

function isForgePrivateKey(value: unknown): value is forge.pki.rsa.PrivateKey {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { decrypt?: unknown };
  return typeof candidate.decrypt === "function";
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

function randomBytes(length: number): Uint8Array {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    return crypto.getRandomValues(new Uint8Array(length));
  }
  return binaryToBytes(forge.random.getBytesSync(length));
}

export async function generateOperatorKeys(): Promise<OperatorKeys> {
  if (!hasSubtleCrypto()) {
    try {
      const keyPair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
      return {
        privateKey: keyPair.privateKey,
        publicKeyPem: forge.pki.publicKeyToPem(keyPair.publicKey),
        insecure: false
      };
    } catch {
      return {
        privateKey: null,
        publicKeyPem: "PLAINTEXT-INSECURE",
        insecure: true
      };
    }
  }

  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 4096,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["encrypt", "decrypt"]
  );

  const exportedPublic = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  const publicBase64 = toBase64(new Uint8Array(exportedPublic));
  const chunks = publicBase64.match(/.{1,64}/g)?.join("\n") ?? publicBase64;

  return {
    privateKey: keyPair.privateKey,
    publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${chunks}\n-----END PUBLIC KEY-----`,
    insecure: false
  };
}

export async function decryptRoomKey(
  encryptedRoomKeyBase64: string,
  privateKey: CryptoKey | forge.pki.rsa.PrivateKey | null
): Promise<RoomKey | null> {
  if (!privateKey || !encryptedRoomKeyBase64) {
    return null;
  }

  if (hasSubtleCrypto() && typeof CryptoKey !== "undefined" && privateKey instanceof CryptoKey) {
    const encrypted = fromBase64(encryptedRoomKeyBase64);
    const rawKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, toArrayBuffer(encrypted));

    return crypto.subtle.importKey(
      "raw",
      rawKey,
      {
        name: "AES-GCM",
        length: 256
      },
      false,
      ["encrypt", "decrypt"]
    );
  }

  if (isForgePrivateKey(privateKey)) {
    const decryptedBinary = privateKey.decrypt(forge.util.decode64(encryptedRoomKeyBase64), "RSA-OAEP", {
      md: forge.md.sha256.create(),
      mgf1: {
        md: forge.md.sha256.create()
      }
    });
    return binaryToBytes(decryptedBinary);
  }

  return null;
}

export async function encryptMessage(plaintext: string, roomKey: RoomKey | null): Promise<{ ciphertext: string; nonce: string }> {
  if (!roomKey || !hasSubtleCrypto()) {
    if (roomKey instanceof Uint8Array) {
      const nonce = randomBytes(12);
      const cipher = forge.cipher.createCipher("AES-GCM", bytesToBinary(roomKey));
      cipher.start({ iv: bytesToBinary(nonce), tagLength: 128 });
      cipher.update(forge.util.createBuffer(plaintext, "utf8"));
      cipher.finish();

      const encryptedBinary = cipher.output.getBytes() + cipher.mode.tag.getBytes();
      return {
        ciphertext: toBase64(binaryToBytes(encryptedBinary)),
        nonce: toBase64(nonce)
      };
    }

    return {
      ciphertext: toBase64(encoder.encode(plaintext)),
      nonce: "PLAINTEXT"
    };
  }

  if (roomKey instanceof Uint8Array) {
    const nonce = randomBytes(12);
    const cipher = forge.cipher.createCipher("AES-GCM", bytesToBinary(roomKey));
    cipher.start({ iv: bytesToBinary(nonce), tagLength: 128 });
    cipher.update(forge.util.createBuffer(plaintext, "utf8"));
    cipher.finish();

    const encryptedBinary = cipher.output.getBytes() + cipher.mode.tag.getBytes();
    return {
      ciphertext: toBase64(binaryToBytes(encryptedBinary)),
      nonce: toBase64(nonce)
    };
  }

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce
    },
    roomKey,
    encoder.encode(plaintext)
  );

  return {
    ciphertext: toBase64(new Uint8Array(encrypted)),
    nonce: toBase64(nonce)
  };
}

export async function decryptMessage(ciphertext: string, nonce: string, roomKey: RoomKey | null): Promise<string> {
  if (nonce === "PLAINTEXT") {
    return decoder.decode(fromBase64(ciphertext));
  }

  if (roomKey instanceof Uint8Array) {
    const nonceBytes = fromBase64(nonce);
    const ciphertextWithTag = fromBase64(ciphertext);
    if (ciphertextWithTag.length < 17) {
      throw new Error("Invalid ciphertext payload");
    }

    const tag = ciphertextWithTag.slice(ciphertextWithTag.length - 16);
    const encrypted = ciphertextWithTag.slice(0, ciphertextWithTag.length - 16);

    const decipher = forge.cipher.createDecipher("AES-GCM", bytesToBinary(roomKey));
    decipher.start({
      iv: bytesToBinary(nonceBytes),
      tagLength: 128,
      tag: forge.util.createBuffer(bytesToBinary(tag))
    });
    decipher.update(forge.util.createBuffer(bytesToBinary(encrypted)));
    const ok = decipher.finish();
    if (!ok) {
      throw new Error("Message authentication failed");
    }
    return decipher.output.toString();
  }

  if (!roomKey || !hasSubtleCrypto()) {
    throw new Error("No compatible crypto context available");
  }

  const nonceBytes = fromBase64(nonce);
  const ciphertextBytes = fromBase64(ciphertext);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonceBytes)
    },
    roomKey,
    toArrayBuffer(ciphertextBytes)
  );

  return decoder.decode(decrypted);
}
