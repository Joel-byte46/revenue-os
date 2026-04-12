// ============================================================
// REVENUE OS — ORCHESTRATOR
// Point d'entrée unique pour tous les cycles d'agents.
// Déclenché par pg_cron ou manuellement via API.
//
// RESPONSABILITÉS :
// 1. Récupérer tous les tenants actifs
// 2. Pour chaque tenant : vérifier quels agents lancer
// 3. Lancer les agents dans le bon ordre
// 4. Agréger les résultats et logger
//
// NE FAIT PAS :
// → Aucune logique métier
// → Aucun appel LLM
// → Aucune écriture en DB (sauf logs)
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type {
  Tenant,
  Provider,
  AgentResult,
  OrchestratorResult
} from '../_shared/types.ts'
import { notifyBatch, notifyCritical } from '../_shared/notify.ts'
import { checkPythonHealth } from '../_shared/python-client.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ORCHESTRATOR_SECRET = Deno.env.get('ORCHESTRATOR_SECRET') ?? ''

// Edge Function URLs (self-referencing dans Supabase)
const EDGE_BASE = `${SUPABASE_URL}/functions/v1`

// Modes d'exécution
type OrchestratorMode =
  | 'full'
  | 'treasury_only'
  | 'brief_only'
  | 'feedback_only'
  | 'scheduled_actions'
  | 'fx_rates'
  | 'health_check'

// ------------------------------------------------------------
// ENTRY POINT
// ------------------------------------------------------------

serve(async (req: Request) => {
  const startTime = Date.now()

  // Vérification du secret (pg_cron ou API interne)
  const authHeader = req.headers.get('Authorization') ?? ''
  const providedSecret = authHeader.replace('Bearer ', '')

  if (
    ORCHESTRATOR_SECRET &&
    providedSecret !== ORCHESTRATOR_SECRET &&
    providedSecret !== SUPABASE_SERVICE_KEY
  ) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    )
  }

  let body: { mode?: string; tenant_id?: string } = {}
  try {
    body = await req.json()
  } catch {
    body = { mode: 'full' }
  }

  const mode = (body.mode ?? 'full') as OrchestratorMode
  const specificTenantId = body.tenant_id ?? null

  console.log(`[orchestrator] Starting mode=${mode}`, {
    specific_tenant: specificTenantId ?? 'all'
  })

  try {
    const result = await runOrchestrator(mode, specificTenantId, startTime)

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[orchestrator] Fatal error:', message)

    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})

// ------------------------------------------------------------
// MAIN ORCHESTRATOR LOGIC
// ------------------------------------------------------------

async function runOrchestrator(
  mode: OrchestratorMode,
  specificTenantId: string | null,
  startTime: number
): Promise<OrchestratorResult> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // Mode spéciaux non-tenant
  if (mode === 'fx_rates') {
    await refreshFxRates(supabase)
    return buildResult(mode, 0, 0, [], startTime)
  }

  if (mode === 'health_check') {
    const pythonHealthy = await checkPythonHealth()
    console.log('[orchestrator] Health check:', { python: pythonHealthy })
    return buildResult(mode, 0, 0, [], startTime)
  }

  if (mode === 'scheduled_actions') {
    await processScheduledActions(supabase)
    return buildResult(mode, 0, 0, [], startTime)
  }

  // Récupérer les tenants à traiter
  const tenants = await getActiveTenants(supabase, specificTenantId)

  if (tenants.length === 0) {
    console.log('[orchestrator] No active tenants found')
    return buildResult(mode, 0, 0, [], startTime)
  }

  console.log(`[orchestrator] Processing ${tenants.length} tenant(s)`)

  // Traiter tous les tenants en parallèle
  // (chaque tenant est indépendant)
  const tenantResults = await Promise.allSettled(
    tenants.map(tenant => processTenant(tenant, mode))
  )

  // Agréger les résultats
  let totalRecommendations = 0
  const errors: Array<{ tenantId: string; error: string }> = []

  for (let i = 0; i < tenantResults.length; i++) {
    const result = tenantResults[i]
    const tenant = tenants[i]

    if (result.status === 'fulfilled') {
      totalRecommendations += result.value.totalRecommendations
    } else {
      const errorMessage = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason)

      errors.push({ tenantId: tenant.id, error: errorMessage })

      console.error(
        `[orchestrator] Tenant ${tenant.id} failed:`,
        errorMessage
      )
    }
  }

  return buildResult(mode, tenants.length, totalRecommendations, errors, startTime)
}

