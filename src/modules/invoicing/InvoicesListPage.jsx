import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { subscribe } from "../../lib/realtime.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";
import { INVOICE_STATUSES, invoiceStatusBadge, isInvoiceOverdue } from "./invoiceHelpers.js";
import { SkeletonTable } from "../../components/Skeleton.jsx";
import { InvoiceEditorModal } from "./InvoiceEditorModal.jsx";
import { ConfirmModal } from "../../components/ConfirmModal.jsx";
import { DocumentPreviewModal } from "../../components/DocumentPreviewModal.jsx";
import { capture } from "../../lib/telemetry.js";
import { syncVatCurrentPeriod } from "../../lib/vat-sync.js";
import { NotifBadge } from "../../components/NotifBadge.jsx";
import { useSignalCounts } from "../../lib/useSignalCounts.js";

export function InvoicesListPage({ token, company }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // v8.27.5 — signalements ouverts du cabinet sur chaque facture
  const { byId: signalsByInvoiceId } = useSignalCounts(token, company?.id, "invoice");

  const [editModal, setEditModal] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingIssue, setPendingIssue] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [toast, setToast] = useState(null);
  const [openMenu, setOpenMenu] = useState(null);
  // Modale de preview PDF : null ou objet facture
  const [previewInvoice, setPreviewInvoice] = useState(null);

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

  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setEditModal("new");
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // v8.75 — Ouverture directe de l'aperçu d'une facture via ?open=<id>
  // (lien "Voir la facture" depuis un devis converti). Attend le chargement.
  useEffect(() => {
    const openId = searchParams.get("open");
    if (!openId || invoices.length === 0) return;
    const inv = invoices.find((x) => x.id === openId);
    if (inv) setPreviewInvoice(inv);
    const next = new URLSearchParams(searchParams);
    next.delete("open");
    setSearchParams(next, { replace: true });
  }, [searchParams, invoices, setSearchParams]);

  async function refreshInvoices(silent = false) {
    if (!silent) setLoading(true);
    const list = await sb.select(token, "invoices", {
      filter: `company_id=eq.${company.id}`,
      order: "created_at.desc",
      limit: 300
    });
    const newList = list || [];
    if (silent) {
      setInvoices((prev) => {
        if (prev.length !== newList.length) return newList;
        for (let i = 0; i < newList.length; i++) {
          if (prev[i]?.id !== newList[i].id) return newList;
          if (prev[i]?.status !== newList[i].status) return newList;
          if (prev[i]?.paid_cents !== newList[i].paid_cents) return newList;
          if (prev[i]?.pdp_transmitted_at !== newList[i].pdp_transmitted_at) return newList;
          if (prev[i]?.sent_at !== newList[i].sent_at) return newList;
          if (prev[i]?.facturx_status !== newList[i].facturx_status) return newList;
        }
        return prev;
      });
    } else {
      setInvoices(newList);
      setLoading(false);
    }
  }

  // Chargement initial + Realtime WebSocket + fallback polling
  useEffect(() => {
    let alive = true;
    let timer = null;
    refreshInvoices(false);

    // Realtime : reaction <1s aux INSERT/UPDATE/DELETE
    const unsubscribe = subscribe(
      token,
      "invoices",
      `company_id=eq.${company.id}`,
      () => { if (alive) refreshInvoices(true); }
    );

    // Fallback : polling 60s
    timer = setInterval(() => { if (alive) refreshInvoices(true); }, 60000);

    function onVisibility() {
      if (alive && document.visibilityState === "visible") refreshInvoices(true);
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [token, company.id]);

  // v8.57.6 — Polling automatique DÉSACTIVÉ temporairement.
  //
  // Le polling déclenchait des UPDATE sur invoices via paInvoiceStatus,
  // ce qui réveillait le Realtime Supabase qui refetchait toute la liste,
  // ce qui écrasait le state actionLoading côté client — résultat : le
  // bouton "Transmettre" restait figé et la transmission ne partait pas.
  //
  // Le bouton manuel 🔄 sur chaque facture reste fonctionnel. En attendant
  // v8.58 avec webhook SUPER PDP push (au lieu du polling), utiliser le
  // bouton manuel pour rafraîchir le statut d'une facture précise.
  //
  // Ref garde de l'ancien code, on garde le hook vide pour ne rien casser.
  const invoicesRef = useRef(invoices);
  useEffect(() => { invoicesRef.current = invoices; }, [invoices]);

  function effectiveStatus(inv) {
    if (isInvoiceOverdue(inv)) return "overdue";
    return inv.status;
  }

  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    return invoices.filter((inv) => {
      const name = snapshotDisplayName(inv.client_snapshot).toLowerCase();
      const matchS = !s || (inv.number || "").toLowerCase().includes(s) || name.includes(s);
      const matchF = statusFilter === "all" || effectiveStatus(inv) === statusFilter;
      return matchS && matchF;
    });
  }, [invoices, search, statusFilter]);

  const counts = useMemo(() => {
    const c = { all: invoices.length };
    Object.keys(INVOICE_STATUSES).forEach((k) => { c[k] = 0; });
    invoices.forEach((inv) => {
      const eff = effectiveStatus(inv);
      c[eff] = (c[eff] || 0) + 1;
    });
    return c;
  }, [invoices]);

  // v8.49 — Utilise grand_total_cents (TTC + débours) au lieu de total_ttc_cents.
  // Sinon paid_cents (qui inclut débours) > total_ttc_cents → reste négatif fantôme.
  // Fallback sur total_ttc_cents pour les factures pré-v8.49 (pas encore migrées).
  const totalUnpaid = invoices
    .filter((inv) => ["issued", "sent", "partial", "overdue"].includes(inv.status))
    .reduce((s, inv) => s + (((inv.grand_total_cents || inv.total_ttc_cents) || 0) - (inv.paid_cents || 0)), 0);

  function showToast(msg, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  function onSavedFromModal(savedInvoice) {
    setInvoices((prev) => {
      const exists = prev.find((i) => i.id === savedInvoice.id);
      if (exists) return prev.map((i) => (i.id === savedInvoice.id ? savedInvoice : i));
      return [savedInvoice, ...prev];
    });
    setEditModal(null);
    showToast(`Facture ${savedInvoice.number} enregistrée`);
  }

  async function issueInvoice(inv) {
    setActionLoading(`issue-${inv.id}`);
    try {
      // On delegue tout au serveur : UPDATE statut + generation Factur-X en une seule API call
      // (evite la race condition entre UPDATE frontend et lecture serveur)
      const r = await fetch("/api/generate-facturx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoice_id: inv.id, issue: true })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `Erreur ${r.status} lors de l'emission`);
      }
      capture("invoice_issued", { invoice_id: inv.id });
      // Sync TVA en arrière-plan (n'attend pas la réponse pour ne pas bloquer l'UI)
      syncVatCurrentPeriod(token, company);
      await refreshInvoices();
      setPendingIssue(null);
      showToast(`Facture ${inv.number} émise et PDF Factur-X généré !`);
    } catch (e) {
      showToast(e.message || "Erreur émission", "error");
    }
    setActionLoading(null);
  }

  async function transmitToAdmin(inv) {
    setActionLoading(`transmit-${inv.id}`);
    try {
      // v8.48.15 — 2a : validation Factur-X AVANT transmission (gratuit
      // chez SUPER PDP). Si non conforme, on bloque et on affiche l'erreur.
      const validationResp = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "pa_validate", payload: { invoice_id: inv.id } })
      });
      const validation = await validationResp.json().catch(() => ({}));
      if (!validationResp.ok) {
        throw new Error(validation.error || "Validation Factur-X impossible");
      }
      if (validation.is_valid === false) {
        // v8.48.20 — Affiche TOUTES les erreurs SUPER PDP, pas juste la première.
        const errs = validation.errors || [];
        const detail = errs.length
          ? "\n\n" + errs.slice(0, 5).map((e, i) =>
              (i + 1) + ". " + (e.message || e.description || e.rule || e.code || e.text || JSON.stringify(e))
            ).join("\n")
          : "";
        const rawInfo = !errs.length && validation.raw
          ? "\n\nRetour brut : " + JSON.stringify(validation.raw).slice(0, 500)
          : "";
        throw new Error("Facture non conforme à l'API AFNOR." + detail + rawInfo);
      }

      // Confirmation utilisateur : on ne transmet pas par accident.
      if (!window.confirm("Transmettre cette facture à " + (inv.client_name || "l'acheteur") + " via la Plateforme Agréée ?\n\nCette action est irréversible.")) {
        setActionLoading(null);
        return;
      }

      const r = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "pa_send", payload: { invoice_id: inv.id } })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(j.error || `Erreur ${r.status}`);
      }
      capture("invoice_pdp_transmitted", { invoice_id: inv.id, pa_document_id: j.pa_document_id });
      await refreshInvoices();
      showToast(`Facture transmise à la Plateforme Agréée (ID : ${j.pa_document_id || "?"})`);
    } catch (e) {
      showToast(e.message || "Erreur transmission PA", "error");
    }
    setActionLoading(null);
  }

  // v8.57.2 — Rafraîchit le statut d'une facture depuis SUPER PDP.
  // Utilisé par le bouton 🔄 manuel ET par le polling auto (toutes les 5s).
  //
  // v8.57.3 — Ne recharge PLUS toute la liste des factures pour éviter le
  // sautillement visuel. À la place, on patche uniquement le champ
  // `facturx_status` de la ligne concernée dans le state local. Le Realtime
  // Supabase confirmera de son côté sans casser la position visuelle.
  //
  // - `silent` : désactive les toasts (utile pour le polling)
  // - `force`  : bypasse le guard de non-changement (le bouton force le refresh)
  async function refreshInvoiceStatus(inv, { silent = false, force = false } = {}) {
    if (!inv?.pdp_transmission_id) return null;
    if (!silent) setActionLoading(`refresh-${inv.id}`);
    try {
      const r = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "pa_status", payload: { invoice_id: inv.id } })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (!silent) showToast(j.error || `Erreur ${r.status}`, "error");
        return null;
      }
      const oldFx = inv.facturx_status;
      const newFx = j.facturx_status;

      // v8.57.3 — Patch en place uniquement si changement. Zéro sautillement.
      if (newFx && newFx !== oldFx) {
        setInvoices((prev) => prev.map((x) =>
          x.id === inv.id ? { ...x, facturx_status: newFx } : x
        ));
      }

      if (!silent) {
        const labelMap = {
          transmitted:  "Transmise",
          accepted:     "Approuvée par l'acheteur",
          payment_sent: "Paiement transmis par l'acheteur",
          paid:         "Encaissée",
          rejected:     "Refusée par l'acheteur"
        };
        const label = labelMap[newFx] || newFx || "statut inchangé";
        if (force && newFx === oldFx) {
          showToast(`Statut confirmé : ${label}`);
        } else if (newFx !== oldFx) {
          showToast(`Statut mis à jour : ${label}`);
        } else {
          showToast("Statut inchangé");
        }
      }
      return { oldFx, newFx };
    } catch (e) {
      if (!silent) showToast(e.message || "Erreur rafraîchissement", "error");
      return null;
    } finally {
      if (!silent) setActionLoading(null);
    }
  }

  // v8.57.9 — Marquer une facture émise comme "Encaissée" côté vendeur.
  //
  // Sémantique AFNOR : envoie fr:212 (Payment received) qui informe le PPF et
  // l'acheteur que le vendeur a bien constaté le paiement. C'est le signal
  // fiscal qui déclenche l'exigibilité TVA sur les prestations de services.
  //
  // v8.57.10 — L'appel SUPER PDP a lieu D'ABORD. Le status local n'est mis
  // à "paid" que si SUPER PDP a bien accepté le fr:212. Sinon le status
  // reste inchangé et le bouton reste disponible pour retenter.
  async function markEncaissee(inv) {
    const totalTtc = inv.grand_total_cents || inv.total_ttc_cents || 0;
    const dateStr = new Date().toLocaleDateString("fr-FR");
    const client = inv.client_snapshot?.legal_name
                 || inv.client_snapshot?.last_name
                 || "l'acheteur";
    if (!window.confirm(
      "Marquer cette facture comme encaissée le " + dateStr + " ?\n\n"
      + "Montant : " + fmtEUR(totalTtc) + "\n"
      + "Client  : " + client + "\n\n"
      + "IOBILL enverra fr:212 (Encaissée) à votre PDP. Le PPF et l'acheteur "
      + "seront informés que le paiement est bien reçu. Cette action est "
      + "irréversible dans le cycle de vie AFNOR."
    )) return;

    setActionLoading(`encaisser-${inv.id}`);
    try {
      // 1. D'ABORD envoyer fr:212 à SUPER PDP. Si SUPER PDP rejette (règles
      //    AFNOR non satisfaites, TVA absente, etc.), on N'écrit RIEN en base.
      const r = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "pa_invoice_encaisser",
          payload: { invoice_id: inv.id }
        })
      });
      const j = await r.json().catch(() => ({}));

      // Cas d'échec : le serveur renvoie ok:false OU statut HTTP != 2xx.
      // On n'écrit rien en base et on laisse l'utilisateur retenter.
      if (!r.ok || j.ok === false) {
        const msg = j.message || j.error || "SUPER PDP a rejeté fr:212";
        showToast("Encaissement refusé par la PDP : " + msg, "error");
        return;
      }

      // 2. SUPER PDP a accepté (ou skippé pour idempotence). On met à jour
      //    la base localement.
      const nowIso = new Date().toISOString();
      await sb.update(token, "invoices", "id=eq." + inv.id, {
        status: "paid",
        paid_cents: totalTtc,
        updated_at: nowIso
      });

      // 3. Patch en place du state local
      setInvoices((prev) => prev.map((x) =>
        x.id === inv.id
          ? { ...x, status: "paid", paid_cents: totalTtc, facturx_status: "paid" }
          : x
      ));

      // 4. Sync TVA en arrière-plan
      syncVatCurrentPeriod(token, company);
      capture("invoice_encaissee", { invoice_id: inv.id });

      if (j.skipped) {
        showToast("Facture marquée encaissée (fr:212 déjà envoyé)");
      } else {
        showToast("Facture marquée encaissée · fr:212 transmis au PPF ✓");
      }
    } catch (e) {
      showToast(e.message || "Erreur lors du marquage", "error");
    }
    setActionLoading(null);
  }

  async function sendInvoice(inv) {
    setActionLoading(`send-${inv.id}`);
    try {
      const r = await fetch("/api/send-document", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ document_type: "invoice", document_id: inv.id })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Erreur d'envoi");
      capture("invoice_sent", { invoice_id: inv.id });
      await refreshInvoices();
      showToast(`Facture envoyée à ${j.recipient}${j.pdf_attached ? " (PDF joint)" : ""}`);
    } catch (e) {
      showToast(e.message, "error");
    }
    setActionLoading(null);
  }

  function previewPdf(inv) {
    // Ouvre la modale d'apercu PDF (pattern IOcar PrintDoc)
    setPreviewInvoice(inv);
  }

  async function shareLink(inv) {
    setActionLoading(`share-${inv.id}`);
    try {
      const r = await fetch("/api/public-share", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ scope: "invoice", resource_id: inv.id, expires_in_days: 90 })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Erreur");
      if (j.public_url) {
        try { await navigator.clipboard.writeText(j.public_url); } catch {}
        showToast("Lien copié dans le presse-papiers !");
      }
    } catch (e) {
      showToast(e.message, "error");
    }
    setActionLoading(null);
  }

  async function deleteInvoice(id) {
    try {
      await sb.delete(token, "document_lines", `document_type=eq.invoice&document_id=eq.${id}`);
      await sb.delete(token, "invoices", `id=eq.${id}`);
      setInvoices((prev) => prev.filter((i) => i.id !== id));
      setPendingDelete(null);
      showToast("Facture supprimée");
    } catch (e) {
      showToast(e.message || "Erreur suppression", "error");
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">FACTURES</div>
          <div className="page-sub">
            {invoices.length} factures · {fmtEUR(totalUnpaid)} en attente de règlement
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditModal("new")}>
          <Icon name="plus" size={14} /> Nouvelle facture
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
            Toutes ({counts.all})
          </button>
          {Object.entries(INVOICE_STATUSES)
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
          <div style={{ fontSize: 40, marginBottom: 14 }}>🧾</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            {search || statusFilter !== "all" ? "Aucune facture ne correspond" : "Aucune facture pour l'instant"}
          </div>
          {search || statusFilter !== "all" ? (
            <button className="btn btn-ghost" onClick={() => { setSearch(""); setStatusFilter("all"); }}>
              Effacer les filtres
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setEditModal("new")}>
              <Icon name="plus" size={14} /> Créer une facture
            </button>
          )}
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>N°</th>
                <th>Client</th>
                <th>Émise le</th>
                <th>Échéance</th>
                <th style={{ textAlign: "right" }}>Montant TTC</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const eff = effectiveStatus(inv);
                const badge = invoiceStatusBadge(eff);
                // v8.37 — Factures venant d'une app externe (IOCAR, IOBTP...)
                // sont en LECTURE SEULE côté IOBILL. Les modifs se font dans
                // l'app source pour garantir la cohérence.
                const isExternal = !!inv.external_source && inv.external_source !== "iobill";
                const sourceLabel = inv.external_source === "iocar" ? "IO CAR"
                                  : inv.external_source === "iobtp" ? "IO BTP"
                                  : String(inv.external_source || "").toUpperCase();

                const canEdit = !isExternal && inv.status === "draft";
                const canIssue = !isExternal && inv.status === "draft";
                const canSend = !isExternal && ["issued", "sent", "partial", "overdue"].includes(inv.status);
                const canDelete = !isExternal && inv.status === "draft";
                // Transmettre PDP reste possible pour les factures externes
                // (utile : la PDP est gérée centralement côté IOBILL)
                const canTransmit = ["issued", "sent", "partial", "paid", "overdue"].includes(inv.status) && !inv.pdp_transmitted_at;
                const alreadyTransmitted = !!inv.pdp_transmitted_at;

                return (
                  <tr key={inv.id}>
                    <td className="mono">
                      {inv.number || <span style={{ color: "var(--muted)" }}>—</span>}
                      {isExternal && (
                        <span
                          title={`Facture créée et gérée depuis ${sourceLabel}. Lecture seule ici.`}
                          style={{
                            display: "inline-block",
                            marginLeft: 6,
                            padding: "1px 6px",
                            borderRadius: 8,
                            background: "rgba(212,168,67,0.15)",
                            color: "var(--gold, #d4a843)",
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: 0.3,
                            verticalAlign: "middle"
                          }}
                        >
                          🚗 {sourceLabel}
                        </span>
                      )}
                      {signalsByInvoiceId[inv.id] && (
                        <NotifBadge
                          count={signalsByInvoiceId[inv.id].count}
                          severity={signalsByInvoiceId[inv.id].maxSeverity}
                          title={`${signalsByInvoiceId[inv.id].count} signalement(s) ouvert(s) de votre cabinet`}
                        />
                      )}
                    </td>
                    <td>{snapshotDisplayName(inv.client_snapshot)}</td>
                    <td>{fmtDate(inv.issue_date)}</td>
                    <td style={{ fontSize: 12, color: eff === "overdue" ? "var(--red)" : "var(--muted2)" }}>
                      {fmtDate(inv.due_date)}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {/* v8.49 — Affiche le grand_total (TTC + débours) comme montant principal
                          = ce que le client paye réellement. Sous-ligne discrète "dont TVA · débours"
                          pour la transparence fiscale (art. 267 II 2° CGI). */}
                      {(() => {
                        const debTotal = inv.debour_total_cents || 0;
                        const vatTotal = inv.vat_total_cents || 0;
                        const grandTotal = inv.grand_total_cents ?? ((inv.total_ttc_cents || 0) + debTotal);
                        const parts = [];
                        if (vatTotal > 0) parts.push(`${fmtEUR(vatTotal)} TVA`);
                        if (debTotal > 0) parts.push(`${fmtEUR(debTotal)} débours`);
                        return (
                          <>
                            <div>{fmtEUR(grandTotal)}</div>
                            {parts.length > 0 && (
                              <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "inherit" }}>
                                dont {parts.join(" · ")}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </td>
                    <td><span className={"badge " + badge.cls}>{badge.label}</span></td>
                    <td>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "nowrap" }}>
                        {/* Bouton principal : Voir (preview PDF) si emise, sinon Modifier */}
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => canEdit ? setEditModal(inv) : setPreviewInvoice(inv)}
                          style={{ padding: "5px 12px", fontSize: 11, whiteSpace: "nowrap" }}
                          title={canEdit ? "Modifier cette facture" : "Aperçu PDF avec statut"}
                        >
                          {canEdit ? "✏️ Modifier" : "👁 Voir"}
                        </button>

                        {/* Action contextuelle principale */}
                        {canIssue && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setPendingIssue(inv)}
                            disabled={actionLoading === `issue-${inv.id}`}
                            style={{ padding: "5px 10px", fontSize: 11, color: "var(--gold)", borderColor: "rgba(212,168,67,0.4)", whiteSpace: "nowrap" }}
                            title="Émettre et verrouiller cette facture"
                          >
                            🔒 Émettre
                          </button>
                        )}
                        {canSend && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => sendInvoice(inv)}
                            disabled={actionLoading === `send-${inv.id}`}
                            style={{ padding: "5px 10px", fontSize: 11, color: "var(--gold)", borderColor: "rgba(212,168,67,0.4)", whiteSpace: "nowrap" }}
                            title="Envoyer la facture par email"
                          >
                            {actionLoading === `send-${inv.id}` ? "⏳" : "📧 Envoyer"}
                          </button>
                        )}
                        {canTransmit && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => transmitToAdmin(inv)}
                            disabled={actionLoading === `transmit-${inv.id}`}
                            style={{ padding: "5px 10px", fontSize: 11, color: "var(--green)", borderColor: "rgba(62,207,122,0.4)", whiteSpace: "nowrap" }}
                            title="Transmettre la facture à l'administration via votre PDP"
                          >
                            {actionLoading === `transmit-${inv.id}` ? "⏳ Transmission..." : "🏛️ Transmettre"}
                          </button>
                        )}
                        {alreadyTransmitted && (() => {
                          // v8.48.15 — Affiche le vrai statut cycle de vie PA
                          // v8.57.8 — 5 états au lieu de 3
                          const fx = inv.facturx_status || "transmitted";
                          const meta = {
                            transmitted:  { icon: "📤", label: "Transmise",           color: "#4a9eff" },
                            accepted:     { icon: "✅", label: "Approuvée",           color: "#3ecf7a" },
                            payment_sent: { icon: "💸", label: "Paiement transmis",   color: "#d4a843" },
                            paid:         { icon: "💰", label: "Encaissée",           color: "#2ecc71" },
                            rejected:     { icon: "❌", label: "Refusée",             color: "#e54949" }
                          }[fx] || { icon: "📤", label: fx, color: "#8a8a96" };
                          const when = inv.pdp_transmitted_at ? new Date(inv.pdp_transmitted_at).toLocaleDateString("fr-FR") : "";
                          return (
                            <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                              <span
                                style={{
                                  padding: "5px 10px", fontSize: 10, color: meta.color,
                                  border: "1px solid " + meta.color + "55",
                                  background: meta.color + "18",
                                  borderRadius: 6, whiteSpace: "nowrap"
                                }}
                                title={"Transmise via " + (inv.pdp_provider || "PA") + (when ? " le " + when : "") + " · ID " + (inv.pdp_transmission_id || "?")}
                              >
                                {meta.icon} {meta.label}
                              </span>
                              {/* v8.57.2 — Bouton "Rafraîchir statut" : va lire côté SUPER PDP
                                  le dernier événement de cycle de vie (fr:205, fr:210, fr:212...)
                                  et met à jour facturx_status en base. Utile en attendant le
                                  webhook automatique (v8.58). */}
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => refreshInvoiceStatus(inv, { force: true })}
                                disabled={actionLoading === `refresh-${inv.id}`}
                                style={{
                                  padding: "2px 6px", fontSize: 10,
                                  color: "var(--muted)", borderColor: "rgba(255,255,255,0.08)",
                                  minWidth: 24, height: 24, lineHeight: 1
                                }}
                                title="Rafraîchir le statut PDP (accepté / refusé / encaissé)"
                              >
                                {actionLoading === `refresh-${inv.id}` ? "⏳" : "🔄"}
                              </button>
                            </span>
                          );
                        })()}

                        {/* Bouton kebab : trigger, menu rendu en portail plus bas */}
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (openMenu?.id === inv.id) {
                              setOpenMenu(null);
                              return;
                            }
                            const rect = e.currentTarget.getBoundingClientRect();
                            setOpenMenu({
                              id: inv.id,
                              invoice: inv,
                              right: window.innerWidth - rect.right,
                              top: rect.bottom + 4,
                              canEdit, canDelete
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
              })}
            </tbody>
          </table>
        </div>
      )}

      {editModal && (
        <InvoiceEditorModal
          token={token}
          company={company}
          invoice={editModal === "new" ? null : editModal}
          onClose={() => setEditModal(null)}
          onSaved={onSavedFromModal}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title="Supprimer cette facture ?"
          message={`Cette action est irréversible. La facture ${pendingDelete.label} et toutes ses lignes seront supprimées.`}
          confirmLabel="Supprimer"
          confirmType="danger"
          onConfirm={() => deleteInvoice(pendingDelete.id)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingIssue && (
        <ConfirmModal
          title="Émettre cette facture ?"
          message={
            <>
              La facture <strong>{pendingIssue.number}</strong> sera émise et verrouillée :
              elle ne pourra plus être modifiée. Un PDF Factur-X conforme sera généré automatiquement.
              <br /><br />
              <em style={{ fontSize: 11, color: "var(--muted)" }}>
                Pour corriger une facture émise, vous devrez créer un avoir.
              </em>
            </>
          }
          confirmLabel="Émettre la facture"
          confirmType="primary"
          onConfirm={() => issueInvoice(pendingIssue)}
          onCancel={() => setPendingIssue(null)}
        />
      )}

      {/* ─── Apercu PDF en modale (pattern IOcar PrintDoc) ─── */}
      {previewInvoice && (
        <DocumentPreviewModal
          token={token}
          docType="invoice"
          doc={previewInvoice}
          onClose={() => setPreviewInvoice(null)}
          onSend={async (inv) => {
            await sendInvoice(inv);
          }}
        />
      )}

      {/* ─── Menu kebab : rendu en position:fixed ─── */}
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
          <MenuItemInv onClick={() => { previewPdf(openMenu.invoice); setOpenMenu(null); }}>
            📄 Aperçu PDF
          </MenuItemInv>
          {!openMenu.canEdit && (
            <MenuItemInv onClick={() => { shareLink(openMenu.invoice); setOpenMenu(null); }}>
              🔗 Copier le lien public
            </MenuItemInv>
          )}
          {/* v8.57.9 — Marquer encaissée (B2B).
              Visible uniquement si :
                - facture transmise (pdp_transmission_id NOT NULL)
                - acheteur a approuvé ou signalé un paiement
                - facture pas déjà payée */}
          {(() => {
            const inv = openMenu.invoice;
            const canEncaisser =
              !!inv.pdp_transmission_id
              && inv.status !== "paid"
              && (inv.facturx_status === "accepted" || inv.facturx_status === "payment_sent");
            if (!canEncaisser) return null;
            return (
              <>
                <div style={{ height: 1, background: "var(--border2)", margin: "4px 0" }} />
                <MenuItemInv
                  onClick={() => { markEncaissee(inv); setOpenMenu(null); }}
                  style={{ color: "#2ecc71" }}
                >
                  💰 Marquer encaissée (fr:212)
                </MenuItemInv>
              </>
            );
          })()}
          {openMenu.canDelete && (
            <>
              <div style={{ height: 1, background: "var(--border2)", margin: "4px 0" }} />
              <MenuItemInv
                onClick={() => { setPendingDelete({ id: openMenu.invoice.id, label: openMenu.invoice.number || "cette facture" }); setOpenMenu(null); }}
                style={{ color: "var(--red)" }}
              >
                🗑 Supprimer
              </MenuItemInv>
            </>
          )}
        </div>
      )}

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

// ─── Composant MenuItem reutilisable ───
function MenuItemInv({ children, onClick, style = {} }) {
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
