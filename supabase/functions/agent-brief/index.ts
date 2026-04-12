// ============================================================
// REVENUE OS — AGENT BRIEF (A6)
// Agrège les outputs de tous les agents.
// Génère le brief exécutif hebdomadaire.
//
// FLUX :
// 1. SQL : Agréger métriques pipeline, leads, ads, treasury
// 2. SQL : Récupérer les top recommandations en attente
// 3. Python : Forecast pipeline (si données suffisantes)
// 4. LLM : Narratif + top 3 actions (une seule fois)
// 5. DB  : executive_briefs + Slack
//
// RÈGLE :
// Le LLM reçoit des chiffres calculés.
// Il produit uniquement du texte autour de ces chiffres.
// Le score hebdomadaire est calculé ici, jamais par LLM.
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLMJson } from '../_shared/llm.ts'
import { notifyWeeklyBrief } from '../_shared/notify.ts'
import { calculateForecast } from '../_shared/python-client.ts'
import {
  WEEKLY_EXECUTIVE_BRIEF
} from '../_shared/prompts/brief.prompts.ts'
import type {
  WeeklyMetrics,
  BriefAction,
  BriefPayload,
  AgentResult,
  RecommendationPriority
} from '../_shared/types.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// ------------------------------------------------------------
// ENTRY POINT
// ------------------------------------------------------------

