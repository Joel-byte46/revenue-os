-- ============================================================
-- REVENUE OS — SCHEMA COMPLET
-- Migration 001 : Toutes les tables
-- Ordre : extensions → core → business → ai → utility
-- ============================================================

-- ------------------------------------------------------------
-- EXTENSIONS
-- ------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_net";      -- HTTP calls depuis pg_cron

-- ------------------------------------------------------------
-- CORE : TENANTS
-- Un tenant = une entreprise cliente
-- ------------------------------------------------------------

CREATE TABLE tenants (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                TEXT,
  status              TEXT NOT NULL DEFAULT 'trial',
  -- trial | active | suspended | cancelled
  vertical            TEXT NOT NULL DEFAULT 'saas',
  -- saas | ecom
  timezone            TEXT NOT NULL DEFAULT 'Europe/Paris',
  currency            TEXT NOT NULL DEFAULT 'EUR',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  settings            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- {
  --   crm_field_mapping: { "Gagné !": "closed_won", ... },
  --   stage_thresholds: { "proposal_sent": 14, ... },
  --   target_industries: ["SaaS", "FinTech"],
  --   auto_send_sequences: false,
  --   slack_webhook: "https://hooks.slack.com/...",
  --   alert_email: "founder@company.com"
  -- }

  CONSTRAINT tenants_status_check
    CHECK (status IN ('trial','active','suspended','cancelled')),
  CONSTRAINT tenants_vertical_check
    CHECK (vertical IN ('saas','ecom'))
);

-- ------------------------------------------------------------
-- CORE : PROFILES
-- Lié à auth.users. Un user = un tenant (owner).
-- ------------------------------------------------------------

CREATE TABLE profiles (
  id                    UUID PRIMARY KEY
                          REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role                  TEXT NOT NULL DEFAULT 'owner',
  -- owner | admin | viewer
  onboarding_step       INT NOT NULL DEFAULT 1,
  -- 1=account, 2=llm_key, 3=crm, 4=mapping, 5=done
  onboarding_completed  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT profiles_role_check
    CHECK (role IN ('owner','admin','viewer'))
);

-- ------------------------------------------------------------
-- CORE : SECRETS
-- Clés API chiffrées AES-256 côté application.
-- Jamais stockées en clair.
-- ------------------------------------------------------------

CREATE TABLE secrets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  -- openai | anthropic | hubspot | salesforce | pipedrive |
  -- close | attio | stripe | plaid | tink | meta_ads |
  -- google_ads | linkedin_ads | tiktok_ads | quickbooks |
  -- xero | pennylane | slack | gmail | calendly
  encrypted_value TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- { last_verified_at, expires_at, account_id, portal_id }
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, provider)
);

-- ------------------------------------------------------------
-- CORE : INTEGRATIONS
-- Statut de chaque connexion OAuth par tenant.
-- ------------------------------------------------------------

CREATE TABLE integrations (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  -- pending | active | degraded | expired | error | disconnected
  nango_connection_id TEXT,
  -- ID de la connexion dans Nango self-hosted
  last_sync_at        TIMESTAMPTZ,
  last_error          TEXT,
  last_error_at       TIMESTAMPTZ,
  sync_cursor         TEXT,
  -- Curseur pour sync incrémentale (timestamp ou page token)
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- { portal_id, account_id, shop_domain, ... }
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, provider),
  CONSTRAINT integrations_status_check
    CHECK (status IN
      ('pending','active','degraded','expired','error','disconnected'))
);

-- ------------------------------------------------------------
-- BUSINESS : DEALS
-- Normalisé depuis HubSpot / Salesforce / Pipedrive / Close / Attio
-- ------------------------------------------------------------

CREATE TABLE deals (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id       TEXT NOT NULL,
  external_source   TEXT NOT NULL,
  -- hubspot | salesforce | pipedrive | close | attio

  title             TEXT,
  amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'EUR',
  stage             TEXT NOT NULL DEFAULT 'unknown',
  -- Normalisé : new | qualified | demo_done | proposal_sent |
  --             negotiation | closed_won | closed_lost | unknown
  stage_raw         TEXT,
  -- Valeur originale du CRM (avant normalisation)
  probability       NUMERIC(5,2),
  -- 0.00 à 100.00

  close_date        DATE,
  contact_email     TEXT,
  contact_name      TEXT,
  company_name      TEXT,
  owner_name        TEXT,

  last_activity_at  TIMESTAMPTZ,
  notes             TEXT,
  -- Dernière note CRM (utile pour le LLM)

  raw_data          JSONB,
  -- Payload complet du CRM (pour enrichissement LLM)

  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, external_id, external_source)
);

