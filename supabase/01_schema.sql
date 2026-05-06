-- ═══════════════════════════════════════════════════════════════════════════
--  IO BILL — SCHEMA v1.0
--  Ordre d'exécution : 01_schema.sql → 02_security.sql → 03_functions.sql
--  À exécuter dans Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────
--  EXTENSIONS
-- ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ──────────────────────────────────────────────────────────────
--  COMPANIES (entreprise/profil utilisateur)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.companies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Identité
  legal_name TEXT NOT NULL,
  trade_name TEXT,
  legal_form TEXT,                              -- micro, ei, eurl, sasu, sarl, sas, sa, association, autre
  siret TEXT,
  rcs TEXT,
  vat_number TEXT,                              -- TVA intracom (vide si franchise)
  ape_code TEXT,
  -- Adresse
  address_line1 TEXT,
  address_line2 TEXT,
  postal_code TEXT,
  city TEXT,
  country TEXT DEFAULT 'FR',
  -- Contact
  email TEXT NOT NULL,
  phone TEXT,
  website TEXT,
  -- Régime fiscal
  vat_regime TEXT NOT NULL DEFAULT 'franchise', -- franchise, normal_monthly, normal_quarterly, simplified
  vat_default_rate NUMERIC(5,2) DEFAULT 20.00,
  micro_threshold NUMERIC(12,2),                -- seuil franchise selon activité (39 100 ou 101 000)
  micro_activity TEXT,                          -- bnc, bic_services, bic_vente
  urssaf_period TEXT DEFAULT 'monthly',         -- monthly, quarterly
  urssaf_rate NUMERIC(5,2),                     -- taux global (cotisations sociales) selon activité
  -- Numérotation
  invoice_number_prefix TEXT DEFAULT 'FAC',
  invoice_number_format TEXT DEFAULT '{prefix}-{year}-{seq:04}',
  invoice_next_seq INTEGER DEFAULT 1,
  invoice_seq_year INTEGER DEFAULT EXTRACT(YEAR FROM NOW())::INT,
  quote_number_prefix TEXT DEFAULT 'DEV',
  quote_next_seq INTEGER DEFAULT 1,
  quote_seq_year INTEGER DEFAULT EXTRACT(YEAR FROM NOW())::INT,
  credit_note_number_prefix TEXT DEFAULT 'AVO',
  credit_note_next_seq INTEGER DEFAULT 1,
  credit_note_seq_year INTEGER DEFAULT EXTRACT(YEAR FROM NOW())::INT,
  -- Branding
  logo_url TEXT,
  brand_color TEXT DEFAULT '#d4a843',
  -- Modules activés (objet JSON, valeurs booléennes)
  modules JSONB DEFAULT '{
    "invoicing": true,
    "quotes": true,
    "credit_notes": true,
    "purchases": true,
    "vat": false,
    "urssaf": true,
    "accounting": true,
    "banking": false,
    "client_portal": true,
    "esign": true
  }'::JSONB,
  -- Préférences UI
  ui_prefs JSONB DEFAULT '{}'::JSONB,
  -- Abonnement Stripe
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  sub_status TEXT,                              -- trialing, active, past_due, canceled, suspended
  trial_ends_at TIMESTAMPTZ,
  subscribed_at TIMESTAMPTZ,
  payment_failed_at TIMESTAMPTZ,
  -- Conformité
  rgpd_consent_at TIMESTAMPTZ,
  -- Méta
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_companies_user_id ON public.companies(user_id);
CREATE INDEX IF NOT EXISTS idx_companies_stripe_cust ON public.companies(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_companies_email ON public.companies(email);

-- ──────────────────────────────────────────────────────────────
--  CLIENTS (CRM complet)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Type
  client_type TEXT NOT NULL DEFAULT 'company', -- company, individual
  -- Nom / dénomination
  legal_name TEXT,                              -- raison sociale (B2B)
  first_name TEXT,                              -- B2C
  last_name TEXT,                               -- B2C
  -- Identifiants pro
  siret TEXT,
  vat_number TEXT,
  vat_validated_at TIMESTAMPTZ,                 -- date dernière vérif VIES
  vat_valid BOOLEAN,
  -- Contacts
  email TEXT,
  phone TEXT,
  contact_person TEXT,
  -- Adresse facturation
  address_line1 TEXT,
  address_line2 TEXT,
  postal_code TEXT,
  city TEXT,
  country TEXT DEFAULT 'FR',
  -- Adresse livraison (si différente)
  delivery_address_line1 TEXT,
  delivery_address_line2 TEXT,
  delivery_postal_code TEXT,
  delivery_city TEXT,
  delivery_country TEXT,
  -- CRM
  status TEXT NOT NULL DEFAULT 'prospect',     -- prospect, quote_sent, negotiation, customer, vip, inactive
  source TEXT,                                  -- bouche-à-oreille, site, linkedin, salon, autre
  tags TEXT[] DEFAULT '{}',
  notes TEXT,
  -- Conditions commerciales
  payment_terms_days INTEGER DEFAULT 30,        -- délai paiement par défaut
  default_vat_rate NUMERIC(5,2),
  default_currency TEXT DEFAULT 'EUR',
  discount_pct NUMERIC(5,2) DEFAULT 0,          -- remise habituelle
  -- Score interne
  payment_score TEXT DEFAULT 'normal',          -- fast, normal, slow, risky
  -- Méta
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_company_id ON public.clients(company_id);
CREATE INDEX IF NOT EXISTS idx_clients_status ON public.clients(company_id, status);
CREATE INDEX IF NOT EXISTS idx_clients_search ON public.clients USING GIN (
  to_tsvector('french', COALESCE(legal_name,'') || ' ' || COALESCE(first_name,'') || ' ' || COALESCE(last_name,'') || ' ' || COALESCE(email,''))
);

-- ──────────────────────────────────────────────────────────────
--  CLIENT_INTERACTIONS (notes, appels, relances datées)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_interactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                           -- note, call, email, meeting, reminder
  title TEXT,
  content TEXT,
  scheduled_at TIMESTAMPTZ,                     -- pour les rappels
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interactions_client ON public.client_interactions(client_id);
CREATE INDEX IF NOT EXISTS idx_interactions_company ON public.client_interactions(company_id);

-- ──────────────────────────────────────────────────────────────
--  QUOTES (devis)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.quotes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  number TEXT NOT NULL,                         -- DEV-2026-0001
  -- Snapshot client (pour conserver l'historique même si fiche modifiée après)
  client_snapshot JSONB NOT NULL,
  company_snapshot JSONB NOT NULL,
  -- Dates
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  validity_days INTEGER DEFAULT 30,
  expires_at DATE,
  -- Statut
  status TEXT NOT NULL DEFAULT 'draft',         -- draft, sent, signed, refused, expired, converted
  signed_at TIMESTAMPTZ,
  signed_ip TEXT,
  signature_provider TEXT,                      -- internal, yousign
  signature_ref TEXT,
  refused_at TIMESTAMPTZ,
  converted_invoice_id UUID,
  -- Totaux (en cents pour précision absolue)
  subtotal_ht_cents BIGINT DEFAULT 0,
  vat_total_cents BIGINT DEFAULT 0,
  total_ttc_cents BIGINT DEFAULT 0,
  discount_cents BIGINT DEFAULT 0,
  currency TEXT DEFAULT 'EUR',
  -- Contenu libre
  notes TEXT,
  terms TEXT,
  -- Fichiers
  pdf_url TEXT,
  -- Méta
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, number)
);