serve(async (req: Request) => {
  const startTime = Date.now()

  const body = await req.json().catch(() => ({}))
  const tenantId = body.tenant_id as string

  if (!tenantId) {
    return new Response(
      JSON.stringify({ error: 'tenant_id required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  console.log(`[agent-brief] Starting for tenant ${tenantId}`)

  try {
    const result = await runBriefAgent(tenantId)

    const agentResult: AgentResult = {
      tenantId,
      agentType: 'weekly_brief',
      success: true,
      recommendationsCreated: result.created ? 1 : 0,
      durationMs: Date.now() - startTime
    }

    console.log(
      `[agent-brief] Done for ${tenantId}: ` +
      `score=${result.overallScore}, ` +
      `delivered=${result.delivered}`
    )

    return new Response(JSON.stringify(agentResult), {
      headers: { 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[agent-brief] Error for tenant ${tenantId}:`, message)

    return new Response(
      JSON.stringify({
        tenantId,
        agentType: 'weekly_brief',
        success: false,
        recommendationsCreated: 0,
        error: message,
        durationMs: Date.now() - startTime
      } satisfies AgentResult),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})

// ------------------------------------------------------------
// MAIN LOGIC
// ------------------------------------------------------------

interface BriefRunResult {
  overallScore: number
  created: boolean
  delivered: boolean
}

async function runBriefAgent(tenantId: string): Promise<BriefRunResult> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // Semaine courante (lundi)
  const weekOf = getMondayOfCurrentWeek()

  // Vérifier si le brief de cette semaine existe déjà
  const { data: existingBrief } = await supabase
    .from('executive_briefs')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('week_of', weekOf)
    .single()

  if (existingBrief) {
    console.log(`[agent-brief] Brief already exists for week ${weekOf}`)
    return { overallScore: 0, created: false, delivered: false }
  }

  // Récupérer la config du tenant
  const { data: tenantData } = await supabase
    .from('tenants')
    .select('settings, vertical, name, currency')
    .eq('id', tenantId)
    .single()

  const tenantVertical = (tenantData?.vertical ?? 'saas') as 'saas' | 'ecom'
  const tenantName = tenantData?.name ?? 'Votre entreprise'

  // --------------------------------------------------------
  // ÉTAPE 1 : Agréger toutes les métriques (SQL pur)
  // --------------------------------------------------------
  const metrics = await aggregateWeeklyMetrics(supabase, tenantId)

  // --------------------------------------------------------
  // ÉTAPE 2 : Récupérer les top recommandations pending
  // --------------------------------------------------------
  const { data: pendingRecs } = await supabase
    .from('recommendations')
    .select('id, agent_type, priority, title, payload')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .order('priority', { ascending: true })
    // critical < high < medium < low alphabétiquement — on trie après
    .limit(20)

  // Re-trier par priorité (critical > high > medium > low)
  const priorityOrder: Record<RecommendationPriority, number> = {
    critical: 0, high: 1, medium: 2, low: 3
  }

  const sortedRecs = (pendingRecs ?? []).sort((a, b) =>
    (priorityOrder[a.priority as RecommendationPriority] ?? 3) -
    (priorityOrder[b.priority as RecommendationPriority] ?? 3)
  )

  const topPendingActions: BriefAction[] = sortedRecs.slice(0, 5).map(rec => ({
    title: rec.title,
    impact_estimate: extractImpactEstimate(rec),
    recommendation_id: rec.id,
    priority: rec.priority as RecommendationPriority
  }))

  // --------------------------------------------------------
  // ÉTAPE 3 : Score hebdomadaire (déterministe)
  // --------------------------------------------------------
  const overallScore = calculateWeeklyScore(metrics, sortedRecs.length)

  // Récupérer le score de la semaine précédente
  const { data: prevBrief } = await supabase
    .from('executive_briefs')
    .select('overall_score')
    .eq('tenant_id', tenantId)
    .lt('week_of', weekOf)
    .order('week_of', { ascending: false })
    .limit(1)
    .single()

  const previousWeekScore = prevBrief?.overall_score ?? null

  // --------------------------------------------------------
  // ÉTAPE 4 : Construire alertes et highlights
  // --------------------------------------------------------
  const criticalAlerts = buildCriticalAlerts(metrics, sortedRecs)
  const positiveHighlights = buildPositiveHighlights(metrics)

  // --------------------------------------------------------
  // ÉTAPE 5 : LLM — narratif (une seule fois)
  // --------------------------------------------------------
  let briefResult: {
    narrative: string
    week_score: number
    score_trend: string
    critical_alert: string | null
    top_actions: BriefAction[]
    one_liner: string
  }

  try {
    briefResult = await callLLMJson({
      tenantId,
      systemPrompt: WEEKLY_EXECUTIVE_BRIEF.system,
      userPrompt: WEEKLY_EXECUTIVE_BRIEF.user({
        weekOf,
        metrics,
        topPendingActions,
        overallScore,
        previousWeekScore,
        criticalAlerts,
        positiveHighlights,
        tenantVertical,
        tenantName
      }),
      jsonMode: true,
      maxTokens: 800,
      temperature: 0.6
    })
  } catch (llmError) {
    // Fallback : brief sans narratif LLM
    console.warn('[agent-brief] LLM failed, generating data-only brief')
    briefResult = {
      narrative: buildFallbackNarrative(metrics, criticalAlerts),
      week_score: overallScore,
      score_trend: previousWeekScore === null
        ? 'first'
        : overallScore > previousWeekScore + 5
          ? 'up'
          : overallScore < previousWeekScore - 5
            ? 'down'
            : 'stable',
      critical_alert: criticalAlerts[0] ?? null,
      top_actions: topPendingActions.slice(0, 3),
      one_liner: `${metrics.pending_actions} actions en attente. Runway : ${metrics.runway_months.toFixed(1)} mois.`
    }
  }

  // --------------------------------------------------------
  // ÉTAPE 6 : Stocker le brief
  // --------------------------------------------------------
  const { error: briefError } = await supabase
    .from('executive_briefs')
    .insert({
      tenant_id: tenantId,
      week_of: weekOf,
      metrics,
      narrative: briefResult.narrative,
      top_actions: briefResult.top_actions,
      overall_score: overallScore,
      delivered_at: new Date().toISOString()
    })

  if (briefError) {
    console.error('[agent-brief] Insert brief error:', briefError.message)
  }

  // --------------------------------------------------------
  // ÉTAPE 7 : Insérer dans recommendations (visible dans /command)
  // --------------------------------------------------------
  const briefPayload: BriefPayload = {
    week_of: weekOf,
    metrics,
    narrative: briefResult.narrative,
    top_actions: briefResult.top_actions,
    overall_score: overallScore
  }

  await supabase
    .from('recommendations')
    .insert({
      tenant_id: tenantId,
      agent_type: 'weekly_brief',
      priority: 'medium',
      title: `Brief semaine du ${weekOf} — Score ${overallScore}/100`,
      summary: briefResult.one_liner,
      payload: briefPayload,
      status: 'pending',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    })

  // --------------------------------------------------------
  // ÉTAPE 8 : Livrer via Slack
  // --------------------------------------------------------
  let delivered = false

  try {
    await notifyWeeklyBrief(tenantId, briefPayload)
    delivered = true
  } catch (err) {
    console.error('[agent-brief] Slack delivery failed:', err)
    // Ne pas bloquer — le brief est en DB
  }

  return { overallScore, created: true, delivered }
}

// ------------------------------------------------------------
// AGGREGATE WEEKLY METRICS (100% SQL)
// ------------------------------------------------------------

async function aggregateWeeklyMetrics(
  supabase: ReturnType<typeof createClient>,
  tenantId: string
): Promise<WeeklyMetrics> {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // Pipeline health
  const { data: pipelineHealth } = await supabase
    .rpc('get_pipeline_health', { p_tenant_id: tenantId })

  const ph = pipelineHealth as {
    total_deals: number
    total_value: number
    stagnant_count: number
    stagnant_value: number
    critical_count: number
    avg_deal_size: number
    deals_closed_30d: number
    revenue_closed_30d: number
  } | null

  // Pipeline snapshot de la semaine précédente (pour le % de changement)
  const { data: prevPipelineSnapshot } = await supabase
    .from('pipeline_snapshots')
    .select('metrics')
    .eq('tenant_id', tenantId)
    .lt('snapshot_date', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0])
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .single()

  const prevPipelineValue = (prevPipelineSnapshot?.metrics as { total_value?: number })?.total_value ?? 0
  const currentPipelineValue = ph?.total_value ?? 0
  const pipelineChangePct = prevPipelineValue > 0
    ? Math.round(((currentPipelineValue - prevPipelineValue) / prevPipelineValue) * 100)
    : 0

  // Leads métriques
  const { data: newLeadsData } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', oneWeekAgo)

  const { data: hotLeadsData } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('total_score', 80)
    .neq('status', 'won')
    .neq('status', 'lost')
    .neq('status', 'disqualified')

  const { data: repliedLeadsData } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'replied')
    .gte('updated_at', oneWeekAgo)

  const { data: sequencedLeadsData } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('sequence_status', 'active')

  const newLeads = (newLeadsData as unknown as { count: number })?.count ?? 0
  const hotLeads = (hotLeadsData as unknown as { count: number })?.count ?? 0
  const repliedLeads = (repliedLeadsData as unknown as { count: number })?.count ?? 0
  const sequencedLeads = (sequencedLeadsData as unknown as { count: number })?.count ?? 1
  const replyRate = sequencedLeads > 0
    ? Math.round((repliedLeads / sequencedLeads) * 100)
    : 0

  // Trésorerie (dernier snapshot)
  const { data: treasurySnapshot } = await supabase
    .from('treasury_snapshots')
    .select('runway_months, mrr, monthly_net_burn')
    .eq('tenant_id', tenantId)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .single()

  // Ads métriques
  const { data: adsData } = await supabase
    .from('ad_campaigns')
    .select('spend, cost_per_conversion, conversions')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .gte('snapshot_date', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0])

  const adsArray = adsData ?? []
  const totalAdsSpend = adsArray.reduce((sum, c) => sum + (c.spend ?? 0), 0)
  const totalConversions = adsArray.reduce((sum, c) => sum + (c.conversions ?? 0), 0)
  const avgCpa = totalConversions > 0 ? totalAdsSpend / totalConversions : 0

  // Gaspillage détecté cette semaine
  const { data: wasteRecs } = await supabase
    .from('recommendations')
    .select('payload')
    .eq('tenant_id', tenantId)
    .eq('agent_type', 'ads_waste')
    .gte('created_at', oneWeekAgo)

  const wasteDetected = (wasteRecs ?? []).reduce((sum, rec) => {
    const payload = rec.payload as { monthly_waste?: number }
    return sum + (payload?.monthly_waste ?? 0)
  }, 0)

  // Revenue cette semaine
  const { data: weeklyRevenue } = await supabase
    .from('transactions')
    .select('amount')
    .eq('tenant_id', tenantId)
    .eq('type', 'revenue')
    .gte('date', oneWeekAgo.split('T')[0])

  const revenueThisWeek = (weeklyRevenue ?? []).reduce(
    (sum, t) => sum + (t.amount ?? 0), 0
  )

  // Recommandations en attente
  const { data: pendingCount } = await supabase
    .from('recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')

  return {
    pipeline_value: currentPipelineValue,
    pipeline_change_pct: pipelineChangePct,
    stagnant_count: ph?.stagnant_count ?? 0,
    stagnant_value: ph?.stagnant_value ?? 0,
    deals_closed: ph?.deals_closed_30d ?? 0,
    revenue_this_week: Math.round(revenueThisWeek),
    monthly_forecast: 0,
    // Calculé séparément si données suffisantes
    new_leads: newLeads,
    hot_leads: hotLeads,
    reply_rate: replyRate,
    runway_months: treasurySnapshot?.runway_months ?? 0,
    mrr: treasurySnapshot?.mrr ?? 0,
    net_burn: treasurySnapshot?.monthly_net_burn ?? 0,
    ads_spend: Math.round(totalAdsSpend),
    avg_cpa: Math.round(avgCpa),
    waste_detected: Math.round(wasteDetected),
    pending_actions: (pendingCount as unknown as { count: number })?.count ?? 0
  }
}

// ------------------------------------------------------------
// CALCULATE WEEKLY SCORE (déterministe)
// 0-100. Jamais calculé par LLM.
// ------------------------------------------------------------

function calculateWeeklyScore(
  metrics: WeeklyMetrics,
  pendingActionsCount: number
): number {
  let score = 100

  // Pipeline health (max -30 points)
  const stagnantRatio = metrics.pipeline_value > 0
    ? metrics.stagnant_value / metrics.pipeline_value
    : 0

  if (stagnantRatio > 0.5) score -= 30
  else if (stagnantRatio > 0.3) score -= 20
  else if (stagnantRatio > 0.15) score -= 10

  // Runway (max -30 points)
  if (metrics.runway_months < 3) score -= 30
  else if (metrics.runway_months < 6) score -= 20
  else if (metrics.runway_months < 9) score -= 10

  // Actions pending non traitées (max -20 points)
  if (pendingActionsCount > 10) score -= 20
  else if (pendingActionsCount > 5) score -= 10
  else if (pendingActionsCount > 3) score -= 5

  // Ads waste (max -10 points)
  if (metrics.waste_detected > 2000) score -= 10
  else if (metrics.waste_detected > 500) score -= 5

  // Bonus positifs
  if (metrics.pipeline_change_pct > 10) score += 5
  if (metrics.deals_closed > 0) score += 5
  if (metrics.mrr > 0 && metrics.net_burn === 0) score += 5
  // Profitable

  return Math.min(100, Math.max(0, score))
}

// ------------------------------------------------------------
// BUILD CRITICAL ALERTS
// ------------------------------------------------------------

function buildCriticalAlerts(
  metrics: WeeklyMetrics,
  pendingRecs: Array<{ priority: string; title: string }>
): string[] {
  const alerts: string[] = []

  if (metrics.runway_months > 0 && metrics.runway_months < 3) {
    alerts.push(`Runway critique : ${metrics.runway_months.toFixed(1)} mois restants`)
  }

  if (metrics.stagnant_value > metrics.pipeline_value * 0.4) {
    alerts.push(
      `${Math.round((metrics.stagnant_value / metrics.pipeline_value) * 100)}% du pipeline est bloqué`
    )
  }

  const criticalRecs = pendingRecs.filter(r => r.priority === 'critical')
  if (criticalRecs.length > 0) {
    alerts.push(`${criticalRecs.length} alerte(s) critique(s) en attente d'action`)
  }

  if (metrics.waste_detected > 1000) {
    alerts.push(`${metrics.waste_detected.toLocaleString('fr-FR')}€/mois de gaspillage pub identifié`)
  }

  return alerts
}

// ------------------------------------------------------------
// BUILD POSITIVE HIGHLIGHTS
// ------------------------------------------------------------

function buildPositiveHighlights(metrics: WeeklyMetrics): string[] {
  const highlights: string[] = []

  if (metrics.deals_closed > 0) {
    highlights.push(`${metrics.deals_closed} deal(s) closé(s) — ${metrics.revenue_this_week.toLocaleString('fr-FR')}€ encaissés`)
  }

  if (metrics.pipeline_change_pct > 10) {
    highlights.push(`Pipeline en croissance : +${metrics.pipeline_change_pct}% cette semaine`)
  }

  if (metrics.runway_months > 18) {
    highlights.push(`Trésorerie solide : ${metrics.runway_months.toFixed(0)} mois de runway`)
  }

  if (metrics.net_burn === 0 && metrics.mrr > 0) {
    highlights.push('Rentabilité atteinte — net burn nul')
  }

  if (metrics.hot_leads >= 5) {
    highlights.push(`${metrics.hot_leads} leads chauds (score 80+) en attente de contact`)
  }

  return highlights
}

// ------------------------------------------------------------
// EXTRACT IMPACT ESTIMATE FROM PAYLOAD
// ------------------------------------------------------------

function extractImpactEstimate(rec: {
  agent_type: string
  payload: unknown
}): string {
  const payload = rec.payload as Record<string, unknown>

  switch (rec.agent_type) {
    case 'pipeline_stagnation': {
      const amount = payload.deal_amount as number ?? 0
      return `${amount.toLocaleString('fr-FR')}€ de pipeline à débloquer`
    }
    case 'ads_waste': {
      const waste = payload.monthly_savings_estimate as number ?? payload.monthly_waste as number ?? 0
      return `${waste.toLocaleString('fr-FR')}€/mois économisés`
    }
    case 'treasury_zombie': {
      const cost = payload.annual_cost as number ?? 0
      return `${cost.toLocaleString('fr-FR')}€/an économisés`
    }
    case 'treasury_runway': {
      const runway = payload.runway_months as number ?? 0
      return `Runway actuel : ${runway.toFixed(1)} mois`
    }
    case 'lead_engagement': {
      const score = payload.lead_score as number ?? 0
      return `Lead score ${score}/100`
    }
    default:
      return 'Impact à évaluer'
  }
}

// ------------------------------------------------------------
// FALLBACK NARRATIVE (si LLM indisponible)
// ------------------------------------------------------------

function buildFallbackNarrative(
  metrics: WeeklyMetrics,
  criticalAlerts: string[]
): string {
  if (criticalAlerts.length > 0) {
    return `⚠️ ${criticalAlerts[0]} — ${metrics.pending_actions} recommandations en attente dans le Command Center.`
  }

  return (
    `Pipeline : ${metrics.pipeline_value.toLocaleString('fr-FR')}€ ` +
    `(${metrics.stagnant_count} deals bloqués). ` +
    `Runway : ${metrics.runway_months.toFixed(1)} mois. ` +
    `MRR : ${metrics.mrr.toLocaleString('fr-FR')}€.`
  )
}

// ------------------------------------------------------------
// GET MONDAY OF CURRENT WEEK
// ------------------------------------------------------------

function getMondayOfCurrentWeek(): string {
  const today = new Date()
  const dayOfWeek = today.getDay()
  const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const monday = new Date(today)
  monday.setDate(today.getDate() + daysToMonday)

  return monday.toISOString().split('T')[0]
}