-- Colonne calculée : jours depuis la dernière activité

CREATE INDEX idx_deals_tenant         ON deals(tenant_id);
CREATE INDEX idx_deals_stage          ON deals(tenant_id, stage);
CREATE INDEX idx_deals_stagnant       ON deals(tenant_id, days_stagnant DESC);
CREATE INDEX idx_deals_amount         ON deals(tenant_id, amount DESC);
CREATE INDEX idx_deals_contact        ON deals(tenant_id, contact_email);

-- ------------------------------------------------------------
-- BUSINESS : CONTACTS
-- Contacts normalisés depuis CRM
-- ------------------------------------------------------------

CREATE TABLE contacts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id     TEXT NOT NULL,
  external_source TEXT NOT NULL,

  email           TEXT,
  first_name      TEXT,
  last_name       TEXT,
  phone           TEXT,
  company_name    TEXT,
  job_title       TEXT,
  linkedin_url    TEXT,

  raw_data        JSONB,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, external_id, external_source)
);

CREATE INDEX idx_contacts_tenant ON contacts(tenant_id);
CREATE INDEX idx_contacts_email  ON contacts(tenant_id, email);

-- ------------------------------------------------------------
-- BUSINESS : LEADS
-- Leads entrants scorés par l'agent A3
-- ------------------------------------------------------------

CREATE TABLE leads (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  first_name      TEXT,
  last_name       TEXT,
  company         TEXT,

  -- Enrichissement
  company_size    TEXT,
  -- 1-10 | 11-50 | 51-200 | 201-500 | 500+
  industry        TEXT,
  linkedin_url    TEXT,

  -- Scoring (calculé par A3, jamais par LLM)
  fit_score       INT NOT NULL DEFAULT 0 CHECK (fit_score BETWEEN 0 AND 40),
  intent_score    INT NOT NULL DEFAULT 0 CHECK (intent_score BETWEEN 0 AND 40),
  timing_score    INT NOT NULL DEFAULT 0 CHECK (timing_score BETWEEN 0 AND 20),

  -- Statut
  status          TEXT NOT NULL DEFAULT 'new',
  -- new | in_sequence | replied | qualified | disqualified |
  -- nurture | won | lost | unsubscribed

  -- Source
  form_data       JSONB,
  -- Données du formulaire d'inscription
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  behavior_data   JSONB,
  -- { pricing_page_visits: 3, demo_watched: true, ... }

  sequence_status TEXT NOT NULL DEFAULT 'none',
  -- none | active | completed | paused
  sequence_step   INT NOT NULL DEFAULT 0,
  -- 0=not started, 1=email1 sent, 2=email2 sent, 3=completed

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, email),
  CONSTRAINT leads_status_check CHECK (status IN
    ('new','in_sequence','replied','qualified','disqualified',
     'nurture','won','lost','unsubscribed'))
);

-- Colonne calculée : score total
ALTER TABLE leads
  ADD COLUMN total_score INT
  GENERATED ALWAYS AS (fit_score + intent_score + timing_score) STORED;

CREATE INDEX idx_leads_tenant  ON leads(tenant_id);
CREATE INDEX idx_leads_score   ON leads(tenant_id, total_score DESC);
CREATE INDEX idx_leads_status  ON leads(tenant_id, status);
CREATE INDEX idx_leads_email   ON leads(tenant_id, email);

-- ------------------------------------------------------------
-- BUSINESS : TRANSACTIONS
-- Flux financiers normalisés (Plaid, Tink, Stripe, PayPal)
-- ------------------------------------------------------------

CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id     TEXT NOT NULL,
  external_source TEXT NOT NULL,
  -- plaid | tink | stripe | paypal | quickbooks | xero | pennylane

  date            DATE NOT NULL,
  amount          NUMERIC(14,2) NOT NULL,
  -- Positif = revenu entrant
  -- Négatif = dépense sortante
  currency        TEXT NOT NULL DEFAULT 'EUR',
  amount_eur      NUMERIC(14,2),
  -- Converti en EUR pour les agrégations cross-currency

  type            TEXT NOT NULL,
  -- revenue | expense | transfer | refund
  category        TEXT,
  -- saas | marketing | payroll | infrastructure | ops |
  -- cogs | revenue_stripe | revenue_paypal | tax | unknown
  subcategory     TEXT,
  -- Granularité supplémentaire (ex: "google_ads" dans "marketing")

  merchant        TEXT,
  description     TEXT,
  is_recurring    BOOLEAN NOT NULL DEFAULT FALSE,
  recurrence_id   TEXT,
  -- Regroupe les occurrences du même abonnement

  account_name    TEXT,
  -- Nom du compte bancaire source

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, external_id, external_source)
);

