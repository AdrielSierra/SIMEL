const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const VERSION = "enc1";

function buildKey(secret) {
  if (!secret) {
    throw new Error("Falta APP_ENCRYPTION_KEY para cifrar datos sensibles");
  }

  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encryptText(plainText, secret = process.env.APP_ENCRYPTION_KEY) {
  if (plainText === undefined || plainText === null || plainText === "") {
    return "";
  }

  const key = buildKey(secret);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64")
  ].join(":");
}

function decryptText(cipherText, secret = process.env.APP_ENCRYPTION_KEY) {
  if (!cipherText) return "";

  const raw = String(cipherText);
  if (!raw.startsWith(`${VERSION}:`)) {
    return raw;
  }

  const [, ivB64, authTagB64, payloadB64] = raw.split(":");
  const key = buildKey(secret);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));

  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payloadB64, "base64")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

module.exports = {
  encryptText,
  decryptText
};
