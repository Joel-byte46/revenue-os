// ============================================================
// REVENUE OS — RAG (Retrieval Augmented Generation)
// Système de mémoire long-terme.
// Avant chaque appel LLM, on récupère les patterns
// qui ont fonctionné dans des situations similaires.
//
// FLUX :
// 1. Contexte courant → embedding (OpenAI ada-002)
// 2. Embedding → recherche vectorielle pgvector
// 3. Patterns pertinents → injection dans le prompt LLM
// 4. LLM produit une recommandation ancrée dans l'historique
//
// RÉSULTAT :
// Mois 1 : recommandations génériques
// Mois 3 : recommandations basées sur 50 patterns
// Mois 6 : recommandations hyper-personnalisées
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { generateEmbedding } from './llm.ts'
import type { Pattern, RAGContext, AgentType } from './types.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Seuils de similarité par agent
// Plus le seuil est élevé, plus on est strict sur la pertinence
const SIMILARITY_THRESHOLDS: Record<AgentType, number> = {
  pipeline_stagnation: 0.75,
  lead_engagement: 0.72,
  lead_reengagement: 0.70,
  ads_waste: 0.78,
  ads_scaling: 0.78,
  treasury_runway: 0.80,
  treasury_zombie: 0.82,
  treasury_anomaly: 0.80,
  weekly_brief: 0.65
}

const MIN_RESULT_SCORE = 65
// On ne récupère que les patterns avec outcome_score >= 65
// (patterns qui ont vraiment marché)

const MAX_PATTERNS = 3
// On injecte max 3 patterns dans le prompt
// Au-delà, le contexte devient trop long et dilue la précision

// ------------------------------------------------------------
// GET RAG CONTEXT
// Point d'entrée principal. Appelé par chaque agent
// avant de construire son prompt LLM.
// ------------------------------------------------------------

export async function getRAGContext(
  tenantId: string,
  agentType: AgentType,
  contextText: string
): Promise<RAGContext> {

  // Cas 1 : Pas assez de patterns en DB → retourner contexte vide
  // Le LLM fonctionnera sans contexte RAG (moins précis mais fonctionnel)
  const patternCount = await countPatterns(tenantId, agentType)

  if (patternCount < 3) {
    return {
      patterns: [],
      formattedContext: buildEmptyContext(agentType)
    }
  }

  // Cas 2 : Générer l'embedding du contexte courant
  let embedding: number[]

  try {
    embedding = await generateEmbedding(tenantId, contextText)
  } catch (error) {
    console.error('[rag] Failed to generate embedding:', error)
    return {
      patterns: [],
      formattedContext: buildEmptyContext(agentType)
    }
  }

  // Cas 3 : Recherche vectorielle dans pgvector
  const patterns = await searchPatterns(
    tenantId,
    agentType,
    embedding,
    SIMILARITY_THRESHOLDS[agentType]
  )

  return {
    patterns,
    formattedContext: formatPatternsForPrompt(patterns, agentType)
  }
}

// ------------------------------------------------------------
// STORE PATTERN
// Appelé par A7 (Feedback Agent) quand outcome_score >= 70.
// Stocke le pattern en mémoire long-terme.
// ------------------------------------------------------------