CREATE INDEX idx_transactions_tenant      ON transactions(tenant_id);
CREATE INDEX idx_transactions_date        ON transactions(tenant_id, date DESC);
CREATE INDEX idx_transactions_type        ON transactions(tenant_id, type, category);
CREATE INDEX idx_transactions_recurring   ON transactions(tenant_id, is_recurring);
CREATE INDEX idx_transactions_merchant    ON transactions(tenant_id, merchant);

-- ------------------------------------------------------------
-- BUSINESS : BANK_ACCOUNTS
-- Comptes bancaires connectés via Plaid / Tink
-- ------------------------------------------------------------

CREATE TABLE bank_accounts (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id         TEXT NOT NULL,
  external_source     TEXT NOT NULL,
  -- plaid | tink

  institution_name    TEXT,
  account_name        TEXT,
  account_type        TEXT,
  -- checking | savings | credit | investment
  currency            TEXT NOT NULL DEFAULT 'EUR',
  current_balance     NUMERIC(14,2),
  available_balance   NUMERIC(14,2),
  last_updated_at     TIMESTAMPTZ,

  UNIQUE(tenant_id, external_id, external_source)
);

CREATE INDEX idx_bank_accounts_tenant ON bank_accounts(tenant_id);

-- ------------------------------------------------------------
-- BUSINESS : AD_CAMPAIGNS
-- Campagnes publicitaires normalisées
-- ------------------------------------------------------------

CREATE TABLE ad_campaigns (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id           TEXT NOT NULL,
  platform              TEXT NOT NULL,
  -- meta | google | linkedin | tiktok

  name                  TEXT,
  status                TEXT,
  -- active | paused | removed | archived
  objective             TEXT,
  -- awareness | traffic | conversions | leads

  -- Budget
  daily_budget          NUMERIC(10,2),
  lifetime_budget       NUMERIC(10,2),
  currency              TEXT NOT NULL DEFAULT 'EUR',

  -- Métriques (snapshot sur 30 jours glissants)
  impressions           BIGINT NOT NULL DEFAULT 0,
  clicks                BIGINT NOT NULL DEFAULT 0,
  ctr                   NUMERIC(8,6) NOT NULL DEFAULT 0,
  -- Ratio 0.000000 à 1.000000
  avg_cpc               NUMERIC(10,4) NOT NULL DEFAULT 0,
  conversions           NUMERIC(10,2) NOT NULL DEFAULT 0,
  spend                 NUMERIC(10,2) NOT NULL DEFAULT 0,
  cost_per_conversion   NUMERIC(10,2),
  roas                  NUMERIC(10,4),

  snapshot_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  synced_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, external_id, platform, snapshot_date)
);

CREATE INDEX idx_ad_campaigns_tenant   ON ad_campaigns(tenant_id);
CREATE INDEX idx_ad_campaigns_platform ON ad_campaigns(tenant_id, platform);
CREATE INDEX idx_ad_campaigns_status   ON ad_campaigns(tenant_id, status);
CREATE INDEX idx_ad_campaigns_spend    ON ad_campaigns(tenant_id, spend DESC);

-- ------------------------------------------------------------
-- AI OUTPUT : RECOMMENDATIONS
-- Sortie de tous les agents. Jamais modifiée par les agents.
-- Modifiée uniquement par le founder (approve/reject)
-- et par A7 (outcome tracking).
-- ------------------------------------------------------------

