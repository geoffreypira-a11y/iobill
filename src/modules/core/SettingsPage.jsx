import React, { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtDate, isSiret, formatSiret, isEmail } from "../../lib/helpers.js";
import { useT, useLang, getLang, setLang } from "../../lib/i18n.js";
import { resetTour } from "../../components/OnboardingTour.jsx";
import { pushSupported, pushPermission, isPushSubscribed, enablePush, disablePush } from "../../lib/push.js";

const VALID_TABS = ["profile", "modules", "notifications", "billing", "inbox", "pdp", "sms", "security"];

export function SettingsPage({ token, company, setCompany, user, onSignOut }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = VALID_TABS.includes(searchParams.get("tab")) ? searchParams.get("tab") : "profile";
  const [tab, setTab] = useState(initialTab);

  // Quand on change d'onglet, on synchronise l'URL (sans push history)
  function selectTab(newTab) {
    setTab(newTab);
    if (newTab === "profile") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab: newTab }, { replace: true });
    }
  }

  // Si l'URL change depuis l'extérieur (deeplink), on resynchronise
  useEffect(() => {
    const urlTab = searchParams.get("tab");
    if (VALID_TABS.includes(urlTab) && urlTab !== tab) {
      setTab(urlTab);
    }
  }, [searchParams]);

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-header">
        <div>
          <div className="page-title">PARAMÈTRES</div>
          <div className="page-sub">Profil société, modules, abonnement et sécurité</div>
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 22, flexWrap: "wrap" }}>
        <button className={"tab" + (tab === "profile" ? " active" : "")} onClick={() => selectTab("profile")}>Profil société</button>
        <button className={"tab" + (tab === "modules" ? " active" : "")} onClick={() => selectTab("modules")}>Modules</button>
        <button className={"tab" + (tab === "notifications" ? " active" : "")} onClick={() => selectTab("notifications")}>🔔 Notifications</button>
        <button className={"tab" + (tab === "billing" ? " active" : "")} onClick={() => selectTab("billing")}>Abonnement</button>
        <button className={"tab" + (tab === "inbox" ? " active" : "")} onClick={() => selectTab("inbox")}>📧 Inbox OCR</button>
        <button className={"tab" + (tab === "pdp" ? " active" : "")} onClick={() => selectTab("pdp")}>🏛️ PDP</button>
        <button className={"tab" + (tab === "sms" ? " active" : "")} onClick={() => selectTab("sms")}>📱 SMS</button>
        <button className={"tab" + (tab === "security" ? " active" : "")} onClick={() => selectTab("security")}>Sécurité</button>
      </div>

      {tab === "profile" && <ProfileTab token={token} company={company} setCompany={setCompany} />}
      {tab === "modules" && <ModulesTab token={token} company={company} setCompany={setCompany} />}
      {tab === "notifications" && <NotificationsTab token={token} company={company} />}
      {tab === "billing" && <BillingTab token={token} company={company} setCompany={setCompany} />}
      {tab === "inbox" && <InboxTab token={token} company={company} setCompany={setCompany} />}
      {tab === "pdp" && <PdpTab token={token} company={company} setCompany={setCompany} />}
      {tab === "sms" && <SmsTab token={token} company={company} setCompany={setCompany} />}
      {tab === "security" && <SecurityTab token={token} user={user} onSignOut={onSignOut} />}
    </div>
  );
}

