// ============================================================
// REVENUE OS — COMMAND QUERY (Cmd+K)
// Répond aux questions du founder en temps réel.
//
// POST { tenant_id, query: string }
// Response: { answer, query_type, data?, event_id }
//
// RÈGLE : Si la question peut être répondue par SQL → SQL uniquement.
//         Si besoin d'interprétation → SQL + LLM.
//         Jamais LLM sans données SQL.
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLMJson } from '../_shared/llm.ts'
import { buildFinancialSystemPrompt } from '../_shared/prompts/system.rules.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

// Patterns qui peuvent être répondus par SQL uniquement
const SQL_PATTERNS = [
  /runway/i,
  /cash|trésorerie|solde/i,
  /burn|dépenses?/i,
  /mrr|arr|revenus?/i,
  /pipeline|deals?/i,
  /leads?/i,
  /ads?|pub|campagne/i,
  /recommandations?|actions?/i
]

// Patterns qui nécessitent une analyse LLM
const LLM_PATTERNS = [
  /pourquoi/i,
  /analyser?|analysi/i,
  /simul/i,
  /prévoir?|prévision/i,
  /comparer?/i,
  /risque/i,
  /conseil|recommande/i
]

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
    const { tenant_id, query } = body as { tenant_id: string; query: string }

    if (!tenant_id || !query?.trim()) {
      return new Response(
        JSON.stringify({ error: 'tenant_id and query required' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    const trimmedQuery = query.trim().slice(0, 500)
    // Limite de sécurité

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // --------------------------------------------------------
    // ÉTAPE 1 : Classifier la query
    // --------------------------------------------------------
    const needsLLM = LLM_PATTERNS.some(p => p.test(trimmedQuery))
    const isSQLAnswerable = SQL_PATTERNS.some(p => p.test(trimmedQuery)) && !needsLLM
    const queryType = isSQLAnswerable ? 'sql_only' : needsLLM ? 'hybrid' : 'llm'

    // --------------------------------------------------------
    // ÉTAPE 2 : Récupérer le contexte SQL (toujours)
    // --------------------------------------------------------
    const { data: stateMetrics } = await supabase
      .rpc('get_state_metrics', { p_tenant_id: tenant_id })

    const metrics = stateMetrics as Record<string, unknown> | null

    // --------------------------------------------------------
    // ÉTAPE 3 : Données supplémentaires selon la query
    // --------------------------------------------------------
    let additionalData: Record<string, unknown> = {}

    if (/deal|pipeline/i.test(trimmedQuery)) {
      const { data: pipelineHealth } = await supabase
        .rpc('get_pipeline_health', { p_tenant_id: tenant_id })
      additionalData.pipeline = pipelineHealth
    }

    if (/lead/i.test(trimmedQuery)) {
      const { data: leads } = await supabase
        .from('leads')
        .select('status, total_score, company, industry')
        .eq('tenant_id', tenant_id)
        .order('total_score', { ascending: false })
        .limit(10)
      additionalData.leads = leads
    }

    if (/recommendation|action/i.test(trimmedQuery)) {
      const { data: pendingRecs } = await supabase
        .from('recommendations')
        .select('agent_type, priority, title, summary')
        .eq('tenant_id', tenant_id)
        .eq('status', 'pending')
        .order('priority', { ascending: true })
        .limit(5)
      additionalData.pending_recommendations = pendingRecs
    }

    // --------------------------------------------------------
    // ÉTAPE 4 : Construire la réponse
    // --------------------------------------------------------
    let answer = ''
    let answerData: Record<string, unknown> | null = null
    let tokensUsed = 0

    if (isSQLAnswerable && metrics) {
      // Réponse SQL directe sans LLM
      answer = buildSQLAnswer(trimmedQuery, metrics, additionalData)
      answerData = { ...metrics, ...additionalData }

    } else {
      // LLM avec contexte SQL
      const systemPrompt = buildFinancialSystemPrompt()
      const userPrompt = buildCommandPrompt(trimmedQuery, metrics, additionalData)

      try {
        const llmResult = await callLLMJson<{
          answer: string
          key_numbers: Record<string, unknown>
          follow_up_suggestion: string | null
        }>({
          tenantId: tenant_id,
          systemPrompt,
          userPrompt,
          jsonMode: true,
          maxTokens: 400,
          temperature: 0.4
        })

        answer = llmResult.answer
        answerData = llmResult.key_numbers
        tokensUsed = 0
        // Sera capturé par le log dans llm.ts

      } catch (llmError) {
        // Fallback SQL si LLM échoue
        answer = buildSQLAnswer(trimmedQuery, metrics, additionalData)
        answerData = metrics
      }
    }

    // --------------------------------------------------------
    // ÉTAPE 5 : Créer le system_event pour le feed
    // --------------------------------------------------------
    const { data: eventData } = await supabase
      .from('system_events')
      .insert({
        tenant_id,
        event_type: 'command_response',
        title: `Question : "${trimmedQuery.slice(0, 60)}${trimmedQuery.length > 60 ? '...' : ''}"`,
        body: answer,
        severity: 'info',
        metadata: {
          query: trimmedQuery,
          query_type: queryType,
          duration_ms: Date.now() - startTime
        }
      })
      .select('id')
      .single()

    // --------------------------------------------------------
    // ÉTAPE 6 : Stocker dans command_queries
    // --------------------------------------------------------
    await supabase
      .from('command_queries')
      .insert({
        tenant_id,
        query: trimmedQuery,
        query_type: queryType,
        answer,
        answer_data: answerData,
        tokens_used: tokensUsed,
        duration_ms: Date.now() - startTime,
        system_event_id: eventData?.id ?? null
      })

    return new Response(
      JSON.stringify({
        answer,
        query_type: queryType,
        data: answerData,
        event_id: eventData?.id ?? null,
        duration_ms: Date.now() - startTime
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[command-query] Error:', message)

    return new Response(
      JSON.stringify({ error: 'Erreur lors du traitement de la question.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})

// ------------------------------------------------------------
// BUILD SQL ANSWER
// Réponse directe pour les questions simples.
// Aucun LLM — déterministe.
// ------------------------------------------------------------

function buildSQLAnswer(
  query: string,
  metrics: Record<string, unknown> | null,
  additional: Record<string, unknown>
): string {
  if (!metrics) {
    return 'Données insuffisantes. Connectez vos intégrations pour obtenir une analyse.'
  }

  // Runway
  if (/runway|trésorerie|cash/i.test(query)) {
    const runway = metrics.runway_months as number | null
    const balance = metrics.current_balance as number | null
    const burn = metrics.net_burn as number | null

    if (!runway) {
      return 'Runway non calculable — connectez votre compte bancaire.'
    }

    const runwayText = runway >= 99
      ? 'Système rentable — runway infini.'
      : `${runway.toFixed(1)} mois de runway.`

    return [
      runwayText,
      balance ? `Cash disponible : ${balance.toLocaleString('fr-FR')}€.` : null,
      burn ? `Burn net : ${burn.toLocaleString('fr-FR')}€/mois.` : null
    ].filter(Boolean).join(' ')
  }

  // Pipeline
  if (/pipeline|deal/i.test(query)) {
    const value = metrics.pipeline_value as number ?? 0
    const stagnant = metrics.stagnant_count as number ?? 0
    const active = metrics.active_deals as number ?? 0

    return `Pipeline actif : ${value.toLocaleString('fr-FR')}€ (${active} deals). ${stagnant} deal(s) bloqué(s).`
  }

  // MRR
  if (/mrr|arr|revenu/i.test(query)) {
    const mrr = metrics.mrr as number ?? 0
    const arr = metrics.arr as number ?? 0

    return `MRR : ${mrr.toLocaleString('fr-FR')}€. ARR : ${arr.toLocaleString('fr-FR')}€.`
  }

  // Actions en attente
  if (/recommendation|action/i.test(query)) {
    const pending = metrics.pending_actions as number ?? 0
    const critical = metrics.critical_actions as number ?? 0

    return `${pending} recommandation(s) en attente.${critical > 0 ? ` Dont ${critical} critique(s).` : ''}`
  }

  // Fallback générique
  const runway = metrics.runway_months as number | null
  const pipeline = metrics.pipeline_value as number ?? 0
  const pending = metrics.pending_actions as number ?? 0

  return [
    runway ? `Runway : ${runway.toFixed(1)} mois.` : null,
    `Pipeline : ${pipeline.toLocaleString('fr-FR')}€.`,
    `${pending} action(s) en attente.`
  ].filter(Boolean).join(' ')
}

// ------------------------------------------------------------
// BUILD COMMAND PROMPT
// Prompt pour les questions nécessitant une analyse LLM.
// ------------------------------------------------------------

function buildCommandPrompt(
  query: string,
  metrics: Record<string, unknown> | null,
  additional: Record<string, unknown>
): string {
  return `
=== QUESTION DU FOUNDER ===

"${query}"

=== ÉTAT ACTUEL DU BUSINESS (données calculées) ===

Trésorerie :
- Runway : ${metrics?.runway_months ?? 'N/A'} mois
- Cash : ${metrics?.current_balance ?? 'N/A'}€
- Burn net : ${metrics?.net_burn ?? 'N/A'}€/mois
- MRR : ${metrics?.mrr ?? 'N/A'}€
- Rentable : ${metrics?.is_profitable ? 'Oui' : 'Non'}

Pipeline :
- Valeur totale : ${metrics?.pipeline_value ?? 'N/A'}€
- Deals actifs : ${metrics?.active_deals ?? 'N/A'}
- Deals bloqués : ${metrics?.stagnant_count ?? 'N/A'}

${additional.pipeline ? `Détail pipeline : ${JSON.stringify(additional.pipeline)}` : ''}
${additional.leads ? `Leads : ${JSON.stringify(additional.leads).slice(0, 500)}` : ''}
${additional.pending_recommendations ? `Actions en attente : ${JSON.stringify(additional.pending_recommendations).slice(0, 500)}` : ''}

Publicité :
- Spend mensuel : ${metrics?.ads_spend ?? 'N/A'}€
- Taux de conversion : ${metrics?.conversion_rate ?? 'N/A'}%

Actions en attente : ${metrics?.pending_actions ?? 0}

=== MISSION ===

Réponds à la question du founder de manière directe et factuelle.
Utilise UNIQUEMENT les données fournies ci-dessus.
N'invente aucun chiffre. Si l'information manque, dis-le.
Maximum 3 phrases. Direct. Chiffré si possible.

Produis UNIQUEMENT ce JSON :

{
  "answer": "Réponse directe en 1-3 phrases.",
  "key_numbers": { "chiffre_cle": valeur },
  "follow_up_suggestion": "Question de suivi pertinente (optionnel, null si aucune)"
}
`.trim()
}
