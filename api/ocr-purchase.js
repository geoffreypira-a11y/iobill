// ═══════════════════════════════════════════════════════════
// IO BILL — API OCR Mistral pour factures fournisseurs
// ═══════════════════════════════════════════════════════════
// Flow :
//   1) Frontend envoie un fichier (PDF/PNG/JPG) en multipart
//   2) On valide MIME + taille
//   3) On envoie a Mistral OCR (mistral-ocr-latest)
//   4) On structure le texte extrait via Mistral chat (mistral-small)
//   5) On retourne un JSON pre-rempli pour le formulaire d'achat
//
// Doc Mistral : https://docs.mistral.ai/capabilities/OCR/document_ocr/
// ═══════════════════════════════════════════════════════════

import { authenticate, json, sbAdmin } from "./_lib/supabase-admin.js";

export const config = {
  api: { bodyParser: false } // on parse le multipart manuellement
};

// Limites de securite
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB max
const ALLOWED_MIMES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp"
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  // Auth utilisateur
  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { user, company } = auth;

  // Verifier la cle API Mistral
  if (!process.env.MISTRAL_API_KEY) {
    return json(res, 503, {
      error: "OCR temporairement indisponible (cle API non configuree). Contactez le support."
    });
  }

  // Lecture du body (multipart/form-data)
  const buffers = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > MAX_FILE_SIZE) {
      return json(res, 413, {
        error: "Fichier trop volumineux (max 10 MB). Compressez le PDF avant import."
      });
    }
    buffers.push(chunk);
  }
  const buffer = Buffer.concat(buffers);

  // Extraction du fichier depuis le multipart
  const ct = req.headers["content-type"] || "";
  const boundary = ct.split("boundary=")[1];
  if (!boundary) return json(res, 400, { error: "Format multipart invalide" });

  const fileData = extractFileFromMultipart(buffer, boundary);
  if (!fileData) return json(res, 400, { error: "Aucun fichier dans la requete" });

  // Validation MIME
  const mime = (fileData.mime || "").toLowerCase().split(";")[0].trim();
  if (!ALLOWED_MIMES.includes(mime)) {
    return json(res, 415, {
      error: `Format non supporte (${mime}). Acceptes : PDF, PNG, JPG, WEBP.`
    });
  }

  // Encode en base64 pour API Mistral
  const base64 = fileData.content.toString("base64");
  const dataUrl = "data:" + mime + ";base64," + base64;
  const isImage = mime.startsWith("image/");

  try {
    // ─── Appel Mistral OCR ───
    const ocrPayload = isImage
      ? { type: "image_url", image_url: dataUrl }
      : { type: "document_url", document_url: dataUrl };

    const r = await fetch("https://api.mistral.ai/v1/ocr", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.MISTRAL_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "mistral-ocr-latest",
        document: ocrPayload,
        include_image_base64: false
      })
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error("[ocr-purchase] Mistral OCR error", r.status, txt.slice(0, 300));
      return json(res, 502, {
        error: "Erreur de l'OCR. Reessayez ou saisissez manuellement.",
        detail: txt.slice(0, 200)
      });
    }

    const ocr = await r.json();

    // Extraction du texte de toutes les pages
    const fullText = (ocr.pages || [])
      .map((p) => p.markdown || p.text || "")
      .join("\n\n")
      .trim();

    if (!fullText || fullText.length < 10) {
      return json(res, 422, {
        error: "Aucun texte detecte dans le document. Saisissez manuellement."
      });
    }

    // ─── Structuration via Mistral chat ───
    const structured = await structureWithMistral(fullText);

    // ─── Audit log (tracage pour facturation future) ───
    try {
      await sbAdmin.insert("audit_log", {
        company_id: company.id,
        user_id: user.id,
        action: "ocr.purchase",
        entity: "purchase",
        metadata: {
          file_mime: mime,
          file_size: buffer.length,
          pages: (ocr.pages || []).length,
          extracted_vendor: structured.vendor_name || null,
          extracted_total: structured.total_ttc || null
        }
      });
    } catch {
      // Audit log silencieux : ne bloque pas la reponse
    }

    return json(res, 200, {
      ok: true,
      pages: (ocr.pages || []).length,
      raw_text: fullText.slice(0, 4000), // limite la taille de la reponse
      ...structured
    });
  } catch (e) {
    console.error("[ocr-purchase] error", e);
    return json(res, 500, {
      error: "OCR failed: " + (e.message || "erreur inconnue")
    });
  }
}