/* ─── Profil société ────────────────────────────────────── */
function ProfileTab({ token, company, setCompany }) {
  const [data, setData] = useState({ ...company });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  function update(k, v) { setData((d) => ({ ...d, [k]: v })); }

  async function save() {
    setMsg("");
    if (!data.legal_name?.trim()) { setMsg("Raison sociale requise"); return; }
    if (data.email && !isEmail(data.email)) { setMsg("Email invalide"); return; }
    if (data.siret && !isSiret(data.siret)) { setMsg("SIRET invalide (14 chiffres)"); return; }
    setSaving(true);
    const { id, user_id, created_at, updated_at, ...payload } = data;
    if (payload.siret) payload.siret = payload.siret.replace(/\s/g, "");
    const updated = await sb.update(token, "companies", `id=eq.${company.id}`, payload);
    setSaving(false);
    if (updated && updated[0]) {
      setCompany(updated[0]);
      setMsg("✓ Profil enregistré");
      setTimeout(() => setMsg(""), 2500);
    } else {
      setMsg("Erreur d'enregistrement");
    }
  }

  return (
    <>
      {/* ─── BRANDING en premier ─── */}
      <BrandingTab token={token} company={company} setCompany={setCompany} />

      <div className="card card-pad" style={{ marginTop: 18 }}>
        {msg && (
          <div className={msg.startsWith("✓") ? "auth-success" : "auth-error"} style={{ marginBottom: 16 }}>
            {msg}
          </div>
        )}

        <SectionTitle>Identité</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Raison sociale *" value={data.legal_name} onChange={(v) => update("legal_name", v)} />
        <Field label="Nom commercial" value={data.trade_name} onChange={(v) => update("trade_name", v)} />
        <Field label="Forme juridique" value={data.legal_form} onChange={(v) => update("legal_form", v)} />
        <Field label="Code APE" value={data.ape_code} onChange={(v) => update("ape_code", v)} />
        <Field label="SIRET" value={data.siret ? formatSiret(data.siret) : ""} onChange={(v) => update("siret", v.replace(/\s/g, ""))} />
        <Field label="N° RCS" value={data.rcs} onChange={(v) => update("rcs", v)} />
        <Field label="N° TVA intracom." value={data.vat_number} onChange={(v) => update("vat_number", (v || "").toUpperCase())} />
      </div>

      <SectionTitle style={{ marginTop: 24 }}>Adresse</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Adresse" value={data.address_line1} onChange={(v) => update("address_line1", v)} full />
        <Field label="Complément" value={data.address_line2} onChange={(v) => update("address_line2", v)} full />
        <Field label="Code postal" value={data.postal_code} onChange={(v) => update("postal_code", v)} />
        <Field label="Ville" value={data.city} onChange={(v) => update("city", v)} />
        <Field label="Pays" value={data.country} onChange={(v) => update("country", (v || "").toUpperCase())} />
      </div>

      <SectionTitle style={{ marginTop: 24 }}>Contact</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Email" value={data.email} onChange={(v) => update("email", v)} />
        <Field label="Téléphone" value={data.phone} onChange={(v) => update("phone", v)} />
        <Field label="Site web" value={data.website} onChange={(v) => update("website", v)} />
      </div>

      <SectionTitle style={{ marginTop: 24 }}>Coordonnées bancaires</SectionTitle>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12 }}>
        Affichées sur les PDF de factures pour permettre à vos clients de payer par virement.
        Laissez vide si vous ne souhaitez pas les afficher.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Nom de la banque" value={data.bank_name} onChange={(v) => update("bank_name", v)} />
        <Field label="BIC / SWIFT" value={data.bic} onChange={(v) => update("bic", (v || "").toUpperCase().replace(/\s/g, ""))} />
        <Field label="IBAN" value={data.iban} onChange={(v) => update("iban", (v || "").toUpperCase())} full />
      </div>
      <div style={{
        marginTop: 12,
        padding: "10px 14px",
        border: "1px solid var(--border, rgba(255,255,255,0.08))",
        borderRadius: 8,
        display: "flex", alignItems: "center", gap: 12,
        background: "rgba(212,168,67,0.04)"
      }}>
        <input
          type="checkbox"
          id="iban_default"
          checked={data.show_payment_iban_default !== false}
          onChange={(e) => update("show_payment_iban_default", e.target.checked)}
          style={{ accentColor: "var(--gold)", width: 16, height: 16 }}
        />
        <label htmlFor="iban_default" style={{ flex: 1, cursor: "pointer", fontSize: 13 }}>
          <div style={{ fontWeight: 500 }}>Afficher l'IBAN par défaut sur les nouvelles factures</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            Vous pourrez toujours décocher au cas par cas dans l'éditeur de facture.
          </div>
        </label>
      </div>

      <SectionTitle style={{ marginTop: 24 }}>Régime fiscal</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <SelectField
          label="Régime TVA"
          value={data.vat_regime}
          onChange={(v) => update("vat_regime", v)}
          options={[
            { value: "franchise", label: "Franchise en base de TVA" },
            { value: "normal_monthly", label: "Réel normal mensuel (CA3)" },
            { value: "normal_quarterly", label: "Réel normal trimestriel (CA3)" },
            { value: "simplified", label: "Réel simplifié (CA12)" }
          ]}
        />
        <Field label="Taux TVA par défaut (%)" value={data.vat_default_rate} onChange={(v) => update("vat_default_rate", Number(v))} type="number" />
        <SelectField
          label="Période URSSAF"
          value={data.urssaf_period || "monthly"}
          onChange={(v) => update("urssaf_period", v)}
          options={[
            { value: "monthly", label: "Mensuelle" },
            { value: "quarterly", label: "Trimestrielle" }
          ]}
        />
        <SelectField
          label="Activité (micro)"
          value={data.micro_activity || ""}
          onChange={(v) => update("micro_activity", v)}
          options={[
            { value: "", label: "—" },
            { value: "bnc", label: "Profession libérale (BNC)" },
            { value: "bic_services", label: "Prestations de services (BIC)" },
            { value: "bic_vente", label: "Vente de marchandises (BIC)" }
          ]}
        />
      </div>

      <div style={{ marginTop: 24 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Enregistrement..." : "Enregistrer le profil"}
        </button>
      </div>
    </div>
    </>
  );
}

/* ─── Modules ─────────────────────────────────────────── */
function ModulesTab({ token, company, setCompany }) {
  const [modules, setModules] = useState({ ...(company.modules || {}) });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const MODULE_LIST = [
    { code: "invoicing", label: "Factures", description: "Émission de factures avec Factur-X et hash chain DGFiP", required: true },
    { code: "quotes", label: "Devis", description: "Création de devis avec signature électronique" },
    { code: "credit_notes", label: "Avoirs", description: "Avoirs liés à des factures émises" },
    { code: "purchases", label: "Achats fournisseurs", description: "Saisie + OCR Mistral des factures fournisseurs" },
    { code: "vat", label: "TVA", description: "Déclarations CA3 / CA12" },
    { code: "urssaf", label: "URSSAF", description: "Cotisations auto-entrepreneur (mensuel/trimestriel)" },
    { code: "accounting", label: "Export comptable", description: "FEC, CSV, connecteurs Pennylane / Tiime" },
    { code: "banking", label: "Lettrage bancaire PSD2", description: "Connexion Bridge pour lettrage automatique" },
    { code: "client_portal", label: "Portail client", description: "Accès public sécurisé pour vos clients" },
    { code: "esign", label: "Signature électronique", description: "Signature interne (clic) ou Yousign (eIDAS)" }
  ];

  function toggle(code) {
    setModules((m) => ({ ...m, [code]: !m[code] }));
  }

  async function save() {
    setSaving(true);
    const updated = await sb.update(token, "companies", `id=eq.${company.id}`, { modules });
    setSaving(false);
    if (updated && updated[0]) {
      setCompany(updated[0]);
      setMsg("✓ Modules mis à jour");
      setTimeout(() => setMsg(""), 2500);
    }
  }

  return (
    <div className="card card-pad">
      {msg && <div className="auth-success" style={{ marginBottom: 16 }}>{msg}</div>}
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 18 }}>
        Activez ou désactivez les modules selon vos besoins. Les modules désactivés disparaissent de la barre latérale.
      </div>

      {MODULE_LIST.map((m) => {
        const isOn = m.required || !!modules[m.code];
        return (
          <div
            key={m.code}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 14px",
              borderRadius: 8,
              background: isOn ? "var(--card2)" : "transparent",
              border: "1px solid " + (isOn ? "var(--border)" : "var(--border2)"),
              marginBottom: 8,
              cursor: m.required ? "default" : "pointer",
              opacity: m.required ? 0.85 : 1
            }}
            onClick={() => !m.required && toggle(m.code)}
          >
            <div style={{
              width: 38,
              height: 22,
              borderRadius: 11,
              background: isOn ? "var(--gold)" : "var(--card3)",
              position: "relative",
              transition: "background 0.2s",
              flexShrink: 0
            }}>
              <div style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: "#fff",
                position: "absolute",
                top: 2,
                left: isOn ? 18 : 2,
                transition: "left 0.2s"
              }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                {m.label}
                {m.required && <span style={{ marginLeft: 8, fontSize: 10, color: "var(--gold)" }}>(requis)</span>}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted2)" }}>{m.description}</div>
            </div>
          </div>
        );
      })}

      <div style={{ marginTop: 18 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Enregistrement..." : "Enregistrer les modules"}
        </button>
      </div>
    </div>
  );
}