// ------------------------------------------------------------
// PROCESS ONE TENANT
// ------------------------------------------------------------

interface TenantProcessResult {
  tenantId: string
  totalRecommendations: number
  agentResults: AgentResult[]
}

async function processTenant(
  tenant: Tenant,
  mode: OrchestratorMode
): Promise<TenantProcessResult> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  console.log(`[orchestrator] Processing tenant ${tenant.id}, mode=${mode}`)

  // Vérifier les intégrations connectées
  const { data: integrations } = await supabase
    .from('integrations')
    .select('provider, status')
    .eq('tenant_id', tenant.id)
    .eq('status', 'active')

  const connectedProviders = new Set<Provider>(
    (integrations ?? []).map(i => i.provider as Provider)
  )

  if (connectedProviders.size === 0 && mode !== 'brief_only') {
    console.log(`[orchestrator] Tenant ${tenant.id} has no active integrations — skipping`)
    return { tenantId: tenant.id, totalRecommendations: 0, agentResults: [] }
  }

  const agentResults: AgentResult[] = []
  let totalRecs = 0

  // --------------------------------------------------------
  // PHASE 1 : INGESTOR (toujours en premier, bloquant)
  // --------------------------------------------------------
  if (mode === 'full' || mode === 'treasury_only') {
    try {
      const ingestResult = await callAgent('agent-ingestor', {
        tenant_id: tenant.id,
        providers: Array.from(connectedProviders)
      })
      agentResults.push(ingestResult)
    } catch (error) {
      console.error(
        `[orchestrator] Ingestor failed for ${tenant.id}:`,
        error instanceof Error ? error.message : error
      )
      // Continuer avec les données en cache — ne pas bloquer les agents
    }
  }

  // --------------------------------------------------------
  // PHASE 2 : AGENTS MÉTIER (en parallèle)
  // --------------------------------------------------------
  const phase2Agents: Promise<AgentResult>[] = []

  if (mode === 'full') {
    // Pipeline Agent (nécessite CRM)
    const hasCRM = ['hubspot', 'salesforce', 'pipedrive', 'close', 'attio']
      .some(p => connectedProviders.has(p as Provider))

    if (hasCRM) {
      phase2Agents.push(
        callAgent('agent-pipeline', { tenant_id: tenant.id })
          .catch(err => buildFailedAgentResult('agent-pipeline', tenant.id, err))
      )
    }

    // Leads Agent (nécessite CRM ou formulaires)
    if (hasCRM) {
      phase2Agents.push(
        callAgent('agent-leads', { tenant_id: tenant.id })
          .catch(err => buildFailedAgentResult('agent-leads', tenant.id, err))
      )
    }

    // Ads Agent (nécessite au moins une plateforme pub)
    const hasAds = ['meta_ads', 'google_ads', 'linkedin_ads', 'tiktok_ads']
      .some(p => connectedProviders.has(p as Provider))

    if (hasAds) {
      phase2Agents.push(
        callAgent('agent-ads', { tenant_id: tenant.id })
          .catch(err => buildFailedAgentResult('agent-ads', tenant.id, err))
      )
    }
  }

  // Treasury Agent (nécessite banking OU stripe)
  if (mode === 'full' || mode === 'treasury_only') {
    const hasTreasury = ['plaid', 'tink', 'stripe', 'quickbooks', 'xero', 'pennylane']
      .some(p => connectedProviders.has(p as Provider))

    if (hasTreasury) {
      phase2Agents.push(
        callAgent('agent-treasury', { tenant_id: tenant.id })
          .catch(err => buildFailedAgentResult('agent-treasury', tenant.id, err))
      )
    }
  }

  // Attendre tous les agents phase 2
  if (phase2Agents.length > 0) {
    const phase2Results = await Promise.all(phase2Agents)
    agentResults.push(...phase2Results)
    totalRecs += phase2Results.reduce(
      (sum, r) => sum + (r.recommendationsCreated ?? 0),
      0
    )
  }

  // --------------------------------------------------------
  // PHASE 3 : BRIEF AGENT (dépend de phase 2)
  // --------------------------------------------------------
  if (mode === 'full' || mode === 'brief_only') {
    try {
      const briefResult = await callAgent('agent-brief', { tenant_id: tenant.id })
      agentResults.push(briefResult)
      totalRecs += briefResult.recommendationsCreated ?? 0
    } catch (error) {
      console.error(
        `[orchestrator] Brief agent failed for ${tenant.id}:`,
        error instanceof Error ? error.message : error
      )
    }
  }

  // --------------------------------------------------------
  // PHASE 4 : FEEDBACK AGENT (async, ne bloque pas)
  // --------------------------------------------------------
  if (mode === 'full' || mode === 'feedback_only') {
    callAgent('agent-feedback', { tenant_id: tenant.id })
      .catch(err => console.error(
        `[orchestrator] Feedback agent failed for ${tenant.id}:`,
        err instanceof Error ? err.message : err
      ))
    // Fire and forget — ne pas await
  }

  // --------------------------------------------------------
  // NOTIFIER LE FOUNDER (si nouvelles recommandations)
  // --------------------------------------------------------
  if (totalRecs > 0 && mode !== 'feedback_only') {
    await notifyNewRecommendations(tenant.id, totalRecs)
  }

  console.log(
    `[orchestrator] Tenant ${tenant.id} done: ${totalRecs} recommendations created`
  )

  return { tenantId: tenant.id, totalRecommendations: totalRecs, agentResults }
}

