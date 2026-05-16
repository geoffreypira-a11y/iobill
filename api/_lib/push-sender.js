// IO BILL - Envoi Web Push avec VAPID + JWT (sans dependance externe)
// Utilise par stripe-webhook (paiements), invoice issued, etc.
//
// VAPID = Voluntary Application Server Identification (RFC 8292)
// On signe un JWT ES256 avec la cle privee VAPID, et on l'envoie au push service.

import { createSign, createPrivateKey, randomBytes, createCipheriv, createHash, createECDH, createHmac } from "crypto";
import { sbAdmin } from "./supabase-admin.js";

const VAPID_PUBLIC_KEY = process.env.VITE_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:contact@iobill.fr";

/**
 * Envoie une notification push a un user (toutes ses subscriptions actives)
 * @param {string} userId
 * @param {object} payload  { title, body, url, tag, requireInteraction }
 */
export async function sendPushToUser(userId, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn("[push] VAPID keys not configured, skipping push");
    return { sent: 0, skipped: true };
  }

  const subs = await sbAdmin.select("push_subscriptions", {
    filter: `user_id=eq.${userId}`,
    select: "id,endpoint,p256dh_key,auth_key"
  });
  if (!subs || subs.length === 0) return { sent: 0 };

  let sent = 0;
  for (const s of subs) {
    try {
      const ok = await sendPushSingle(s, payload);
      if (ok) sent++;
    } catch (e) {
      // 410 = subscription expired -> on supprime
      if (e.statusCode === 410 || e.statusCode === 404) {
        await sbAdmin.delete("push_subscriptions", `id=eq.${s.id}`);
      }
    }
  }
  return { sent, total: subs.length };
}

/**
 * Envoie a tous les users d'une company
 */
export async function sendPushToCompany(companyId, payload) {
  const users = await sbAdmin.select("company_users", {
    filter: `company_id=eq.${companyId}&accepted_at=not.is.null`,
    select: "user_id"
  });
  if (!users || users.length === 0) {
    // Fallback : si pas de company_users, essayer companies.user_id
    const co = await sbAdmin.selectOne("companies", `id=eq.${companyId}`);
    if (co?.user_id) return sendPushToUser(co.user_id, payload);
    return { sent: 0 };
  }

  let total = 0;
  for (const u of users) {
    const r = await sendPushToUser(u.user_id, payload);
    total += r.sent || 0;
  }
  return { sent: total };
}

// ──────────────────────────────────────────────────────────────
// Implementation VAPID + JWT + chiffrement RFC 8291 (ECE/aes128gcm)
// ──────────────────────────────────────────────────────────────
async function sendPushSingle(sub, payload) {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;

  // 1) Header VAPID (JWT signe ES256)
  const jwt = makeVapidJwt(audience, VAPID_PRIVATE_KEY);

  // 2) Chiffrer le payload (aes128gcm + ECDH)
  const json = JSON.stringify(payload || {});
  const encrypted = encryptPayload(json, sub.p256dh_key, sub.auth_key);

  // 3) POST au push service
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400"
    },
    body: encrypted
  });

  if (r.ok) return true;
  const err = new Error(`Push failed: ${r.status}`);
  err.statusCode = r.status;
  throw err;
}

function makeVapidJwt(audience, privateKeyB64) {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT
  };

  const segHeader = b64url(JSON.stringify(header));
  const segPayload = b64url(JSON.stringify(payload));
  const signingInput = `${segHeader}.${segPayload}`;

  // Cle privee VAPID = 32 bytes raw, base64url
  const privKeyBuf = b64urlDecode(privateKeyB64);
  // Construire un PEM EC
  const pem = ecRawPrivateKeyToPem(privKeyBuf);
  const keyObj = createPrivateKey({ key: pem, format: "pem" });

  // Signer ES256 (DER) puis convertir en raw r||s 64 bytes (JWS format)
  const signer = createSign("SHA256");
  signer.update(signingInput);
  const derSig = signer.sign(keyObj);
  const rawSig = derToRaw(derSig);

  return `${signingInput}.${b64urlBuf(rawSig)}`;
}

