// IO BILL - Generation Factur-X (PDF/A-3 + XML CII embarque)
// Profil cible : EN16931 — Reference : Factur-X 1.0.07 (FNFE-MPE)
// v8.61.3 : basculé BASIC WL → EN16931 (le XML contenait déjà les lignes,
//           mais BASIC WL les interdit → XSD invalide. EN16931 les exige.)
// v8.14 : support des avoirs (credit_notes) en plus des factures (invoices)

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";
import { AFRelationship, PDFName, PDFString, PDFHexString, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { buildDocumentPdf, uploadToStorage, signedUrl } from "./_lib/pdf-builder.js";
import { notifyAdmin } from "./_lib/monitor.js";

// Mapping document_type → config table/colonnes
const DOC_CONFIG = {
  invoice: {
    table: "invoices",
    lineType: "invoice",
    typeCode: "380",          // Factur-X : 380 = Commercial invoice
    // v8.48.31 — Retour à BASIC WL : SUPER PDP n'a pas de validateur EN16931
    // en sandbox ("aucun validateur trouvé pour ce format de fichier").
    // On garde le bloc IncludedSupplyChainTradeLineItem par ligne, il ne
    // gêne pas BASIC WL mais servira quand SUPER PDP câblera EN16931.
    profile: "urn:cen.eu:en16931:2017",
    storageBucket: "invoices-pdf",
    fxStatusColumn: "facturx_status",
    fxPdfColumn: "facturx_pdf_url",
    fxXmlColumn: "facturx_xml_url",
    pdfColumn: "pdf_url",
    label: "Facture",
    issuedStatuses: ["issued", "sent", "partial", "paid", "overdue"]
  },
  credit_note: {
    table: "credit_notes",
    lineType: "credit_note",
    typeCode: "381",          // Factur-X : 381 = Credit note
    profile: "urn:cen.eu:en16931:2017",
    storageBucket: "invoices-pdf", // même bucket — différencié par préfixe nom
    fxStatusColumn: "facturx_status",
    fxPdfColumn: "facturx_pdf_url",
    fxXmlColumn: "facturx_xml_url",
    pdfColumn: "pdf_url",
    label: "Avoir",
    issuedStatuses: ["issued"]
  }
};

// ═══════════════════════════════════════════════════════════════════
// v8.61.2 — PDF/A-3 : métadonnées XMP Factur-X
//
// Contexte : pdf-lib attache bien le XML (factur-x.xml) mais ne pose AUCUN
// bloc XMP dans le catalogue. Résultat : le PDF n'est pas un PDF/A-3 déclaré,
// et certains parseurs stricts (dont potentiellement SUPER PDP) ne savent pas
// qu'un Factur-X est embarqué → ils affichent le PDF mais n'extraient pas les
// métadonnées structurées (onglet "Général" vide).
//
// Le validateur tiers facturxapi.com signale ce défaut : NO_XMP_METADATA.
//
// Ce helper pose le paquet XMP minimal exigé par Factur-X :
//   - namespace pdfaid (PDF/A part=3, conformance=B)
//   - namespace fx (urn:factur-x) : DocumentType=INVOICE, DocumentFileName,
//     Version=1.0, ConformanceLevel (mappé depuis le profil urn:...)
//   - Dublin Core minimal (title)
//
// On mappe le profil interne (urn:factur-x.eu:1p0:basicwl) vers le
// ConformanceLevel XMP attendu (BASIC WL, BASIC, EN 16931, etc.).
// ═══════════════════════════════════════════════════════════════════
function profileToConformanceLevel(profileUrn) {
  const p = String(profileUrn || "").toLowerCase();
  if (p.includes("minimum")) return "MINIMUM";
  if (p.includes("basicwl")) return "BASIC WL";
  if (p.includes("basic")) return "BASIC";
  if (p.includes("en16931")) return "EN 16931";
  if (p.includes("extended")) return "EXTENDED";
  return "BASIC WL";
}

function buildFacturxXmp({ documentNumber, conformanceLevel, isCredit }) {
  // Échappe le strict minimum pour rester bien formé dans le XMP.
  const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
  const title = esc((isCredit ? "Avoir " : "Facture ") + (documentNumber || ""));
  const docType = "INVOICE"; // Factur-X : toujours INVOICE, même pour un avoir (TypeCode 381 gère la distinction dans le CII)
  return `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${title}</rdf:li>
        </rdf:Alt>
      </dc:title>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
      <fx:DocumentType>${docType}</fx:DocumentType>
      <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>${esc(conformanceLevel)}</fx:ConformanceLevel>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
      <pdfaExtension:schemas>
        <rdf:Bag>
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
            <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>fx</pdfaSchema:prefix>
            <pdfaSchema:property>
              <rdf:Seq>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>DocumentFileName</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>Name of the embedded XML invoice file</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>DocumentType</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>INVOICE</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>Version</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>The actual version of the Factur-X data</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>ConformanceLevel</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>The conformance level of the Factur-X data</pdfaProperty:description>
                </rdf:li>
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>
        </rdf:Bag>
      </pdfaExtension:schemas>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// v8.61.3 — Profil ICC sRGB (IEC61966-2.1) embarqué en base64 pour l'OutputIntent
// PDF/A-3. Requis : un PDF/A-3 DOIT déclarer un OutputIntent avec profil ICC,
// sinon l'enveloppe n'est pas un PDF/A-3 valide → SUPER PDP refuse d'extraire
// le Factur-X embarqué (métadonnées "Général" vides). Généré via sRGB standard.
const SRGB_ICC_B64 = "AAACTGxjbXMEQAAAbW50clJHQiBYWVogB+oACAAMABYAMwAsYWNzcEFQUEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA2Y3BydAAAAUAAAABMd3RwdAAAAYwAAAAUY2hhZAAAAaAAAAAsclhZWgAAAcwAAAAUYlhZWgAAAeAAAAAUZ1hZWgAAAfQAAAAUclRSQwAAAggAAAAgZ1RSQwAAAggAAAAgYlRSQwAAAggAAAAgY2hybQAAAigAAAAkbWx1YwAAAAAAAAABAAAADGVuVVMAAAAaAAAAHABzAFIARwBCACAAYgB1AGkAbAB0AC0AaQBuAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAADAAAAAcAE4AbwAgAGMAbwBwAHkAcgBpAGcAaAB0ACwAIAB1AHMAZQAgAGYAcgBlAGUAbAB5WFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDEIAAAXe///zJQAAB5MAAP2Q///7of///aIAAAPcAADAblhZWiAAAAAAAABvoAAAOPUAAAOQWFlaIAAAAAAAACSfAAAPhAAAtsNYWVogAAAAAAAAYpcAALeHAAAY2XBhcmEAAAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbY2hybQAAAAAAAwAAAACj1wAAVHsAAEzNAACZmgAAJmYAAA9c";

// Ajoute l'OutputIntent PDF/A-3 (profil colorimétrique sRGB) au catalogue.
async function applyPdfA3OutputIntent(pdfDoc) {
  const iccBytes = Uint8Array.from(atob(SRGB_ICC_B64), (c) => c.charCodeAt(0));
  const iccStream = pdfDoc.context.stream(iccBytes, { N: 3 });
  const iccRef = pdfDoc.context.register(iccStream);
  const outputIntent = pdfDoc.context.obj({
    Type: "OutputIntent",
    S: "GTS_PDFA1",
    OutputConditionIdentifier: PDFString.of("sRGB"),
    Info: PDFString.of("sRGB IEC61966-2.1"),
    DestOutputProfile: iccRef,
  });
  const oiRef = pdfDoc.context.register(outputIntent);
  pdfDoc.catalog.set(PDFName.of("OutputIntents"), pdfDoc.context.obj([oiRef]));
}

// Pose le flux XMP dans le catalogue du PDF (/Metadata) + AFRelationship.
async function applyPdfA3Metadata(pdfDoc, xmpString) {
  const xmpBytes = new TextEncoder().encode(xmpString);
  const stream = pdfDoc.context.stream(xmpBytes, {
    Type: "Metadata",
    Subtype: "XML",
  });
  const streamRef = pdfDoc.context.register(stream);
  pdfDoc.catalog.set(PDFName.of("Metadata"), streamRef);
}

export default async function handler(req, res) {
  try {
    return await handleRequest(req, res);
  } catch (e) {
    // Catch global pour éviter les 500 HTML Vercel : on retourne toujours du JSON
    console.error("[generate-facturx] UNCAUGHT", e?.stack || e?.message || e);
    notifyAdmin({
      level: "critical",
      subject: "generate-facturx plante",
      details: { error: e?.message, stack: (e?.stack || "").slice(0, 1000) }
    }).catch(() => {});
    return json(res, 500, {
      error: "Erreur serveur : " + (e?.message || "inconnue"),
      stack_top: (e?.stack || "").split("\n").slice(0, 3).join(" | ")
    });
  }
}

async function handleRequest(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  // v8.37 — Mode INTERNAL : appel server-to-server depuis public.js external
  // après push_invoice / update_invoice_status. Authentifié par secret partagé.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const isInternal = body?.internal === true;
  let company;

  if (isInternal) {
    const provided = req.headers["x-internal-secret"] || req.headers["X-Internal-Secret"];
    const expected = process.env.IOBILL_INTERNAL_GEN_SECRET
                  || process.env.IOBILL_EXTERNAL_SECRET;
    if (!expected || !provided || provided !== expected) {
      return json(res, 401, { error: "Invalid internal secret" });
    }
    // En mode internal, on récupère la company via le document directement
    const documentType = body?.document_type || (body?.invoice_id ? "invoice" : null);
    if (!documentType || !DOC_CONFIG[documentType]) {
      return json(res, 400, { error: "document_type invalide" });
    }
    const documentId = body?.document_id || body?.invoice_id;
    if (!documentId) return json(res, 400, { error: "document_id requis" });
    const docPre = await sbAdmin.selectOne(DOC_CONFIG[documentType].table, `id=eq.${documentId}`);
    if (!docPre) return json(res, 404, { error: "Document introuvable" });
    company = await sbAdmin.selectOne("companies", `id=eq.${docPre.company_id}`);
    if (!company) return json(res, 404, { error: "Company introuvable" });
  } else {
    // Mode normal : auth user
    const auth = await authenticate(req);
    if (auth.error) return json(res, auth.status, { error: auth.error });
    company = auth.company;
  }

  // Routage du document_type
  // Rétro-compat : invoice_id seul → document_type = "invoice"
  const documentType = body?.document_type || (body?.invoice_id ? "invoice" : null);
  if (!documentType || !DOC_CONFIG[documentType]) {
    return json(res, 400, { error: "document_type invalide (attendu: invoice | credit_note)" });
  }
  const cfg = DOC_CONFIG[documentType];

  const documentId = body?.document_id || body?.invoice_id;
  if (!documentId) return json(res, 400, { error: "document_id (ou invoice_id) requis" });

  const issueMode = body?.issue === true || body?.mode === "issue";
  const preview = body?.preview === true;
  const transmitPdp = body?.transmit_pdp === true || body?.mode === "transmit_pdp";

  const doc = await sbAdmin.selectOne(cfg.table, `id=eq.${documentId}&company_id=eq.${company.id}`);
  if (!doc) return json(res, 404, { error: `${cfg.label} introuvable` });

  // ═══════════════════════════════════════════════════════════
  // MODE : TRANSMISSION PDP (administration fiscale)
  // ⚠️ v8.47.1 — Chemin legacy neutralisé. La transmission passe
  // désormais par l'adapter Plateforme Agréée réel :
  //     POST /api/admin  { action: "pa_send", payload: { invoice_id } }
  // qui utilise pdp_transmission_id sur la vraie PA.
  // Laisser ce code actif écrivait des ID factices "PPF-TEST-..."
  // qui bloquaient ensuite la vraie transmission (déjà transmise).
  // ═══════════════════════════════════════════════════════════
  if (transmitPdp) {
    return json(res, 410, {
      error: "Le chemin de transmission PDP historique est désactivé. Utilisez le bouton « Transmettre » sur la facture qui appelle la Plateforme Agréée configurée par l'admin."
    });
  }

  // ═══════════════════════════════════════════════════════════
  // MODE : ISSUE — passage en "issued" (factures uniquement,
  // les avoirs sont émis via UPDATE direct côté front)
  // ═══════════════════════════════════════════════════════════
  if (issueMode && documentType === "invoice") {
    if (["paid", "canceled"].includes(doc.status)) {
      return json(res, 400, { error: "Cette facture ne peut plus être émise (statut: " + doc.status + ")" });
    }
    if (doc.status === "draft") {
      try {
        // v8.51 — Le numéro LÉGAL est attribué ici, à l'émission, et non à la
        // création du brouillon : supprimer un brouillon ne laisse donc plus
        // de trou dans la séquence. On l'écrit dans le MÊME UPDATE que le
        // statut, pour que la chaîne de hashs anti-fraude (trigger BEFORE
        // UPDATE) le couvre.
        //
        // Une facture qui porte déjà un vrai numéro garde le sien : soit
        // elle a été créée avant la v8.51, soit son numéro a été saisi à la
        // main. Lui en réattribuer un créerait précisément le trou qu'on
        // cherche à supprimer.
        const patch = {
          status: "issued",
          issued_at: new Date().toISOString()
        };

        if (String(doc.number || "").startsWith("BROUILLON-")) {
          const legalNumber = await sbAdmin.rpc("allocate_document_number", {
            p_company_id: company.id,
            p_doc_type: "invoice"
          });
          if (!legalNumber || typeof legalNumber !== "string") {
            return json(res, 500, {
              error: "Impossible d'attribuer le numéro de facture. Si la migration v8.51 "
                + "n'a pas été exécutée, lancez migration_v8_51_numero_a_emission.sql "
                + "dans Supabase."
            });
          }
          patch.number = legalNumber;
        }

        const updated = await sbAdmin.update("invoices", `id=eq.${documentId}`, patch);
        if (!updated || !updated[0]) {
          return json(res, 500, {
            error: "Échec de l'émission. Si vous n'avez pas exécuté la migration v8.10, allez dans Supabase SQL Editor et lancez le contenu de migration_v8_10_fix_hash_chain.sql"
          });
        }
        Object.assign(doc, updated[0]);

        // v8.59 — Émettre une facture au nom d'un client le fait sortir du
        // stade prospect : c'est le moment où la relation devient commerciale.
        // On ne touche ni aux clients VIP ni à ceux déjà marqués « client »,
        // pour ne pas écraser une qualification saisie à la main.
        // Best-effort : une erreur ici ne doit pas faire échouer l'émission.
        if (doc.client_id) {
          try {
            const cli = await sbAdmin.selectOne(
              "clients", `id=eq.${doc.client_id}&company_id=eq.${company.id}`, "id,status"
            );
            if (cli && ["prospect", "quote_sent", "negotiation", "inactive"].includes(cli.status)) {
              await sbAdmin.update("clients", `id=eq.${cli.id}`, { status: "customer" });
            }
          } catch (e) {
            console.warn("[generate-facturx] promotion client impossible:", e?.message);
          }
        }
      } catch (e) {
        return json(res, 500, { error: "Erreur SQL émission : " + (e.message || "inconnue") });
      }
    }
  }

  // Mode preview : on autorise la génération même sur un brouillon
  if (!preview && !issueMode && !cfg.issuedStatuses.includes(doc.status)) {
    return json(res, 400, { error: `${cfg.label} doit être émis avant de générer le Factur-X` });
  }

  // ═══════════════════════════════════════════════════════════
  // FAST-PATH PREVIEW : si le document est émis (donc immuable
  // par chaîne de hashs) ET qu'un PDF est déjà stocké, on resigne
  // simplement l'URL existante au lieu de tout regénérer.
  // Gain : ~3-5s → ~300ms.
  // ═══════════════════════════════════════════════════════════
  if (preview && !issueMode && cfg.issuedStatuses.includes(doc.status) && doc[cfg.fxPdfColumn]) {
    // Le PDF existe déjà. On a besoin du path pour resigner.
    // doc[cfg.fxPdfColumn] est une URL signée déjà : on en extrait le path.
    const filePrefix = documentType === "credit_note" ? "avoir-" : "";
    const pdfPath = `${company.id}/${filePrefix}${doc.number}.pdf`;
    const xmlPath = `${company.id}/${filePrefix}${doc.number}.xml`;
    const pdfSigned = await signedUrl(cfg.storageBucket, pdfPath, 3600);
    if (pdfSigned) {
      const xmlSigned = await signedUrl(cfg.storageBucket, xmlPath, 3600);
      console.log(`[generate-facturx] FAST-PATH preview pour ${doc.number}`);
      return json(res, 200, {
        ok: true,
        pdf_url: pdfSigned,
        xml_url: xmlSigned,
        cached: true
      });
    }
    // Si la signature échoue (fichier supprimé ?), on retombe sur la
    // régénération normale ci-dessous, ce qui le recréera.
    console.log(`[generate-facturx] FAST-PATH miss pour ${doc.number}, régénération`);
  }

  const lines = await sbAdmin.select("document_lines", {
    filter: `document_type=eq.${cfg.lineType}&document_id=eq.${documentId}`,
    order: "sort_order.asc"
  });

  // v8.66 — Règlements, pour ventiler « Déjà encaissé » sur le PDF.
  // Sans eux le client lit « - 2 000,00 € » sans savoir d'où ça vient : un
  // acompte, une reprise, un virement ? L'annexe des paiements le dit, mais
  // en page 2 et seulement à l'export cabinet.
  // Les avoirs n'ont pas de règlements rattachés.
  let payments = [];
  if (documentType === "invoice") {
    payments = await sbAdmin.select("payments", {
      filter: `invoice_id=eq.${documentId}`,
      order: "paid_at.asc"
    }) || [];
  }

  console.log(`[generate-facturx] doc=${documentType}/${documentId} lines=${(lines || []).length} payments=${payments.length} status=${doc.status}`);

  // 1) XML CII Factur-X
  let xml;
  try {
    xml = buildFacturxXml({ doc, lines: lines || [], company, cfg });
    // v8.48.22 — Log les blocs TVA pour diagnostiquer BR-CO-17.
    const vatBlocks = xml.match(/<ram:ApplicableTradeTax>[\s\S]*?<\/ram:ApplicableTradeTax>/g) || [];
    console.log("[generate-facturx] ApplicableTradeTax count=" + vatBlocks.length);
    vatBlocks.forEach((b, i) => console.log("[generate-facturx] block[" + i + "] " + b.replace(/\s+/g, " ")));
    // Log le breakdown source et les lignes
    console.log("[generate-facturx] doc.vat_breakdown=" + JSON.stringify(doc.vat_breakdown));
    console.log("[generate-facturx] doc.vat_total_cents=" + doc.vat_total_cents + " subtotal_ht=" + doc.subtotal_ht_cents);
    console.log("[generate-facturx] lines=" + JSON.stringify((lines || []).map(l => ({
      total_ht_cents: l.total_ht_cents, vat_rate: l.vat_rate
    }))));
  } catch (e) {
    throw new Error("buildFacturxXml: " + (e?.message || "?"));
  }

  // 2) PDF (builder partagé) + embed XML
  let pdfDoc;
  try {
    pdfDoc = await buildDocumentPdf({
      docType: documentType,
      doc,
      lines: lines || [],
      payments,
      company
    });
  } catch (e) {
    throw new Error("buildDocumentPdf: " + (e?.message || "?"));
  }

  const xmlBytes = new TextEncoder().encode(xml);
  try {
    await pdfDoc.attach(xmlBytes, "factur-x.xml", {
      mimeType: "application/xml",
      description: documentType === "credit_note" ? "Avoir électronique Factur-X" : "Facture électronique Factur-X",
      creationDate: new Date(),
      modificationDate: new Date(),
      afRelationship: AFRelationship.Alternative
    });
  } catch (e) {
    throw new Error("pdfDoc.attach: " + (e?.message || "?"));
  }

  // v8.61.2 — Pose les métadonnées XMP Factur-X (PDF/A-3) avant sauvegarde.
  // Sans ce bloc, le PDF n'est pas un PDF/A-3 déclaré et certains parseurs
  // n'extraient pas le XML embarqué (validateur tiers : NO_XMP_METADATA).
  try {
    const conformanceLevel = profileToConformanceLevel(cfg.profile);
    const xmp = buildFacturxXmp({
      documentNumber: doc.number,
      conformanceLevel,
      isCredit: documentType === "credit_note"
    });
    await applyPdfA3Metadata(pdfDoc, xmp);
    await applyPdfA3OutputIntent(pdfDoc);
  } catch (e) {
    // Non bloquant : si le XMP échoue, on garde le PDF sans (comportement
    // pré-v8.61.2). On log pour diagnostic mais on ne casse pas la génération.
    console.warn(`[generate-facturx] v8.61.2 XMP non posé invoice=${documentId}: ${e.message}`);
  }

  let pdfBytes;
  try {
    pdfBytes = await pdfDoc.save();
  } catch (e) {
    throw new Error("pdfDoc.save: " + (e?.message || "?"));
  }

  // 3) Upload + URLs signées
  // Prefix "avoir-" pour différencier des factures dans le bucket commun
  const filePrefix = documentType === "credit_note" ? "avoir-" : "";
  const pdfPath = `${company.id}/${filePrefix}${doc.number}.pdf`;
  const xmlPath = `${company.id}/${filePrefix}${doc.number}.xml`;
  const uploadedPdf = await uploadToStorage(cfg.storageBucket, pdfPath, pdfBytes, "application/pdf");
  if (!uploadedPdf) {
    return json(res, 500, { error: `Storage upload failed (pdf) — bucket=${cfg.storageBucket} path=${pdfPath}` });
  }
  const uploadedXml = await uploadToStorage(cfg.storageBucket, xmlPath, xmlBytes, "application/xml");
  if (!uploadedXml) {
    return json(res, 500, { error: `Storage upload failed (xml) — bucket=${cfg.storageBucket} path=${xmlPath}` });
  }
  const pdfSigned = await signedUrl(cfg.storageBucket, pdfPath, 3600);
  const xmlSigned = await signedUrl(cfg.storageBucket, xmlPath, 3600);

  console.log(`[generate-facturx] OK pdf_size=${pdfBytes.length} signed=${!!pdfSigned}`);

  const updatePayload = {
    [cfg.fxStatusColumn]: "generated",
    [cfg.fxPdfColumn]: pdfSigned,
    [cfg.fxXmlColumn]: xmlSigned,
    [cfg.pdfColumn]: pdfSigned
  };
  await sbAdmin.update(cfg.table, `id=eq.${documentId}`, updatePayload);

  // v8.60.2 — Chaînage AUTO-TRANSMIT B2B après génération du Factur-X
  //
  // Quand push_invoice a été appelé avec `auto_transmit: true` (typiquement
  // IOCAR poussant une facture B2B en "issued"), le trigger a passé le flag
  // `auto_transmit_after_generation` en body. On l'exécute maintenant, une
  // fois le PDF/A-3 uploadé dans Storage.
  //
  // Fait dans CE worker (pas dans push_invoice) pour éviter le pattern Vercel
  // fatal où le fire-and-forget meurt au res.json() du worker précédent.
  //
  // Erreur non fatale : si paSendInvoice échoue (auth SUPER PDP, doublon,
  // etc.), on log et retourne quand même 200 pour la génération. L'utilisateur
  // peut retenter manuellement via "🏛️ Transmettre" côté IOBILL.
  if (body && body.auto_transmit_after_generation === true && documentType === "invoice") {
    try {
      const { paSendInvoice } = await import("./_lib/pa-actions.js");
      const paResult = await paSendInvoice(company, { invoice_id: documentId });
      console.log(
        `[generate-facturx→autoTransmit] OK invoice=${documentId}`
        + ` pa_document_id=${paResult.pa_document_id}`
      );
    } catch (e) {
      console.warn(
        `[generate-facturx→autoTransmit] échec invoice=${documentId} : ${e.message || e}`
      );
      // On continue et retourne 200 — le PDF est bien généré, l'user pourra
      // retenter la transmission manuellement.
    }
  }

  return json(res, 200, {
    ok: true,
    pdf_url: pdfSigned,
    xml_url: xmlSigned,
    pdf_size: pdfBytes.length,
    // v8.51 — Le numéro peut avoir changé à l'émission (provisoire → légal) :
    // le frontend en a besoin pour afficher le bon numéro sans relire la base.
    number: doc.number
  });
}

// ─────────────────────────────────────────────────────────────
// XML CII : commun factures/avoirs, différencié par TypeCode
// (380 = facture, 381 = avoir)
// ─────────────────────────────────────────────────────────────
// v8.61.3 — Mappe une unité (saisie libre ou code) vers un code UN/ECE Rec 20
// valide (exigé par EN16931 pour @unitCode). Retombe sur C62 (unité/pièce)
// pour toute valeur non reconnue. Les codes déjà valides sont conservés tels quels.
const UN_ECE_UNIT_MAP = {
  // Unité / pièce
  "u": "C62", "unite": "C62", "unité": "C62", "unites": "C62", "unités": "C62",
  "piece": "H87", "pièce": "H87", "pieces": "H87", "pièces": "H87", "pce": "H87", "pcs": "H87", "pc": "H87",
  "ea": "C62", "each": "C62",
  // Temps
  "h": "HUR", "heure": "HUR", "heures": "HUR", "hr": "HUR", "hrs": "HUR",
  "j": "DAY", "jour": "DAY", "jours": "DAY", "day": "DAY",
  "min": "MIN", "minute": "MIN", "minutes": "MIN",
  "mois": "MON", "month": "MON",
  "an": "ANN", "ans": "ANN", "annee": "ANN", "année": "ANN", "year": "ANN",
  "sem": "WEE", "semaine": "WEE", "week": "WEE",
  // Masse
  "kg": "KGM", "kilo": "KGM", "kilos": "KGM", "kilogramme": "KGM",
  "g": "GRM", "gramme": "GRM", "grammes": "GRM",
  "t": "TNE", "tonne": "TNE", "tonnes": "TNE",
  // Longueur
  "m": "MTR", "metre": "MTR", "mètre": "MTR", "metres": "MTR", "mètres": "MTR",
  "cm": "CMT", "mm": "MMT", "km": "KMT",
  // Surface / volume
  "m2": "MTK", "m²": "MTK", "m3": "MTQ", "m³": "MTQ",
  "l": "LTR", "litre": "LTR", "litres": "LTR",
  "ml": "MLT",
  // Forfait / divers → unité
  "forfait": "C62", "ff": "C62", "lot": "C62", "ens": "C62", "ensemble": "C62",
  "pourcentage": "P1", "%": "P1",
  "kwh": "KWH", "kw": "KWT"
};
// Set des codes UN/ECE valides déjà (si l'utilisateur a saisi un vrai code).
// Liste courante suffisante ; tout code inconnu tombe sur C62.
const UN_ECE_VALID = new Set(["C62","H87","HUR","DAY","MIN","MON","ANN","WEE",
  "KGM","GRM","TNE","MTR","CMT","MMT","KMT","MTK","MTQ","LTR","MLT","P1","KWH",
  "KWT","SET","NPR","XPP","XBX","XCT","D64","LS"]);
function mapUnitCode(raw) {
  if (!raw) return "C62";
  const s = String(raw).trim();
  if (!s) return "C62";
  // Déjà un code valide (insensible à la casse pour les codes normés en MAJ) ?
  const up = s.toUpperCase();
  if (UN_ECE_VALID.has(up)) return up;
  // Libellé libre → mappe (insensible à la casse)
  const mapped = UN_ECE_UNIT_MAP[s.toLowerCase()];
  return mapped || "C62";
}

// v8.63 — BT-40 / BT-55 : le code pays d'une adresse DOIT être un code
// ISO 3166-1 alpha-2. Le champ « Pays » des réglages est en saisie libre :
// une société ayant tapé « FRANCE » produisait
// <ram:CountryID>FRANCE</ram:CountryID>, refusé par le XSD (la valeur est
// contrainte à la liste de codes ISO) et par la règle EN16931 BR-09.
// La facture partait donc invalide sans que rien ne le signale côté IOBILL.
//
// On normalise ici, à l'émission, plutôt qu'en base : le pays n'est utilisé
// nulle part ailleurs que dans ce XML (il n'apparaît pas sur le PDF lisible),
// et corriger au point d'usage rattrape aussi les données déjà saisies.
const COUNTRY_NAME_TO_ISO2 = {
  FRANCE: "FR", FRANCAISE: "FR", "FRANCE METROPOLITAINE": "FR",
  BELGIQUE: "BE", BELGIUM: "BE", BELGIE: "BE",
  SUISSE: "CH", SWITZERLAND: "CH", SCHWEIZ: "CH",
  LUXEMBOURG: "LU",
  ALLEMAGNE: "DE", GERMANY: "DE", DEUTSCHLAND: "DE",
  ESPAGNE: "ES", SPAIN: "ES", ESPANA: "ES",
  ITALIE: "IT", ITALY: "IT", ITALIA: "IT",
  "PAYS-BAS": "NL", "PAYS BAS": "NL", NETHERLANDS: "NL", NEDERLAND: "NL",
  PORTUGAL: "PT",
  "ROYAUME-UNI": "GB", "ROYAUME UNI": "GB", "UNITED KINGDOM": "GB", ANGLETERRE: "GB",
  IRLANDE: "IE", IRELAND: "IE",
  AUTRICHE: "AT", AUSTRIA: "AT",
  MONACO: "MC", ANDORRE: "AD", ANDORRA: "AD",
  CANADA: "CA", "ETATS-UNIS": "US", "ETATS UNIS": "US", "UNITED STATES": "US", USA: "US",
  MAROC: "MA", MOROCCO: "MA", TUNISIE: "TN", TUNISIA: "TN", ALGERIE: "DZ", ALGERIA: "DZ"
};

function iso2Country(v, fallback = "FR") {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return fallback;
  // Accents et ponctuation retirés : « ALGÉRIE » doit trouver « ALGERIE ».
  const key = raw.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/^[A-Z]{2}$/.test(key)) return key;        // déjà un code ISO2
  if (COUNTRY_NAME_TO_ISO2[key]) return COUNTRY_NAME_TO_ISO2[key];
  // Un libellé inconnu ne doit surtout pas passer tel quel dans le XML :
  // mieux vaut le pays par défaut, qui produit une facture valide, qu'une
  // valeur libre qui la fait rejeter en bloc par le PDP.
  return fallback;
}

function buildFacturxXml({ doc, lines, company, cfg }) {
  const cs = doc.client_snapshot || {};
  const co = doc.company_snapshot || company;
  const cur = doc.currency || "EUR";
  const dt = (iso) => (iso || "").replace(/-/g, "").slice(0, 8);
  const x = (s) => String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

  // v8.64 — PEPPOL-EN16931-R008 : « Document MUST not contain empty elements ».
  // Les balises d'adresse étaient émises inconditionnellement : un acheteur
  // sans adresse — le cas normal d'une cliente de salon poussée par IOBEAUTY —
  // produisait <ram:PostcodeCode></ram:PostcodeCode> et deux autres balises
  // vides, soit trois règles enfreintes et une facture rejetée.
  //
  // Dans BG-8 (adresse de l'acheteur), seul BT-55 (code pays) est obligatoire :
  // rue, code postal et ville sont facultatifs. Les omettre est donc conforme,
  // et bien préférable à inventer une adresse de complaisance sur une facture.
  const tagIf = (tag, value) => {
    const v = x(value);
    return v ? `<ram:${tag}>${v}</ram:${tag}>` : "";
  };

  const supplierName = x(co.legal_name || co.trade_name);
  const buyerName = x(cs.legal_name || `${cs.first_name || ""} ${cs.last_name || ""}`.trim() || "Client");
  // v8.68 — DÉBOURS (art. 267 II 2° du CGI) : sommes avancées au nom et pour le
  // compte du client (carte grise…). Hors base TVA, mais dues par le client :
  // elles doivent donc entrer dans le montant à payer, sinon le document
  // transmis réclame moins que la facture remise au client (constaté sur
  // VEH-2026-0097 : 7 980,00 € transmis contre 8 113,76 € dus).
  //
  // Modélisation EN 16931 : charge au niveau document (BG-21) rattachée à une
  // catégorie de TVA exonérée, plus le groupe de ventilation correspondant.
  // La catégorie « O » (hors champ) serait la plus juste, mais BR-O-11 interdit
  // de la mêler à d'autres catégories : sur une facture portant aussi des
  // lignes à 20 %, elle ferait rejeter le document. On retient donc « E » avec
  // le motif d'exonération en clair (BT-120), que BR-E-10 accepte sans code.
  const debourCents = Math.max(0, Math.round(Number(doc.debour_total_cents || 0)));
  const DEBOURS_REASON = "Débours - art. 267 II 2° du CGI";
  const DEBOURS_EXEMPTION_TEXT =
    "Débours - sommes avancées au nom et pour le compte du client (art. 267 II 2° du CGI)";

  // v8.48.21 — Fix BR-CO-14 : reconstruit vat_breakdown depuis les lignes
  // si vide, sinon Σ(TVA par catégorie) ≠ TVA totale et la validation échoue.
  // v8.48.23 — Fix BR-CO-17 : les vraies colonnes de document_lines sont
  // line_ht_cents et line_vat_cents (pas total_ht_cents). Sans ça, la
  // base restait à 0 et le calcul base × rate ne matchait pas la TVA.
  let breakdown = doc.vat_breakdown || [];
  if (!Array.isArray(breakdown) || breakdown.length === 0) {
    const byRate = new Map();
    for (const l of (lines || [])) {
      const rate = Number(l.vat_rate ?? 0);
      // Fallback en cascade sur les noms de colonnes possibles
      const baseC = Number(
        l.line_ht_cents ??
        l.total_ht_cents ??
        (Number(l.unit_price_ht_cents ?? 0) * Number(l.quantity ?? 1)) ??
        0
      );
      const vatC = Number(
        l.line_vat_cents ??
        Math.round(baseC * rate / 100)
      );
      const key = rate.toFixed(2);
      const prev = byRate.get(key) || { rate, base_cents: 0, vat_cents: 0 };
      prev.base_cents += baseC;
      prev.vat_cents += vatC;
      byRate.set(key, prev);
    }
    breakdown = Array.from(byRate.values());
    // Correction d'arrondi cumulatif : force la somme TVA à matcher le total.
    const totalC = Number(doc.vat_total_cents ?? 0);
    const sumC = breakdown.reduce((s, v) => s + v.vat_cents, 0);
    if (breakdown.length > 0 && totalC && sumC !== totalC) {
      breakdown[breakdown.length - 1].vat_cents += (totalC - sumC);
    }
  }
  // v8.68 — Les débours rejoignent la ventilation TVA en catégorie E, base =
  // montant avancé, TVA = 0 (BR-E-9). Deux groupes de même catégorie et même
  // taux étant interdits, on fusionne avec un éventuel groupe à 0 % déjà
  // présent — le régime de marge, typiquement. La copie évite de modifier
  // le vat_breakdown stocké sur le document.
  if (debourCents > 0) {
    breakdown = breakdown.map(v => ({ ...v }));
    const zeroGroup = breakdown.find(v => !(Number(v.rate) > 0));
    if (zeroGroup) {
      zeroGroup.base_cents = Number(zeroGroup.base_cents || 0) + debourCents;
    } else {
      breakdown.push({ rate: 0, base_cents: debourCents, vat_cents: 0, exemption_text: DEBOURS_EXEMPTION_TEXT });
    }
  }
  // v8.62 — Régime marge (art. 297 A CGI = art. 313 directive 2006/112) : les
  // lignes exonérées sortent en catégorie TVA "E". EN16931 BR-E-10 impose un
  // motif d'exonération (BT-120 texte + BT-121 code) et BR-CL-22 impose que le
  // code appartienne à la LISTE CEF VATEX. Or "VATEX-FR-F" (cas AFNOR n°33)
  // N'EST PAS dans la liste CEF → rejet 213 (BR-CL-22). Le code CEF correct
  // pour le régime de marge « biens d'occasion » est VATEX-EU-F.
  const MARGIN_EXEMPTION_TEXT = "Régime particulier - Biens d'occasion (art. 297 A du CGI)";
  const MARGIN_EXEMPTION_CODE = "VATEX-EU-F";
  const vatBlocks = breakdown.map((v) => {
    const isExempt = !(Number(v.rate) > 0);
    // v8.68 — Un groupe peut porter son propre motif (débours). À défaut, le
    // motif exonéré du document reste celui du régime de marge. Le code VATEX
    // n'accompagne que ce dernier : aucun code CEF ne couvre les débours, et
    // BR-E-10 se satisfait du texte seul.
    const exemptionText = v.exemption_text || MARGIN_EXEMPTION_TEXT;
    const exemptionCode = v.exemption_text ? "" : MARGIN_EXEMPTION_CODE;
    // Ordre des éléments imposé par le XSD CII (TradeTaxType) :
    // CalculatedAmount, TypeCode, ExemptionReason, BasisAmount, CategoryCode,
    // ExemptionReasonCode, RateApplicablePercent.
    return `
    <ram:ApplicableTradeTax>
      <ram:CalculatedAmount>${(v.vat_cents / 100).toFixed(2)}</ram:CalculatedAmount>
      <ram:TypeCode>VAT</ram:TypeCode>${isExempt ? `
      <ram:ExemptionReason>${x(exemptionText)}</ram:ExemptionReason>` : ""}
      <ram:BasisAmount>${(v.base_cents / 100).toFixed(2)}</ram:BasisAmount>
      <ram:CategoryCode>${isExempt ? "E" : "S"}</ram:CategoryCode>${isExempt && exemptionCode ? `
      <ram:ExemptionReasonCode>${exemptionCode}</ram:ExemptionReasonCode>` : ""}
      <ram:RateApplicablePercent>${Number(v.rate).toFixed(2)}</ram:RateApplicablePercent>
    </ram:ApplicableTradeTax>`;
  }).join("");

  // Pour un avoir : référence à la facture d'origine via BillingReferencedDocument
  let billingRefBlock = "";
  if (cfg.lineType === "credit_note" && doc.invoice_id) {
    // On a déjà fait la requête lines, on n'a pas la facture source ici ;
    // mais on a son numéro via client_snapshot ? Non : on stocke l'id seulement.
    // Astuce : on met l'id pour traçabilité (la facture sera retrouvée côté DGFiP via num).
    billingRefBlock = `<ram:BillingReferencedDocument><ram:IssuerAssignedID>${x(doc.invoice_id)}</ram:IssuerAssignedID></ram:BillingReferencedDocument>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <!-- v8.48.27 — Mode de facturation Chorus Pro requis par BR-FR-08.
         S1 = Service simple (cas standard). Autres valeurs possibles :
         B1/B2/B4/B7/B8/B9 (biens), S1/S2/S3/S4/S5/S6/S7/S8/S9 (services),
         M1/M2/M4/M8/M9 (mixte). -->
    <ram:BusinessProcessSpecifiedDocumentContextParameter>
      <ram:ID>S1</ram:ID>
    </ram:BusinessProcessSpecifiedDocumentContextParameter>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>${cfg.profile}</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${x(doc.number)}</ram:ID>
    <ram:TypeCode>${cfg.typeCode}</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${dt(doc.issue_date)}</udt:DateTimeString>
    </ram:IssueDateTime>
    <!-- v8.48.24 — Mentions obligatoires FR (BR-FR-05/BT-22) requises par
         SUPER PDP / AFNOR. Sinon la validation lève des warnings bloquants.
         PMT : frais de recouvrement forfaitaires (Art. D. 441-5 Code de commerce)
         PMD : pénalités de retard (Art. L. 441-10 Code de commerce)
         DEP : indemnité forfaitaire d'escompte (Art. L. 441-10) -->
    <ram:IncludedNote>
      <ram:Content>En cas de retard de paiement, une indemnité forfaitaire de 40 € pour frais de recouvrement est due (Art. D. 441-5 du Code de commerce).</ram:Content>
      <ram:SubjectCode>PMT</ram:SubjectCode>
    </ram:IncludedNote>
    <ram:IncludedNote>
      <ram:Content>Tout retard de paiement entraîne l'application de pénalités égales à trois fois le taux d'intérêt légal en vigueur, sans qu'un rappel soit nécessaire (Art. L. 441-10 du Code de commerce).</ram:Content>
      <ram:SubjectCode>PMD</ram:SubjectCode>
    </ram:IncludedNote>
    <ram:IncludedNote>
      <ram:Content>Aucun escompte n'est accordé en cas de paiement anticipé.</ram:Content>
      <ram:SubjectCode>AAB</ram:SubjectCode>
    </ram:IncludedNote>
    ${cs.client_type === "individual" ? `<!-- v8.48.29 — Note BAR=B2C obligatoire selon doc SUPER PDP pour les factures particulier -->
    <ram:IncludedNote>
      <ram:Content>B2C</ram:Content>
      <ram:SubjectCode>BAR</ram:SubjectCode>
    </ram:IncludedNote>` : ""}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    ${(() => {
      // v8.48.30 — EN16931 exige IncludedSupplyChainTradeLineItem pour chaque
      // ligne de facture. BASIC WL ne l'imposait pas ; EN16931 oui.
      return (lines || []).map((l, i) => {
        const qty = Number(l.quantity ?? 1);
        // v8.61.3 — Fix règle EN16931 "Value of '@unitCode' is not allowed".
        // Le unitCode DOIT être un code UN/ECE Rec 20 valide. Les factures
        // natives IOBILL laissaient passer la saisie libre ("u", "pièce", "h"…)
        // directement en unitCode → invalide (le Schematron EN16931 vérifie
        // contre la liste officielle → rejet SUPER PDP B2B).
        // On mappe les libellés courants FR/libres vers leur code UN/ECE, et
        // on retombe sur C62 (unité/pièce) si l'unité n'est pas reconnue.
        const unit = mapUnitCode(l.unit);
        const unitPriceC = Number(l.unit_price_ht_cents ?? 0);
        const lineHtC = Number(l.line_ht_cents ?? Math.round(unitPriceC * qty));
        const rate = Number(l.vat_rate ?? 20);
        // v8.118 — Le PDF visuel affiche la désignation en multi-lignes, mais dans
        // le XML on aplatit les retours à la ligne (espace) : ram:Name doit rester
        // une chaîne simple pour les validateurs EN16931.
        const desc = x(String(l.description || ("Ligne " + (i + 1))).replace(/\r?\n+/g, " ").trim());
        return `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${i + 1}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${desc}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${(unitPriceC / 100).toFixed(2)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${x(unit)}">${qty}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>${rate > 0 ? "" : `
          <ram:ExemptionReason>${x(MARGIN_EXEMPTION_TEXT)}</ram:ExemptionReason>`}
          <ram:CategoryCode>${rate > 0 ? "S" : "E"}</ram:CategoryCode>${rate > 0 ? "" : `
          <ram:ExemptionReasonCode>${MARGIN_EXEMPTION_CODE}</ram:ExemptionReasonCode>`}
          <ram:RateApplicablePercent>${rate.toFixed(2)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${(lineHtC / 100).toFixed(2)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
      }).join("");
    })()}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${supplierName}</ram:Name>
        ${(() => {
          // v8.48.27 — BR-FR-10 : AFNOR exige SIREN (9 chiffres) avec
          // schemeID="0002" pour le vendeur, même si techniquement 0002=SIRET
          // dans ISO 6523. On extrait toujours les 9 premiers chiffres.
          const raw = String(co.siret || "").replace(/\s/g, "");
          const siren = raw.length === 14 ? raw.slice(0, 9) : (raw.length === 9 ? raw : null);
          if (siren) {
            return `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${x(siren)}</ram:ID></ram:SpecifiedLegalOrganization>`;
          }
          return "";
        })()}
        <ram:PostalTradeAddress>
          ${tagIf("PostcodeCode", co.postal_code)}
          ${tagIf("LineOne", co.address_line1)}
          ${tagIf("LineTwo", co.address_line2)}
          ${tagIf("CityName", co.city)}
          <ram:CountryID>${x(iso2Country(co.country))}</ram:CountryID>
        </ram:PostalTradeAddress>
        <!-- v8.60.4 — BR-FR-13/BT-34 : URIUniversalCommunication vendeur.
             Restauration du patch v8.55 écrasé par ZIP consolidé postérieur.
             Scheme officiel FR 2026 = 0225 (AFNOR XP Z12-014). C'est l'adresse
             d'annuaire PPF où le vendeur reçoit ses statuts de cycle de vie.
             Priorité : co.peppol_address (override sandbox / cas spéciaux)
             puis SIREN par défaut (fallback prod standard). Ultime : email EM.
             Ancien code v8.48.29 utilisait 0009 (Peppol historique) : rejeté
             par la réforme française 2026 et par le routeur SUPER PDP. -->
        ${(() => {
          const ppf = co.peppol_address ? String(co.peppol_address).trim() : "";
          if (ppf) {
            return `<ram:URIUniversalCommunication><ram:URIID schemeID="0225">${x(ppf)}</ram:URIID></ram:URIUniversalCommunication>`;
          }
          const rawSiret = String(co.siret || "").replace(/\s/g, "");
          const siren = rawSiret.length === 14 ? rawSiret.slice(0, 9) : (rawSiret.length === 9 ? rawSiret : null);
          if (siren) {
            return `<ram:URIUniversalCommunication><ram:URIID schemeID="0225">${x(siren)}</ram:URIID></ram:URIUniversalCommunication>`;
          }
          return `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${x(co.email || "contact@iobill.online")}</ram:URIID></ram:URIUniversalCommunication>`;
        })()}
        ${co.vat_number ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${x(co.vat_number)}</ram:ID></ram:SpecifiedTaxRegistration>` : ""}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${buyerName}</ram:Name>
        ${(() => {
          // v8.48.27 — Idem BR-FR : SIREN 9 chiffres pour l'acheteur.
          const raw = String(cs.siret || "").replace(/\s/g, "");
          const siren = raw.length === 14 ? raw.slice(0, 9) : (raw.length === 9 ? raw : null);
          if (siren) {
            return `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${x(siren)}</ram:ID></ram:SpecifiedLegalOrganization>`;
          }
          return "";
        })()}
        <ram:PostalTradeAddress>
          ${tagIf("PostcodeCode", cs.postal_code)}
          ${tagIf("LineOne", cs.address_line1)}
          ${tagIf("LineTwo", cs.address_line2)}
          ${tagIf("CityName", cs.city)}
          <ram:CountryID>${x(iso2Country(cs.country))}</ram:CountryID>
        </ram:PostalTradeAddress>
        <!-- v8.60.4 — BR-FR-12/BT-49 : URIUniversalCommunication acheteur.
             Restauration du patch v8.55 écrasé par ZIP consolidé postérieur.
             Scheme officiel FR 2026 = 0225 (AFNOR XP Z12-014). C'est l'adresse
             d'annuaire PPF où la facture doit être livrée. Sans elle correctement
             renseignée, le PPF/PDP ne peut pas router la facture au destinataire.
             B2B : priorité cs.peppol_address (override sandbox / cas spéciaux)
             puis SIREN par défaut (fallback prod standard).
             B2C (particulier) : schemeID="EM" avec email (circuit e-reporting).
             Ancien code v8.48.29 utilisait 0009 (Peppol historique) : rejeté
             par la réforme française 2026 et par le routeur SUPER PDP. -->
        ${(() => {
          const isB2C = cs.client_type === "individual";
          if (isB2C) {
            const email = cs.email || cs.contact_email || "particulier@iobill.online";
            return `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${x(email)}</ram:URIID></ram:URIUniversalCommunication>`;
          }
          const ppf = cs.peppol_address ? String(cs.peppol_address).trim() : "";
          if (ppf) {
            return `<ram:URIUniversalCommunication><ram:URIID schemeID="0225">${x(ppf)}</ram:URIID></ram:URIUniversalCommunication>`;
          }
          const rawSiret = String(cs.siret || "").replace(/\s/g, "");
          const siren = rawSiret.length === 14 ? rawSiret.slice(0, 9) : (rawSiret.length === 9 ? rawSiret : null);
          if (siren) {
            return `<ram:URIUniversalCommunication><ram:URIID schemeID="0225">${x(siren)}</ram:URIID></ram:URIUniversalCommunication>`;
          }
          // Fallback si aucun SIREN : email formel (peut re-déclencher B2C mais BR-FR-12 exige BT-49)
          return `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${x(cs.email || "client@iobill.online")}</ram:URIID></ram:URIUniversalCommunication>`;
        })()}
        ${cs.vat_number ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${x(cs.vat_number)}</ram:ID></ram:SpecifiedTaxRegistration>` : ""}
      </ram:BuyerTradeParty>
      ${billingRefBlock}
    </ram:ApplicableHeaderTradeAgreement>
    <!-- v8.61.3 — Fix règle PEPPOL-EN16931-R008 : "Document MUST not contain
         empty elements". L'élément ApplicableHeaderTradeDelivery était auto-fermant
         (vide), ce qui violait la règle Schematron EN16931 → rejet SUPER PDP côté
         B2B (le B2C tolérait, pas le B2B). Le XSD EN16931 EXIGE néanmoins la
         présence de l'élément → on le remplit avec la date de livraison effective
         (= date de livraison si dispo, sinon date d'émission). Satisfait XSD ET
         Schematron simultanément (validé contre les schémas officiels FNFE-MPE). -->
    <ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime><udt:DateTimeString format="102">${dt(doc.delivery_date || doc.issue_date)}</udt:DateTimeString></ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${cur}</ram:InvoiceCurrencyCode>
      ${vatBlocks}${debourCents > 0 ? `
      <ram:SpecifiedTradeAllowanceCharge>
        <ram:ChargeIndicator><udt:Indicator>true</udt:Indicator></ram:ChargeIndicator>
        <ram:ActualAmount>${(debourCents / 100).toFixed(2)}</ram:ActualAmount>
        <ram:Reason>${x(DEBOURS_REASON)}</ram:Reason>
        <ram:CategoryTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>E</ram:CategoryCode>
          <ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>
        </ram:CategoryTradeTax>
      </ram:SpecifiedTradeAllowanceCharge>` : ""}
      <ram:SpecifiedTradePaymentTerms>
        <ram:Description>${x(doc.payment_terms || "Paiement à réception de la facture")}</ram:Description>${doc.due_date ? `
        <ram:DueDateDateTime><udt:DateTimeString format="102">${dt(doc.due_date)}</udt:DateTimeString></ram:DueDateDateTime>` : ""}
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${(doc.subtotal_ht_cents / 100).toFixed(2)}</ram:LineTotalAmount>${debourCents > 0 ? `
        <ram:ChargeTotalAmount>${(debourCents / 100).toFixed(2)}</ram:ChargeTotalAmount>` : ""}
        <ram:TaxBasisTotalAmount>${((doc.subtotal_ht_cents + debourCents) / 100).toFixed(2)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${cur}">${(doc.vat_total_cents / 100).toFixed(2)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${((doc.total_ttc_cents + debourCents) / 100).toFixed(2)}</ram:GrandTotalAmount>
        ${(() => {
          // Règle BR-CO-16 : DuePayable = GrandTotal − TotalPrepaid (+ Rounding),
          // toujours ≥ 0. Si la facture est soldée, TotalPrepaid = GrandTotal
          // et DuePayable = 0. Le plafonnement reste par sécurité.
          //
          // v8.68 — Le GrandTotal inclut maintenant les débours (charge document
          // ci-dessus), donc paid_cents, qui les contenait déjà, ne le dépasse
          // plus : c'est ce décalage que le plafond v8.57.13 masquait, au prix
          // d'un montant dû amputé du débours.
          const grandTotal = doc.total_ttc_cents + debourCents;
          const paidRaw = doc.paid_cents || 0;
          const prepaidCents = Math.min(paidRaw, grandTotal); // plafonné
          const dueCents = Math.max(0, grandTotal - prepaidCents);
          const blocks = [];
          if (prepaidCents > 0) {
            blocks.push(`<ram:TotalPrepaidAmount>${(prepaidCents / 100).toFixed(2)}</ram:TotalPrepaidAmount>`);
          }
          blocks.push(`<ram:DuePayableAmount>${(dueCents / 100).toFixed(2)}</ram:DuePayableAmount>`);
          return blocks.join("\n        ");
        })()}
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}

// ═══════════════════════════════════════════════════════════
// TRANSMISSION PDP
// ═══════════════════════════════════════════════════════════
async function transmitToPdp({ provider, accountId, apiKey, doc, docType, company }) {
  switch (provider) {
    case "ppf_test":
      return {
        transmission_id: "PPF-TEST-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        message: "Transmission test (PPF sandbox DGFiP) - aucun envoi réel"
      };
    case "iopole":
      throw new Error("Provider Iopole : intégration prévue en V1.2");
    case "generix":
      throw new Error("Provider Generix : intégration prévue en V1.2");
    case "cegid":
      throw new Error("Provider Cegid : intégration prévue en V1.2");
    default:
      throw new Error("Provider PDP inconnu : " + provider);
  }
}
