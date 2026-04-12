// ============================================================
// REVENUE OS — AGENT PIPELINE STAGNATION (A2)
// Détecte les deals bloqués et génère des actions de déblocage.
//
// FLUX :
// 1. SQL : Identifier les deals bloqués (déterministe)
// 2. SQL : Vérifier qu'il n'y a pas déjà une reco pending
// 3. RAG : Récupérer les patterns similaires
// 4. LLM : Analyser et générer l'action de déblocage
// 5. DB  : Stocker la recommandation
// 6. Slack : Notifier si critique
//
// RÈGLE : Jamais de calcul financier dans cet agent.
//         Jamais de décision sans données.
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLMJson } from '../_shared/llm.ts'
import {
  getRAGContext,
  buildPipelineContextText
} from '../_shared/rag.ts'
import { notifyRecommendation } from '../_shared/notify.ts'
import { ANALYZE_STUCK_DEAL, PIPELINE_BATCH_SUMMARY } from '../_shared/prompts/pipeline.prompts.ts'
import type {
  StagnantDeal,
  Recommendation,
  PipelinePayload,
  RecommendationPriority,
  AgentResult
} from '../_shared/types.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Max deals analysés par run (éviter spam + timeout)
const MAX_DEALS_PER_RUN = 10

// Seuils de stagnation par étape (jours)
const DEFAULT_STAGE_THRESHOLDS: Record<string, number> = {
  new: 3,
  qualified: 7,
  demo_done: 10,
  proposal_sent: 14,
  negotiation: 21
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

  console.log(`[agent-pipeline] Starting for tenant ${tenantId}`)

  try {
    const result = await runPipelineAgent(tenantId)

    const agentResult: AgentResult = {
      tenantId,
      agentType: 'pipeline_stagnation',
      success: true,
      recommendationsCreated: result.recommendationsCreated,
      durationMs: Date.now() - startTime
    }

    console.log(
      `[agent-pipeline] Done for ${tenantId}: ` +
      `${result.dealsAnalyzed} deals analyzed, ` +
      `${result.recommendationsCreated} recommendations created`
    )

    return new Response(JSON.stringify(agentResult), {
      headers: { 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[agent-pipeline] Error for tenant ${tenantId}:`, message)

    return new Response(
      JSON.stringify({
        tenantId,
        agentType: 'pipeline_stagnation',
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

interface PipelineRunResult {
  dealsAnalyzed: number
  recommendationsCreated: number
  skippedAlreadyPending: number
  failedLLM: number
}

async function runPipelineAgent(tenantId: string): Promise<PipelineRunResult> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // --------------------------------------------------------
  // ÉTAPE 1 : Récupérer la config du tenant
  // --------------------------------------------------------
  const { data: tenantData } = await supabase
    .from('tenants')
    .select('settings, vertical, currency')
    .eq('id', tenantId)
    .single()

  const tenantVertical = (tenantData?.vertical ?? 'saas') as 'saas' | 'ecom'
  const customThresholds: Record<string, number> =
    tenantData?.settings?.stage_thresholds ?? {}
  const stageThresholds = { ...DEFAULT_STAGE_THRESHOLDS, ...customThresholds }

  // --------------------------------------------------------
  // ÉTAPE 2 : Identifier les deals bloqués (SQL pur)
  // --------------------------------------------------------
  const { data: stagnantDeals, error: dealsError } = await supabase
    .rpc('get_stagnant_deals', {
      p_tenant_id: tenantId,
      p_limit: MAX_DEALS_PER_RUN
    })

  if (dealsError) {
    throw new Error(`Failed to fetch stagnant deals: ${dealsError.message}`)
  }

  if (!stagnantDeals || stagnantDeals.length === 0) {
    console.log(`[agent-pipeline] No stagnant deals for tenant ${tenantId}`)
    return {
      dealsAnalyzed: 0,
      recommendationsCreated: 0,
      skippedAlreadyPending: 0,
      failedLLM: 0
    }
  }

  // Appliquer les seuils personnalisés
  const filteredDeals = (stagnantDeals as StagnantDeal[]).filter(deal => {
    const threshold = stageThresholds[deal.stage] ?? 14
    return deal.days_stagnant > threshold
  })

  if (filteredDeals.length === 0) {
    return {
      dealsAnalyzed: 0,
      recommendationsCreated: 0,
      skippedAlreadyPending: 0,
      failedLLM: 0
    }
  }

  // --------------------------------------------------------
  // ÉTAPE 3 : Filtrer les deals déjà en attente de reco
  // --------------------------------------------------------
  const dealIds = filteredDeals.map(d => d.id)

  const { data: existingRecs } = await supabase
    .from('recommendations')
    .select("payload->>'deal_id'")
    .eq('tenant_id', tenantId)
    .eq('agent_type', 'pipeline_stagnation')
    .eq('status', 'pending')

  const dealsWithPendingRec = new Set(
    (existingRecs ?? []).map(r => r["payload->>'deal_id'"] as string)
  )

  const dealsToProcess = filteredDeals.filter(
    deal => !dealsWithPendingRec.has(deal.id)
  )

  const skippedAlreadyPending = filteredDeals.length - dealsToProcess.length

  if (dealsToProcess.length === 0) {
    console.log(
      `[agent-pipeline] All ${filteredDeals.length} deals already have pending recommendations`
    )
    return {
      dealsAnalyzed: filteredDeals.length,
      recommendationsCreated: 0,
      skippedAlreadyPending,
      failedLLM: 0
    }
  }

  // --------------------------------------------------------
  // ÉTAPE 4 : Analyser chaque deal
  // --------------------------------------------------------
  let recommendationsCreated = 0
  let failedLLM = 0
  const createdRecs: Recommendation[] = []

  for (const deal of dealsToProcess) {
    try {
      const rec = await analyzeDeal(supabase, tenantId, deal, tenantVertical)
      if (rec) {
        createdRecs.push(rec)
        recommendationsCreated++
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[agent-pipeline] Failed to analyze deal ${deal.id}:`,
        message
      )
      failedLLM++

      // Si erreur LLM (clé invalide, credits épuisés) → arrêter immédiatement
      if (message.includes('API key') || message.includes('billing')) {
        console.error('[agent-pipeline] LLM error — stopping agent')
        break
      }
    }
  }

  // --------------------------------------------------------
  // ÉTAPE 5 : Notifier les recos critiques immédiatement
  // --------------------------------------------------------
  for (const rec of createdRecs) {
    if (rec.priority === 'critical') {
      await notifyRecommendation(rec).catch(err =>
        console.error('[agent-pipeline] Notify failed:', err)
      )
    }
  }

  // --------------------------------------------------------
  // ÉTAPE 6 : Snapshot pipeline (pour les tendances)
  // --------------------------------------------------------
  await updatePipelineSnapshot(supabase, tenantId)

  return {
    dealsAnalyzed: dealsToProcess.length,
    recommendationsCreated,
    skippedAlreadyPending,
    failedLLM
  }
}

// ------------------------------------------------------------
// ANALYZE ONE DEAL
// ------------------------------------------------------------

async function analyzeDeal(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  deal: StagnantDeal,
  tenantVertical: 'saas' | 'ecom'
): Promise<Recommendation | null> {

  // STEP 1 : RAG Context
  const contextText = buildPipelineContextText({
    stage: deal.stage,
    amount: deal.amount,
    days_stagnant: deal.days_stagnant,
    company_name: deal.company_name,
    notes: deal.notes,
    contact_email: deal.contact_email
  })

  const ragContext = await getRAGContext(
    tenantId,
    'pipeline_stagnation',
    contextText
  )

  // STEP 2 : LLM Analysis
  const systemPrompt = ANALYZE_STUCK_DEAL.system
  const userPrompt = ANALYZE_STUCK_DEAL.user({
    deal,
    ragContext,
    tenantVertical
  })

  interface LLMAnalysisResult {
    blocking_reason: string
    confidence: number
    reasoning: string
    action: {
      type: string
      subject: string
      body: string
      why_this_works: string
    }
    urgency: string
    estimated_impact: string
    alternative_action?: {
      type: string
      description: string
    }
  }

  const analysis = await callLLMJson<LLMAnalysisResult>({
    tenantId,
    systemPrompt,
    userPrompt,
    jsonMode: true,
    maxTokens: 600,
    temperature: 0.7
  })

  // STEP 3 : Calculer la priorité (déterministe, pas LLM)
  const priority = calculatePriority(deal, analysis.urgency)

  // STEP 4 : Construire le payload
  const payload: PipelinePayload = {
    deal_id: deal.id,
    deal_title: deal.title ?? 'Deal sans nom',
    deal_amount: deal.amount,
    deal_stage: deal.stage,
    days_stagnant: deal.days_stagnant,
    contact_email: deal.contact_email,
    contact_name: deal.contact_name,
    company_name: deal.company_name,
    blocking_reason: analysis.blocking_reason,
    confidence: Math.min(95, Math.max(30, analysis.confidence)),
    action: {
      type: 'email',
      subject: analysis.action?.subject ?? '',
      body: analysis.action?.body ?? '',
      why_this_works: analysis.action?.why_this_works ?? ''
    },
    urgency: (analysis.urgency as 'critical' | 'high' | 'medium') ?? 'medium',
    estimated_impact: analysis.estimated_impact ?? ''
  }

  // STEP 5 : Insérer la recommandation
  const { data: inserted, error } = await supabase
    .from('recommendations')
    .insert({
      tenant_id: tenantId,
      agent_type: 'pipeline_stagnation',
      priority,
      title: `Deal bloqué : ${deal.title ?? 'Sans nom'} — ${deal.days_stagnant}j`,
      summary: analysis.blocking_reason,
      payload,
      status: 'pending',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    })
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to insert recommendation: ${error.message}`)
  }

  return inserted as Recommendation
}

// ------------------------------------------------------------
// CALCULATE PRIORITY (Déterministe — jamais par LLM)
// ------------------------------------------------------------

function calculatePriority(
  deal: StagnantDeal,
  llmUrgency: string
): RecommendationPriority {
  const amount = deal.amount ?? 0
  const days = deal.days_stagnant ?? 0

  // Règles déterministes basées sur amount × jours
  if (amount > 10_000 && days > 20) return 'critical'
  if (amount > 5_000 && days > 30) return 'critical'
  if (amount > 5_000 && days > 14) return 'high'
  if (amount > 2_000 && days > 21) return 'high'
  if (llmUrgency === 'critical') return 'high'
  // LLM peut influencer mais pas dépasser le calcul déterministe
  if (llmUrgency === 'high') return 'medium'
  return 'low'
}

// ------------------------------------------------------------
// UPDATE PIPELINE SNAPSHOT
// Sauvegarde un snapshot hebdomadaire pour les tendances.
// ------------------------------------------------------------

async function updatePipelineSnapshot(
  supabase: ReturnType<typeof createClient>,
  tenantId: string
): Promise<void> {
  const { data: health } = await supabase
    .rpc('get_pipeline_health', { p_tenant_id: tenantId })

  if (!health) return

  const today = new Date().toISOString().split('T')[0]

  await supabase
    .from('pipeline_snapshots')
    .upsert(
      { tenant_id: tenantId, snapshot_date: today, metrics: health },
      { onConflict: 'tenant_id,snapshot_date' }
    )
}