CREATE INDEX IF NOT EXISTS idx_quotes_company ON public.quotes(company_id);
CREATE INDEX IF NOT EXISTS idx_quotes_client ON public.quotes(client_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON public.quotes(company_id, status);

-- ──────────────────────────────────────────────────────────────
--  INVOICES (factures)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  quote_id UUID REFERENCES public.quotes(id) ON DELETE SET NULL,
  number TEXT NOT NULL,
  -- Snapshots (immuables après émission)
  client_snapshot JSONB NOT NULL,
  company_snapshot JSONB NOT NULL,
  -- Dates
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  payment_terms_days INTEGER,
  -- Statut
  status TEXT NOT NULL DEFAULT 'draft',         -- draft, issued, sent, partial, paid, overdue, canceled
  issued_at TIMESTAMPTZ,                        -- date d'émission définitive (verrouillage)
  -- Totaux (cents)
  subtotal_ht_cents BIGINT DEFAULT 0,
  vat_total_cents BIGINT DEFAULT 0,
  total_ttc_cents BIGINT DEFAULT 0,
  paid_cents BIGINT DEFAULT 0,
  discount_cents BIGINT DEFAULT 0,
  currency TEXT DEFAULT 'EUR',
  -- TVA détail (ventilation par taux)
  vat_breakdown JSONB DEFAULT '[]'::JSONB,      -- [{rate: 20, base_cents: X, vat_cents: Y}]
  -- Anti-fraude : chaîne de hashs (loi finances)
  content_hash TEXT,                            -- hash SHA-256 du contenu de la facture
  previous_hash TEXT,                           -- hash de la facture précédente (chaînage)
  -- Factur-X
  facturx_status TEXT DEFAULT 'pending',        -- pending, generated, transmitted, accepted, rejected
  facturx_pdf_url TEXT,
  facturx_xml_url TEXT,
  pdp_provider TEXT,                            -- nom du connecteur PDP
  pdp_transmission_id TEXT,
  pdp_transmitted_at TIMESTAMPTZ,
  -- Paiement
  stripe_payment_link_url TEXT,
  stripe_payment_intent_id TEXT,
  payment_method TEXT,
  -- Relances
  last_reminder_sent_at TIMESTAMPTZ,
  reminder_count INTEGER DEFAULT 0,
  -- Contenu libre
  notes TEXT,
  terms TEXT,
  -- Fichiers
  pdf_url TEXT,
  -- Méta
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_company ON public.invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON public.invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON public.invoices(company_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_due ON public.invoices(company_id, due_date) WHERE status IN ('issued','sent','partial','overdue');
CREATE INDEX IF NOT EXISTS idx_invoices_issued ON public.invoices(company_id, issued_at DESC);

-- ──────────────────────────────────────────────────────────────
--  DOCUMENT_LINES (lignes de devis OU facture OU avoir)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.document_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,                  -- quote, invoice, credit_note
  document_id UUID NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Contenu
  description TEXT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit TEXT,                                    -- u, h, j, kg, m, m², m³, etc.
  unit_price_ht_cents BIGINT NOT NULL DEFAULT 0,
  vat_rate NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  discount_pct NUMERIC(5,2) DEFAULT 0,
  -- Totaux ligne
  line_ht_cents BIGINT NOT NULL DEFAULT 0,
  line_vat_cents BIGINT NOT NULL DEFAULT 0,
  line_ttc_cents BIGINT NOT NULL DEFAULT 0,
  -- Méta
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lines_doc ON public.document_lines(document_type, document_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_lines_company ON public.document_lines(company_id);

-- ──────────────────────────────────────────────────────────────
--  CREDIT_NOTES (avoirs)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.credit_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  number TEXT NOT NULL,
  client_snapshot JSONB NOT NULL,
  company_snapshot JSONB NOT NULL,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft, issued
  subtotal_ht_cents BIGINT DEFAULT 0,
  vat_total_cents BIGINT DEFAULT 0,
  total_ttc_cents BIGINT DEFAULT 0,
  vat_breakdown JSONB DEFAULT '[]'::JSONB,
  content_hash TEXT,
  previous_hash TEXT,
  pdf_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, number)
);

CREATE INDEX IF NOT EXISTS idx_creditnotes_company ON public.credit_notes(company_id);
CREATE INDEX IF NOT EXISTS idx_creditnotes_invoice ON public.credit_notes(invoice_id);

-- ──────────────────────────────────────────────────────────────
--  PAYMENTS (encaissements et lettrage)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  amount_cents BIGINT NOT NULL,
  currency TEXT DEFAULT 'EUR',
  method TEXT,                                  -- bank_transfer, stripe, cash, check, other
  reference TEXT,                               -- numéro de chèque, libellé virement
  paid_at DATE NOT NULL DEFAULT CURRENT_DATE,
  -- Lettrage automatique PSD2
  bank_transaction_id TEXT,
  bank_account_id TEXT,
  match_confidence NUMERIC(3,2),                -- 0.00 - 1.00
  match_method TEXT,                            -- auto, manual, suggested
  -- Stripe
  stripe_charge_id TEXT,
  -- Méta
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_company ON public.payments(company_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON public.payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON public.payments(company_id, paid_at DESC);

-- ──────────────────────────────────────────────────────────────
--  PURCHASES (factures fournisseurs)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.purchases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Fournisseur (texte libre OU lien vers vendor)
  vendor_name TEXT NOT NULL,
  vendor_siret TEXT,
  vendor_vat_number TEXT,
  -- Doc
  number TEXT,                                  -- numéro fournisseur
  issue_date DATE,
  due_date DATE,
  -- Totaux (cents)
  subtotal_ht_cents BIGINT DEFAULT 0,
  vat_total_cents BIGINT DEFAULT 0,
  total_ttc_cents BIGINT DEFAULT 0,
  vat_breakdown JSONB DEFAULT '[]'::JSONB,
  currency TEXT DEFAULT 'EUR',
  -- Catégorisation
  category TEXT,                                -- libellé libre
  accounting_code TEXT,                         -- compte 6xxxxx
  -- Source
  source TEXT NOT NULL DEFAULT 'manual',        -- manual, email, ocr, api
  source_email_id TEXT,
  -- OCR
  ocr_status TEXT DEFAULT 'pending',            -- pending, processing, done, failed
  ocr_provider TEXT,                            -- mistral, tesseract
  ocr_confidence NUMERIC(3,2),
  ocr_raw JSONB,                                -- résultat brut
  -- Statut
  status TEXT NOT NULL DEFAULT 'pending',       -- pending, validated, paid, archived
  paid_at DATE,
  payment_method TEXT,
  -- Fichier
  file_url TEXT,                                -- bucket privé Supabase
  file_size INTEGER,
  file_mime TEXT,
  -- Méta
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchases_company ON public.purchases(company_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON public.purchases(company_id, status);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON public.purchases(company_id, issue_date DESC);

-- ──────────────────────────────────────────────────────────────
--  VAT_RETURNS (déclarations TVA)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vat_returns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  form_type TEXT NOT NULL,                      -- CA3, CA12
  -- Calculs (cents)
  collected_vat_cents BIGINT DEFAULT 0,
  deductible_vat_cents BIGINT DEFAULT 0,
  net_vat_cents BIGINT DEFAULT 0,
  taxable_base_cents BIGINT DEFAULT 0,
  -- Détail par taux
  breakdown JSONB DEFAULT '{}'::JSONB,
  -- Statut
  status TEXT NOT NULL DEFAULT 'draft',         -- draft, ready, declared, paid
  declared_at TIMESTAMPTZ,
  paid_at DATE,
  -- Snapshot des données prises en compte
  snapshot JSONB,
  pdf_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_vat_company ON public.vat_returns(company_id, period_start DESC);

-- ──────────────────────────────────────────────────────────────
--  URSSAF_RETURNS (déclarations URSSAF auto-entrepreneur)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.urssaf_returns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_type TEXT NOT NULL,                    -- monthly, quarterly
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  -- Calculs
  ca_encaisse_cents BIGINT DEFAULT 0,           -- CA encaissé sur la période
  cotisations_cents BIGINT DEFAULT 0,
  rate_applied NUMERIC(5,2),
  -- Statut
  status TEXT NOT NULL DEFAULT 'draft',
  declared_at TIMESTAMPTZ,
  paid_at DATE,
  snapshot JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_urssaf_company ON public.urssaf_returns(company_id, period_start DESC);

-- ──────────────────────────────────────────────────────────────
--  ACCOUNTING_EXPORTS (historique exports compta)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.accounting_exports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  format TEXT NOT NULL,                         -- fec, sage, cegid, ebp, csv, pennylane_api, tiime_api
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  file_url TEXT,
  file_size INTEGER,
  row_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending, ready, downloaded, sent
  generated_at TIMESTAMPTZ,
  downloaded_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exports_company ON public.accounting_exports(company_id, created_at DESC);

-- ──────────────────────────────────────────────────────────────
--  BANK_CONNECTIONS (PSD2 — Bridge/Powens)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bank_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                       -- bridge, powens
  external_id TEXT NOT NULL,
  bank_name TEXT,
  iban_last4 TEXT,
  status TEXT NOT NULL DEFAULT 'active',        -- active, expired, revoked
  consent_expires_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bankconn_company ON public.bank_connections(company_id);

-- ──────────────────────────────────────────────────────────────
--  BANK_TRANSACTIONS (mouvements rapatriés)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bank_connection_id UUID REFERENCES public.bank_connections(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,                    -- id côté agrégateur
  amount_cents BIGINT NOT NULL,                 -- positif = crédit, négatif = débit
  currency TEXT DEFAULT 'EUR',
  description TEXT,
  counterparty TEXT,
  transaction_date DATE NOT NULL,
  -- Lettrage
  matched_invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  matched_purchase_id UUID REFERENCES public.purchases(id) ON DELETE SET NULL,
  match_confidence NUMERIC(3,2),
  match_status TEXT DEFAULT 'unmatched',        -- unmatched, suggested, matched, ignored
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_banktx_company ON public.bank_transactions(company_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_banktx_match ON public.bank_transactions(company_id, match_status);

-- ──────────────────────────────────────────────────────────────
--  AUDIT_LOG (append-only, conformité légale)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL,
  user_id UUID,
  table_name TEXT NOT NULL,
  record_id UUID,
  action TEXT NOT NULL,                         -- INSERT, UPDATE, DELETE, ISSUE, CANCEL
  old_data JSONB,
  new_data JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_company ON public.audit_log(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_record ON public.audit_log(table_name, record_id);

-- ──────────────────────────────────────────────────────────────
--  TRIGGERS UPDATED_AT
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END $$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['companies','clients','quotes','invoices','credit_notes','purchases','vat_returns','urssaf_returns'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_touch ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', t, t);
  END LOOP;
END $$;

-- FIN 01_schema.sql
