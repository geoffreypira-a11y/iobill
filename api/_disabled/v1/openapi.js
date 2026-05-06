// IO BILL - OpenAPI 3.0 spec for public API v1

import { json } from "../_lib/supabase-admin.js";

const SPEC = {
  openapi: "3.0.3",
  info: {
    title: "IO BILL Public API",
    version: "1.0.0",
    description: "API publique IO BILL pour intégration tierce. Authentification par clé API (Bearer token).",
    contact: { name: "OWL'S INDUSTRY", email: "support@iobill.fr" }
  },
  servers: [{ url: "https://iobill.fr/api/v1", description: "Production" }],
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: {
        type: "http",
        scheme: "bearer",
        description: "Format: `Bearer iobill_live_<prefix>_<secret>`. Générer une clé depuis Settings → API."
      }
    },
    schemas: {
      Client: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid", readOnly: true },
          type: { type: "string", enum: ["company", "individual"] },
          legal_name: { type: "string", nullable: true },
          first_name: { type: "string", nullable: true },
          last_name: { type: "string", nullable: true },
          email: { type: "string", format: "email", nullable: true },
          phone: { type: "string", nullable: true },
          siret: { type: "string", nullable: true, description: "14 chiffres si type=company" },
          vat_number: { type: "string", nullable: true, description: "ex: FR12345678901" },
          address_line1: { type: "string", nullable: true },
          postal_code: { type: "string", nullable: true },
          city: { type: "string", nullable: true },
          country: { type: "string", default: "FR" },
          payment_terms_days: { type: "integer", default: 30 }
        },
        required: ["type"]
      },
      InvoiceLine: {
        type: "object",
        properties: {
          description: { type: "string" },
          quantity: { type: "number", default: 1 },
          unit: { type: "string", nullable: true },
          unit_price_ht: { type: "number", description: "Prix unitaire HT en EUROS (pas en cents)" },
          vat_rate: { type: "number", default: 20 },
          discount_pct: { type: "number", default: 0 }
        },
        required: ["description", "unit_price_ht"]
      },
      Invoice: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid", readOnly: true },
          number: { type: "string", readOnly: true, description: "Numéro alloué auto: FA-2025-0042" },
          status: { type: "string", enum: ["draft", "issued", "sent", "partial", "paid", "overdue", "canceled"] },
          client_id: { type: "string", format: "uuid" },
          issue_date: { type: "string", format: "date" },
          due_date: { type: "string", format: "date" },
          currency: { type: "string", default: "EUR" },
          subtotal_ht_cents: { type: "integer", readOnly: true },
          vat_total_cents: { type: "integer", readOnly: true },
          total_ttc_cents: { type: "integer", readOnly: true },
          paid_cents: { type: "integer", readOnly: true },
          notes: { type: "string", nullable: true },
          terms: { type: "string", nullable: true },
          pdf_url: { type: "string", readOnly: true, nullable: true },
          facturx_xml_url: { type: "string", readOnly: true, nullable: true },
          public_token: { type: "string", readOnly: true, nullable: true }
        }
      },
      InvoiceCreate: {
        type: "object",
        properties: {
          client_id: { type: "string", format: "uuid" },
          lines: { type: "array", items: { $ref: "#/components/schemas/InvoiceLine" }, minItems: 1 },
          due_date: { type: "string", format: "date", nullable: true, description: "Si omis, calculé via payment_terms_days du client" },
          issue: { type: "boolean", default: false, description: "Si true, émet directement la facture (status=issued)" },
          currency: { type: "string", default: "EUR" },
          vat_category: { type: "string", default: "standard" },
          notes: { type: "string", nullable: true },
          terms: { type: "string", nullable: true }
        },
        required: ["client_id", "lines"]
      },
      Error: {
        type: "object",
        properties: {
          error: { type: "string" }
        }
      }
    }
  },
  paths: {
    "/clients": {
      get: {
        summary: "Liste des clients",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } }
        ],
        responses: {
          200: {
            description: "OK",
            content: { "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: { type: "array", items: { $ref: "#/components/schemas/Client" } },
                  meta: { type: "object", properties: { count: { type: "integer" }, limit: { type: "integer" } } }
                }
              }
            } }
          },
          401: { $ref: "#/components/responses/Unauthorized" }
        }
      },
      post: {
        summary: "Créer un client",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Client" } } }
        },
        responses: {
          201: { description: "Client créé", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Client" } } } } } },
          400: { $ref: "#/components/responses/BadRequest" },
          401: { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/invoices": {
      get: {
        summary: "Liste des factures",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
          { name: "status", in: "query", schema: { type: "string", enum: ["draft", "issued", "sent", "partial", "paid", "overdue", "canceled"] } }
        ],
        responses: { 200: { description: "OK" } }
      },
      post: {
        summary: "Créer une facture",
        description: "Calcule les totaux et alloue un numéro automatiquement. Par défaut en brouillon — passez `?issue=1` pour émettre immédiatement.",
        parameters: [
          { name: "issue", in: "query", schema: { type: "string", enum: ["1"] }, description: "Si présent, émet directement" }
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/InvoiceCreate" } } }
        },
        responses: {
          201: { description: "Facture créée", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Invoice" } } } } } },
          400: { $ref: "#/components/responses/BadRequest" },
          401: { $ref: "#/components/responses/Unauthorized" },
          429: { description: "Rate limit dépassé" }
        }
      }
    }
  }
};

// Reponses partagees
SPEC.components.responses = {
  Unauthorized: {
    description: "Clé API invalide ou révoquée",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
  },
  BadRequest: {
    description: "Requête mal formée",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
  }
};

export default function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");
  return json(res, 200, SPEC);
}