// ------------------------------------------------------------
// CALL AGENT (Edge Function)
// ------------------------------------------------------------

async function callAgent(
  functionName: string,
  body: Record<string, unknown>
): Promise<AgentResult> {
  const url = `${EDGE_BASE}/${functionName}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(55_000)
    // Edge Functions ont un timeout de 60s — on laisse 5s de marge
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`${functionName} returned ${response.status}: ${errorText}`)
  }

  return await response.json() as AgentResult
}

// ------------------------------------------------------------
// GET ACTIVE TENANTS
// ------------------------------------------------------------

async function getActiveTenants(
  supabase: ReturnType<typeof createClient>,
  specificTenantId: string | null
): Promise<Tenant[]> {
  let query = supabase
    .from('tenants')
    .select('*')
    .in('status', ['trial', 'active'])

  if (specificTenantId) {
    query = query.eq('id', specificTenantId)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to fetch tenants: ${error.message}`)
  }

  return (data ?? []) as Tenant[]
}

// ------------------------------------------------------------
// NOTIFY NEW RECOMMENDATIONS
// Récupère les nouvelles recos et notifie via Slack.
// ------------------------------------------------------------

async function notifyNewRecommendations(
  tenantId: string,
  count: number
): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

  const { data: newRecs } = await supabase
    .from('recommendations')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .gte('created_at', fiveMinutesAgo)
    .order('priority', { ascending: false })

  if (!newRecs || newRecs.length === 0) return

  // Vérifier si critique → notification immédiate
  const hasCritical = newRecs.some(r => r.priority === 'critical')
  if (hasCritical) {
    const criticalRec = newRecs.find(r => r.priority === 'critical')!
    await notifyCritical(
      tenantId,
      criticalRec.title,
      criticalRec.summary ?? '',
      `${Deno.env.get('APP_URL') ?? ''}/command`
    )
  } else {
    await notifyBatch(tenantId, newRecs)
  }
}

// ------------------------------------------------------------
// PROCESS SCHEDULED ACTIONS
// Exécute les actions planifiées dont scheduled_at < NOW()
// ------------------------------------------------------------

