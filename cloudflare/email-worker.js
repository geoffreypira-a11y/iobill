// IO BILL - Cloudflare Email Worker
// Forwarde les emails entrants sur *@inbox.iobill.fr vers /api/inbox-purchase
//
// DEPLOIEMENT :
// 1. Crée un domaine inbox.iobill.fr (ou sous-domaine de ton domaine principal)
// 2. Active Cloudflare Email Routing sur ce domaine
// 3. Crée une "catch-all" rule -> Send to a Worker -> Selectionne ce script
// 4. Définis les variables d'environnement (Workers > Settings > Variables) :
//      INBOX_SECRET     = meme valeur que la var Vercel
//      IOBILL_ENDPOINT  = https://iobill.fr/api/inbox-purchase
//
// LIMITES :
// - Cloudflare Email Workers : taille max 10 MB par message
// - Pour des PJ plus lourdes : utiliser .forward() vers un script de stockage R2

export default {
  async email(message, env, ctx) {
    const to = message.to;
    const from = message.from;
    const subject = message.headers.get("subject") || "";
    const messageId = message.headers.get("message-id") || "";

    // 1) Lire le contenu raw du mail
    const raw = await streamToString(message.raw);

    // 2) Parser les attachments via une mini-lib MIME
    //    Cloudflare ne fournit pas de parser MIME natif. On utilise mailparser-style
    //    via la lib postal-mime (~50 KB, compatible Worker).
    let parsed;
    try {
      const PostalMime = (await import("postal-mime")).default;
      parsed = await PostalMime.parse(raw);
    } catch (e) {
      console.error("MIME parse failed:", e);
      return message.setReject("MIME parsing failed");
    }

    const attachments = (parsed.attachments || [])
      .filter((a) => a.content && a.content.byteLength > 0)
      .map((a) => ({
        filename: a.filename || "attachment",
        mime: a.mimeType || "application/octet-stream",
        content_b64: bufferToBase64(a.content)
      }));

    if (attachments.length === 0) {
      // Pas d'attachement => on ne process pas (mais on log cote Vercel quand meme)
      console.log("No attachments, skipping body content");
    }

    // 3) Forward vers Vercel
    const r = await fetch(env.IOBILL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-IO-INBOX-SECRET": env.INBOX_SECRET
      },
      body: JSON.stringify({
        to,
        from,
        subject,
        message_id: messageId,
        attachments
      })
    });

    if (!r.ok) {
      console.error("Forward failed:", r.status, await r.text());
      return message.setReject("Internal forward error");
    }

    const j = await r.json().catch(() => ({}));
    console.log("Forwarded:", to, "→", j);
  }
};

async function streamToString(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  // Concatenation des chunks Uint8Array
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(out);
}

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
