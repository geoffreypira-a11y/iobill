import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { useTableSort, SortableTh, sortRows } from "../../components/TableSort.jsx";
import { subscribe } from "../../lib/realtime.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate, daysUntil } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";
import { QUOTE_STATUSES, quoteStatusBadge, isQuoteExpired } from "./quoteHelpers.js";
import { SkeletonTable } from "../../components/Skeleton.jsx";
import { QuoteEditorModal } from "./QuoteEditorModal.jsx";
import { ConfirmModal } from "../../components/ConfirmModal.jsx";
import { DocumentPreviewModal } from "../../components/DocumentPreviewModal.jsx";
import { capture } from "../../lib/telemetry.js";

export function QuotesListPage({ token, company }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  // v8.53 — Tri par colonne, date d'émission décroissante par défaut.
  const { sort, toggleSort } = useTableSort("iobill:quotes:sort", { key: "issue_date", dir: "desc" });

  // Modale d'édition : null = fermée, "new" = création, objet quote = édition
  const [editModal, setEditModal] = useState(null);
  // Modale de confirmation suppression : null ou { id, label }
  const [pendingDelete, setPendingDelete] = useState(null);
  // Modale de confirmation conversion en facture : null ou quote
  const [pendingConvert, setPendingConvert] = useState(null);
  // Action en cours (pour disable boutons)
  const [actionLoading, setActionLoading] = useState(null);
  // Notification de succès (toast simple)
  const [toast, setToast] = useState(null);
  // Versions de devis depliees (root_quote_id du groupe ouvert)
  const [expandedRoots, setExpandedRoots] = useState(new Set());
  // Menu kebab : null ou { id, x, y } pour position fixed
  const [openMenu, setOpenMenu] = useState(null);
  // Modale de preview PDF : null ou objet devis
  const [previewQuote, setPreviewQuote] = useState(null);

  // Fermer le menu kebab si on clique en dehors ou si on scroll
  useEffect(() => {
    function close() { setOpenMenu(null); }
    if (openMenu) {
      const t = setTimeout(() => {
        document.addEventListener("click", close);
        window.addEventListener("scroll", close, true);
        window.addEventListener("resize", close);
      }, 50);
      return () => {
        clearTimeout(t);
        document.removeEventListener("click", close);
        window.removeEventListener("scroll", close, true);
        window.removeEventListener("resize", close);
      };
    }
  }, [openMenu]);

  // Auto-ouverture modale si ?new=1
  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setEditModal("new");
      // Clean l'URL
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // ─── Chargement ─────
  // silent=true : refresh en arriere-plan, pas de "loading", pas de re-render
  // si rien n'a change (compare ids + status).
  async function refreshQuotes(silent = false) {
    if (!silent) setLoading(true);
    const list = await sb.select(token, "quotes", {
      filter: `company_id=eq.${company.id}`,
      order: "created_at.desc",
      limit: 200
    });
    const newList = list || [];
    if (silent) {
      // Compare avant de setState pour eviter re-render inutile
      setQuotes((prev) => {
        if (prev.length !== newList.length) return newList;
        for (let i = 0; i < newList.length; i++) {
          if (prev[i]?.id !== newList[i].id) return newList;
          if (prev[i]?.status !== newList[i].status) return newList;
          if (prev[i]?.signed_at !== newList[i].signed_at) return newList;
          if (prev[i]?.refused_at !== newList[i].refused_at) return newList;
        }
        return prev;
      });
    } else {
      setQuotes(newList);
      setLoading(false);
    }
  }

  // Chargement initial + Realtime WebSocket + fallback polling
  useEffect(() => {
    let alive = true;
    let timer = null;
    refreshQuotes(false);

    // Realtime : reaction <1s aux INSERT/UPDATE/DELETE
    const unsubscribe = subscribe(
      token,
      "quotes",
      `company_id=eq.${company.id}`,
      () => { if (alive) refreshQuotes(true); }
    );

    // Fallback : polling 60s (au cas ou WS lache)
    timer = setInterval(() => { if (alive) refreshQuotes(true); }, 60000);

    function onVisibility() {
      if (alive && document.visibilityState === "visible") refreshQuotes(true);
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [token, company.id]);

  // ─── Filtres ─────
  // v8.199 — Tout l'écran raisonne désormais par CHAÎNE de versions, plus par
  // ligne de table. Le tableau n'a jamais affiché qu'une ligne par chaîne — la
  // dernière version — mais les compteurs, eux, dénombraient les lignes en
  // base. D'où « Tous (14) » au-dessus d'un tableau de dix lignes, et
  // « Envoyé (12) » pour huit lignes envoyées.
  //
  // Une chaîne vaut ce que vaut sa dernière version : les précédentes ont été
  // remplacées. C'est vrai du compte comme du total en attente de signature.
  const chaines = useMemo(() => {
    const parRacine = new Map();
    for (const q of quotes) {
      const rootId = q.root_quote_id || q.id;
      if (!parRacine.has(rootId)) parRacine.set(rootId, []);
      parRacine.get(rootId).push(q);
    }
    const result = [];
    for (const [rootId, versions] of parRacine) {
      versions.sort((a, b) => (b.version || 1) - (a.version || 1));
      result.push({
        rootId,
        latest: versions[0],
        versions,
        hasMultipleVersions: versions.length > 1
      });
    }
    return result;
  }, [quotes]);

  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    return chaines.filter((g) => {
      // La recherche accepte le numéro de N'IMPORTE quelle version : on cherche
      // souvent une chaîne à partir du numéro qu'on a sous les yeux, qui peut
      // être celui d'une version remplacée depuis.
      const matchS = !s || g.versions.some((q) =>
        (q.number || "").toLowerCase().includes(s)
        || snapshotDisplayName(q.client_snapshot).toLowerCase().includes(s)
      );
      const eff = isQuoteExpired(g.latest) ? "expired" : g.latest.status;
      const matchF = statusFilter === "all" || eff === statusFilter;
      return matchS && matchF;
    });
  }, [chaines, search, statusFilter]);

  const counts = useMemo(() => {
    const c = { all: chaines.length };
    Object.keys(QUOTE_STATUSES).forEach((k) => { c[k] = 0; });
    chaines.forEach((g) => {
      const eff = isQuoteExpired(g.latest) ? "expired" : g.latest.status;
      c[eff] = (c[eff] || 0) + 1;
    });
    return c;
  }, [chaines]);

  // v8.199 — « En attente de signature » additionnait TOUTES les versions à
  // plat. Un devis révisé deux fois pesait trois fois dans le total, et une
  // chaîne finalement convertie en facture continuait de l'alimenter par ses
  // versions antérieures, restées au statut « envoyé ».
  //
  // Seule la dernière version d'une chaîne représente une proposition vivante :
  // les précédentes ont été remplacées, elles n'attendent plus rien. Et si
  // cette dernière version est convertie, signée, refusée ou expirée, la
  // chaîne entière sort du total — ce qui règle le cas des devis convertis
  // sans avoir à les traiter à part.
  const totalPending = useMemo(
    () => chaines.reduce((total, g) => {
      const q = g.latest;
      const enAttente = q.status === "sent" && !isQuoteExpired(q);
      return enAttente ? total + (q.total_ttc_cents || 0) : total;
    }, 0),
    [chaines]
  );

  // Nombre de propositions distinctes — une chaîne de versions compte pour un.
  // L'en-tête annonçait le nombre de lignes en base (14 sur la capture du
  // 21/09) alors que le tableau en affiche dix : il ne montre que la dernière
  // version de chaque chaîne. Les deux chiffres parlent maintenant de la même
  // chose.


  // ─── Groupement par root_quote_id (versions imbriquees facon arborescence) ─────
  // On ne montre que la DERNIERE version de chaque arbre, et un bouton expand
  // pour voir les versions precedentes.
  const grouped = useMemo(() => {
    // v8.199 — `filtered` porte déjà des chaînes constituées : il ne reste
    // qu'à les trier.
    const result = filtered;
    // v8.53 — Tri par la colonne choisie, appliqué à la version la plus
    // récente de chaque groupe (c'est elle qui est affichée sur la ligne).
    const valueOf = (g, key) => {
      const q = g.latest;
      switch (key) {
        case "number":     return q.number || "";
        case "client":     return snapshotDisplayName(q.client_snapshot).toLowerCase();
        case "expires_at": return q.expires_at || "";
        case "amount":     return q.total_ttc_cents ?? 0;
        case "status":     return QUOTE_STATUSES[isQuoteExpired(q) ? "expired" : q.status]?.order ?? 99;
        default:           return q.issue_date || "";
      }
    };
    return sortRows(result, sort, valueOf, (g) => g.latest.number || "");
  }, [filtered, sort]);

  function toggleExpand(rootId) {
    setExpandedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  }

  // ─── Toast helper ─────
  function showToast(msg, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  // ─── Sauvegarde depuis modale ─────
  function onSavedFromModal(savedQuote) {
    setQuotes((prev) => {
      const exists = prev.find((q) => q.id === savedQuote.id);
      if (exists) return prev.map((q) => (q.id === savedQuote.id ? savedQuote : q));
      return [savedQuote, ...prev];
    });
    setEditModal(null);
    showToast(`Devis ${savedQuote.number} enregistré`);
  }

  // ─── Actions sur ligne ─────
  async function sendQuote(q) {
    if (q.status !== "draft" && q.status !== "sent") {
      showToast("Ce devis ne peut plus être envoyé (statut : " + q.status + ")", "error");
      return;
    }
    setActionLoading(`send-${q.id}`);
    try {
      const r = await fetch("/api/send-document", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ document_type: "quote", document_id: q.id })
      });
      const j = await r.json();
      if (!r.ok) {
        throw new Error(j.error || "Erreur d'envoi");
      }
      capture("quote_sent", { quote_id: q.id });
      // Refresh pour récupérer le statut "sent" mis à jour
      await refreshQuotes();
      showToast(`Devis envoyé à ${j.recipient}${j.pdf_attached ? " (PDF joint)" : ""}`);
    } catch (e) {
      showToast(e.message, "error");
    }
    setActionLoading(null);
  }

  // v8.49 — Rendre un devis "actif" sans passer par l'email.
  // L'espace client n'affiche que les devis transmis : tant qu'un devis reste
  // en brouillon, le client ne le voit pas. Cette action le déclare envoyé,
  // exactement comme le ferait un envoi par email ou le partage du lien.
  async function markQuoteSent(q) {
    if (q.status !== "draft") return;
    if (!confirm(
      `Marquer le devis ${q.number} comme envoyé ?\n\n`
      + "Il devient visible et signable dans l'espace client.\n"
      + "Un devis envoyé ne peut plus être supprimé (vous pourrez toujours le "
      + "modifier ou en créer une nouvelle version)."
    )) return;
    setActionLoading(`markSent-${q.id}`);
    try {
      // Repli si la colonne sent_at n'existe pas encore (migration v8.50) :
      // le statut prime, c'est lui qui rend le devis visible côté client.
      let updated = await sb.update(token, "quotes", `id=eq.${q.id}`, {
        status: "sent",
        sent_at: new Date().toISOString()
      });
      if (!updated || !updated[0]) {
        updated = await sb.update(token, "quotes", `id=eq.${q.id}`, { status: "sent" });
      }
      if (!updated || !updated[0]) throw new Error("Erreur lors du changement de statut");
      await refreshQuotes();
      showToast("Devis marqué comme envoyé — il apparaît dans l'espace client");
    } catch (e) {
      showToast(e.message || "Erreur", "error");
    }
    setActionLoading(null);
  }

  function previewPdf(q) {
    // Ouvre la modale d'apercu PDF (pattern IOcar PrintDoc)
    setPreviewQuote(q);
  }

  async function shareLink(q) {
    setActionLoading(`share-${q.id}`);
    try {
      const r = await fetch("/api/public?op=share", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ scope: "quote", resource_id: q.id, expires_in_days: 90 })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Erreur");
      if (j.public_url) {
        try { await navigator.clipboard.writeText(j.public_url); } catch {}
        // v8.49 — partager le lien fait passer le devis en "Envoyé" : il devient
        // visible et signable depuis l'espace client.
        if (j.status_changed === "sent") await refreshQuotes();
        showToast(j.status_changed === "sent"
          ? "Lien copié — le devis passe en « Envoyé » et apparaît dans l'espace client"
          : "Lien copié dans le presse-papiers !");
      }
    } catch (e) {
      showToast(e.message, "error");
    }
    setActionLoading(null);
  }

  async function createVersion(q) {
    setActionLoading(`v2-${q.id}`);
    try {
      const r = await fetch("/api/quote-version", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ quote_id: q.id })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Erreur création version");
      await refreshQuotes();
      showToast(`Nouvelle version ${j.new_quote_number} créée (v${j.version})`);
      // Recharge le nouveau devis et l'ouvre pour édition
      if (j.new_quote_id) {
        const newQ = await sb.selectOne(token, "quotes", `id=eq.${j.new_quote_id}`);
        if (newQ) setEditModal(newQ);
      }
    } catch (e) {
      showToast(e.message, "error");
    }
    setActionLoading(null);
  }

  async function convertToInvoice(q) {
    setActionLoading(`convert-${q.id}`);
    try {
      // Create invoice from quote (côté frontend pour simplicité)
      const number = await sb.rpc(token, "allocate_document_number", {
        p_company_id: company.id,
        p_doc_type: "invoice"
      });
      const today = new Date().toISOString().slice(0, 10);
      const due = new Date();
      due.setDate(due.getDate() + (company.payment_terms_days || 30));
      const invoicePayload = {
        company_id: company.id,
        client_id: q.client_id,
        client_snapshot: q.client_snapshot,
        company_snapshot: q.company_snapshot,
        issue_date: today,
        due_date: due.toISOString().slice(0, 10),
        subtotal_ht_cents: q.subtotal_ht_cents,
        vat_total_cents: q.vat_total_cents,
        total_ttc_cents: q.total_ttc_cents,
        currency: q.currency,
        vat_category: q.vat_category,
        vat_legal_mention: q.vat_legal_mention,
        notes: q.notes,
        terms: q.terms,
        number,
        status: "draft",
        quote_id: q.id
      };
      const created = await sb.insert(token, "invoices", invoicePayload);
      const newInvoice = created?.[0];
      if (!newInvoice) throw new Error("Création facture échouée");

      // Copier les lignes
      const quoteLines = await sb.select(token, "document_lines", {
        filter: `document_type=eq.quote&document_id=eq.${q.id}`,
        order: "sort_order.asc"
      });
      if (quoteLines && quoteLines.length > 0) {
        const invoiceLines = quoteLines.map((l, idx) => ({
          company_id: company.id,
          document_type: "invoice",
          document_id: newInvoice.id,
          sort_order: idx,
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          unit_price_ht_cents: l.unit_price_ht_cents,
          vat_rate: l.vat_rate,
          discount_pct: l.discount_pct,
          line_ht_cents: l.line_ht_cents,
          line_vat_cents: l.line_vat_cents,
          line_ttc_cents: l.line_ttc_cents
        }));
        await sb.insert(token, "document_lines", invoiceLines);
      }

      // Marquer le devis comme converti
      await sb.update(token, "quotes", `id=eq.${q.id}`, {
        status: "converted",
        converted_invoice_id: newInvoice.id
      });
      await refreshQuotes();
      capture("quote_converted", { quote_id: q.id, invoice_id: newInvoice.id });
      showToast(`Facture ${newInvoice.number} créée !`);
      setPendingConvert(null);
    } catch (e) {
      showToast(e.message || "Erreur conversion", "error");
    }
    setActionLoading(null);
  }

  // v8.200 — Supprimer une version isolée.
  //
  // C'était déjà possible — l'entrée « 🗑 Supprimer » du menu « ⋯ » apparaît
  // sur toute ligne au statut brouillon, version intermédiaire comprise — mais
  // deux choses l'empêchaient de bien se passer.
  //
  // D'abord, `sb.delete` renvoie un booléen que personne ne regardait. Un refus
  // de la base laissait donc la ligne disparaître de l'écran (elle n'était
  // retirée que de l'état local) pour réapparaître au rechargement suivant,
  // sans le moindre message. Le retour est maintenant vérifié.
  //
  // Ensuite, la version précédente continuait de porter un `superseded_by_id`
  // pointant vers le document supprimé. Ce champ n'est lu nulle part
  // aujourd'hui, mais laisser un « remplacé par » qui désigne le vide est le
  // genre de détail qui se paie le jour où on décide de l'afficher.
  async function deleteQuote(id) {
    try {
      const supprime = quotes.find((q) => q.id === id);

      const lignesOk = await sb.delete(token, "document_lines", `document_type=eq.quote&document_id=eq.${id}`);
      if (!lignesOk) throw new Error("Les lignes du devis n'ont pas pu être supprimées");

      const devisOk = await sb.delete(token, "quotes", `id=eq.${id}`);
      if (!devisOk) throw new Error("Le devis n'a pas pu être supprimé");

      // Recoudre la chaîne : la version qui désignait celle-ci comme
      // remplaçante ne remplace plus rien.
      const precedente = quotes.find((q) => q.superseded_by_id === id);
      if (precedente) {
        await sb.update(token, "quotes", `id=eq.${precedente.id}`, { superseded_by_id: null });
      }

      setQuotes((prev) => prev
        .filter((q) => q.id !== id)
        .map((q) => q.superseded_by_id === id ? { ...q, superseded_by_id: null } : q));
      setPendingDelete(null);
      showToast(
        supprime?.version > 1
          ? `Version v${supprime.version} supprimée — les autres versions sont conservées`
          : "Devis supprimé"
      );
    } catch (e) {
      showToast(e.message || "Erreur suppression", "error");
    }
  }

  // ─── Rendu d'une ligne devis (utilise dans le tableau groupe) ─────
  function renderQuoteRow(q, opts = {}) {
    const { isLatest = true, hasMultipleVersions = false, isExpanded = false, totalVersions = 1, onToggleExpand, isChild = false } = opts;
    const expired = isQuoteExpired(q);
    const effectiveStatus = expired ? "expired" : q.status;
    const badge = quoteStatusBadge(effectiveStatus);
    const validity = q.expires_at ? daysUntil(q.expires_at) : null;
    // v8.198 — Un devis ENVOYÉ n'est plus modifiable. Le client en détient une
    // copie : la modifier en silence ferait diverger ce qu'il a reçu de ce que
    // porte l'application, et c'est exactement ce qui se plaide mal quand il
    // revient avec son PDF. Pour le corriger, on crée une nouvelle version —
    // le bouton « Nouvelle version » reste disponible (canVersion ci-dessous).
    const canEdit = !["sent", "signed", "converted", "refused"].includes(q.status);
    const canSend = ["draft", "sent"].includes(q.status);
    // Conversion possible dès le brouillon (à condition de ne pas déjà être converti ou refusé)
    const canConvert = !["converted", "refused"].includes(q.status) && !q.converted_invoice_id;
    const canDelete = q.status === "draft";
    // v8.72 — V2 possible SAUF si le devis est accepté (signed) ou déjà converti :
    // un devis REFUSÉ doit pouvoir être révisé (re-proposition), un devis ACCEPTÉ non.
    const canVersion = !["converted", "signed"].includes(q.status);
    const version = q.version || 1;

    return (
      <tr key={q.id} style={isChild ? { background: "rgba(212,168,67,0.04)" } : null}>
        {/* Colonne expand : chevron si latest avec versions multiples, ⤷ si enfant */}
        <td style={{ textAlign: "center", width: 30 }}>
          {isLatest && hasMultipleVersions ? (
            <button
              onClick={onToggleExpand}
              style={{
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--gold)", fontSize: 12, padding: 4
              }}
              title={isExpanded ? "Masquer les versions" : `Voir les ${totalVersions} versions`}
            >
              {isExpanded ? "▼" : "▶"}
            </button>
          ) : isChild ? (
            <span style={{ color: "var(--muted)", fontSize: 12, paddingLeft: 12 }}>⤷</span>
          ) : null}
        </td>
        <td className="mono" style={isChild ? { paddingLeft: 22, fontSize: 11, color: "var(--muted2)" } : null}>
          {q.number || <span style={{ color: "var(--muted)" }}>—</span>}
          {hasMultipleVersions && isLatest && (
            <span style={{ marginLeft: 8, fontSize: 10, color: "var(--gold)", fontWeight: 600 }}>
              v{version}{totalVersions > 1 ? ` (sur ${totalVersions})` : ""}
            </span>
          )}
          {isChild && (
            <span style={{ marginLeft: 8, fontSize: 10, color: "var(--muted)" }}>
              v{version}
            </span>
          )}
        </td>
        <td style={isChild ? { fontSize: 11, color: "var(--muted2)" } : null}>
          {snapshotDisplayName(q.client_snapshot)}
        </td>
        <td style={isChild ? { fontSize: 11, color: "var(--muted2)" } : null}>{fmtDate(q.issue_date)}</td>
        <td style={{ fontSize: 12, color: q.status === "sent" && validity !== null && validity < 7 ? "var(--orange)" : "var(--muted2)" }}>
          {q.expires_at ? (
            validity > 0 ? `${validity} j` : validity === 0 ? "Aujourd'hui" : "Expiré"
          ) : "—"}
        </td>
        <td className="mono" style={{ textAlign: "right", ...(isChild ? { fontSize: 11, color: "var(--muted2)" } : {}) }}>
          {fmtEUR(q.total_ttc_cents)}
        </td>
        <td><span className={"badge " + badge.cls}>{badge.label}</span></td>
        <td>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "nowrap" }}>
            {/* Bouton principal : Voir (preview PDF) si readonly, sinon Modifier */}
            <button
              className="btn btn-primary btn-sm"
              onClick={() => canEdit ? setEditModal(q) : setPreviewQuote(q)}
              style={{ padding: "5px 12px", fontSize: 11, whiteSpace: "nowrap" }}
              title={canEdit
                ? "Modifier ce devis"
                : q.status === "sent"
                  ? "Devis envoyé — le client en détient une copie. Pour le modifier, créez une nouvelle version."
                  : "Aperçu du devis avec son historique"}
            >
              {canEdit ? "✏️ Modifier" : "👁 Voir"}
            </button>

            {/* Action contextuelle principale selon le statut */}
            {canSend && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => sendQuote(q)}
                disabled={actionLoading === `send-${q.id}`}
                style={{ padding: "5px 10px", fontSize: 11, color: "var(--gold)", borderColor: "rgba(212,168,67,0.4)", whiteSpace: "nowrap" }}
                title="Envoyer le devis par email au client"
              >
                {actionLoading === `send-${q.id}` ? "⏳" : "📧 Envoyer"}
              </button>
            )}
            {canConvert && !canSend && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setPendingConvert(q)}
                disabled={actionLoading === `convert-${q.id}`}
                style={{ padding: "5px 10px", fontSize: 11, color: "var(--green)", borderColor: "rgba(62,207,122,0.4)", whiteSpace: "nowrap" }}
                title="Convertir ce devis en facture"
              >
                🧾 Facturer
              </button>
            )}

            {/* v8.75 — Devis converti : lien direct vers la facture générée */}
            {q.status === "converted" && q.converted_invoice_id && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => navigate(`/invoices?open=${q.converted_invoice_id}`)}
                style={{ padding: "5px 10px", fontSize: 11, color: "var(--gold)", borderColor: "rgba(212,168,67,0.4)", whiteSpace: "nowrap" }}
                title="Ouvrir la facture générée à partir de ce devis"
              >
                🧾 Voir la facture
              </button>
            )}

            {/* Bouton kebab : calcule position et stocke contexte. Menu rendu en portail plus bas. */}
            <button
              className="btn btn-ghost btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                if (openMenu?.id === q.id) {
                  setOpenMenu(null);
                  return;
                }
                const rect = e.currentTarget.getBoundingClientRect();
                setOpenMenu({
                  id: q.id,
                  quote: q,
                  // Position du menu : aligné à droite du bouton, juste en-dessous
                  right: window.innerWidth - rect.right,
                  top: rect.bottom + 4,
                  canConvert, canSend, canVersion, canDelete, version
                });
              }}
              style={{ padding: "5px 8px", fontSize: 14, lineHeight: 1 }}
              title="Plus d'actions"
            >
              ⋯
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">DEVIS</div>
          <div className="page-sub">
            {/* v8.199 — Le résumé ne disait que ce qui reste à signer. Il annonce
                maintenant ce qui a abouti : un devis signé ou converti est un
                devis gagné, c'est le chiffre qu'on cherche en ouvrant l'écran.
                Chaque mention ne s'affiche que si elle vaut quelque chose — un
                « 0 signé » permanent n'apprendrait rien. */}
            {chaines.length} devis
            {(counts.signed || 0) > 0 && (
              <> · {counts.signed} devis signé{counts.signed > 1 ? "s" : ""}</>
            )}
            {(counts.converted || 0) > 0 && (
              <> · {counts.converted} converti{counts.converted > 1 ? "s" : ""} en facture</>
            )}
            {totalPending > 0 && (
              <> · {fmtEUR(totalPending)} en attente de signature</>
            )}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditModal("new")}>
          <Icon name="plus" size={14} /> Nouveau devis
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <input
          className="search-input"
          placeholder="Rechercher numéro, client..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="tabs" style={{ margin: 0 }}>
          <button className={"tab" + (statusFilter === "all" ? " active" : "")} onClick={() => setStatusFilter("all")}>
            Tous ({counts.all})
          </button>
          {Object.entries(QUOTE_STATUSES)
            .sort((a, b) => a[1].order - b[1].order)
            .map(([key, s]) => (
              counts[key] > 0 ? (
                <button
                  key={key}
                  className={"tab" + (statusFilter === key ? " active" : "")}
                  onClick={() => setStatusFilter(key)}
                >
                  {s.label} ({counts[key]})
                </button>
              ) : null
            ))}
        </div>
      </div>

      {loading ? (
        <SkeletonTable rows={6} cols={7} />
      ) : filtered.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>📄</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            {search || statusFilter !== "all" ? "Aucun devis ne correspond" : "Aucun devis pour l'instant"}
          </div>
          {search || statusFilter !== "all" ? (
            <button className="btn btn-ghost" onClick={() => { setSearch(""); setStatusFilter("all"); }}>
              Effacer les filtres
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setEditModal("new")}>
              <Icon name="plus" size={14} /> Créer un devis
            </button>
          )}
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <SortableTh label="N°" sortKey="number" sort={sort} onSort={toggleSort} />
                <SortableTh label="Client" sortKey="client" sort={sort} onSort={toggleSort} />
                <SortableTh label="Émis le" sortKey="issue_date" sort={sort} onSort={toggleSort} />
                <SortableTh label="Validité" sortKey="expires_at" sort={sort} onSort={toggleSort} />
                <SortableTh label="Montant TTC" sortKey="amount" sort={sort} onSort={toggleSort} align="right" />
                <SortableTh label="Statut" sortKey="status" sort={sort} onSort={toggleSort} />
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((group) => {
                const { rootId, latest, versions, hasMultipleVersions } = group;
                const isExpanded = expandedRoots.has(rootId);
                const rows = [];

                // ─── Ligne principale (derniere version) ─────
                rows.push(renderQuoteRow(latest, {
                  isLatest: true,
                  hasMultipleVersions,
                  isExpanded,
                  totalVersions: versions.length,
                  onToggleExpand: () => toggleExpand(rootId)
                }));

                // ─── Lignes des versions precedentes (si deplie) ─────
                if (isExpanded && hasMultipleVersions) {
                  for (let i = 1; i < versions.length; i++) {
                    rows.push(renderQuoteRow(versions[i], { isLatest: false, isChild: true }));
                  }
                }

                return rows;
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Fonction de rendu d'une ligne devis (definie inline pour acceder au closure) */}
      {/* On stocke pas la fonction, on l'inline ici via renderQuoteRow definie en dessous */}

      {/* ─── Modale d'édition ─── */}
      {editModal && (
        <QuoteEditorModal
          token={token}
          company={company}
          quote={editModal === "new" ? null : editModal}
          onClose={() => setEditModal(null)}
          onSaved={onSavedFromModal}
        />
      )}

      {/* ─── Confirmation suppression ─── */}
      {/* v8.200 — La confirmation disait « le devis X ET TOUTES SES LIGNES »,
          ce qui se lit facilement comme « et toutes ses versions » sur un devis
          qui en a plusieurs. On nomme donc explicitement ce qui part et ce qui
          reste : supprimer une révision ne touche pas aux autres. */}
      {pendingDelete && (() => {
        const cible = quotes.find((q) => q.id === pendingDelete.id);
        const racine = cible ? (cible.root_quote_id || cible.id) : null;
        const autresVersions = racine
          ? quotes.filter((q) => (q.root_quote_id || q.id) === racine && q.id !== pendingDelete.id).length
          : 0;
        return (
        <ConfirmModal
          title={autresVersions > 0 ? "Supprimer cette version ?" : "Supprimer ce devis ?"}
          message={autresVersions > 0
            ? `Seule la version ${pendingDelete.label}${cible?.version ? ` (v${cible.version})` : ""} sera supprimée, avec ses lignes. `
              + `${autresVersions === 1 ? "L'autre version est conservée" : `Les ${autresVersions} autres versions sont conservées`}. `
              + "Cette action est irréversible."
            : `Cette action est irréversible. Le devis ${pendingDelete.label} et toutes ses lignes seront supprimés.`}
          confirmLabel="Supprimer"
          confirmType="danger"
          onConfirm={() => deleteQuote(pendingDelete.id)}
          onCancel={() => setPendingDelete(null)}
        />
        );
      })()}

      {/* ─── Confirmation conversion en facture ─── */}
      {pendingConvert && (
        <ConfirmModal
          title="Convertir en facture ?"
          message={`Une nouvelle facture sera créée à partir du devis ${pendingConvert.number} avec les mêmes lignes. Le devis passera au statut "converti".`}
          confirmLabel="Créer la facture"
          confirmType="primary"
          onConfirm={() => convertToInvoice(pendingConvert)}
          onCancel={() => setPendingConvert(null)}
        />
      )}

      {/* ─── Apercu PDF en modale (pattern IOcar PrintDoc) ─── */}
      {previewQuote && (
        <DocumentPreviewModal
          token={token}
          docType="quote"
          doc={previewQuote}
          onClose={() => setPreviewQuote(null)}
          onSend={async (q) => {
            await sendQuote(q);
          }}
        />
      )}

      {/* ─── Menu kebab : rendu en position:fixed pour passer par-dessus la card ─── */}
      {openMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: openMenu.top,
            right: openMenu.right,
            background: "var(--card)",
            border: "1px solid var(--border2)",
            borderRadius: 8,
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            minWidth: 200,
            zIndex: 9999,
            overflow: "hidden"
          }}
        >
          <MenuItem onClick={() => { previewPdf(openMenu.quote); setOpenMenu(null); }}>
            📄 Aperçu PDF
          </MenuItem>
          <MenuItem onClick={() => { shareLink(openMenu.quote); setOpenMenu(null); }}>
            🔗 Copier le lien public
          </MenuItem>
          {openMenu.quote.status === "draft" && (
            <MenuItem
              onClick={() => { markQuoteSent(openMenu.quote); setOpenMenu(null); }}
              style={{ color: "var(--gold)" }}
            >
              ✅ Marquer comme envoyé (espace client)
            </MenuItem>
          )}
          {openMenu.canConvert && openMenu.canSend && (
            <MenuItem
              onClick={() => { setPendingConvert(openMenu.quote); setOpenMenu(null); }}
              style={{ color: "var(--green)" }}
            >
              🧾 Convertir en facture
            </MenuItem>
          )}
          {openMenu.canVersion && (
            <MenuItem onClick={() => { createVersion(openMenu.quote); setOpenMenu(null); }}>
              ↪️ Créer une nouvelle version (v{openMenu.version + 1})
            </MenuItem>
          )}
          {openMenu.canDelete && (
            <>
              <div style={{ height: 1, background: "var(--border2)", margin: "4px 0" }} />
              <MenuItem
                onClick={() => { setPendingDelete({ id: openMenu.quote.id, label: openMenu.quote.number || "ce devis" }); setOpenMenu(null); }}
                style={{ color: "var(--red)" }}
              >
                🗑 Supprimer
              </MenuItem>
            </>
          )}
        </div>
      )}

      {/* ─── Toast ─── */}
      {toast && (
        <div style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          background: toast.type === "error" ? "rgba(229,92,92,0.95)" : "rgba(62,207,122,0.95)",
          color: "#0b0c10",
          padding: "12px 18px",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          zIndex: 500,
          boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
          maxWidth: 400,
          animation: "slideup 0.2s"
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ─── Composant MenuItem reutilisable (pour le menu kebab des actions) ───
function MenuItem({ children, onClick, style = {} }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "10px 14px",
        background: hover ? "var(--card2)" : "transparent",
        border: "none",
        color: "var(--text)",
        fontSize: 12,
        cursor: "pointer",
        fontFamily: "inherit",
        ...style
      }}
    >
      {children}
    </button>
  );
}
