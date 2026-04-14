// ============================================================
// REVENUE OS — AGENT FEEDBACK (A7)
// Mesure les outcomes. Alimente le RAG.
// Rend le système plus intelligent à chaque cycle.
//
// FLUX :
// 1. SQL : Recommandations approuvées sans outcome (7-30 jours)
// 2. SQL : Mesurer l'état avant vs après
// 3. Code : Calculer outcome_score (déterministe)
// 4. RAG : Stocker les patterns qui ont marché (score >= 70)
// 5. LLM : Rare — uniquement pour outcomes ambigus
//
// RÈGLE :
// 90% de cet agent = SQL + calculs.
// Le LLM n'intervient que pour les cas limites ambigus.
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLMJson } from '../_shared/llm.ts'
import { storePattern } from '../_shared/rag.ts'
import { OUTCOME_CLASSIFICATION } from '../_shared/prompts/feedback.prompts.ts'
import type {
  Recommendation,
  AgentType,
  AgentResult,
  OutcomeData
} from '../_shared/types.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Délais de mesure par type d'agent
const MEASUREMENT_DELAYS = {
  pipeline_stagnation: 7,
  // Vérifier après 7 jours
  lead_engagement: 7,
  lead_reengagement: 14,
  ads_waste: 30,
  ads_scaling: 30,
  treasury_runway: 30,
  treasury_zombie: 30,
  treasury_anomaly: 14,
  weekly_brief: 7
}