export async function storePattern(params: {
  tenantId: string
  agentType: AgentType
  contextText: string
  // Description du contexte de la situation
  resultScore: number
  // 0-100, mesuré par l'agent feedback
  metadata: Record<string, unknown>
}): Promise<void> {
  const { tenantId, agentType, contextText, resultScore, metadata } = params

  if (resultScore < MIN_RESULT_SCORE) {
    // Ne pas stocker les patterns médiocres
    return
  }

  let embedding: number[]

  try {
    embedding = await generateEmbedding(tenantId, contextText)
  } catch (error) {
    console.error('[rag] Failed to generate embedding for storage:', error)
    return
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  const { error } = await supabase
    .from('pattern_embeddings')
    .insert({
      tenant_id: tenantId,
      embedding: `[${embedding.join(',')}]`,
      content: contextText,
      agent_source: agentType,
      result_score: resultScore,
      metadata
    })

  if (error) {
    console.error('[rag] Failed to store pattern:', error)
  }
}

// ------------------------------------------------------------
// BUILD CONTEXT TEXT
// Helpers pour construire le texte à vectoriser
// depuis les données métier de chaque agent.
// Appelés par les agents avant getRAGContext().
// ------------------------------------------------------------

export function buildPipelineContextText(deal: {
  stage: string
  amount: number
  days_stagnant: number
  company_name: string | null
  notes: string | null
  contact_email: string | null
}): string {
  return [
    `Deal stuck at stage: ${deal.stage}`,
    `Amount: ${deal.amount}`,
    `Days without activity: ${deal.days_stagnant}`,
    deal.company_name ? `Company: ${deal.company_name}` : null,
    deal.notes ? `Last notes: ${deal.notes.slice(0, 200)}` : null,
    `Recovery attempt needed`
  ]
    .filter(Boolean)
    .join('. ')
}

export function buildLeadContextText(lead: {
  total_score: number
  fit_score: number
  intent_score: number
  industry: string | null
  company_size: string | null
  behavior_data: Record<string, unknown> | null
}): string {
  const behaviors: string[] = []
  if (lead.behavior_data) {
    if (lead.behavior_data.pricing_page_visits) {
      behaviors.push(`visited pricing ${lead.behavior_data.pricing_page_visits} times`)
    }
    if (lead.behavior_data.demo_watched) {
      behaviors.push('watched demo')
    }
    if (lead.behavior_data.trial_started) {
      behaviors.push('started trial')
    }
  }

  return [
    `Lead engagement needed`,
    `Total score: ${lead.total_score}/100`,
    `Fit: ${lead.fit_score}/40, Intent: ${lead.intent_score}/40`,
    lead.industry ? `Industry: ${lead.industry}` : null,
    lead.company_size ? `Company size: ${lead.company_size}` : null,
    behaviors.length > 0 ? `Behavior: ${behaviors.join(', ')}` : null
  ]
    .filter(Boolean)
    .join('. ')
}

export function buildAdsContextText(campaign: {
  platform: string
  spend: number
  conversions: number
  ctr: number
  cost_per_conversion: number | null
  avg_cpa: number
}): string {
  return [
    `Ad campaign optimization needed`,
    `Platform: ${campaign.platform}`,
    `Monthly spend: ${campaign.spend}`,
    `Conversions: ${campaign.conversions}`,
    `CTR: ${(campaign.ctr * 100).toFixed(2)}%`,
    campaign.cost_per_conversion
      ? `CPA: ${campaign.cost_per_conversion} vs account avg: ${campaign.avg_cpa}`
      : `Zero conversions detected`
  ]
    .filter(Boolean)
    .join('. ')
}

export function buildTreasuryContextText(data: {
  runway_months: number
  monthly_net_burn: number
  mrr: number
  alert_type: string
}): string {
  return [
    `Treasury alert: ${data.alert_type}`,
    `Runway: ${data.runway_months.toFixed(1)} months`,
    `Net burn: ${data.monthly_net_burn}/month`,
    `MRR: ${data.mrr}`
  ].join('. ')
}

// ------------------------------------------------------------
// INTERNAL : SEARCH PATTERNS
// ------------------------------------------------------------

async function searchPatterns(
  tenantId: string,
  agentType: AgentType,
  embedding: number[],
  minSimilarity: number
): Promise<Pattern[]> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  const { data, error } = await supabase.rpc('match_patterns', {
    p_tenant_id: tenantId,
    p_embedding: `[${embedding.join(',')}]`,
    p_limit: MAX_PATTERNS,
    p_min_score: MIN_RESULT_SCORE
  })

  if (error) {
    console.error('[rag] Vector search error:', error)
    return []
  }

  // Filtrer par similarité minimum
  return (data ?? [])
    .filter((p: Pattern) => p.similarity >= minSimilarity)
    .map((p: Pattern) => ({
      content: p.content,
      result_score: p.result_score,
      agent_source: p.agent_source,
      metadata: p.metadata,
      similarity: p.similarity
    }))
}

// ------------------------------------------------------------
// INTERNAL : COUNT PATTERNS
// ------------------------------------------------------------

async function countPatterns(
  tenantId: string,
  agentType: AgentType
): Promise<number> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  const { count, error } = await supabase
    .from('pattern_embeddings')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('agent_source', agentType)
    .gte('result_score', MIN_RESULT_SCORE)

  if (error) return 0
  return count ?? 0
}

// ------------------------------------------------------------
// INTERNAL : FORMAT PATTERNS FOR PROMPT
// Transforme les patterns en texte injectable dans un prompt.
// ------------------------------------------------------------

function formatPatternsForPrompt(
  patterns: Pattern[],
  agentType: AgentType
): string {
  if (patterns.length === 0) {
    return buildEmptyContext(agentType)
  }

  const header = `HISTORIQUE DES SITUATIONS SIMILAIRES (${patterns.length} cas) :`
  const intro = `Ces patterns ont été mesurés et ont produit des résultats positifs.`
  const instruction = `Utilise-les comme référence pour calibrer ta recommandation.`

  const patternBlocks = patterns.map((p, i) => {
    const similarity = Math.round(p.similarity * 100)
    const score = p.result_score

    return [
      `--- Cas ${i + 1} (pertinence: ${similarity}%, succès: ${score}/100) ---`,
      p.content,
      p.metadata.outcome_details
        ? `Résultat obtenu: ${p.metadata.outcome_details}`
        : null
    ]
      .filter(Boolean)
      .join('\n')
  })

  return [header, intro, instruction, '', ...patternBlocks].join('\n')
}

function buildEmptyContext(agentType: AgentType): string {
  return `HISTORIQUE : Pas encore de patterns disponibles pour ${agentType}. ` +
    `Utilise les meilleures pratiques générales. ` +
    `Le système apprendra de ce premier cas.`
}