function encryptPayload(plaintext, p256dhB64, authB64) {
  const userPub = b64urlDecode(p256dhB64);    // 65 bytes (uncompressed)
  const userAuth = b64urlDecode(authB64);     // 16 bytes

  // 1) Generer une paire ECDH ephemere (P-256)
  const ec = createECDH("prime256v1");
  ec.generateKeys();
  const localPub = ec.getPublicKey(null, "uncompressed"); // 65 bytes

  // 2) Calculer le shared secret
  const sharedSecret = ec.computeSecret(userPub);

  // 3) HKDF pour deriver IKM, CEK, nonce (RFC 8291 + RFC 8188)
  const salt = randomBytes(16);
  const prk = hkdfExtract(userAuth, sharedSecret);

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\x00"),
    userPub,
    localPub
  ]);
  const ikm = hkdfExpand(prk, keyInfo, 32);

  const prk2 = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk2, Buffer.from("Content-Encoding: aes128gcm\x00"), 16);
  const nonce = hkdfExpand(prk2, Buffer.from("Content-Encoding: nonce\x00"), 12);

  // 4) Chiffrer : padding (1 byte 0x02) + plaintext
  const padded = Buffer.concat([Buffer.from(plaintext, "utf8"), Buffer.from([0x02])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // 5) Construire le record (header aes128gcm: salt(16) + rs(4) + idlen(1) + keyid)
  // keyid = local public key (65 bytes)
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  const idlen = Buffer.from([localPub.length]); // 65
  const header = Buffer.concat([salt, rs, idlen, localPub]);

  return Buffer.concat([header, ciphertext, authTag]);
}

// HKDF helpers
function hkdfExtract(salt, ikm) {
  const hmac = createHmac("sha256", salt);
  hmac.update(ikm);
  return hmac.digest();
}
function hkdfExpand(prk, info, length) {
  const hmac = createHmac("sha256", prk);
  hmac.update(Buffer.concat([info, Buffer.from([0x01])]));
  return hmac.digest().slice(0, length);
}

// EC raw -> PEM (PKCS8)
function ecRawPrivateKeyToPem(rawKey) {
  // ASN.1 DER PKCS8 wrapper pour P-256 (prime256v1, OID 1.2.840.10045.3.1.7)
  const prefix = Buffer.from(
    "308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420",
    "hex"
  );
  const der = Buffer.concat([prefix, rawKey]);
  const b64 = der.toString("base64");
  // Reformatage 64 chars/line
  const lines = b64.match(/.{1,64}/g).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

// DER ECDSA -> raw r||s (64 bytes)
function derToRaw(derSig) {
  // DER format: 0x30 len 0x02 lenR R 0x02 lenS S
  let offset = 2; // skip 0x30 + total len
  if (derSig[1] & 0x80) offset += derSig[1] & 0x7f;
  // R
  if (derSig[offset++] !== 0x02) throw new Error("Invalid DER");
  let lenR = derSig[offset++];
  let r = derSig.slice(offset, offset + lenR);
  offset += lenR;
  // S
  if (derSig[offset++] !== 0x02) throw new Error("Invalid DER");
  let lenS = derSig[offset++];
  let s = derSig.slice(offset, offset + lenS);

  // Padding/truncate à 32 bytes chacun
  r = padOrTrim(r, 32);
  s = padOrTrim(s, 32);
  return Buffer.concat([r, s]);
}
function padOrTrim(buf, len) {
  if (buf.length === len) return buf;
  if (buf.length > len) return buf.slice(buf.length - len);
  return Buffer.concat([Buffer.alloc(len - buf.length, 0), buf]);
}

// Base64URL helpers
function b64url(str) {
  return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlBuf(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}
