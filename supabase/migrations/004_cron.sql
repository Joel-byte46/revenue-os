-- ============================================================
-- REVENUE OS — pg_cron SCHEDULES
-- Migration 004 : Orchestration temporelle
-- Toutes les heures en UTC. Ajuster selon timezone tenant
-- via l'orchestrateur (qui lit tenant.timezone).
-- ============================================================

-- Activer pg_cron (doit être activé dans Supabase dashboard)
-- Settings → Database → Extensions → pg_cron → Enable

-- ------------------------------------------------------------
-- VARIABLE : URL de base des Edge Functions
-- Remplacer [PROJECT_REF] par ton ref Supabase réel
-- Remplacer [SERVICE_ROLE_KEY] par ta clé service_role réelle
-- Ces valeurs sont injectées via les secrets Supabase.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- JOB 1 : CYCLE COMPLET
-- Toutes les 6 heures : sync + tous les agents
-- 00:00, 06:00, 12:00, 18:00 UTC
-- ------------------------------------------------------------

SELECT cron.schedule(
  'revenue-os-full-cycle',
  '0 */6 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.edge_function_url') || '/orchestrator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body    := '{"mode":"full"}'::jsonb
  )
  $$
);

-- ------------------------------------------------------------
-- JOB 2 : TREASURY QUOTIDIEN
-- Tous les jours à 07:00 UTC
-- Calcule le runway même si le cycle complet a déjà tourné
-- ------------------------------------------------------------

SELECT cron.schedule(
  'revenue-os-treasury-daily',
  '0 7 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.edge_function_url') || '/orchestrator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body    := '{"mode":"treasury_only"}'::jsonb
  )
  $$
);

-- ------------------------------------------------------------
-- JOB 3 : BRIEF HEBDOMADAIRE
-- Chaque lundi à 07:00 UTC
-- ------------------------------------------------------------

SELECT cron.schedule(
  'revenue-os-weekly-brief',
  '0 7 * * 1',
  $$
  SELECT net.http_post(
    url     := current_setting('app.edge_function_url') || '/orchestrator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body    := '{"mode":"brief_only"}'::jsonb
  )
  $$
);

-- ------------------------------------------------------------
-- JOB 4 : FEEDBACK AGENT
-- Tous les jours à 03:00 UTC (faible trafic)
-- Mesure les outcomes des recommandations de 7-30 jours
-- ------------------------------------------------------------

SELECT cron.schedule(
  'revenue-os-feedback-daily',
  '0 3 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.edge_function_url') || '/orchestrator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body    := '{"mode":"feedback_only"}'::jsonb
  )
  $$
);

-- ------------------------------------------------------------
-- JOB 5 : SCHEDULED ACTIONS WORKER
-- Toutes les heures : exécute les actions planifiées
-- (follow-ups emails, notifications différées)
-- ------------------------------------------------------------

SELECT cron.schedule(
  'revenue-os-scheduled-actions',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.edge_function_url') || '/orchestrator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body    := '{"mode":"scheduled_actions"}'::jsonb
  )
  $$
);

-- ------------------------------------------------------------
-- JOB 6 : FX RATES REFRESH
-- Tous les jours à 06:00 UTC
-- Récupère les taux de change du jour
-- ------------------------------------------------------------

SELECT cron.schedule(
  'revenue-os-fx-rates',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.edge_function_url') || '/orchestrator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body    := '{"mode":"fx_rates"}'::jsonb
  )
  $$
);

-- ------------------------------------------------------------
-- JOB 7 : EXPIRE OLD RECOMMENDATIONS
-- Tous les jours à 02:00 UTC
-- Passe en 'expired' les recommandations pending > 7 jours
-- ------------------------------------------------------------

SELECT cron.schedule(
  'revenue-os-expire-recs',
  '0 2 * * *',
  $$
  UPDATE recommendations
  SET status = 'expired', updated_at = NOW()
  WHERE status = 'pending'
    AND expires_at < NOW()
  $$
);

-- ------------------------------------------------------------
-- JOB 8 : CLEANUP SYNC JOBS
-- Tous les dimanches à 04:00 UTC
-- Supprime les sync_jobs terminés de plus de 30 jours
-- ------------------------------------------------------------

SELECT cron.schedule(
  'revenue-os-cleanup-sync-jobs',
  '0 4 * * 0',
  $$
  DELETE FROM sync_jobs
  WHERE status IN ('done', 'failed')
    AND created_at < NOW() - INTERVAL '30 days'
  $$
);

-- ------------------------------------------------------------
-- CONFIGURATION DES SETTINGS
-- À exécuter après avoir remplacé les valeurs réelles
-- ------------------------------------------------------------

-- ALTER DATABASE postgres
--   SET app.edge_function_url = 'https://[PROJECT_REF].supabase.co/functions/v1';
-- ALTER DATABASE postgres
--   SET app.service_role_key = '[SERVICE_ROLE_KEY]';

-- Ces deux commandes doivent être exécutées manuellement
-- dans le SQL Editor Supabase avec les vraies valeurs.
-- Ne pas committer les vraies valeurs dans le repo.

-- ------------------------------------------------------------
-- VÉRIFICATION : Lister les jobs actifs
-- ------------------------------------------------------------

-- SELECT jobname, schedule, active
-- FROM cron.job
-- ORDER BY jobname;