CREATE TABLE recommendations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  agent_type      TEXT NOT NULL,
  -- pipeline_stagnation | lead_engagement | lead_reengagement |
  -- ads_waste | ads_scaling | treasury_runway | treasury_zombie |
  -- treasury_anomaly | weekly_brief

  priority        TEXT NOT NULL DEFAULT 'medium',
  -- critical | high | medium | low

  title           TEXT NOT NULL,
  summary         TEXT,
  -- 1-2 lignes. Visible sans ouvrir la carte.

  payload         JSONB NOT NULL,
  -- Contenu complet. Structure dépend de agent_type.
  -- pipeline_stagnation: { deal_id, email_draft, blocking_reason, ... }
  -- treasury_zombie: { merchant, monthly_cost, recommendation, ... }
  -- etc.

  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending | approved | rejected | executed | expired | failed

  -- Tracking
  approved_at     TIMESTAMPTZ,
  rejected_at     TIMESTAMPTZ,
  executed_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),

  -- Feedback loop (rempli par A7)
  outcome_score   INT CHECK (outcome_score BETWEEN 0 AND 100),
  outcome_data    JSONB,
  -- { measured_at, before_state, after_state, details }
  outcome_measured_at TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT recommendations_priority_check
    CHECK (priority IN ('critical','high','medium','low')),
  CONSTRAINT recommendations_status_check
    CHECK (status IN
      ('pending','approved','rejected','executed','expired','failed'))
);

CREATE INDEX idx_recs_tenant_status   ON recommendations(tenant_id, status);
CREATE INDEX idx_recs_tenant_priority ON recommendations(tenant_id, priority);
CREATE INDEX idx_recs_tenant_type     ON recommendations(tenant_id, agent_type);
CREATE INDEX idx_recs_created         ON recommendations(tenant_id, created_at DESC);
CREATE INDEX idx_recs_outcome         ON recommendations(tenant_id, outcome_score)
  WHERE outcome_score IS NOT NULL;

-- ------------------------------------------------------------
-- AI OUTPUT : EXECUTIVE_BRIEFS
-- Brief hebdomadaire généré par A6
-- ------------------------------------------------------------

CREATE TABLE executive_briefs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  week_of     DATE NOT NULL,
  -- Lundi de la semaine concernée

  -- Métriques de la semaine (calculées, pas par LLM)
  metrics     JSONB NOT NULL,
  -- {
  --   pipeline_value, pipeline_change_pct,
  --   stagnant_count, stagnant_value,
  --   deals_closed, revenue_this_week,
  --   monthly_forecast,
  --   new_leads, hot_leads, reply_rate,
  --   runway_months, mrr, net_burn,
  --   ads_spend, avg_cpa, waste_detected,
  --   pending_actions
  -- }

  -- Narratif généré par LLM
  narrative   TEXT,
  top_actions JSONB,
  -- [{ title, impact_estimate, recommendation_id }, ...]

  overall_score INT,
  -- Score de la semaine 0-100 (calculé, pas LLM)

  delivered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, week_of)
);

-- ------------------------------------------------------------
-- AI OUTPUT : TREASURY_SNAPSHOTS
-- Photo quotidienne de la trésorerie (Python calcule, on stocke)
-- ------------------------------------------------------------

CREATE TABLE treasury_snapshots (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_date       DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Calculé par Python, jamais par LLM
  current_balance     NUMERIC(14,2),
  monthly_burn_gross  NUMERIC(14,2),
  monthly_revenue     NUMERIC(14,2),
  monthly_net_burn    NUMERIC(14,2),
  runway_months       NUMERIC(6,2),
  runway_date         DATE,
  mrr                 NUMERIC(14,2),
  arr                 NUMERIC(14,2),

  -- Scénarios
  scenario_pessimistic NUMERIC(6,2),
  scenario_realistic   NUMERIC(6,2),
  scenario_optimistic  NUMERIC(6,2),

  is_profitable       BOOLEAN NOT NULL DEFAULT FALSE,
  data_confidence     TEXT NOT NULL DEFAULT 'partial',
  -- full | partial | insufficient
  -- full = toutes les sources connectées
  -- partial = certaines sources manquantes
  -- insufficient = moins de 30 jours de données

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, snapshot_date)
);

CREATE INDEX idx_treasury_tenant ON treasury_snapshots(tenant_id, snapshot_date DESC);

-- ------------------------------------------------------------
-- AI OUTPUT : PATTERN_EMBEDDINGS
-- Mémoire long-terme (RAG). Ce qui a marché.
-- ------------------------------------------------------------