// Seuil pour stocker un pattern dans le RAG
const RAG_STORAGE_THRESHOLD = 70

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

  console.log(`[agent-feedback] Starting for tenant ${tenantId}`)

  try {
    const result = await runFeedbackAgent(tenantId)

    const agentResult: AgentResult = {
      tenantId,
      agentType: 'weekly_brief',
      // Feedback n'a pas son propre AgentType — on réutilise
      success: true,
      recommendationsCreated: 0,
      durationMs: Date.now() - startTime
    }

    console.log(
      `[agent-feedback] Done for ${tenantId}: ` +
      `${result.measured} measured, ` +
      `${result.patternsStored} patterns stored, ` +
      `${result.ambiguous} ambiguous`
    )

    return new Response(JSON.stringify({ ...agentResult, feedback: result }), {
      headers: { 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[agent-feedback] Error for tenant ${tenantId}:`, message)

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

interface FeedbackRunResult {
  measured: number
  patternsStored: number
  ambiguous: number
  skippedTooEarly: number
}

async function runFeedbackAgent(tenantId: string): Promise<FeedbackRunResult> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  let measured = 0
  let patternsStored = 0
  let ambiguous = 0
  let skippedTooEarly = 0

  // --------------------------------------------------------
  // Récupérer les recommandations approuvées sans outcome
  // --------------------------------------------------------
  const { data: approvedRecs } = await supabase
    .from('recommendations')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'approved')
    .is('outcome_score', null)
    .not('agent_type', 'eq', 'weekly_brief')
    // Les briefs ne sont pas mesurés de la même façon
    .order('approved_at', { ascending: true })
    .limit(50)

  if (!approvedRecs || approvedRecs.length === 0) {
    console.log(`[agent-feedback] No approved recommendations to measure for ${tenantId}`)
    return { measured: 0, patternsStored: 0, ambiguous: 0, skippedTooEarly: 0 }
  }

  for (const rec of approvedRecs as Recommendation[]) {
    const agentType = rec.agent_type as AgentType
    const delayDays = MEASUREMENT_DELAYS[agentType] ?? 7
    const approvedAt = new Date(rec.approved_at!)
    const daysSinceApproval = Math.floor(
      (Date.now() - approvedAt.getTime()) / (1000 * 60 * 60 * 24)
    )

    // Pas encore assez de temps écoulé
    if (daysSinceApproval < delayDays) {
      skippedTooEarly++
      continue
    }

    try {
      // Mesurer l'outcome selon le type d'agent
      const outcome = await measureOutcome(supabase, tenantId, rec)

      if (outcome === null) {
        ambiguous++
        continue
      }

      // Mettre à jour la recommandation
      await supabase
        .from('recommendations')
        .update({
          outcome_score: outcome.score,
          outcome_data: outcome.data,
          outcome_measured_at: new Date().toISOString()
        })
        .eq('id', rec.id)

      measured++

      // Stocker dans le RAG si le pattern a bien fonctionné
      if (outcome.score >= RAG_STORAGE_THRESHOLD) {
        await storePatternFromOutcome(tenantId, rec, outcome)
        patternsStored++
      }

    } catch (error) {
      console.error(
        `[agent-feedback] Failed to measure rec ${rec.id}:`,
        error instanceof Error ? error.message : error
      )
    }
  }

  return { measured, patternsStored, ambiguous, skippedTooEarly }
}

// ------------------------------------------------------------
// MEASURE OUTCOME
// Dispatch selon le type d'agent.
// Retourne null si l'outcome est ambigu.
// ------------------------------------------------------------

interface OutcomeResult {
  score: number
  // 0-100
  data: OutcomeData
  contextText: string
  // Pour le RAG
}

function measureOutcome(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  rec: Recommendation
): Promise<OutcomeResult | null> {
  switch (rec.agent_type) {
    case 'pipeline_stagnation':
      return measurePipelineOutcome(supabase, tenantId, rec)

    case 'lead_engagement':
    case 'lead_reengagement':
      return measureLeadOutcome(supabase, tenantId, rec)

    case 'ads_waste':
    case 'ads_scaling':
      return measureAdsOutcome(supabase, tenantId, rec)

    case 'treasury_runway':
    case 'treasury_zombie':
    case 'treasury_anomaly':
      return measureTreasuryOutcome(supabase, tenantId, rec)

    default:
      return null
  }
}

// ------------------------------------------------------------
// PIPELINE OUTCOME
// A le deal avancé après la recommandation ?
// ------------------------------------------------------------

async function measurePipelineOutcome(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  rec: Recommendation
): Promise<OutcomeResult | null> {
  const payload = rec.payload as { deal_id: string; deal_stage: string; deal_amount: number }
  const dealId = payload.deal_id

  if (!dealId) return null

  // Récupérer l'état actuel du deal
  const { data: deal } = await supabase
    .from('deals')
    .select('stage, amount, updated_at')
    .eq('id', dealId)
    .eq('tenant_id', tenantId)
    .single()

  if (!deal) return null

  const stagesBefore = payload.deal_stage
  const stageNow = deal.stage

  // Calculer le score selon l'évolution
  let score = 0

  if (stageNow === 'closed_won') {
    score = 100
  } else if (stageNow !== stagesBefore && stageNow !== 'closed_lost') {
    // A progressé sans être perdu
    score = 70
  } else if (stageNow === 'closed_lost') {
    score = 10
    // L'action a eu lieu mais le deal a été perdu quand même
  } else {
    // Pas de changement
    score = 0
  }

  // Ambiguïté : le deal a changé mais on ne sait pas si c'est grâce à l'action
  const isAmbiguous = score === 70 && deal.updated_at
    ? new Date(deal.updated_at) < new Date(rec.approved_at!)
    : false

  if (isAmbiguous) return null

  const beforeState = { stage: stagesBefore, amount: payload.deal_amount }
  const afterState = { stage: stageNow, amount: deal.amount }

  const contextText = buildPipelinePatternText(rec, beforeState, afterState, score)

  return {
    score,
    data: {
      measured_at: new Date().toISOString(),
      before_state: beforeState,
      after_state: afterState,
      details: `Deal ${stagesBefore} → ${stageNow}. Score: ${score}/100.`
    },
    contextText
  }
}

// ------------------------------------------------------------
// LEAD OUTCOME
// Le lead a-t-il répondu ou progressé ?
// ------------------------------------------------------------

async function measureLeadOutcome(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  rec: Recommendation
): Promise<OutcomeResult | null> {
  const payload = rec.payload as { lead_id: string; lead_email: string; lead_score: number }
  const leadId = payload.lead_id

  if (!leadId) return null

  const { data: lead } = await supabase
    .from('leads')
    .select('status, total_score, updated_at')
    .eq('id', leadId)
    .eq('tenant_id', tenantId)
    .single()

  if (!lead) return null

  const scoreMap: Record<string, number> = {
    won: 100,
    qualified: 80,
    replied: 60,
    in_sequence: 20,
    disqualified: 10,
    lost: 10,
    nurture: 30,
    new: 0,
    unsubscribed: 0
  }

  const score = scoreMap[lead.status] ?? 0

  const beforeState = { status: 'new', score: payload.lead_score }
  const afterState = { status: lead.status, score: lead.total_score }

  const contextText = buildLeadPatternText(rec, beforeState, afterState, score)

  return {
    score,
    data: {
      measured_at: new Date().toISOString(),
      before_state: beforeState,
      after_state: afterState,
      details: `Lead status: new → ${lead.status}. Score: ${score}/100.`
    },
    contextText
  }
}

// ------------------------------------------------------------
// ADS OUTCOME
// Le CPA a-t-il amélioré ? Le gaspillage a-t-il été coupé ?
// ------------------------------------------------------------

async function measureAdsOutcome(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  rec: Recommendation
): Promise<OutcomeResult | null> {
  const payload = rec.payload as {
    campaign_id: string
    monthly_waste?: number
    current_cpa?: number
    avg_cpa?: number
  }

  // Récupérer les métriques actuelles de la campagne
  const { data: currentCampaign } = await supabase
    .from('ad_campaigns')
    .select('spend, conversions, cost_per_conversion, status, ctr')
    .eq('id', payload.campaign_id)
    .eq('tenant_id', tenantId)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .single()

  if (!currentCampaign) return null

  let score = 0

  if (rec.agent_type === 'ads_waste') {
    // Est-ce que le spend a baissé ou la campagne a été pausée ?
    if (currentCampaign.status === 'paused') {
      score = 100
      // Campagne pausée → gaspillage arrêté
    } else if (payload.monthly_waste && currentCampaign.spend < payload.monthly_waste * 0.7) {
      score = 70
      // Spend a baissé de 30%+
    } else {
      score = 0
      // Rien n'a changé
    }
  } else if (rec.agent_type === 'ads_scaling') {
    // Est-ce que le CPA est resté bon après l'augmentation du budget ?
    const originalCpa = payload.current_cpa ?? 0
    const currentCpa = currentCampaign.cost_per_conversion ?? 0
    const avgCpa = payload.avg_cpa ?? 0

    if (currentCpa > 0 && avgCpa > 0 && currentCpa < avgCpa) {
      score = currentCpa < originalCpa * 1.1 ? 100 : 70
      // CPA toujours bon après scaling
    } else if (currentCpa > avgCpa * 1.5) {
      score = 10
      // CPA a explosé après scaling
    } else {
      score = 40
    }
  }

  const beforeState = {
    spend: payload.monthly_waste,
    cpa: payload.current_cpa,
    status: 'active'
  }

  const afterState = {
    spend: currentCampaign.spend,
    cpa: currentCampaign.cost_per_conversion,
    status: currentCampaign.status
  }

  return {
    score,
    data: {
      measured_at: new Date().toISOString(),
      before_state: beforeState,
      after_state: afterState,
      details: `Ads ${rec.agent_type}. Score: ${score}/100.`
    },
    contextText: `Ads optimization ${rec.agent_type} on ${payload.campaign_id}. Score: ${score}.`
  }
}

// ------------------------------------------------------------
// TREASURY OUTCOME
// Le runway a-t-il amélioré ? L'abonnement a-t-il été annulé ?
// ------------------------------------------------------------

async function measureTreasuryOutcome(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  rec: Recommendation
): Promise<OutcomeResult | null> {
  const payload = rec.payload as {
    runway_months?: number
    merchant?: string
    monthly_cost?: number
  }

  // Dernier snapshot treasury
  const { data: latestSnapshot } = await supabase
    .from('treasury_snapshots')
    .select('runway_months, monthly_net_burn, mrr')
    .eq('tenant_id', tenantId)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .single()

  if (!latestSnapshot) return null

  let score = 20
  // Score de base : la recommandation avait au moins de la valeur de sensibilisation

  if (rec.agent_type === 'treasury_runway') {
    const prevRunway = payload.runway_months ?? 0
    const currRunway = latestSnapshot.runway_months ?? 0
    const improvement = currRunway - prevRunway

    if (improvement > 1) score = 100
    else if (improvement > 0.5) score = 80
    else if (improvement > 0) score = 60
    else if (improvement < -0.5) score = 10
    // La situation s'est dégradée

    const beforeState = { runway_months: prevRunway }
    const afterState = { runway_months: currRunway }

    return {
      score,
      data: {
        measured_at: new Date().toISOString(),
        before_state: beforeState,
        after_state: afterState,
        details: `Runway ${prevRunway?.toFixed(1)} → ${currRunway?.toFixed(1)} mois. Score: ${score}/100.`
      },
      contextText: buildTreasuryPatternText(rec, beforeState, afterState, score)
    }
  }

  if (rec.agent_type === 'treasury_zombie' && payload.merchant) {
    // Vérifier si le merchant apparaît encore dans les transactions récentes
    const { count } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .ilike('merchant', `%${payload.merchant}%`)
      .gte('date', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0])

    score = (count ?? 0) === 0 ? 100 : 20
    // Annulé (100) ou toujours actif (20)

    return {
      score,
      data: {
        measured_at: new Date().toISOString(),
        before_state: { merchant: payload.merchant, monthly_cost: payload.monthly_cost },
        after_state: { still_charging: (count ?? 0) > 0 },
        details: `Zombie ${payload.merchant}: ${(count ?? 0) === 0 ? 'cancelled' : 'still active'}. Score: ${score}/100.`
      },
      contextText: `Zombie subscription ${payload.merchant} at ${payload.monthly_cost}€/mo. Outcome: ${score}.`
    }
  }

  return { score, data: {
    measured_at: new Date().toISOString(),
    before_state: {},
    after_state: { snapshot: latestSnapshot },
    details: `Treasury ${rec.agent_type}. Score: ${score}/100.`
  }, contextText: '' }
}

// ------------------------------------------------------------
// STORE PATTERN IN RAG
// Appelé uniquement si outcome_score >= 70.
// ------------------------------------------------------------

async function storePatternFromOutcome(
  tenantId: string,
  rec: Recommendation,
  outcome: OutcomeResult
): Promise<void> {
  if (!outcome.contextText || outcome.contextText.trim() === '') return

  await storePattern({
    tenantId,
    agentType: rec.agent_type as AgentType,
    contextText: outcome.contextText,
    resultScore: outcome.score,
    metadata: {
      recommendation_id: rec.id,
      agent_type: rec.agent_type,
      outcome_score: outcome.score,
      outcome_details: outcome.data.details,
      approved_at: rec.approved_at,
      measured_at: outcome.data.measured_at
    }
  })
}

// ------------------------------------------------------------
// PATTERN TEXT BUILDERS
// Textes optimisés pour la recherche vectorielle RAG.
// ------------------------------------------------------------

function buildPipelinePatternText(
  rec: Recommendation,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  score: number
): string {
  const payload = rec.payload as {
    deal_stage: string
    deal_amount: number
    days_stagnant: number
    company_name: string | null
    blocking_reason: string
    action: { subject: string; body: string }
  }

  return [
    `Deal stuck at stage: ${payload.deal_stage}`,
    `Amount: ${payload.deal_amount}€`,
    `Days stagnant: ${payload.days_stagnant}`,
    payload.company_name ? `Company: ${payload.company_name}` : null,
    `Blocking reason: ${payload.blocking_reason}`,
    `Action taken: email with subject "${payload.action?.subject}"`,
    `Result: stage moved from ${before.stage} to ${after.stage}`,
    `Outcome score: ${score}/100`
  ].filter(Boolean).join('. ')
}

function buildLeadPatternText(
  rec: Recommendation,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  score: number
): string {
  const payload = rec.payload as {
    lead_score: number
    industry: string | null
    company: string | null
    score_explanation: string
    sequence: { emails: Array<{ subject: string }> }
  }

  return [
    `Lead engagement for score ${payload.lead_score}/100`,
    payload.industry ? `Industry: ${payload.industry}` : null,
    payload.company ? `Company: ${payload.company}` : null,
    `Email subject: "${payload.sequence?.emails?.[0]?.subject ?? 'N/A'}"`,
    `Result: status moved from ${before.status} to ${after.status}`,
    `Outcome score: ${score}/100`
  ].filter(Boolean).join('. ')
}

function buildTreasuryPatternText(
  rec: Recommendation,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  score: number
): string {
  const payload = rec.payload as {
    runway_months: number
    monthly_net_burn: number
    mrr: number
    narrative: string
  }

  return [
    `Treasury runway alert`,
    `Runway before: ${payload.runway_months?.toFixed(1)} months`,
    `Runway after: ${(after.runway_months as number)?.toFixed(1)} months`,
    `Net burn: ${payload.monthly_net_burn}€/month`,
    `MRR: ${payload.mrr}€`,
    `Outcome score: ${score}/100`
  ].filter(Boolean).join('. ')
}
