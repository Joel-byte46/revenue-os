// ============================================================
// REVENUE OS — AGENT ADS OPTIMIZATION (A4)
// Détecte le gaspillage publicitaire et les opportunités de scaling.
//
// FLUX :
// 1. SQL : Récupérer les campagnes actives + moyennes du compte
// 2. SQL : Appliquer les règles de détection (déterministe)
// 3. RAG : Patterns similaires
// 4. LLM : Explication du diagnostic + recommandation
// 5. DB  : Recommandations stockées
//
// RÈGLE ABSOLUE :
// Le SQL décide ce qui est gaspillage ou opportunité.
// Le LLM explique et formule. Jamais l'inverse.
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLMJson } from '../_shared/llm.ts'
import {
  getRAGContext,
  buildAdsContextText
} from '../_shared/rag.ts'
import { notifyRecommendation } from '../_shared/notify.ts'
import {
  WASTE_DIAGNOSIS,
  SCALING_OPPORTUNITY
} from '../_shared/prompts/ads.prompts.ts'
import type {
  AdCampaign,
  AdAccountAverages,
  AdPlatform,
  AdsWastePayload,
  AdsScalingPayload,
  Recommendation,
  RecommendationPriority,
  AgentResult
} from '../_shared/types.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const MAX_RECOMMENDATIONS_PER_RUN = 15

// ------------------------------------------------------------
// RÈGLES DE DÉTECTION (100% déterministe)
// Ces seuils ne sont jamais modifiés par LLM.
// ------------------------------------------------------------

const WASTE_RULES = {
  zero_conversion: {
    min_spend: 200,
    // Spend > 200€ ET zéro conversion
    conversions_threshold: 0
  },
  high_cpa: {
    cpa_multiplier: 3.0
    // CPA > 3x la moyenne du compte
  },
  low_ctr: {
    ctr_threshold: 0.005,
    // CTR < 0.5%
    min_impressions: 10_000
    // Sur au moins 10K impressions
  },
  budget_inefficiency: {
    spend_trend_pct: 0.20,
    // Spend +20% MoM
    conversion_flat_threshold: 0.05
    // Avec conversions stables (< 5% de variation)
  }
}

