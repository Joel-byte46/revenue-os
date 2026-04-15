-- ============================================================
-- REVENUE OS — pg_cron SCHEDULES
-- Migration 004 : Orchestration temporelle (PRODUCTION SAFE)
-- ============================================================

-- ------------------------------------------------------------
-- EXTENSIONS REQUIRED
-- ------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- IMPORTANT:
-- pg_net est obligatoire pour net.http_post dans Supabase

-- ------------------------------------------------------------
-- NOTE ARCHITECTURE
-- ------------------------------------------------------------
-- ❌ NE PAS utiliser current_setting() pour secrets
-- ✔ utiliser des secrets injectés côté Edge Function si besoin
-- ✔ cron déclenche uniquement un call HTTP simple

-- Base URL (à remplacer une seule fois ici)
-- ⚠️ pas de secrets ici
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_settings WHERE name = 'app.edge_function_url'
  ) THEN
    PERFORM set_config(
      'app.edge_function_url',
      'https://YOUR_PROJECT_REF.supabase.co/functions/v1',
      false
    );
  END IF;
END $$;

-- ------------------------------------------------------------
-- HELPER FUNCTION (safe HTTP wrapper)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION trigger_orchestrator(payload jsonb)
RETURNS void
LANGUAGE SQL
AS $$
  SELECT net.http_post(
    url := current_setting('app.edge_function_url') || '/orchestrator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json'
    ),
    body := payload
  );
$$;

-- ============================================================
-- JOB 1 : FULL CYCLE (6H)
-- ============================================================

SELECT cron.schedule(
  'revenue-os-full-cycle',
  '0 */6 * * *',
  $$ SELECT trigger_orchestrator('{"mode":"full"}'::jsonb); $$
);

-- ============================================================
-- JOB 2 : TREASURY DAILY
-- ============================================================

SELECT cron.schedule(
  'revenue-os-treasury-daily',
  '0 7 * * *',
  $$ SELECT trigger_orchestrator('{"mode":"treasury_only"}'::jsonb); $$
);

-- ============================================================
-- JOB 3 : WEEKLY BRIEF
-- ============================================================

SELECT cron.schedule(
  'revenue-os-weekly-brief',
  '0 7 * * 1',
  $$ SELECT trigger_orchestrator('{"mode":"brief_only"}'::jsonb); $$
);

-- ============================================================
-- JOB 4 : FEEDBACK LOOP
-- ============================================================

SELECT cron.schedule(
  'revenue-os-feedback-daily',
  '0 3 * * *',
  $$ SELECT trigger_orchestrator('{"mode":"feedback_only"}'::jsonb); $$
);

-- ============================================================
-- JOB 5 : SCHEDULED ACTIONS
-- ============================================================

SELECT cron.schedule(
  'revenue-os-scheduled-actions',
  '0 * * * *',
  $$ SELECT trigger_orchestrator('{"mode":"scheduled_actions"}'::jsonb); $$
);

-- ============================================================
-- JOB 6 : FX RATES
-- ============================================================

SELECT cron.schedule(
  'revenue-os-fx-rates',
  '0 6 * * *',
  $$ SELECT trigger_orchestrator('{"mode":"fx_rates"}'::jsonb); $$
);

-- ============================================================
-- JOB 7 : EXPIRE RECOMMENDATIONS
-- ============================================================

SELECT cron.schedule(
  'revenue-os-expire-recs',
  '0 2 * * *',
  $$
  UPDATE recommendations
  SET status = 'expired',
      updated_at = NOW()
  WHERE status = 'pending'
    AND expires_at < NOW();
  $$
);

-- ============================================================
-- JOB 8 : CLEANUP SYNC JOBS
-- ============================================================

SELECT cron.schedule(
  'revenue-os-cleanup-sync-jobs',
  '0 4 * * 0',
  $$
  DELETE FROM sync_jobs
  WHERE status IN ('done', 'failed')
    AND created_at < NOW() - INTERVAL '30 days';
  $$
);

-- ============================================================
-- DEBUG QUERY (optional)
-- ============================================================

-- SELECT * FROM cron.job ORDER BY jobname;