async function processScheduledActions(
  supabase: ReturnType<typeof createClient>
): Promise<void> {
  const { data: dueActions } = await supabase
    .from('scheduled_actions')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .lt('attempts', 3)
    .order('scheduled_at', { ascending: true })
    .limit(50)

  if (!dueActions || dueActions.length === 0) return

  console.log(`[orchestrator] Processing ${dueActions.length} scheduled actions`)

  for (const action of dueActions) {
    try {
      // Marquer comme running
      await supabase
        .from('scheduled_actions')
        .update({ status: 'running', attempts: action.attempts + 1 })
        .eq('id', action.id)

      await executeScheduledAction(action)

      // Marquer comme done
      await supabase
        .from('scheduled_actions')
        .update({ status: 'done', executed_at: new Date().toISOString() })
        .eq('id', action.id)

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[orchestrator] Scheduled action ${action.id} failed:`, message)

      const newAttempts = action.attempts + 1
      await supabase
        .from('scheduled_actions')
        .update({
          status: newAttempts >= action.max_attempts ? 'failed' : 'pending',
          error: message,
          attempts: newAttempts
        })
        .eq('id', action.id)
    }
  }
}

async function executeScheduledAction(
  action: Record<string, unknown>
): Promise<void> {
  const actionType = action.action_type as string

  switch (actionType) {
    case 'run_agent': {
      const payload = action.payload as Record<string, unknown>
      await callAgent(payload.agent_name as string, {
        tenant_id: action.tenant_id,
        ...payload
      })
      break
    }

    case 'send_notification': {
      const payload = action.payload as Record<string, unknown>
      await notifyCritical(
        action.tenant_id as string,
        payload.title as string,
        payload.body as string,
        payload.url as string | undefined
      )
      break
    }

    default:
      console.warn(`[orchestrator] Unknown action type: ${actionType}`)
  }
}

// ------------------------------------------------------------
// REFRESH FX RATES
// Récupère les taux de change quotidiens depuis une API gratuite.
// ------------------------------------------------------------

async function refreshFxRates(
  supabase: ReturnType<typeof createClient>
): Promise<void> {
  try {
    // API gratuite : exchangerate-api.com ou frankfurter.app
    const response = await fetch(
      'https://api.frankfurter.app/latest?from=EUR&to=USD,GBP,CHF,SEK,DKK,NOK,PLN,CZK',
      { signal: AbortSignal.timeout(10_000) }
    )

    if (!response.ok) {
      console.error('[orchestrator] FX rates API error:', response.status)
      return
    }

    const data = await response.json()
    const today = new Date().toISOString().split('T')[0]

    const rates = Object.entries(data.rates as Record<string, number>).map(
      ([currency, rate]) => ({
        from_currency: 'EUR',
        to_currency: currency,
        rate,
        rate_date: today
      })
    )

    // Ajouter EUR → EUR
    rates.push({ from_currency: 'EUR', to_currency: 'EUR', rate: 1.0, rate_date: today })

    await supabase
      .from('fx_rates')
      .upsert(rates, { onConflict: 'from_currency,to_currency,rate_date' })

    console.log(`[orchestrator] FX rates updated: ${rates.length} pairs`)

  } catch (error) {
    console.error('[orchestrator] Failed to refresh FX rates:', error)
  }
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function buildResult(
  mode: string,
  tenantsProcessed: number,
  totalRecommendations: number,
  errors: Array<{ tenantId: string; error: string }>,
  startTime: number
): OrchestratorResult {
  return {
    mode,
    tenantsProcessed,
    totalRecommendations,
    errors,
    durationMs: Date.now() - startTime
  }
}

function buildFailedAgentResult(
  agentName: string,
  tenantId: string,
  error: unknown
): AgentResult {
  return {
    tenantId,
    agentType: agentName as never,
    success: false,
    recommendationsCreated: 0,
    error: error instanceof Error ? error.message : String(error),
    durationMs: 0
  }
}