CREATE TABLE pattern_embeddings (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  embedding     vector(1536) NOT NULL,
  -- OpenAI text-embedding-ada-002 dimension

  content       TEXT NOT NULL,
  -- Description humaine du pattern
  -- Ex: "Email re-engagement for FinTech SaaS 11-50 employees,
  --      deal stuck proposal_sent 18 days, angle: compliance ROI.
  --      Result: deal moved, closed 3 weeks later."

  agent_source  TEXT NOT NULL,
  -- pipeline_stagnation | lead_engagement | ads_waste | treasury_alert

  result_score  INT NOT NULL,
  -- Score de succès 0-100 (mesuré par A7)

  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- {
  --   recommendation_id,
  --   industry, company_size, deal_amount,
  --   days_stagnant, action_type,
  --   outcome_details
  -- }

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index HNSW pour recherche vectorielle rapide
CREATE INDEX idx_patterns_embedding
  ON pattern_embeddings
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_patterns_tenant
  ON pattern_embeddings(tenant_id, agent_source, result_score DESC);

-- ------------------------------------------------------------
-- UTILITY : SCHEDULED_ACTIONS
-- File d'attente pour les follow-ups temporels
-- (remplace Inngest dans la stack zéro budget)
-- ------------------------------------------------------------

CREATE TABLE scheduled_actions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  action_type     TEXT NOT NULL,
  -- send_email | check_reply | run_agent | send_notification

  scheduled_at    TIMESTAMPTZ NOT NULL,
  -- Quand exécuter cette action

  payload         JSONB NOT NULL,
  -- Tout ce dont l'exécuteur a besoin

  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending | running | done | failed | cancelled

  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 3,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at     TIMESTAMPTZ,
  error           TEXT
);

CREATE INDEX idx_scheduled_pending
  ON scheduled_actions(scheduled_at, status)
  WHERE status = 'pending';

CREATE INDEX idx_scheduled_tenant
  ON scheduled_actions(tenant_id, status);

-- ------------------------------------------------------------
-- UTILITY : SYNC_JOBS
-- Queue pour les syncs avec rate limiting par provider
-- ------------------------------------------------------------

CREATE TABLE sync_jobs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  job_type      TEXT NOT NULL,
  -- initial_sync | incremental_sync | webhook_process

  status        TEXT NOT NULL DEFAULT 'pending',
  -- pending | running | done | failed

  priority      INT NOT NULL DEFAULT 5,
  -- 1 (highest) à 10 (lowest)

  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error         TEXT,
  attempts      INT NOT NULL DEFAULT 0,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT sync_jobs_priority_check
    CHECK (priority BETWEEN 1 AND 10)
);

CREATE INDEX idx_sync_jobs_pending
  ON sync_jobs(priority, created_at)
  WHERE status = 'pending';

-- ------------------------------------------------------------
-- UTILITY : FX_RATES
-- Taux de change quotidiens pour normalisation multi-devises
-- ------------------------------------------------------------

CREATE TABLE fx_rates (
  id            BIGSERIAL PRIMARY KEY,
  from_currency TEXT NOT NULL,
  to_currency   TEXT NOT NULL,
  rate          NUMERIC(16,8) NOT NULL,
  rate_date     DATE NOT NULL DEFAULT CURRENT_DATE,

  UNIQUE(from_currency, to_currency, rate_date)
);

CREATE INDEX idx_fx_rates_date ON fx_rates(from_currency, to_currency, rate_date DESC);

-- ------------------------------------------------------------
-- UTILITY : ENTITY_RESOLUTION
-- Déduplication cross-sources (même personne dans HubSpot et Stripe)
-- ------------------------------------------------------------

CREATE TABLE entity_resolution (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  canonical_id    UUID NOT NULL DEFAULT uuid_generate_v4(),
  -- ID unifié (toutes les sources mappées à ce canonical_id)
  email           TEXT NOT NULL,
  -- Clé de déduplication primaire
  sources         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [
  --   { provider: "hubspot", external_id: "123" },
  --   { provider: "stripe", external_id: "cus_xxx" }
  -- ]
  merged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, email)
);

CREATE INDEX idx_entity_tenant ON entity_resolution(tenant_id, email);

-- ------------------------------------------------------------
-- TRIGGERS : updated_at automatique
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER secrets_updated_at
  BEFORE UPDATE ON secrets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER integrations_updated_at
  BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER deals_updated_at
  BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER recommendations_updated_at
  BEFORE UPDATE ON recommendations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ------------------------------------------------------------
-- TRIGGER : Création automatique profil + tenant à l'inscription
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  new_tenant_id UUID;
BEGIN
  INSERT INTO tenants (name, status)
  VALUES (NEW.email, 'trial')
  RETURNING id INTO new_tenant_id;

  INSERT INTO profiles (id, tenant_id, role)
  VALUES (NEW.id, new_tenant_id, 'owner');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