/* ─── Branding ────────────────────────────────────────── */
function BrandingTab({ token, company, setCompany }) {
  const [data, setData] = useState({
    logo_url: company.logo_url || "",
    brand_color: company.brand_color || "#d4a843"
  });
  const [logoPreview, setLogoPreview] = useState(null);  // URL signée pour la preview
  const [logoLoading, setLogoLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const fileRef = useRef(null);

  // Au montage : charger une URL signée du logo existant pour preview
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!data.logo_url) { setLogoPreview(null); return; }
      const url = await sb.getSignedUrl(token, "company-logos", data.logo_url, 3600);
      if (alive) setLogoPreview(url);
    })();
    return () => { alive = false; };
  }, [data.logo_url, token]);

  // Compresse une image data-URL : redimensionne à max 800px et ré-encode en PNG
  function compressLogo(dataUrl, maxWidth = 800) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        // PNG sinon JPEG selon le poids
        const png = canvas.toDataURL("image/png");
        // Si PNG > 200 Ko et > 500 Ko original, JPEG quality 92
        if (png.length > 200_000 * 1.37) {
          resolve(canvas.toDataURL("image/jpeg", 0.92));
        } else {
          resolve(png);
        }
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  async function handleFile(e) {
    setErr("");
    setMsg("");
    const file = e.target.files?.[0];
    if (!file) return;

    // Limite taille brute (avant compression)
    if (file.size > 5_000_000) {
      setErr("Fichier trop volumineux (max 5 Mo). Réduisez votre image et réessayez.");
      return;
    }
    if (!/^image\//.test(file.type)) {
      setErr("Format non supporté. Utilisez PNG, JPEG, WebP ou SVG.");
      return;
    }

    setLogoLoading(true);

    // 1. Lire le fichier en DataURL
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        // 2. Compresser à 800px max
        let finalDataUrl = ev.target.result;
        try {
          finalDataUrl = await compressLogo(ev.target.result, 800);
        } catch (e) {
          console.warn("[BrandingTab] Compression échouée, on garde l'original", e);
        }

        // 3. Convertir en Blob/File pour upload
        const m = finalDataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
        if (!m) throw new Error("Format invalide après compression");
        const mime = m[1];
        const b64 = m[2];
        const ext = mime.split("/")[1].replace("+xml", "").replace("jpeg", "jpg");
        const byteChars = atob(b64);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
        const compressedFile = new File([bytes], `logo.${ext}`, { type: mime });

        // 4. Upload vers Supabase Storage (bucket privé "company-logos")
        const path = `${company.id}/logo.${ext}`;
        const uploaded = await sb.uploadFile(token, "company-logos", path, compressedFile);
        if (!uploaded) throw new Error("Échec d'upload (vérifiez les permissions du bucket)");

        // 5. Stocker le path et générer une URL signée pour la preview immédiate
        setData((d) => ({ ...d, logo_url: path }));
        const signed = await sb.getSignedUrl(token, "company-logos", path, 3600);
        setLogoPreview(signed || finalDataUrl);  // fallback dataURL si signed échoue

        // 6. Sauvegarde immédiate en base (pas besoin de cliquer "Enregistrer")
        const updated = await sb.update(token, "companies", `id=eq.${company.id}`, { logo_url: path });
        if (updated && updated[0]) {
          setCompany(updated[0]);
          setMsg("✓ Logo enregistré et appliqué.");
          setTimeout(() => setMsg(""), 3500);
        }
      } catch (e) {
        setErr(e.message || "Erreur lors de l'upload");
      }
      setLogoLoading(false);
    };
    reader.onerror = () => {
      setErr("Impossible de lire le fichier.");
      setLogoLoading(false);
    };
    reader.readAsDataURL(file);
  }

  async function removeLogo() {
    if (!confirm("Retirer le logo ? Vos prochains documents s'afficheront sans logo.")) return;
    setLogoLoading(true);
    try {
      // On ne supprime pas le fichier du Storage (au cas où l'utilisateur veuille restaurer)
      // On vide juste la référence
      setData((d) => ({ ...d, logo_url: "" }));
      setLogoPreview(null);
      const updated = await sb.update(token, "companies", `id=eq.${company.id}`, { logo_url: null });
      if (updated && updated[0]) {
        setCompany(updated[0]);
        setMsg("✓ Logo retiré.");
        setTimeout(() => setMsg(""), 2500);
      }
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setErr(e.message || "Erreur lors de la suppression");
    }
    setLogoLoading(false);
  }

  async function saveColor() {
    setSaving(true);
    const updated = await sb.update(token, "companies", `id=eq.${company.id}`, {
      brand_color: data.brand_color
    });
    setSaving(false);
    if (updated && updated[0]) {
      setCompany(updated[0]);
      setMsg("✓ Couleur enregistrée");
      setTimeout(() => setMsg(""), 2500);
    }
  }

  return (
    <div className="card card-pad">
      {msg && <div className="auth-success" style={{ marginBottom: 16 }}>{msg}</div>}
      {err && <div className="auth-error" style={{ marginBottom: 16 }}>{err}</div>}

      <SectionTitle>Logo de votre activité</SectionTitle>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>
        Apparaîtra en haut de tous vos devis, factures, avoirs et sur la page publique vue par vos clients.
        <br />
        Formats acceptés : PNG, JPEG, WebP, SVG. Taille max : 5 Mo (compressé automatiquement à 800px).
      </div>

      {/* Preview du logo */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: 16,
        background: "var(--card2)",
        border: "1px solid var(--border2)",
        borderRadius: 10,
        marginBottom: 16
      }}>
        <div style={{
          width: 120,
          height: 120,
          background: "var(--card)",
          border: "1px solid var(--border2)",
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden"
        }}>
          {logoLoading ? (
            <div style={{ fontSize: 11, color: "var(--muted)" }}>⏳</div>
          ) : logoPreview ? (
            <img
              src={logoPreview}
              alt="Logo"
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
              onError={() => setLogoPreview(null)}
            />
          ) : (
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: 28,
              fontWeight: 800,
              color: "var(--gold)"
            }}>
              {(company.legal_name || "?")
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((w) => (w[0] || "").toUpperCase())
                .join("")}
            </div>
          )}
        </div>

        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 10, fontWeight: 600 }}>
            {data.logo_url ? "Logo actuel" : "Aucun logo défini"}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => fileRef.current?.click()}
              disabled={logoLoading}
            >
              {data.logo_url ? "🔄 Remplacer" : "📤 Téléverser un logo"}
            </button>
            {data.logo_url && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={removeLogo}
                disabled={logoLoading}
                style={{ color: "var(--red)", borderColor: "rgba(229,92,92,0.3)" }}
              >
                🗑 Retirer
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={handleFile}
            style={{ display: "none" }}
          />
          {!data.logo_url && (
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 10, fontStyle: "italic" }}>
              Sans logo, vos initiales s'afficheront dans un carré gold.
            </div>
          )}
        </div>
      </div>

      <SectionTitle>Couleur d'accentuation</SectionTitle>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
        Couleur utilisée sur la page publique et certains accents (en complément du gold IO BILL).
      </div>

      {/* Palette de couleurs prédéfinies */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {[
          { name: "Gold IO BILL", value: "#d4a843" },
          { name: "Vert émeraude", value: "#3ecf7a" },
          { name: "Orange", value: "#e6a23c" },
          { name: "Rouge corail", value: "#e55c5c" },
          { name: "Violet", value: "#9b6bd6" },
          { name: "Bleu nuit", value: "#3a5a8c" },
          { name: "Cuivre", value: "#c87f4a" },
          { name: "Anthracite", value: "#4a4a52" }
        ].map((preset) => {
          const isActive = data.brand_color?.toLowerCase() === preset.value.toLowerCase();
          return (
            <button
              key={preset.value}
              onClick={() => setData((d) => ({ ...d, brand_color: preset.value }))}
              title={preset.name}
              style={{
                width: 36, height: 36,
                background: preset.value,
                border: isActive ? "2px solid var(--text)" : "2px solid var(--border2)",
                borderRadius: 8,
                cursor: "pointer",
                padding: 0,
                position: "relative",
                outline: "none"
              }}
            >
              {isActive && (
                <span style={{
                  position: "absolute", top: "50%", left: "50%",
                  transform: "translate(-50%, -50%)",
                  color: "#fff", fontSize: 14, fontWeight: 700,
                  textShadow: "0 0 4px rgba(0,0,0,0.7)"
                }}>✓</span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 8 }}>
        Ou choisissez une couleur personnalisée :
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
        <input
          type="color"
          value={data.brand_color}
          onChange={(e) => setData((d) => ({ ...d, brand_color: e.target.value }))}
          style={{ width: 50, height: 36, border: "1px solid var(--border2)", borderRadius: 6, cursor: "pointer", background: "transparent" }}
        />
        <input
          className="form-input mono"
          style={{ width: 120, textTransform: "uppercase" }}
          value={data.brand_color}
          onChange={(e) => setData((d) => ({ ...d, brand_color: e.target.value }))}
        />
        <button className="btn btn-primary btn-sm" onClick={saveColor} disabled={saving || data.brand_color === (company.brand_color || "#d4a843")}>
          {saving ? "..." : "Enregistrer"}
        </button>
      </div>
    </div>
  );
}

/* ─── Abonnement ─────────────────────────────────────── */
function BillingTab({ token, company, setCompany }) {
  async function openPortal() {
    try {
      const r = await fetch("/api/stripe-portal", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
      });
      const j = await r.json();
      if (j?.url) window.location.href = j.url;
      else alert("API non câblée. À implémenter dans api/stripe-portal.js");
    } catch {
      alert("API non câblée.");
    }
  }

  async function startCheckout() {
    try {
      const r = await fetch("/api/stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ company_id: company.id, plan: "pro_monthly" })
      });
      const j = await r.json();
      if (j?.url) window.location.href = j.url;
      else alert("API non câblée. À implémenter dans api/stripe.js");
    } catch {
      alert("API non câblée.");
    }
  }

  const trial = company.trial_ends_at ? new Date(company.trial_ends_at) > new Date() : false;
  const daysLeft = trial ? Math.ceil((new Date(company.trial_ends_at) - new Date()) / 86400000) : 0;

  return (
    <div className="card card-pad">
      <SectionTitle>Plan actuel</SectionTitle>
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontFamily: "Syne, sans-serif", fontSize: 22, fontWeight: 700, color: "var(--gold)", marginBottom: 4 }}>
          {company.sub_status === "active" ? "Pro · 9,90 €/mois" : trial ? "Essai gratuit" : "Découverte"}
        </div>
        {company.sub_status === "active" && company.subscribed_at && (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            Abonné depuis le {fmtDate(company.subscribed_at)}
          </div>
        )}
        {trial && (
          <div style={{ fontSize: 12, color: "var(--orange)", marginTop: 4 }}>
            Essai gratuit · {daysLeft} jour{daysLeft > 1 ? "s" : ""} restant{daysLeft > 1 ? "s" : ""}
          </div>
        )}
        {company.payment_failed_at && (
          <div className="auth-error" style={{ marginTop: 8 }}>
            ⚠️ Le dernier paiement a échoué le {fmtDate(company.payment_failed_at)}. Mettez à jour votre moyen de paiement.
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {company.sub_status === "active" ? (
          <button className="btn btn-ghost" onClick={openPortal}>
            Gérer mon abonnement (Stripe Portal)
          </button>
        ) : (
          <button className="btn btn-primary" onClick={startCheckout}>
            S'abonner — 9,90 €/mois
          </button>
        )}
      </div>

      <div style={{ marginTop: 24, paddingTop: 18, borderTop: "1px solid var(--border2)" }}>
        <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>
          Inclus dans Pro
        </div>
        <div style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.7 }}>
          ✅ Devis, factures Factur-X et avoirs illimités<br />
          ✅ CRM Clients complet · ✅ Achats avec OCR Mistral<br />
          ✅ TVA, URSSAF, FEC · ✅ Lettrage bancaire PSD2<br />
          ✅ Signature électronique · ✅ Portail client<br />
          ✅ PWA installable · ✅ Conformité 2026/2027
        </div>
      </div>
    </div>
  );
}

