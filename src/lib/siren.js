// ═══════════════════════════════════════════════════════════════════
// Recherche d'entreprise par SIREN / SIRET
//
// v8.174 — Porté depuis IO Car, où il sert déjà au CRM, à la Flotte et au
// Livre de Police. Saisir un SIRET suffit à remplir raison sociale, adresse
// et n° de TVA : sur un client B2B saisi à la main, c'est autant de champs
// en moins et autant d'occasions de faute en moins — ils partent tels quels
// sur la facture puis dans le Factur-X transmis.
//
// API publique recherche-entreprises.api.gouv.fr (annuaire des entreprises,
// data.gouv.fr) : gratuite, sans clé, ~7 req/s. Elle sert la base SIRENE de
// l'INSEE : la raison sociale et l'adresse sont donc celles du registre.
// ═══════════════════════════════════════════════════════════════════

const API = "https://recherche-entreprises.api.gouv.fr/search";

/** Ne garde que les chiffres, au plus 14 (longueur d'un SIRET). */
export function cleanSiren(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 14);
}

/** Un SIREN fait 9 chiffres, un SIRET 14 : hors de là, rien à chercher. */
export function isSirenSearchable(value) {
  const n = cleanSiren(value).length;
  return n === 9 || n === 14;
}

/**
 * N° de TVA intracommunautaire français, déduit du SIREN.
 * Clé = (12 + 3 × (SIREN mod 97)) mod 97, formule officielle DGFiP : elle est
 * arithmétique, donc calculable sans appel réseau.
 *
 * Vaut pour l'immense majorité des entreprises françaises, mais la DGFiP peut
 * attribuer une clé non standard (cas rares, sociétés non résidentes). On ne
 * pré-remplit donc que les champs laissés vides, et la valeur reste modifiable :
 * en cas de doute, VIES (ec.europa.eu) fait foi — ce numéro figure sur la
 * facture et dans le Factur-X, il mérite une vérification.
 */
export function tvaIntraFR(siren) {
  const s = cleanSiren(siren).slice(0, 9);
  if (s.length !== 9) return "";
  const key = (12 + 3 * (Number(s) % 97)) % 97;
  return `FR${String(key).padStart(2, "0")}${s}`;
}

// L'API renvoie une adresse complète en une ligne (« 12 RUE DE LA PAIX 13000
// MARSEILLE »). Les formulaires ont un champ rue et des champs CP / ville
// séparés : on reconstruit la rue depuis les composants quand ils existent,
// sinon on retire la fin « CP COMMUNE » de la ligne complète.
function streetLine(etab) {
  if (!etab) return "";
  const composed = [etab.complement_adresse, etab.numero_voie, etab.indice_repetition, etab.type_voie, etab.libelle_voie]
    .filter(Boolean).join(" ").trim();
  if (composed) return composed;
  const full = String(etab.adresse || "").trim();
  if (!full) return "";
  const cp = String(etab.code_postal || "").trim();
  if (!cp) return full;
  const cut = full.indexOf(cp);
  return cut > 0 ? full.slice(0, cut).trim() : full;
}

// Le registre écrit en majuscules et c'est cette forme qui fait foi sur un
// document officiel : on ne recapitalise pas, on normalise juste les espaces.
function tidy(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/**
 * Interroge l'annuaire des entreprises.
 *
 * @param {string} input  SIREN (9 chiffres) ou SIRET (14)
 * @returns {Promise<{ok: boolean, error?: string, data?: object}>}
 *   data : { raison_sociale, siren, siret, adresse, code_postal, ville, pays,
 *            tva_intra, forme_juridique, activite, ferme }
 *
 * Ne lève jamais : l'appelant affiche `error` et laisse la saisie manuelle
 * reprendre la main. Une recherche qui échoue ne doit rien casser.
 */
export async function lookupEntreprise(input) {
  const q = cleanSiren(input);
  if (!isSirenSearchable(q)) {
    return { ok: false, error: "Saisissez un SIREN (9 chiffres) ou un SIRET (14 chiffres)." };
  }
  let json;
  try {
    const r = await fetch(`${API}?q=${q}&per_page=1`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    json = await r.json();
  } catch (e) {
    return { ok: false, error: `Recherche indisponible (${e.message}). Saisie manuelle possible.` };
  }
  const ent = json?.results?.[0];
  if (!ent) {
    return { ok: false, error: `Aucune entreprise trouvée pour ${q}.` };
  }

  // Sur un SIRET on veut l'établissement demandé, pas le siège : c'est lui qui
  // a vendu le véhicule et c'est son adresse qui doit figurer au registre.
  const siege = ent.siege || {};
  const matching = Array.isArray(ent.matching_etablissements) ? ent.matching_etablissements : [];
  const etab = (q.length === 14 && matching.find(m => cleanSiren(m.siret) === q)) || siege;
  const siren = cleanSiren(ent.siren) || q.slice(0, 9);

  return {
    ok: true,
    data: {
      raison_sociale: tidy(ent.nom_complet || ent.nom_raison_sociale || ent.sigle),
      siren,
      siret: cleanSiren(etab.siret) || (q.length === 14 ? q : ""),
      adresse: tidy(streetLine(etab)),
      code_postal: tidy(etab.code_postal),
      ville: tidy(etab.libelle_commune || etab.commune),
      pays: "France",
      tva_intra: tvaIntraFR(siren),
      forme_juridique: tidy(ent.nature_juridique),
      activite: tidy(ent.libelle_activite_principale || ent.activite_principale),
      // etat_administratif : "A" active, "C" cessée. Une entreprise fermée
      // peut légitimement apparaître (véhicule acheté avant la radiation),
      // on le signale sans bloquer.
      ferme: (etab.etat_administratif || ent.etat_administratif) === "C",
    },
  };
}
