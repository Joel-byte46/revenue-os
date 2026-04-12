// ============================================================
// REVENUE OS — COMPLETE ONBOARDING
// Scène 5 : Finalise l'onboarding, lance le premier run complet.
//
// POST { tenant_id, calibration }
// Response: { success, first_metrics, events_count }
//
// Le premier run peut prendre jusqu'à 30 secondes.
// On retourne les premières métriques dès qu'elles sont calculées.
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { notifyCritical } from '../_shared/notify.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const EDGE_BASE = `${SUPABASE_URL}/functions/v1`

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

interface CalibrationConfig {
  auto_send_mode: 'draft_only' | 'hybrid' | 'auto'
  digest_frequency: 'weekly' | 'daily' | 'off'
  digest_day?: string
  digest_hour?: number
  thresholds: {
    runway_months: number
    deal_stuck_days: number
    zombie_days: number
    ad_cpa_multiplier: number
  }
  sender_name?: string
  sender_title?: string
  tenant_name?: string
  vertical?: 'saas' | 'ecom'
  timezone?: string
  currency?: string
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }

  const startTime = Date.now()

  try {
    const body = await req.json()
    const { tenant_id, calibration } = body as {
      tenant_id: string
      calibration: CalibrationConfig
    }

    if (!tenant_id || !calibration) {
      return new Response(
        JSON.stringify({ error: 'tenant_id and calibration required' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // --------------------------------------------------------
    // ÉTAPE 1 : Sauvegarder la calibration
    // --------------------------------------------------------
    const { data: currentTenant } = await supabase
      .from('tenants')
      .select('settings')
      .eq('id', tenant_id)
      .single()

    await supabase
      .from('tenants')
      .update({
        name: calibration.tenant_name ?? null,
        vertical: calibration.vertical ?? 'saas',
        timezone: calibration.timezone ?? 'Europe/Paris',
        currency: calibration.currency ?? 'EUR',
        settings: {
          ...(currentTenant?.settings ?? {}),
          auto_send_sequences: calibration.auto_send_mode === 'auto',
          auto_send_mode: calibration.auto_send_mode,
          digest_frequency: calibration.digest_frequency,
          digest_day: calibration.digest_day ?? 'monday',
          digest_hour: calibration.digest_hour ?? 9,
          stage_thresholds: {
            new: 3,
            qualified: calibration.thresholds.deal_stuck_days ?? 7,
            demo_done: 10,
            proposal_sent: calibration.thresholds.deal_stuck_days ?? 14,
            negotiation: 21
          },
          runway_alert_months: calibration.thresholds.runway_months ?? 6,
          zombie_days: calibration.thresholds.zombie_days ?? 60,
          ad_cpa_multiplier: calibration.thresholds.ad_cpa_multiplier ?? 3.0
        }
      })
      .eq('id', tenant_id)

    // Mettre à jour le profil avec sender info
    if (calibration.sender_name || calibration.sender_title) {
      await supabase
        .from('profiles')
        .update({
          sender_name: calibration.sender_name,
          sender_title: calibration.sender_title
        })
        .eq('tenant_id', tenant_id)
    }

    // --------------------------------------------------------
    // ÉTAPE 2 : Finaliser l'onboarding state
    // --------------------------------------------------------
    const { data: currentOnboarding } = await supabase
      .from('onboarding_state')
      .select('completed_steps')
      .eq('tenant_id', tenant_id)
      .single()

    const completedSteps = currentOnboarding?.completed_steps ?? []
    if (!completedSteps.includes('calibration')) {
      completedSteps.push('calibration')
    }

    await supabase
      .from('onboarding_state')
      .update({
        current_step: 'live',
        completed_steps: completedSteps,
        calibration: {
          auto_send_mode: calibration.auto_send_mode,
          digest_frequency: calibration.digest_frequency,
          thresholds: calibration.thresholds
        },
        updated_at: new Date().toISOString()
      })
      .eq('tenant_id', tenant_id)

    // --------------------------------------------------------
    // ÉTAPE 3 : Marquer le profil comme onboarded
    // --------------------------------------------------------
    await supabase
      .from('profiles')
      .update({
        onboarding_completed: true,
        onboarding_step: 5
      })
      .eq('tenant_id', tenant_id)

    await supabase
      .from('tenants')
      .update({
        onboarding_completed_at: new Date().toISOString()
      })
      .eq('id', tenant_id)

    // --------------------------------------------------------
    // ÉTAPE 4 : Lancer le premier run (Ingestor + Treasury)
    // On attend seulement A1 + A5 pour avoir les premières métriques.
    // Les autres agents tournent en arrière-plan.
    // --------------------------------------------------------
    console.log(`[complete-onboarding] Starting first run for tenant ${tenant_id}`)

    // Lancer A1 (Ingestor) en synchrone — on a besoin des données
    let ingestorSuccess = false
    try {
      const ingestorResponse = await fetch(`${EDGE_BASE}/agent-ingestor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
        },
        body: JSON.stringify({
          tenant_id,
          triggered_by: 'onboarding'
        }),
        signal: AbortSignal.timeout(25_000)
      })
      ingestorSuccess = ingestorResponse.ok
    } catch (err) {
      console.warn('[complete-onboarding] Ingestor timed out — continuing with empty data')
    }

    // Lancer A5 (Treasury) en synchrone si l'ingestor a réussi
    let treasurySuccess = false
    if (ingestorSuccess) {
      try {
        const treasuryResponse = await fetch(`${EDGE_BASE}/agent-treasury`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
          },
          body: JSON.stringify({
            tenant_id,
            triggered_by: 'onboarding'
          }),
          signal: AbortSignal.timeout(20_000)
        })
        treasurySuccess = treasuryResponse.ok
      } catch (err) {
        console.warn('[complete-onboarding] Treasury timed out')
      }
    }

    // Lancer les autres agents en fire-and-forget (pas d'await)
    const agentsToRun = ['agent-pipeline', 'agent-leads', 'agent-brief']
    for (const agent of agentsToRun) {
      fetch(`${EDGE_BASE}/${agent}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
        },
        body: JSON.stringify({ tenant_id, triggered_by: 'onboarding' })
      }).catch(err => {
        console.error(`[complete-onboarding] ${agent} fire-and-forget failed:`, err)
      })
    }

    // --------------------------------------------------------
    // ÉTAPE 5 : Récupérer les premières métriques
    // --------------------------------------------------------
    const { data: firstMetrics } = await supabase
      .rpc('get_state_metrics', { p_tenant_id: tenant_id })

    // --------------------------------------------------------
    // ÉTAPE 6 : Stocker les premières métriques dans onboarding_state
    // --------------------------------------------------------
    await supabase
      .from('onboarding_state')
      .update({
        first_run_completed: true,
        first_metrics: firstMetrics,
        completed_at: new Date().toISOString()
      })
      .eq('tenant_id', tenant_id)

    // --------------------------------------------------------
    // ÉTAPE 7 : Message Slack de bienvenue
    // --------------------------------------------------------
    const welcomeMessage = buildWelcomeMessage(firstMetrics, calibration)
    await notifyCritical(
      tenant_id,
      '🚀 Revenue OS initialisé',
      welcomeMessage
    ).catch(err => console.error('[complete-onboarding] Slack welcome failed:', err))

    // --------------------------------------------------------
    // ÉTAPE 8 : System event "live"
    // --------------------------------------------------------
    await supabase
      .from('system_events')
      .insert({
        tenant_id,
        event_type: 'system_initialized',
        title: 'Système opérationnel',
        body: `Premier scan terminé. ${firstMetrics?.pending_actions ?? 0} action(s) identifiée(s).`,
        severity: 'success',
        metadata: {
          duration_ms: Date.now() - startTime,
          ingestor_success: ingestorSuccess,
          treasury_success: treasurySuccess
        }
      })

    console.log(
      `[complete-onboarding] Done for ${tenant_id} in ${Date.now() - startTime}ms`
    )

    return new Response(
      JSON.stringify({
        success: true,
        first_metrics: firstMetrics,
        duration_ms: Date.now() - startTime,
        message: 'Votre OS est opérationnel.'
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[complete-onboarding] Error:', message)

    return new Response(
      JSON.stringify({ error: 'Erreur lors de l\'initialisation.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})

function buildWelcomeMessage(
  metrics: Record<string, unknown> | null,
  calibration: CalibrationConfig
): string {
  if (!metrics) {
    return `Système initialisé. Connectez vos intégrations pour commencer l'analyse.`
  }

  const runway = metrics.runway_months
    ? `Runway détecté : ${(metrics.runway_months as number).toFixed(1)} mois.`
    : 'Connectez votre banque pour calculer votre runway.'

  const pipeline = metrics.pipeline_value
    ? `Pipeline : ${(metrics.pipeline_value as number).toLocaleString('fr-FR')}€.`
    : ''

  const actions = metrics.pending_actions
    ? `${metrics.pending_actions} action(s) identifiée(s) dès maintenant.`
    : 'Aucune action urgente détectée.'

  const briefInfo = calibration.digest_frequency === 'weekly'
    ? `Premier brief complet ce lundi à 09h00.`
    : 'Briefs quotidiens activés.'

  return [runway, pipeline, actions, briefInfo].filter(Boolean).join(' ')
}