/* ─── Notifications ─────────────────────────────────── */
function NotificationsTab({ token, company }) {
  const [prefs, setPrefs] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [msg, setMsg] = useState("");

  // Liste des types de notifications avec metadata UI
  const NOTIF_TYPES = [
    {
      key: "quote_accepted",
      icon: "✍️",
      title: "Devis accepté par un client",
      desc: "Quand un client signe un devis sur la page publique",
      defaultEmail: true
    },
    {
      key: "quote_refused",
      icon: "❌",
      title: "Devis refusé par un client",
      desc: "Quand un client refuse un devis (avec motif s'il y en a)",
      defaultEmail: true
    },
    {
      key: "quote_viewed",
      icon: "👁",
      title: "Devis/facture consulté",
      desc: "Quand un client ouvre le lien public pour la première fois",
      defaultEmail: false
    },
    {
      key: "invoice_payment_clicked",
      icon: "💳",
      title: "Clic sur paiement",
      desc: "Quand un client clique sur le bouton de paiement en ligne",
      defaultEmail: false
    },
    {
      key: "invoice_issued",
      icon: "🔒",
      title: "Facture émise",
      desc: "Quand vous émettez une facture (verrouillage + Factur-X)",
      defaultEmail: false
    },
    {
      key: "invoice_pdp_transmitted",
      icon: "🏛️",
      title: "Facture transmise à l'administration",
      desc: "Quand une facture est envoyée via votre PDP",
      defaultEmail: true
    },
    {
      key: "invoice_overdue",
      icon: "⚠️",
      title: "Facture en retard",
      desc: "Quand une facture dépasse sa date d'échéance",
      defaultEmail: true
    },
    {
      key: "quote_expiring_soon",
      icon: "📅",
      title: "Devis bientôt expiré",
      desc: "Quand un devis envoyé approche de sa date de validité (3 jours)",
      defaultEmail: false
    },
    {
      key: "vat_threshold_warning",
      icon: "🎯",
      title: "Seuil franchise TVA",
      desc: "Quand vous approchez du seuil de franchise (80%, 90%, 100%)",
      defaultEmail: true
    },
    {
      key: "vat_declaration_due",
      icon: "📊",
      title: "Échéance déclaration TVA",
      desc: "7 jours avant la date de déclaration TVA (CA3)",
      defaultEmail: true
    },
    {
      key: "urssaf_due",
      icon: "📊",
      title: "Échéance URSSAF",
      desc: "5 jours avant la date d'échéance URSSAF",
      defaultEmail: true
    },
    {
      key: "client_created",
      icon: "🆕",
      title: "Nouveau client créé",
      desc: "Quand un client est ajouté à votre annuaire",
      defaultEmail: false
    }
  ];

  useEffect(() => {
    let alive = true;
    (async () => {
      const rows = await sb.select(token, "notification_preferences", {
        filter: `company_id=eq.${company.id}`
      });
      if (!alive) return;
      const map = {};
      (rows || []).forEach((r) => { map[r.notif_type] = { in_app: r.in_app, email: r.email }; });
      // Defaut pour les types non encore en base
      NOTIF_TYPES.forEach((t) => {
        if (!map[t.key]) {
          map[t.key] = { in_app: true, email: t.defaultEmail };
        }
      });
      setPrefs(map);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  async function toggle(type, channel) {
    setSaving(type + "-" + channel);
    const current = prefs[type] || { in_app: true, email: false };
    const next = { ...current, [channel]: !current[channel] };

    // Upsert : on supprime puis on cree (PostgREST n'a pas d'UPSERT simple sans on conflict)
    // On utilise plutot insert avec on_conflict
    try {
      const r = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/notification_preferences?on_conflict=company_id,notif_type`,
        {
          method: "POST",
          headers: {
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=representation"
          },
          body: JSON.stringify({
            company_id: company.id,
            notif_type: type,
            in_app: next.in_app,
            email: next.email,
            updated_at: new Date().toISOString()
          })
        }
      );
      if (r.ok) {
        setPrefs((p) => ({ ...p, [type]: next }));
        setMsg("✓ Préférence enregistrée");
        setTimeout(() => setMsg(""), 2000);
      } else {
        setMsg("Erreur enregistrement");
      }
    } catch (e) {
      setMsg("Erreur : " + e.message);
    }
    setSaving(null);
  }

  if (loading) {
    return <div className="card card-pad" style={{ textAlign: "center", color: "var(--muted)" }}>Chargement...</div>;
  }

  return (
    <div className="card card-pad">
      {msg && (
        <div className={msg.startsWith("✓") ? "auth-success" : "auth-error"} style={{ marginBottom: 16 }}>
          {msg}
        </div>
      )}

      <SectionTitle>Notifications</SectionTitle>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 18, lineHeight: 1.5 }}>
        Choisissez les notifications que vous souhaitez recevoir et par quel canal.
        <br />
        <strong style={{ color: "var(--gold)" }}>🔔 Dans l'app</strong> : affiché dans la cloche en haut à gauche.
        <br />
        <strong style={{ color: "var(--gold)" }}>📧 Email</strong> : envoyé à votre adresse email.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {NOTIF_TYPES.map((t) => {
          const p = prefs[t.key] || { in_app: true, email: false };
          return (
            <div
              key={t.key}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto auto",
                gap: 16,
                alignItems: "center",
                padding: "12px 14px",
                background: "var(--card2)",
                border: "1px solid var(--border)",
                borderRadius: 8
              }}
            >
              <div style={{ fontSize: 22, lineHeight: 1 }}>{t.icon}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{t.title}</div>
                <div style={{ fontSize: 11, color: "var(--muted2)", lineHeight: 1.4 }}>{t.desc}</div>
              </div>
              <ToggleSwitch
                checked={p.in_app}
                onChange={() => toggle(t.key, "in_app")}
                disabled={saving === t.key + "-in_app"}
                label="🔔"
                title="Notification dans l'app"
              />
              <ToggleSwitch
                checked={p.email}
                onChange={() => toggle(t.key, "email")}
                disabled={saving === t.key + "-email"}
                label="📧"
                title="Email"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToggleSwitch({ checked, onChange, disabled, label, title }) {
  return (
    <label
      title={title}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
        cursor: disabled ? "wait" : "pointer", opacity: disabled ? 0.5 : 1,
        minWidth: 38
      }}
    >
      <span style={{ fontSize: 14 }}>{label}</span>
      <span style={{
        position: "relative", display: "inline-block",
        width: 32, height: 18,
        background: checked ? "var(--gold)" : "var(--border2)",
        borderRadius: 10, transition: "background 0.2s"
      }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          style={{ opacity: 0, position: "absolute", inset: 0, cursor: "inherit" }}
        />
        <span style={{
          position: "absolute",
          top: 2, left: checked ? 16 : 2,
          width: 14, height: 14,
          background: "#fff", borderRadius: "50%",
          transition: "left 0.2s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.3)"
        }} />
      </span>
    </label>
  );
}

/* ─── Sécurité ──────────────────────────────────────── */
function SecurityTab({ token, user, onSignOut }) {
  const t = useT();
  const { lang } = useLang();
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState("");
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState("");

  // Check push status au montage
  React.useEffect(() => {
    if (pushSupported()) {
      isPushSubscribed().then(setPushOn);
    }
  }, []);

  function switchLang(newLang) {
    setLang(newLang);
  }

  async function togglePush() {
    setPushErr(""); setPushBusy(true);
    try {
      if (pushOn) {
        await disablePush(token);
        setPushOn(false);
      } else {
        await enablePush(token);
        setPushOn(true);
      }
    } catch (e) {
      setPushErr(e.message);
    }
    setPushBusy(false);
  }

  async function changePassword() {
    setMsg("");
    if (!pw1 || pw1.length < 8) { setMsg("Mot de passe : 8 caractères min"); return; }
    if (pw1 !== pw2) { setMsg("Les mots de passe ne correspondent pas"); return; }
    const r = await sb.updateUserPassword(token, pw1);
    if (r.ok) { setMsg("✓ Mot de passe modifié"); setPw1(""); setPw2(""); }
    else setMsg("Erreur : " + (r.data?.msg || "réessayez"));
  }

  async function deleteAccount() {
    if (!confirm("Supprimer définitivement votre compte et toutes vos données ?\n\nCette action est IRRÉVERSIBLE.")) return;
    if (!confirm("Confirmer la suppression définitive ? Toutes les factures, clients, données seront purgés.")) return;
    try {
      await fetch("/api/delete-account", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      onSignOut();
    } catch {
      alert("API non câblée. À implémenter dans api/delete-account.js");
    }
  }

  return (
    <div className="card card-pad">
      <SectionTitle>Compte</SectionTitle>
      <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 18 }}>
        Email : <span className="mono" style={{ color: "var(--text)" }}>{user?.email}</span>
      </div>

      <SectionTitle>Changer le mot de passe</SectionTitle>
      {msg && (
        <div className={msg.startsWith("✓") ? "auth-success" : "auth-error"} style={{ marginBottom: 14 }}>
          {msg}
        </div>
      )}
      <div className="form-row">
        <label className="form-label">Nouveau mot de passe</label>
        <input type="password" className="form-input" value={pw1} onChange={(e) => setPw1(e.target.value)} />
      </div>
      <div className="form-row">
        <label className="form-label">Confirmer</label>
        <input type="password" className="form-input" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </div>
      <button className="btn btn-primary" onClick={changePassword}>Modifier le mot de passe</button>

      {/* Langue + tour */}
      <div style={{ marginTop: 28, paddingTop: 18, borderTop: "1px solid var(--border2)" }}>
        <SectionTitle>{t("Langue") || "Langue de l'interface"}</SectionTitle>
        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          <button
            className={lang === "fr" ? "btn btn-primary" : "btn btn-ghost"}
            onClick={() => switchLang("fr")}
          >
            🇫🇷 Français
          </button>
          <button
            className={lang === "en" ? "btn btn-primary" : "btn btn-ghost"}
            onClick={() => switchLang("en")}
          >
            🇬🇧 English
          </button>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={resetTour}>
          🎓 {t("Relancer la visite guidée") || "Relancer la visite guidée"}
        </button>
      </div>

      {/* Notifications push */}
      {pushSupported() && (
        <div style={{ marginTop: 28, paddingTop: 18, borderTop: "1px solid var(--border2)" }}>
          <SectionTitle>🔔 Notifications push</SectionTitle>
          <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 14, lineHeight: 1.6 }}>
            Recevez les paiements clients, factures payées et alertes même app fermée. Compatible Chrome, Firefox, Safari iOS 16.4+.
          </div>
          {pushErr && <div className="auth-error" style={{ marginBottom: 10 }}>{pushErr}</div>}
          <button
            className={pushOn ? "btn btn-danger" : "btn btn-primary"}
            onClick={togglePush}
            disabled={pushBusy}
          >
            {pushBusy ? "..." : pushOn ? "Désactiver" : "Activer les notifications"}
          </button>
        </div>
      )}

      <div style={{ marginTop: 28, paddingTop: 18, borderTop: "1px solid rgba(229,92,92,0.2)" }}>
        <SectionTitle style={{ color: "var(--red)" }}>Zone dangereuse</SectionTitle>
        <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 14, lineHeight: 1.6 }}>
          La suppression du compte purge toutes vos données conformément au RGPD : factures, clients, achats, déclarations. Les exports comptables doivent être conservés 10 ans selon la loi — pensez à les télécharger avant suppression.
        </div>
        <button className="btn btn-danger" onClick={deleteAccount}>
          <Icon name="trash" size={14} /> Supprimer définitivement le compte
        </button>
      </div>

      <div style={{ marginTop: 28, paddingTop: 18, borderTop: "1px solid var(--border2)" }}>
        <button className="btn btn-ghost" onClick={onSignOut}>
          <Icon name="logout" size={14} /> Se déconnecter
        </button>
      </div>
    </div>
  );
}

/* ─── Helpers UI ──────────────────────────────────────── */
function SectionTitle({ children, style }) {
  return (
    <div style={{
      fontFamily: "Syne, sans-serif",
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      marginBottom: 12,
      color: "var(--text)",
      ...style
    }}>
      {children}
    </div>
  );
}

function Field({ label, value, onChange, type = "text", placeholder, full }) {
  return (
    <div className="form-row" style={full ? { gridColumn: "1 / -1" } : undefined}>
      <label className="form-label">{label}</label>
      <input
        type={type}
        className="form-input"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <div className="form-row">
      <label className="form-label">{label}</label>
      <select className="form-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

/* ─── INBOX OCR (V1.1) ─────────────────────────────────── */
function InboxTab({ token, company, setCompany }) {
  const [enabled, setEnabled] = useState(!!company.inbox_enabled);
  const [recent, setRecent] = useState([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  React.useEffect(() => {
    sb.select(token, "inbox_messages", {
      filter: `company_id=eq.${company.id}`,
      order: "received_at.desc",
      limit: 10
    }).then((list) => setRecent(list || []));
  }, [token, company.id]);

  async function toggle() {
    setSaving(true); setMsg("");
    const updated = await sb.update(token, "companies", `id=eq.${company.id}`, { inbox_enabled: !enabled });
    if (updated && updated[0]) {
      setEnabled(!enabled);
      setCompany(updated[0]);
      setMsg(!enabled ? "Inbox activée — vous pouvez envoyer vos factures à l'adresse ci-dessous" : "Inbox désactivée");
    }
    setSaving(false);
  }

  async function copyAlias() {
    if (!company.inbox_alias) return;
    try { await navigator.clipboard.writeText(company.inbox_alias); setMsg("Adresse copiée !"); } catch {}
  }

  return (
    <div>
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <h3 style={{ margin: "0 0 10px", fontFamily: "Syne, sans-serif", letterSpacing: 1, fontSize: 14 }}>
          📧 Inbox email pour OCR achats
        </h3>
        <p style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.6 }}>
          Faites suivre vos factures fournisseurs reçues par email à votre adresse dédiée.
          IO BILL extrait automatiquement les montants via OCR Mistral et crée un brouillon d'achat.
        </p>

        {company.inbox_alias && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, marginBottom: 14 }}>
            <code style={{
              background: "var(--card2)", padding: "10px 14px", borderRadius: 7,
              fontFamily: "DM Mono, monospace", fontSize: 13, color: "var(--gold)", flex: 1
            }}>
              {company.inbox_alias}
            </code>
            <button className="btn btn-ghost btn-sm" onClick={copyAlias}>📋 Copier</button>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
          <button className={enabled ? "btn btn-danger" : "btn btn-primary"} onClick={toggle} disabled={saving}>
            {saving ? "..." : (enabled ? "Désactiver l'inbox" : "Activer l'inbox")}
          </button>
          <span style={{
            display: "inline-block", padding: "4px 10px", borderRadius: 12,
            fontSize: 11, fontWeight: 600, letterSpacing: 1.5, textTransform: "uppercase",
            background: enabled ? "rgba(62, 207, 122, 0.15)" : "rgba(107, 106, 122, 0.15)",
            color: enabled ? "var(--green)" : "var(--muted)"
          }}>
            {enabled ? "Activée" : "Inactive"}
          </span>
        </div>
        {msg && <div className="tipline" style={{ marginTop: 12 }}>{msg}</div>}

        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 16, lineHeight: 1.7 }}>
          <strong>Comment ça marche :</strong><br />
          1. Ajoutez l'adresse ci-dessus à vos contacts<br />
          2. Faites suivre les emails de factures fournisseurs à cette adresse<br />
          3. IO BILL extrait les données par OCR et crée un brouillon dans <em>Achats</em><br />
          4. Vérifiez et validez l'achat
        </div>
      </div>

      {/* Derniers emails reçus */}
      {recent.length > 0 && (
        <div className="card card-pad">
          <h3 style={{ margin: "0 0 10px", fontFamily: "Syne, sans-serif", letterSpacing: 1, fontSize: 13 }}>
            10 derniers emails reçus
          </h3>
          <table>
            <thead>
              <tr>
                <th>Reçu</th>
                <th>Expéditeur</th>
                <th>Sujet</th>
                <th style={{ textAlign: "right" }}>PJ</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((m) => (
                <tr key={m.id}>
                  <td className="mono" style={{ fontSize: 11 }}>{fmtDate(m.received_at)}</td>
                  <td style={{ fontSize: 12 }}>{m.sender_email || "—"}</td>
                  <td style={{ fontSize: 12, color: "var(--muted2)" }}>{(m.subject || "—").slice(0, 40)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{m.attachment_count}</td>
                  <td>
                    <span className={"badge " + (m.status === "processed" ? "badge-green" : m.status === "received" ? "badge-gold" : "badge-muted")}>
                      {m.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─── PDP (V1.1) ──────────────────────────────────────── */
function PdpTab({ token, company, setCompany }) {
  const [data, setData] = useState({
    pdp_enabled: !!company.pdp_enabled,
    pdp_provider: company.pdp_provider || "ppf_test",
    pdp_account_id: company.pdp_account_id || "",
    pdp_api_key: ""
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  function update(k, v) { setData((d) => ({ ...d, [k]: v })); }

  async function save() {
    setSaving(true); setMsg("");
    const payload = {
      pdp_enabled: data.pdp_enabled,
      pdp_provider: data.pdp_provider,
      pdp_account_id: data.pdp_account_id || null
    };
    // L'API key n'est mise à jour que si fournie (sinon on garde l'existante)
    if (data.pdp_api_key) {
      payload.pdp_api_key_encrypted = data.pdp_api_key; // V1.1 : stockage en clair, V1.2 : Vault
    }
    const updated = await sb.update(token, "companies", `id=eq.${company.id}`, payload);
    if (updated && updated[0]) {
      setCompany(updated[0]);
      setMsg("Configuration PDP enregistrée");
      setData((d) => ({ ...d, pdp_api_key: "" })); // on efface le champ pour la sécurité
    }
    setSaving(false);
  }

  return (
    <div className="card card-pad">
      <h3 style={{ margin: "0 0 10px", fontFamily: "Syne, sans-serif", letterSpacing: 1, fontSize: 14 }}>
        🏛️ Plateforme de Dématérialisation Partenaire (PDP)
      </h3>
      <p style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.6, marginBottom: 16 }}>
        À partir de septembre 2026, toutes les entreprises FR doivent recevoir leurs factures via une PDP certifiée.
        À partir de septembre 2027, l'émission devient obligatoire pour toutes les entreprises FR.
        IO BILL transmet automatiquement vos factures Factur-X au PDP de votre choix.
      </p>

      <div className="form-row">
        <label className="form-label">Activer la transmission PDP</label>
        <input
          type="checkbox"
          checked={data.pdp_enabled}
          onChange={(e) => update("pdp_enabled", e.target.checked)}
          style={{ width: 18, height: 18, accentColor: "var(--gold)" }}
        />
      </div>

      <div className="form-row" style={{ marginTop: 14 }}>
        <label className="form-label">Provider</label>
        <select className="form-input" value={data.pdp_provider} onChange={(e) => update("pdp_provider", e.target.value)}>
          <option value="ppf_test">PPF Test (sandbox DGFiP, gratuit)</option>
          <option value="iopole">Iopole (FR, certifiée)</option>
          <option value="generix">Generix (V1.2)</option>
          <option value="cegid">Cegid (V1.2)</option>
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
        <div className="form-row">
          <label className="form-label">Account ID PDP</label>
          <input
            className="form-input mono"
            value={data.pdp_account_id}
            onChange={(e) => update("pdp_account_id", e.target.value)}
            placeholder="Identifiant fourni par le PDP"
          />
        </div>
        <div className="form-row">
          <label className="form-label">API Key</label>
          <input
            className="form-input mono"
            type="password"
            value={data.pdp_api_key}
            onChange={(e) => update("pdp_api_key", e.target.value)}
            placeholder={company.pdp_api_key_encrypted ? "•••••••••• (clé enregistrée)" : "Clé API PDP"}
          />
        </div>
      </div>

      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 14, lineHeight: 1.7 }}>
        En mode <strong>PPF Test</strong>, les transmissions sont simulées (pas de vrai envoi).
        En mode <strong>Iopole</strong>, vos factures sont réellement transmises selon les standards
        de l'Article 289 bis du CGI (Factur-X CII profil BASIC WL).
      </div>

      <button className="btn btn-primary" onClick={save} disabled={saving} style={{ marginTop: 18 }}>
        {saving ? "Enregistrement..." : "Enregistrer la configuration"}
      </button>
      {msg && <div className="tipline" style={{ marginTop: 12 }}>{msg}</div>}
    </div>
  );
}

/* ─── SMS (V1.1) ──────────────────────────────────────── */
function SmsTab({ token, company, setCompany }) {
  const [enabled, setEnabled] = useState(!!company.sms_enabled);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const count = company.sms_count_month || 0;

  async function toggle() {
    setSaving(true); setMsg("");
    const updated = await sb.update(token, "companies", `id=eq.${company.id}`, { sms_enabled: !enabled });
    if (updated && updated[0]) {
      setEnabled(!enabled);
      setCompany(updated[0]);
      setMsg(!enabled ? "SMS activés — les relances tardives (J+30, J+60) seront envoyées par SMS si le client a un numéro" : "SMS désactivés");
    }
    setSaving(false);
  }

  return (
    <div className="card card-pad">
      <h3 style={{ margin: "0 0 10px", fontFamily: "Syne, sans-serif", letterSpacing: 1, fontSize: 14 }}>
        📱 Relances SMS
      </h3>
      <p style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.6, marginBottom: 16 }}>
        En complément des emails, IO BILL peut envoyer des SMS de relance pour les factures
        en retard de plus de 30 jours, via OVH SMS. Coût indicatif : 0,06 €/SMS.
      </p>

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi">
          <div className="kpi-label">Statut</div>
          <div className={"kpi-val " + (enabled ? "green" : "")}>{enabled ? "Activé" : "Désactivé"}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">SMS envoyés ce mois</div>
          <div className="kpi-val gold">{count}</div>
          <div className="kpi-foot">≈ {(count * 0.06).toFixed(2)} €</div>
        </div>
      </div>

      <button className={enabled ? "btn btn-danger" : "btn btn-primary"} onClick={toggle} disabled={saving}>
        {saving ? "..." : (enabled ? "Désactiver les SMS" : "Activer les SMS")}
      </button>
      {msg && <div className="tipline" style={{ marginTop: 12 }}>{msg}</div>}

      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 18, lineHeight: 1.7 }}>
        <strong>Pré-requis :</strong> les variables OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY,
        OVH_SMS_SERVICE_NAME doivent être configurées côté serveur (Vercel).<br />
        Les SMS sont envoyés uniquement aux relances <em>second</em> (J+30) et <em>final</em> (J+60),
        et seulement si le client a un numéro de téléphone enregistré.
      </div>
    </div>
  );
}
