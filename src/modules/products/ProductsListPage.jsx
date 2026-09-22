import React, { useEffect, useMemo, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR } from "../../lib/helpers.js";
import { ConfirmModal } from "../../components/ConfirmModal.jsx";
import { useTableSort, SortableTh, sortRows } from "../../components/TableSort.jsx";
import { SkeletonTable } from "../../components/Skeleton.jsx";

// v8.202 — CATALOGUE PRODUITS
//
// Un répertoire de ce qu'on vend, pour ne plus ressaisir la même désignation
// et le même tarif à chaque devis. La saisie reste libre : le catalogue
// propose, il n'impose pas.
//
// Le prix est COPIÉ dans la ligne du document au moment où on choisit le
// produit, jamais référencé. Augmenter un tarif ici ne doit rien changer aux
// devis et factures déjà établis — un document qui se met à jour tout seul
// n'est pas un document.

const UNITS = ["u", "h", "j", "forfait", "kg", "m", "m²", "ml", "L"];
const VAT_RATES = [0, 2.1, 5.5, 10, 20];

export function ProductsListPage({ token, company }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState(null);
  const [search, setSearch] = useState("");
  const [voirArchives, setVoirArchives] = useState(false);
  const [editing, setEditing] = useState(null);   // null | "add" | produit
  const [confirmDel, setConfirmDel] = useState(null);
  const { sort, toggleSort } = useTableSort("iobill:products:sort", { key: "designation", dir: "asc" });

  async function charger() {
    setLoading(true);
    try {
      const list = await sb.select(token, "products", {
        filter: `company_id=eq.${company.id}`,
        order: "designation.asc"
      });
      setProducts(Array.isArray(list) ? list : []);
      setErreur(null);
    } catch (e) {
      setErreur(e.message || "Chargement impossible");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { charger(); /* eslint-disable-next-line */ }, [token, company.id]);

  const visibles = useMemo(() => {
    const s = search.toLowerCase().trim();
    const filtres = products.filter((p) => {
      if (!voirArchives && p.archived) return false;
      if (!s) return true;
      return (p.designation || "").toLowerCase().includes(s)
        || (p.reference || "").toLowerCase().includes(s)
        || (p.description || "").toLowerCase().includes(s);
    });
    const valueOf = (p, key) => {
      switch (key) {
        case "reference": return (p.reference || "").toLowerCase();
        case "price":     return p.unit_price_ht_cents ?? 0;
        case "vat":       return Number(p.vat_rate) || 0;
        default:          return (p.designation || "").toLowerCase();
      }
    };
    return sortRows(filtres, sort, valueOf, (p) => (p.designation || "").toLowerCase());
  }, [products, search, voirArchives, sort]);

  const nbArchives = products.filter((p) => p.archived).length;

  async function supprimer(id) {
    // sb.delete renvoie un booléen sans lever : sans ce contrôle, la ligne
    // disparaîtrait de l'écran pour revenir au rechargement suivant.
    const ok = await sb.delete(token, "products", `id=eq.${id}`);
    if (!ok) { setErreur("Suppression refusée par la base."); return; }
    setProducts((prev) => prev.filter((p) => p.id !== id));
    setConfirmDel(null);
  }

  async function basculerArchive(p) {
    const res = await sb.update(token, "products", `id=eq.${p.id}`, {
      archived: !p.archived,
      updated_at: new Date().toISOString()
    });
    if (!res || !res[0]) { setErreur("Modification refusée par la base."); return; }
    setProducts((prev) => prev.map((x) => x.id === p.id ? res[0] : x));
  }

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div className="page-title">PRODUITS</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
            {products.length - nbArchives} produit{products.length - nbArchives > 1 ? "s" : ""} au catalogue
            {nbArchives > 0 && <> · {nbArchives} archivé{nbArchives > 1 ? "s" : ""}</>}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing("add")}>
          <Icon name="plus" size={12} /> Nouveau produit
        </button>
      </div>

      {erreur && (
        <div style={{
          background: "rgba(229,92,92,.1)", border: "1px solid rgba(229,92,92,.35)",
          borderRadius: 6, padding: "8px 12px", fontSize: 12, color: "var(--red)", marginBottom: 12
        }}>{erreur}</div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <input
          className="search-input"
          placeholder="Rechercher une désignation, une référence…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 280 }}
        />
        {nbArchives > 0 && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)", cursor: "pointer" }}>
            <input type="checkbox" checked={voirArchives} onChange={(e) => setVoirArchives(e.target.checked)} />
            Afficher les archivés
          </label>
        )}
      </div>

      {loading ? (
        <SkeletonTable rows={5} />
      ) : visibles.length === 0 ? (
        <div style={{ textAlign: "center", padding: 48, color: "var(--muted)" }}>
          {products.length === 0 ? (
            <>
              <div style={{ fontSize: 14, marginBottom: 8 }}>Votre catalogue est vide.</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: 460, margin: "0 auto" }}>
                Ajoutez ce que vous vendez le plus souvent. Il suffira ensuite d'en taper
                les premières lettres dans un devis ou une facture pour remplir la ligne.
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13 }}>Aucun produit ne correspond à cette recherche.</div>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <SortableTh label="Désignation" sortKey="designation" sort={sort} onSort={toggleSort} />
                <SortableTh label="Référence" sortKey="reference" sort={sort} onSort={toggleSort} />
                <th style={{ textAlign: "center" }}>Unité</th>
                <SortableTh label="Prix HT" sortKey="price" sort={sort} onSort={toggleSort} align="right" />
                <SortableTh label="TVA" sortKey="vat" sort={sort} onSort={toggleSort} align="right" />
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((p) => (
                <tr key={p.id} style={p.archived ? { opacity: 0.5 } : null}>
                  <td>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {p.designation}
                      {p.archived && (
                        <span className="badge badge-muted" style={{ marginLeft: 8, fontSize: 10 }}>Archivé</span>
                      )}
                    </div>
                    {p.description && (
                      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, maxWidth: 420, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {p.description}
                      </div>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 12, color: "var(--muted2)" }}>{p.reference || "—"}</td>
                  <td style={{ textAlign: "center", fontSize: 12, color: "var(--muted2)" }}>{p.unit}</td>
                  <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{fmtEUR(p.unit_price_ht_cents)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 12, color: "var(--muted2)" }}>{Number(p.vat_rate)}%</td>
                  <td>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => setEditing(p)}>
                        ✏️ Modifier
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11 }}
                        onClick={() => basculerArchive(p)}
                        title={p.archived
                          ? "Remettre au catalogue"
                          : "Retirer du catalogue sans le supprimer — il ne sera plus proposé à la saisie"}
                      >
                        {p.archived ? "↩ Réactiver" : "📦 Archiver"}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11, color: "var(--red)" }}
                        onClick={() => setConfirmDel(p)}
                      >
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ProductModal
          token={token}
          company={company}
          product={editing === "add" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setProducts((prev) => {
              const i = prev.findIndex((x) => x.id === p.id);
              return i === -1 ? [...prev, p] : prev.map((x) => x.id === p.id ? p : x);
            });
            setEditing(null);
          }}
        />
      )}

      {confirmDel && (
        <ConfirmModal
          title="Supprimer ce produit ?"
          message={`« ${confirmDel.designation} » sera retiré définitivement du catalogue. `
            + "Les devis et factures qui l'utilisent ne changent pas : ils en portent leur propre copie. "
            + "Si vous voulez seulement cesser de le proposer, préférez l'archiver."}
          confirmLabel="Supprimer"
          confirmType="danger"
          onConfirm={() => supprimer(confirmDel.id)}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </div>
  );
}