const SCALING_RULES = {
  good_cpa: {
    cpa_advantage: 0.70,
    // CPA < 70% de la moyenne = 30% meilleur
    min_conversions: 5
    // Au moins 5 conversions pour être statistiquement fiable
  },
  good_ctr: {
    ctr_multiplier: 1.5,
    // CTR > 1.5x la moyenne du compte
    min_impressions: 5_000
  }
}

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

  console.log(`[agent-ads] Starting for tenant ${tenantId}`)

  try {
    const result = await runAdsAgent(tenantId)

    const agentResult: AgentResult = {
      tenantId,
      agentType: 'ads_waste',
      success: true,
      recommendationsCreated: result.recommendationsCreated,
      durationMs: Date.now() - startTime
    }

    console.log(
      `[agent-ads] Done for ${tenantId}: ` +
      `${result.wasteDetected} waste, ` +
      `${result.scalingOpportunities} scaling, ` +
      `${result.recommendationsCreated} recommendations`
    )

    return new Response(JSON.stringify(agentResult), {
      headers: { 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[agent-ads] Error for tenant ${tenantId}:`, message)

    return new Response(
      JSON.stringify({
        tenantId,
        agentType: 'ads_waste',
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

interface AdsRunResult {
  campaignsAnalyzed: number
  wasteDetected: number
  scalingOpportunities: number
  recommendationsCreated: number
  failedLLM: number
}

async function runAdsAgent(tenantId: string): Promise<AdsRunResult> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // --------------------------------------------------------
  // ÉTAPE 1 : Récupérer les campagnes actives (30 derniers jours)
  // --------------------------------------------------------
  const { data: campaigns, error: campaignsError } = await supabase
    .from('ad_campaigns')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .gte('snapshot_date', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0])
    .order('spend', { ascending: false })

  if (campaignsError) {
    throw new Error(`Failed to fetch campaigns: ${campaignsError.message}`)
  }

  if (!campaigns || campaigns.length === 0) {
    console.log(`[agent-ads] No active campaigns for tenant ${tenantId}`)
    return {
      campaignsAnalyzed: 0,
      wasteDetected: 0,
      scalingOpportunities: 0,
      recommendationsCreated: 0,
      failedLLM: 0
    }
  }

  // --------------------------------------------------------
  // ÉTAPE 2 : Récupérer les moyennes du compte par plateforme
  // --------------------------------------------------------
  const platforms = [...new Set(campaigns.map(c => c.platform))] as AdPlatform[]
  const accountAveragesByPlatform: Record<string, AdAccountAverages> = {}

  for (const platform of platforms) {
    const { data: avgs } = await supabase
      .rpc('get_ads_account_averages', {
        p_tenant_id: tenantId,
        p_platform: platform
      })

    accountAveragesByPlatform[platform] = avgs as AdAccountAverages ?? {
      avg_cpa: 0,
      avg_ctr: 0,
      avg_roas: 0,
      total_spend_30d: 0,
      total_conversions_30d: 0
    }
  }

  // --------------------------------------------------------
  // ÉTAPE 3 : Récupérer les recos déjà pending (déduplication)
  // --------------------------------------------------------
  const { data: existingRecs } = await supabase
    .from('recommendations')
    .select("payload->>'campaign_id'")
    .eq('tenant_id', tenantId)
    .in('agent_type', ['ads_waste', 'ads_scaling'])
    .eq('status', 'pending')

  const campaignsWithPendingRec = new Set(
    (existingRecs ?? []).map(r => r["payload->>'campaign_id'"] as string)
  )

  // --------------------------------------------------------
  // ÉTAPE 4 : Classifier chaque campagne (SQL rules)
  // --------------------------------------------------------
  type WasteType = 'zero_conversion' | 'high_cpa' | 'low_ctr' | 'budget_inefficiency'

  const wasteQueue: Array<{ campaign: AdCampaign; wasteType: WasteType; monthlyWaste: number }> = []
  const scalingQueue: Array<{ campaign: AdCampaign; cpaAdvantage: number }> = []

  for (const campaign of campaigns as AdCampaign[]) {
    if (campaignsWithPendingRec.has(campaign.id)) continue

    const averages = accountAveragesByPlatform[campaign.platform] ?? {
      avg_cpa: 0, avg_ctr: 0, avg_roas: 0,
      total_spend_30d: 0, total_conversions_30d: 0
    }

    const wasteType = detectWaste(campaign, averages)

    if (wasteType) {
      const monthlyWaste = calculateMonthlyWaste(campaign, wasteType, averages)
      wasteQueue.push({ campaign, wasteType, monthlyWaste })
    } else {
      const scalingSignal = detectScalingOpportunity(campaign, averages)
      if (scalingSignal) {
        scalingQueue.push({ campaign, cpaAdvantage: scalingSignal.cpaAdvantage })
      }
    }
  }

  // Trier par impact décroissant
  wasteQueue.sort((a, b) => b.monthlyWaste - a.monthlyWaste)
  scalingQueue.sort((a, b) => b.campaign.spend - a.campaign.spend)

  // --------------------------------------------------------
  // ÉTAPE 5 : Générer les recommandations (LLM)
  // --------------------------------------------------------
  let wasteDetected = 0
  let scalingOpportunities = 0
  let recommendationsCreated = 0
  let failedLLM = 0

  const totalQueue = [
    ...wasteQueue.map(w => ({ type: 'waste' as const, data: w })),
    ...scalingQueue.map(s => ({ type: 'scaling' as const, data: s }))
  ].slice(0, MAX_RECOMMENDATIONS_PER_RUN)

  for (const item of totalQueue) {
    try {
      if (item.type === 'waste') {
        const { campaign, wasteType, monthlyWaste } = item.data as typeof wasteQueue[number]
        const averages = accountAveragesByPlatform[campaign.platform]

        const rec = await generateWasteRecommendation(
          supabase,
          tenantId,
          campaign,
          averages,
          wasteType,
          monthlyWaste
        )

        if (rec) {
          wasteDetected++
          recommendationsCreated++

          if (rec.priority === 'critical' || rec.priority === 'high') {
            await notifyRecommendation(rec).catch(err =>
              console.error('[agent-ads] Notify failed:', err)
            )
          }
        }

      } else {
        const { campaign, cpaAdvantage } = item.data as typeof scalingQueue[number]
        const averages = accountAveragesByPlatform[campaign.platform]

        const rec = await generateScalingRecommendation(
          supabase,
          tenantId,
          campaign,
          averages,
          cpaAdvantage
        )

        if (rec) {
          scalingOpportunities++
          recommendationsCreated++
        }
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[agent-ads] Failed to generate recommendation:`, message)
      failedLLM++

      if (message.includes('API key') || message.includes('billing')) {
        console.error('[agent-ads] LLM error — stopping agent')
        break
      }
    }
  }

  return {
    campaignsAnalyzed: campaigns.length,
    wasteDetected,
    scalingOpportunities,
    recommendationsCreated,
    failedLLM
  }
}

// ------------------------------------------------------------
// DETECT WASTE (100% déterministe)
// ------------------------------------------------------------