// ─── Structuration : transforme le texte brut en JSON metier ───
async function structureWithMistral(text) {
  const prompt =
`Tu es un comptable francais. Voici le texte OCR d'une facture fournisseur.
Extrais ces champs au format JSON STRICT (aucun markdown, aucun commentaire) :

- vendor_name : nom du fournisseur (string)
- vendor_siret : SIRET du fournisseur, exactement 14 chiffres sans espaces (string ou null)
- vendor_vat_number : numero TVA intracom (ex: FR12345678901) (string ou null)
- number : numero de la facture (string)
- issue_date : date d'emission au format YYYY-MM-DD (string)
- subtotal_ht : montant hors taxes (nombre decimal, point comme separateur)
- vat_total : montant total TVA (nombre decimal)
- total_ttc : montant total TTC (nombre decimal)
- category : libelle court de la categorie (ex: "Materiel informatique", "Frais bancaires") (string)
- accounting_code : code comptable francais 6 chiffres le plus probable parmi :
    606300 (fournitures non stockables), 611000 (sous-traitance), 613300 (locations),
    615000 (entretien reparations), 618000 (divers), 622600 (honoraires),
    623000 (publicite), 624000 (transports), 625100 (deplacements),
    626000 (postes telecom), 627000 (services bancaires) (string)

Si une valeur n'est pas trouvee, mets null. Reponds UNIQUEMENT avec un objet JSON valide.

TEXTE :
${text.slice(0, 6000)}`;

  try {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.MISTRAL_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 500
      })
    });
    if (!r.ok) {
      console.warn("[ocr-purchase] structureWithMistral failed", r.status);
      return {};
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return {};

    const parsed = JSON.parse(content);

    // Nettoyage : SIRET sans espaces, dates validees
    if (parsed.vendor_siret) {
      parsed.vendor_siret = String(parsed.vendor_siret).replace(/\D/g, "");
      if (parsed.vendor_siret.length !== 14) parsed.vendor_siret = null;
    }
    if (parsed.vendor_vat_number) {
      parsed.vendor_vat_number = String(parsed.vendor_vat_number).replace(/\s/g, "").toUpperCase();
    }
    if (parsed.issue_date && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.issue_date)) {
      parsed.issue_date = null;
    }
    // Forcer les montants en nombres
    for (const k of ["subtotal_ht", "vat_total", "total_ttc"]) {
      if (parsed[k] !== null && parsed[k] !== undefined) {
        const n = Number(parsed[k]);
        parsed[k] = isNaN(n) ? null : n;
      }
    }

    return parsed;
  } catch (e) {
    console.warn("[ocr-purchase] structureWithMistral exception", e.message);
    return {};
  }
}

// ─── Parser multipart minimal — extrait le 1er fichier ───
function extractFileFromMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from("--" + boundary);
  const parts = [];
  let start = 0;
  let idx;
  while ((idx = buffer.indexOf(boundaryBuf, start)) !== -1) {
    if (start > 0) parts.push(buffer.slice(start, idx));
    start = idx + boundaryBuf.length;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd).toString();
    if (!headers.includes("filename=")) continue;
    const mimeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    const mime = mimeMatch ? mimeMatch[1].trim() : "application/octet-stream";
    let content = part.slice(headerEnd + 4);
    if (content.slice(-2).toString() === "\r\n") content = content.slice(0, -2);
    return { content, mime };
  }
  return null;
}
