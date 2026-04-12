-- ============================================================
-- REVENUE OS — ROW LEVEL SECURITY
-- Migration 002 : Isolation complète par tenant
-- ============================================================

-- ------------------------------------------------------------
-- HELPER FUNCTION
-- Récupère le tenant_id de l'utilisateur connecté.
-- Utilisé dans toutes les policies.
-- SECURITY DEFINER = s'exécute avec les droits du créateur,
-- pas de l'appelant (contourne la récursion RLS sur profiles).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_tenant_id()
RETURNS UUID AS $$
  SELECT tenant_id
  FROM profiles
  WHERE id = auth.uid()
  LIMIT 1
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ------------------------------------------------------------
-- ACTIVATION RLS SUR TOUTES LES TABLES
-- ------------------------------------------------------------

ALTER TABLE tenants              ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE secrets              ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals                ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads                ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_campaigns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE executive_briefs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pattern_embeddings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_actions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_jobs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_resolution    ENABLE ROW LEVEL SECURITY;

-- fx_rates : lecture publique, pas de RLS nécessaire
-- (les taux de change ne sont pas sensibles)

-- ------------------------------------------------------------
-- POLICIES : TENANTS
-- ------------------------------------------------------------

CREATE POLICY "tenant_read_own"
  ON tenants FOR SELECT
  USING (id = get_tenant_id());

CREATE POLICY "tenant_update_own"
  ON tenants FOR UPDATE
  USING (id = get_tenant_id());

-- INSERT géré uniquement par le trigger handle_new_user (SECURITY DEFINER)
-- DELETE jamais permis côté client

-- ------------------------------------------------------------
-- POLICIES : PROFILES
-- ------------------------------------------------------------

CREATE POLICY "profile_read_own"
  ON profiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "profile_update_own"
  ON profiles FOR UPDATE
  USING (id = auth.uid());

-- ------------------------------------------------------------
-- POLICIES : SECRETS
-- Lecture restreinte : jamais exposé en clair au frontend.
-- Les Edge Functions utilisent service_role_key → bypass RLS.
-- ------------------------------------------------------------

CREATE POLICY "secrets_read_own"
  ON secrets FOR SELECT
  USING (tenant_id = get_tenant_id());

CREATE POLICY "secrets_insert_own"
  ON secrets FOR INSERT
  WITH CHECK (tenant_id = get_tenant_id());

CREATE POLICY "secrets_update_own"
  ON secrets FOR UPDATE
  USING (tenant_id = get_tenant_id());

CREATE POLICY "secrets_delete_own"
  ON secrets FOR DELETE
  USING (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : INTEGRATIONS
-- ------------------------------------------------------------

CREATE POLICY "integrations_all_own"
  ON integrations FOR ALL
  USING (tenant_id = get_tenant_id())
  WITH CHECK (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : DEALS
-- ------------------------------------------------------------

CREATE POLICY "deals_all_own"
  ON deals FOR ALL
  USING (tenant_id = get_tenant_id())
  WITH CHECK (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : CONTACTS
-- ------------------------------------------------------------

CREATE POLICY "contacts_all_own"
  ON contacts FOR ALL
  USING (tenant_id = get_tenant_id())
  WITH CHECK (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : LEADS
-- ------------------------------------------------------------

CREATE POLICY "leads_all_own"
  ON leads FOR ALL
  USING (tenant_id = get_tenant_id())
  WITH CHECK (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : TRANSACTIONS
-- ------------------------------------------------------------

CREATE POLICY "transactions_all_own"
  ON transactions FOR ALL
  USING (tenant_id = get_tenant_id())
  WITH CHECK (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : BANK_ACCOUNTS
-- ------------------------------------------------------------

CREATE POLICY "bank_accounts_all_own"
  ON bank_accounts FOR ALL
  USING (tenant_id = get_tenant_id())
  WITH CHECK (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : AD_CAMPAIGNS
-- ------------------------------------------------------------

CREATE POLICY "ad_campaigns_all_own"
  ON ad_campaigns FOR ALL
  USING (tenant_id = get_tenant_id())
  WITH CHECK (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : RECOMMENDATIONS
-- ------------------------------------------------------------

CREATE POLICY "recommendations_read_own"
  ON recommendations FOR SELECT
  USING (tenant_id = get_tenant_id());

CREATE POLICY "recommendations_update_own"
  ON recommendations FOR UPDATE
  USING (tenant_id = get_tenant_id());

-- INSERT uniquement par les Edge Functions (service_role_key → bypass RLS)
-- Le founder ne crée pas de recommandations directement

-- ------------------------------------------------------------
-- POLICIES : EXECUTIVE_BRIEFS
-- ------------------------------------------------------------

CREATE POLICY "briefs_read_own"
  ON executive_briefs FOR SELECT
  USING (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : TREASURY_SNAPSHOTS
-- ------------------------------------------------------------

CREATE POLICY "treasury_read_own"
  ON treasury_snapshots FOR SELECT
  USING (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : PATTERN_EMBEDDINGS
-- Lecture seule côté client (les agents écrivent via service_role)
-- ------------------------------------------------------------

CREATE POLICY "patterns_read_own"
  ON pattern_embeddings FOR SELECT
  USING (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : SCHEDULED_ACTIONS
-- ------------------------------------------------------------

CREATE POLICY "scheduled_read_own"
  ON scheduled_actions FOR SELECT
  USING (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : SYNC_JOBS
-- ------------------------------------------------------------

CREATE POLICY "sync_jobs_read_own"
  ON sync_jobs FOR SELECT
  USING (tenant_id = get_tenant_id());

-- ------------------------------------------------------------
-- POLICIES : ENTITY_RESOLUTION
-- ------------------------------------------------------------

CREATE POLICY "entity_resolution_read_own"
  ON entity_resolution FOR SELECT
  USING (tenant_id = get_tenant_id());