type WasteType = 'zero_conversion' | 'high_cpa' | 'low_ctr' | 'budget_inefficiency'

function detectWaste(
  campaign: AdCampaign,
  averages: AdAccountAverages
): WasteType | null {

  // Règle 1 : Zéro conversion avec spend significatif
  if (
    campaign.spend >= WASTE_RULES.zero_conversion.min_spend &&
    campaign.conversions === 0
  ) {
    return 'zero_conversion'
  }

  // Règle 2 : CPA > 3x la moyenne du compte
  if (
    campaign.cost_per_conversion !== null &&
    averages.avg_cpa > 0 &&
    campaign.cost_per_conversion > averages.avg_cpa * WASTE_RULES.high_cpa.cpa_multiplier
  ) {
    return 'high_cpa'
  }

  // Règle 3 : CTR trop bas sur volume significatif
  if (
    campaign.impressions >= WASTE_RULES.low_ctr.min_impressions &&
    campaign.ctr < WASTE_RULES.low_ctr.ctr_threshold
  ) {
    return 'low_ctr'
  }

  return null
}

// ------------------------------------------------------------
// DETECT SCALING OPPORTUNITY (100% déterministe)
// ------------------------------------------------------------

interface ScalingSignal {
  cpaAdvantage: number
  // 0.3 = 30% meilleur que la moyenne
}

function detectScalingOpportunity(
  campaign: AdCampaign,
  averages: AdAccountAverages
): ScalingSignal | null {

  // Signal 1 : CPA < 70% de la moyenne avec conversions suffisantes
  if (
    campaign.cost_per_conversion !== null &&
    averages.avg_cpa > 0 &&
    campaign.conversions >= SCALING_RULES.good_cpa.min_conversions &&
    campaign.cost_per_conversion < averages.avg_cpa * SCALING_RULES.good_cpa.cpa_advantage
  ) {
    const cpaAdvantage = 1 - (campaign.cost_per_conversion / averages.avg_cpa)
    return { cpaAdvantage }
  }

  // Signal 2 : CTR > 1.5x la moyenne sur volume suffisant
  if (
    campaign.impressions >= SCALING_RULES.good_ctr.min_impressions &&
    averages.avg_ctr > 0 &&
    campaign.ctr > averages.avg_ctr * SCALING_RULES.good_ctr.ctr_multiplier
  ) {
    const cpaAdvantage = campaign.ctr / averages.avg_ctr - 1
    return { cpaAdvantage }
  }

  return null
}

// ------------------------------------------------------------
// CALCULATE MONTHLY WASTE (déterministe)
// ------------------------------------------------------------

function calculateMonthlyWaste(
  campaign: AdCampaign,
  wasteType: WasteType,
  averages: AdAccountAverages
): number {
  switch (wasteType) {
    case 'zero_conversion':
      // Tout le spend est du gaspillage
      return Math.round(campaign.spend)

    case 'high_cpa': {
      // Excess = (CPA_campagne - CPA_moyen) × conversions
      const excessPerConversion = (campaign.cost_per_conversion ?? 0) - averages.avg_cpa
      return Math.round(excessPerConversion * campaign.conversions)
    }

    case 'low_ctr':
      // Estimation : 30% du spend est gaspillé sur mauvaise créative
      return Math.round(campaign.spend * 0.30)

    case 'budget_inefficiency':
      return Math.round(campaign.spend * 0.20)

    default:
      return 0
  }
}

// ------------------------------------------------------------
// GENERATE WASTE RECOMMENDATION
// ------------------------------------------------------------

