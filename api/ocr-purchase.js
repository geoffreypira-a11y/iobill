// IO BILL - OCR Mistral pour factures fournisseurs
// Doc: https://docs.mistral.ai/capabilities/document/

import { authenticate, json, sbAdmin } from "./_lib/supabase-admin.js";

export const config = {
  api: { bodyParser: false }  // on parse le multipart manuellement
};

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });

  if (!process.env.MISTRAL_API_KEY) {
    return json(res, 503, { error: "MISTRAL_API_KEY not configured" });
  }

  // Lecture du body (multipart/form-data)
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const buffer = Buffer.concat(buffers);

  // Extraction simple du fichier (multipart) — on délègue à Mistral
  // Récupère le boundary
  const ct = req.headers["content-type"] || "";
  const boundary = ct.split("boundary=")[1];
  if (!boundary) return json(res, 400, { error: "No multipart boundary" });

  // Parsing minimal du multipart
  const fileData = extractFileFromMultipart(buffer, boundary);
  if (!fileData) return json(res, 400, { error: "No file in payload" });

  // Encode en base64 pour API Mistral Document
  const base64 = fileData.content.toString("base64");
  const mime = fileData.mime || "application/pdf";
  const dataUrl = "data:" + mime + ";base64," + base64;

  try {
    // Appel Mistral OCR
    const r = await fetch("https://api.mistral.ai/v1/ocr", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.MISTRAL_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "mistral-ocr-latest",
        document: { type: "document_url", document_url: dataUrl },
        include_image_base64: false
      })
    });

    if (!r.ok) {
      const txt = await r.text();
      return json(res, 502, { error: "Mistral OCR error: " + txt.slice(0, 200) });
    }
    const ocr = await r.json();

    // Extraction du markdown texte
    const fullText = (ocr.pages || [])
      .map((p) => p.markdown || p.text || "")
      .join("\n\n");

    // Parsing intelligent : on demande à Mistral de structurer ces données
    const structured = await structureWithMistral(fullText);

    return json(res, 200, {
      ok: true,
      raw_text: fullText,
      ...structured
    });
  } catch (e) {
    return json(res, 500, { error: "OCR failed: " + e.message });
  }
}

// Appel Mistral chat pour transformer le texte OCR en JSON structuré
async function structureWithMistral(text) {
  if (!text || text.length < 10) return {};
  const prompt =
    "Voici le texte OCR d'une facture fournisseur. Extrais les champs ci-dessous au format JSON STRICT (pas de markdown, pas de commentaires).\n\n" +
    "Champs : vendor_name, vendor_siret (14 chiffres ou null), vendor_vat_number (FR + 11 chiffres ou null), number (numéro de facture), issue_date (YYYY-MM-DD), subtotal_ht (nombre), vat_total (nombre), total_ttc (nombre), category (libellé court), accounting_code (code 6XXXXX français le plus probable parmi 606300/611000/613300/615000/618000/622600/623000/624000/625100/626000/627000).\n\n" +
    "Si une valeur n'est pas trouvée, mets null. Réponds UNIQUEMENT avec un objet JSON.\n\n" +
    "TEXTE :\n" + text.slice(0, 6000);

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
        temperature: 0
      })
    });
    if (!r.ok) return {};
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return {};
    return JSON.parse(content);
  } catch {
    return {};
  }
}

// Parser multipart minimal — extrait le 1er fichier
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