// ─── Fiche produit ────────────────────────────────────────────────────
function ProductModal({ token, company, product, onClose, onSaved }) {
  const isNew = !product;
  const [designation, setDesignation] = useState(product?.designation || "");
  const [reference, setReference] = useState(product?.reference || "");
  const [description, setDescription] = useState(product?.description || "");
  const [prix, setPrix] = useState(
    product ? String((product.unit_price_ht_cents || 0) / 100) : ""
  );
  const [unit, setUnit] = useState(product?.unit || "u");
  const [vatRate, setVatRate] = useState(
    product ? Number(product.vat_rate) : (company.vat_default_rate ?? 20)
  );
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState(null);

  const pret = designation.trim().length > 0;

  async function enregistrer() {
    if (!pret) return;
    setBusy(true);
    setErreur(null);
    try {
      const payload = {
        company_id: company.id,
        designation: designation.trim(),
        reference: reference.trim() || null,
        description: description.trim() || null,
        unit_price_ht_cents: Math.round((parseFloat(prix) || 0) * 100),
        unit,
        vat_rate: Number(vatRate),
        updated_at: new Date().toISOString()
      };
      const res = isNew
        ? await sb.insert(token, "products", payload)
        : await sb.update(token, "products", `id=eq.${product.id}`, payload);
      // Les helpers renvoient null quand la base refuse, sans lever.
      if (!res || !res[0]) throw new Error("Enregistrement refusé par la base");
      onSaved(res[0]);
    } catch (e) {
      setErreur(e.message || "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-md" onClick={(e) => e.stopPropagation()}>
        <div className="modal-hd">
          <span className="modal-title">{isNew ? "Nouveau produit" : "Modifier le produit"}</span>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {erreur && (
            <div style={{
              background: "rgba(229,92,92,.1)", border: "1px solid rgba(229,92,92,.35)",
              borderRadius: 6, padding: "8px 12px", fontSize: 12, color: "var(--red)", marginBottom: 12
            }}>{erreur}</div>
          )}

          <div className="form-group full" style={{ marginBottom: 14 }}>
            <label className="form-label">Désignation *</label>
            <input
              className="form-input"
              value={designation}
              onChange={(e) => setDesignation(e.target.value)}
              placeholder="ex : Impression textile — sérigraphie 1 couleur"
              autoFocus
            />
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
              C'est ce qui s'écrira sur la ligne du devis. Vous pourrez le retoucher au cas par cas.
            </div>
          </div>

          <div className="form-grid" style={{ marginBottom: 14 }}>
            <div className="form-group">
              <label className="form-label">Référence</label>
              <input
                className="form-input"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="facultative"
                style={{ fontFamily: "DM Mono" }}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Unité</label>
              <select className="form-input" value={unit} onChange={(e) => setUnit(e.target.value)}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Prix HT</label>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  className="form-input mono"
                  type="number"
                  step="0.01"
                  value={prix}
                  onChange={(e) => setPrix(e.target.value)}
                  placeholder="0.00"
                  style={{ textAlign: "right" }}
                />
                <span style={{ color: "var(--muted)" }}>€</span>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">TVA</label>
              <select className="form-input" value={vatRate} onChange={(e) => setVatRate(e.target.value)}>
                {VAT_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
              </select>
            </div>
          </div>

          <div className="form-group full" style={{ marginBottom: 14 }}>
            <label className="form-label">Description détaillée</label>
            <textarea
              className="form-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="facultative — reprise sous la désignation sur le document"
              style={{ resize: "vertical", fontFamily: "inherit" }}
            />
          </div>

          <div style={{
            background: "rgba(212,168,67,.07)", border: "1px solid var(--border2)",
            borderRadius: 6, padding: "10px 14px", fontSize: 11.5, color: "var(--muted)",
            lineHeight: 1.6, marginBottom: 16
          }}>
            Le prix est <strong style={{ color: "var(--text)" }}>recopié</strong> dans la ligne au moment
            où vous choisissez ce produit. Le modifier ici ne changera aucun devis ni aucune facture
            déjà établis — ils portent leur propre copie.
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Annuler</button>
            <button
              className="btn btn-primary"
              onClick={enregistrer}
              disabled={!pret || busy}
              style={!pret ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
            >
              {busy ? "…" : "Enregistrer"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