async function generateWasteRecommendation(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  campaign: AdCampaign,
  averages: AdAccountAverages,
  wasteType: WasteType,
  monthlyWaste: number
): Promise<Recommendation | null> {

  // RAG context
  const contextText = buildAdsContextText({
    platform: campaign.platform,
    spend: campaign.spend,
    conversions: campaign.conversions,
    ctr: campaign.ctr,
    cost_per_conversion: campaign.cost_per_conversion,
    avg_cpa: averages.avg_cpa
  })

  const ragContext = await getRAGContext(tenantId, 'ads_waste', contextText)

  // LLM — diagnostic et recommandation
  const diagnosis = await callLLMJson<{
    diagnosis: string
    root_cause: string
    recommended_action: string
    action_rationale: string
    implementation_steps: string[]
    monthly_savings_if_applied: number
    expected_outcome: string
    risk_if_no_action: string
    confidence: number
    reasoning: string
  }>({
    tenantId,
    systemPrompt: WASTE_DIAGNOSIS.system,
    userPrompt: WASTE_DIAGNOSIS.user({
      campaign,
      accountAverages: averages,
      wasteType,
      monthlyWaste,
      ragContext
    }),
    jsonMode: true,
    maxTokens: 600,
    temperature: 0.6
  })

  const priority = calculateWastePriority(monthlyWaste, wasteType)

  const payload: AdsWastePayload = {
    campaign_id: campaign.id,
    campaign_name: campaign.name ?? 'Campagne sans nom',
    platform: campaign.platform,
    waste_type: wasteType,
    monthly_waste: monthlyWaste,
    diagnosis: diagnosis.diagnosis,
    recommended_action: diagnosis.recommended_action as AdsWastePayload['recommended_action'],
    implementation_steps: diagnosis.implementation_steps,
    monthly_savings_estimate: diagnosis.monthly_savings_if_applied
  }

  const { data: inserted, error } = await supabase
    .from('recommendations')
    .insert({
      tenant_id: tenantId,
      agent_type: 'ads_waste',
      priority,
      title: `Gaspillage pub détecté : ${campaign.name ?? campaign.platform} — ${monthlyWaste}€/mois`,
      summary: diagnosis.diagnosis,
      payload,
      status: 'pending',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    })
    .select()
    .single()

  if (error) {
    console.error('[agent-ads] Insert waste rec error:', error.message)
    return null
  }

  return inserted as Recommendation
}

// ------------------------------------------------------------
// GENERATE SCALING RECOMMENDATION
// ------------------------------------------------------------

async function generateScalingRecommendation(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  campaign: AdCampaign,
  averages: AdAccountAverages,
  cpaAdvantage: number
): Promise<Recommendation | null> {

  // Budget increase suggéré : +30% du spend actuel (conservateur)
  const recommendedBudgetIncrease = Math.round(campaign.spend * 0.30)
  const projectedAdditionalConversions = campaign.cost_per_conversion
    ? Math.floor(recommendedBudgetIncrease / campaign.cost_per_conversion)
    : 0

  // RAG context
  const contextText = buildAdsContextText({
    platform: campaign.platform,
    spend: campaign.spend,
    conversions: campaign.conversions,
    ctr: campaign.ctr,
    cost_per_conversion: campaign.cost_per_conversion,
    avg_cpa: averages.avg_cpa
  })

  const ragContext = await getRAGContext(tenantId, 'ads_scaling', contextText)

  // LLM — opportunité de scaling
  const scaling = await callLLMJson<{
    opportunity_summary: string
    probable_success_factors: string[]
    recommended_budget_increase: number
    scaling_approach: string
    projected_monthly_impact: {
      additional_conversions: number
      additional_spend: number
      projected_cpa: number
    }
    monitoring_kpis: string[]
    scaling_risks: string[]
    stop_signal: string
    confidence: number
    reasoning: string
  }>({
    tenantId,
    systemPrompt: SCALING_OPPORTUNITY.system,
    userPrompt: SCALING_OPPORTUNITY.user({
      campaign,
      accountAverages: averages,
      cpaAdvantage,
      recommendedBudgetIncrease,
      projectedAdditionalConversions,
      ragContext
    }),
    jsonMode: true,
    maxTokens: 600,
    temperature: 0.6
  })

  const payload: AdsScalingPayload = {
    campaign_id: campaign.id,
    campaign_name: campaign.name ?? 'Campagne sans nom',
    platform: campaign.platform,
    current_cpa: campaign.cost_per_conversion ?? 0,
    avg_cpa: averages.avg_cpa,
    cpa_advantage_pct: Math.round(cpaAdvantage * 100),
    recommended_budget_increase: recommendedBudgetIncrease,
    projected_additional_conversions: projectedAdditionalConversions
  }

  const { data: inserted, error } = await supabase
    .from('recommendations')
    .insert({
      tenant_id: tenantId,
      agent_type: 'ads_scaling',
      priority: 'medium',
      title: `Opportunité scaling : ${campaign.name ?? campaign.platform} — CPA ${Math.round(cpaAdvantage * 100)}% sous la moyenne`,
      summary: scaling.opportunity_summary,
      payload,
      status: 'pending',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    })
    .select()
    .single()

  if (error) {
    console.error('[agent-ads] Insert scaling rec error:', error.message)
    return null
  }

  return inserted as Recommendation
}

// ------------------------------------------------------------
// PRIORITY CALCULATION (déterministe)
// ------------------------------------------------------------

function calculateWastePriority(
  monthlyWaste: number,
  wasteType: WasteType
): RecommendationPriority {
  if (monthlyWaste >= 2000) return 'critical'
  if (monthlyWaste >= 500) return 'high'
  if (wasteType === 'zero_conversion') return 'high'
  if (monthlyWaste >= 200) return 'medium'
  return 'low'
}
