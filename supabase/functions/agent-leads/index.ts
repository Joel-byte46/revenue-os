// ============================================================
// REVENUE OS — AGENT LEADS (A3)
// Score les leads entrants. Génère les séquences d'engagement.
// Ré-engage les leads dormants.
//
// FLUX :
// 1. SQL : Leads nouveaux (status='new', score=0) → scoring déterministe
// 2. SQL : Leads dormants (score >= 50, silencieux 30-180j) → ré-engagement
// 3. RAG : Patterns similaires
// 4. LLM : Explication du score + génération des emails
// 5. DB  : Recommandations + scheduled_actions
//
// RÈGLE : Le scoring est 100% déterministe (SQL + code).
//         Le LLM écrit les emails. Jamais le contraire.
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLMJson } from '../_shared/llm.ts'
import {
  getRAGContext,
  buildLeadContextText
} from '../_shared/rag.ts'
import { notifyRecommendation } from '../_shared/notify.ts'
import {
  SCORE_EXPLAIN,
  INITIAL_EMAIL,
  FOLLOWUP_EMAIL_DAY4,
  BREAKUP_EMAIL_DAY9,
  REENGAGEMENT_DORMANT
} from '../_shared/prompts/leads.prompts.ts'
import { buildProductContext } from '../_shared/prompts/shared.context.ts'
import type {
  Lead,
  LeadBehavior,
  LeadEngagementPayload,
  Recommendation,
  RecommendationPriority,
  AgentResult,
  ScheduledAction
} from '../_shared/types.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const MAX_NEW_LEADS_PER_RUN = 20
const MAX_DORMANT_LEADS_PER_RUN = 10

// ------------------------------------------------------------
// SCORING CONSTANTS (déterministes — jamais modifiés par LLM)
// ------------------------------------------------------------

// FIT SCORE (0-40) : correspond à l'ICP ?
const FIT_WEIGHTS = {
  company_size: {
    '1-10': 5,
    '11-50': 15,
    '51-200': 25,
    '201-500': 35,
    '500+': 40
  } as Record<string, number>,
  industry_match: 15,
  // Ajouté si l'industrie est dans target_industries du tenant
  has_linkedin: 5
}

// INTENT SCORE (0-40) : signaux d'intérêt détectés
const INTENT_WEIGHTS = {
  pricing_page_1: 5,
  pricing_page_2: 10,
  pricing_page_3plus: 15,
  demo_watched: 20,
  trial_started: 35,
  docs_visited: 5,
  webinar_attended: 10,
  session_count_5plus: 5
}

// TIMING SCORE (0-20) : urgence déclarée ou signalée
const TIMING_WEIGHTS = {
  timeline_immediate: 20,
  timeline_1month: 15,
  timeline_3months: 10,
  timeline_6months: 5,
  has_budget_field: 5
}

// Routing par score total
const SCORE_ROUTING = {
  immediate: 80,
  // >= 80 → séquence immédiate
  standard: 60,
  // 60-79 → séquence 24h
  nurture: 40
  // 40-59 → séquence longue
  // < 40 → pas d'action
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

  console.log(`[agent-leads] Starting for tenant ${tenantId}`)

  try {
    const result = await runLeadsAgent(tenantId)

    const agentResult: AgentResult = {
      tenantId,
      agentType: 'lead_engagement',
      success: true,
      recommendationsCreated: result.recommendationsCreated,
      durationMs: Date.now() - startTime
    }

    console.log(
      `[agent-leads] Done for ${tenantId}: ` +
      `${result.newLeadsScored} scored, ` +
      `${result.sequencesCreated} sequences, ` +
      `${result.dormantReengaged} reengaged`
    )

    return new Response(JSON.stringify(agentResult), {
      headers: { 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[agent-leads] Error for tenant ${tenantId}:`, message)

    return new Response(
      JSON.stringify({
        tenantId,
        agentType: 'lead_engagement',
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

interface LeadsRunResult {
  newLeadsScored: number
  sequencesCreated: number
  dormantReengaged: number
  recommendationsCreated: number
  failedLLM: number
}

async function runLeadsAgent(tenantId: string): Promise<LeadsRunResult> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // Récupérer la config du tenant
  const { data: tenantData } = await supabase
    .from('tenants')
    .select('settings, vertical, currency')
    .eq('id', tenantId)
    .single()

  const tenantVertical = (tenantData?.vertical ?? 'saas') as 'saas' | 'ecom'
  const targetIndustries: string[] = tenantData?.settings?.target_industries ?? []
  const senderName: string = tenantData?.settings?.sender_name ?? 'L\'équipe'
  const senderTitle: string | undefined = tenantData?.settings?.sender_title

  const productContext = buildProductContext(tenantVertical, true)

  let newLeadsScored = 0
  let sequencesCreated = 0
  let dormantReengaged = 0
  let recommendationsCreated = 0
  let failedLLM = 0

  // --------------------------------------------------------
  // PHASE 1 : Nouveaux leads → scoring + séquences
  // --------------------------------------------------------
  const { data: newLeads } = await supabase
    .from('leads')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'new')
    .eq('sequence_status', 'none')
    .order('created_at', { ascending: false })
    .limit(MAX_NEW_LEADS_PER_RUN)

  for (const leadRow of (newLeads ?? [])) {
    const lead = leadRow as Lead

    try {
      // ÉTAPE 1 : Scoring déterministe
      const scores = calculateLeadScore(lead, targetIndustries)

      // ÉTAPE 2 : Mettre à jour les scores en DB
      await supabase
        .from('leads')
        .update({
          fit_score: scores.fit,
          intent_score: scores.intent,
          timing_score: scores.timing,
          updated_at: new Date().toISOString()
        })
        .eq('id', lead.id)

      newLeadsScored++

      // ÉTAPE 3 : Routing selon score
      const totalScore = scores.fit + scores.intent + scores.timing

      if (totalScore < SCORE_ROUTING.nurture) {
        // Score trop faible → pas d'action
        await supabase
          .from('leads')
          .update({ status: 'disqualified' })
          .eq('id', lead.id)
        continue
      }

      // ÉTAPE 4 : Vérifier qu'il n'y a pas déjà une reco pending
      const { count: existingCount } = await supabase
        .from('recommendations')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('agent_type', 'lead_engagement')
        .eq('status', 'pending')
        .eq(`payload->>lead_id`, lead.id)

      if ((existingCount ?? 0) > 0) continue

      // ÉTAPE 5 : RAG context
      const contextText = buildLeadContextText({
        total_score: totalScore,
        fit_score: scores.fit,
        intent_score: scores.intent,
        industry: lead.industry,
        company_size: lead.company_size,
        behavior_data: lead.behavior_data as Record<string, unknown> | null
      })

      const ragContext = await getRAGContext(
        tenantId,
        'lead_engagement',
        contextText
      )

      // ÉTAPE 6 : LLM — explication du score
      const scoreExplanation = await callLLMJson<{
        explanation: string
        recommended_action: string
        action_reasoning: string
        priority_signals: string[]
        risk_signals: string[]
      }>({
        tenantId,
        systemPrompt: SCORE_EXPLAIN.system,
        userPrompt: SCORE_EXPLAIN.user({
          lead: { ...lead, fit_score: scores.fit, intent_score: scores.intent, timing_score: scores.timing, total_score: totalScore },
          fitScore: scores.fit,
          intentScore: scores.intent,
          timingScore: scores.timing,
          totalScore,
          scoringDetails: {
            company_size_match: scores.companySizeMatch,
            industry_match: scores.industryMatch,
            pricing_page_visits: (lead.behavior_data as LeadBehavior | null)?.pricing_page_visits ?? 0,
            demo_watched: (lead.behavior_data as LeadBehavior | null)?.demo_watched ?? false,
            trial_started: (lead.behavior_data as LeadBehavior | null)?.trial_started ?? false,
            timing_declared: (lead.form_data as Record<string, string> | null)?.timeline ?? null
          }
        }),
        jsonMode: true,
        maxTokens: 300,
        temperature: 0.5
      })

      // ÉTAPE 7 : LLM — email initial
      const emailResult = await callLLMJson<{
        subject: string
        body: string
        angle_used: string
        personalization_elements: string[]
        cta: string
        reasoning: string
      }>({
        tenantId,
        systemPrompt: INITIAL_EMAIL.system,
        userPrompt: INITIAL_EMAIL.user({
          lead: { ...lead, fit_score: scores.fit, intent_score: scores.intent, timing_score: scores.timing, total_score: totalScore },
          ragContext,
          productContext,
          tenantVertical,
          senderName,
          senderTitle
        }),
        jsonMode: true,
        maxTokens: 500,
        temperature: 0.8
      })

      // ÉTAPE 8 : Générer la séquence complète (J+4, J+9)
      const sequence = await generateEmailSequence(tenantId, lead, {
        ...lead,
        fit_score: scores.fit,
        intent_score: scores.intent,
        timing_score: scores.timing,
        total_score: totalScore
      }, emailResult, senderName)

      // ÉTAPE 9 : Calculer la priorité
      const priority = calculateLeadPriority(totalScore, scores)

      // ÉTAPE 10 : Construire le payload
      const payload: LeadEngagementPayload = {
        lead_id: lead.id,
        lead_email: lead.email,
        lead_name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email,
        lead_score: totalScore,
        industry: lead.industry,
        company: lead.company,
        sequence: {
          emails: [
            {
              day: 0,
              subject: emailResult.subject,
              body: emailResult.body,
              reasoning: emailResult.reasoning
            },
            ...sequence
          ]
        },
        score_explanation: scoreExplanation.explanation
      }

      // ÉTAPE 11 : Insérer la recommandation
      const { data: inserted, error: insertError } = await supabase
        .from('recommendations')
        .insert({
          tenant_id: tenantId,
          agent_type: 'lead_engagement',
          priority,
          title: `Nouveau lead : ${lead.first_name ?? lead.email} chez ${lead.company ?? 'entreprise inconnue'} — Score ${totalScore}/100`,
          summary: scoreExplanation.explanation,
          payload,
          status: 'pending',
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        })
        .select()
        .single()

      if (insertError) {
        console.error(`[agent-leads] Insert error for lead ${lead.id}:`, insertError.message)
        continue
      }

      // ÉTAPE 12 : Planifier les emails de suivi
      await scheduleFollowupEmails(supabase, tenantId, lead.id, sequence)

      // ÉTAPE 13 : Marquer le lead comme in_sequence
      await supabase
        .from('leads')
        .update({
          status: 'in_sequence',
          sequence_status: 'active',
          sequence_step: 0,
          updated_at: new Date().toISOString()
        })
        .eq('id', lead.id)

      sequencesCreated++
      recommendationsCreated++

      // Notifier si priorité haute
      if (priority === 'high' || priority === 'critical') {
        await notifyRecommendation(inserted as Recommendation).catch(err =>
          console.error('[agent-leads] Notify failed:', err)
        )
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[agent-leads] Failed to process lead ${lead.id}:`, message)
      failedLLM++

      if (message.includes('API key') || message.includes('billing')) {
        console.error('[agent-leads] LLM error — stopping agent')
        break
      }
    }
  }

  // --------------------------------------------------------
  // PHASE 2 : Leads dormants → ré-engagement
  // --------------------------------------------------------
  const { data: dormantLeads } = await supabase
    .rpc('get_dormant_leads', {
      p_tenant_id: tenantId,
      p_min_days: 30,
      p_max_days: 180,
      p_min_score: 50
    })
    .limit(MAX_DORMANT_LEADS_PER_RUN)

  for (const dormantRow of (dormantLeads ?? [])) {
    const dormant = dormantRow as Lead & { days_silent: number }

    try {
      // Vérifier pas de reco pending
      const { count: existingCount } = await supabase
        .from('recommendations')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('agent_type', 'lead_reengagement')
        .eq('status', 'pending')
        .eq(`payload->>lead_id`, dormant.id)

      if ((existingCount ?? 0) > 0) continue

      // RAG context
      const contextText = buildLeadContextText({
        total_score: dormant.total_score,
        fit_score: dormant.fit_score,
        intent_score: dormant.intent_score,
        industry: dormant.industry,
        company_size: dormant.company_size,
        behavior_data: dormant.behavior_data as Record<string, unknown> | null
      })

      const ragContext = await getRAGContext(
        tenantId,
        'lead_reengagement',
        contextText
      )

      // LLM — email de ré-engagement
      const reengagementResult = await callLLMJson<{
        subject: string
        body: string
        trigger_used: string
        natural_connection: string
        reasoning: string
      }>({
        tenantId,
        systemPrompt: REENGAGEMENT_DORMANT.system,
        userPrompt: REENGAGEMENT_DORMANT.user({
          lead: dormant,
          ragContext,
          triggerReason: 'score_high',
          triggerDetail: null,
          senderName
        }),
        jsonMode: true,
        maxTokens: 400,
        temperature: 0.8
      })

      const payload: LeadEngagementPayload = {
        lead_id: dormant.id,
        lead_email: dormant.email,
        lead_name: [dormant.first_name, dormant.last_name].filter(Boolean).join(' ') || dormant.email,
        lead_score: dormant.total_score,
        industry: dormant.industry,
        company: dormant.company,
        sequence: {
          emails: [{
            day: 0,
            subject: reengagementResult.subject,
            body: reengagementResult.body,
            reasoning: reengagementResult.reasoning
          }]
        },
        score_explanation: reengagementResult.natural_connection
      }

      await supabase
        .from('recommendations')
        .insert({
          tenant_id: tenantId,
          agent_type: 'lead_reengagement',
          priority: 'medium',
          title: `Lead dormant : ${dormant.first_name ?? dormant.email} — ${dormant.days_silent}j de silence`,
          summary: `Score ${dormant.total_score}/100. Silencieux depuis ${dormant.days_silent} jours.`,
          payload,
          status: 'pending',
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        })

      dormantReengaged++
      recommendationsCreated++

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[agent-leads] Failed to reengage lead ${dormant.id}:`, message)
      failedLLM++

      if (message.includes('API key') || message.includes('billing')) break
    }
  }

  return {
    newLeadsScored,
    sequencesCreated,
    dormantReengaged,
    recommendationsCreated,
    failedLLM
  }
}

// ------------------------------------------------------------
// SCORING DÉTERMINISTE
// Jamais modifié par LLM. Règles fixes encodées ici.
// ------------------------------------------------------------

interface ScoreResult {
  fit: number
  intent: number
  timing: number
  companySizeMatch: boolean
  industryMatch: boolean
}

function calculateLeadScore(
  lead: Lead,
  targetIndustries: string[]
): ScoreResult {
  let fit = 0
  let intent = 0
  let timing = 0
  let companySizeMatch = false
  let industryMatch = false

  // ---- FIT SCORE (0-40) ----

  // Taille entreprise
  if (lead.company_size) {
    fit += FIT_WEIGHTS.company_size[lead.company_size] ?? 0
    companySizeMatch = (FIT_WEIGHTS.company_size[lead.company_size] ?? 0) >= 15
  }

  // Industrie match
  if (lead.industry && targetIndustries.length > 0) {
    const industryLower = lead.industry.toLowerCase()
    const matches = targetIndustries.some(t =>
      industryLower.includes(t.toLowerCase())
    )
    if (matches) {
      fit = Math.min(40, fit + FIT_WEIGHTS.industry_match)
      industryMatch = true
    }
  }

  // LinkedIn disponible (signe de qualification)
  if (lead.linkedin_url) {
    fit = Math.min(40, fit + FIT_WEIGHTS.has_linkedin)
  }

  // ---- INTENT SCORE (0-40) ----

  const behavior = lead.behavior_data as LeadBehavior | null

  if (behavior) {
    const pricingVisits = behavior.pricing_page_visits ?? 0

    if (pricingVisits >= 3) {
      intent += INTENT_WEIGHTS.pricing_page_3plus
    } else if (pricingVisits === 2) {
      intent += INTENT_WEIGHTS.pricing_page_2
    } else if (pricingVisits === 1) {
      intent += INTENT_WEIGHTS.pricing_page_1
    }

    if (behavior.trial_started) {
      intent = Math.min(40, intent + INTENT_WEIGHTS.trial_started)
    } else if (behavior.demo_watched) {
      intent = Math.min(40, intent + INTENT_WEIGHTS.demo_watched)
    }

    if (behavior.docs_visited) {
      intent = Math.min(40, intent + INTENT_WEIGHTS.docs_visited)
    }

    if (behavior.webinar_attended) {
      intent = Math.min(40, intent + INTENT_WEIGHTS.webinar_attended)
    }

    if ((behavior.session_count ?? 0) >= 5) {
      intent = Math.min(40, intent + INTENT_WEIGHTS.session_count_5plus)
    }
  }

  // Données formulaire comme signal d'intent
  const formData = lead.form_data as Record<string, string> | null
  if (formData?.demo_requested === 'true' || formData?.demo_requested === true as unknown) {
    intent = Math.min(40, intent + 20)
  }

  // ---- TIMING SCORE (0-20) ----

  const timeline = formData?.timeline?.toLowerCase() ?? ''

  if (timeline.includes('immediate') || timeline.includes('now') || timeline.includes('asap')) {
    timing = TIMING_WEIGHTS.timeline_immediate
  } else if (timeline.includes('1 month') || timeline.includes('month')) {
    timing = TIMING_WEIGHTS.timeline_1month
  } else if (timeline.includes('3 month') || timeline.includes('quarter')) {
    timing = TIMING_WEIGHTS.timeline_3months
  } else if (timeline.includes('6 month') || timeline.includes('semester')) {
    timing = TIMING_WEIGHTS.timeline_6months
  }

  if (formData?.budget && formData.budget !== '') {
    timing = Math.min(20, timing + TIMING_WEIGHTS.has_budget_field)
  }

  return {
    fit: Math.min(40, Math.max(0, fit)),
    intent: Math.min(40, Math.max(0, intent)),
    timing: Math.min(20, Math.max(0, timing)),
    companySizeMatch,
    industryMatch
  }
}

// ------------------------------------------------------------
// PRIORITY CALCULATION (déterministe)
// ------------------------------------------------------------

function calculateLeadPriority(
  totalScore: number,
  scores: ScoreResult
): RecommendationPriority {
  if (totalScore >= 85) return 'critical'
  if (totalScore >= SCORE_ROUTING.immediate) return 'high'
  if (totalScore >= SCORE_ROUTING.standard) return 'medium'
  return 'low'
}

// ------------------------------------------------------------
// GENERATE EMAIL SEQUENCE (J+4 et J+9)
// ------------------------------------------------------------

interface SequenceEmail {
  day: number
  subject: string
  body: string
  reasoning: string
}

async function generateEmailSequence(
  tenantId: string,
  lead: Lead,
  scoredLead: Lead,
  email1: { subject: string; body: string },
  senderName: string
): Promise<SequenceEmail[]> {
  const emails: SequenceEmail[] = []

  try {
    // Email J+4
    const followup = await callLLMJson<{
      subject: string
      body: string
      new_value_delivered: string
      differentiation_from_email1: string
      reasoning: string
    }>({
      tenantId,
      systemPrompt: FOLLOWUP_EMAIL_DAY4.system,
      userPrompt: FOLLOWUP_EMAIL_DAY4.user({
        lead: scoredLead,
        email1Subject: email1.subject,
        email1Body: email1.body,
        ragContext: { patterns: [], formattedContext: '' },
        newValueToAdd: 'insight',
        senderName,
        daysSinceEmail1: 4
      }),
      jsonMode: true,
      maxTokens: 400,
      temperature: 0.8
    })

    emails.push({
      day: 4,
      subject: followup.subject,
      body: followup.body,
      reasoning: followup.reasoning
    })

    // Email J+9
    const breakup = await callLLMJson<{
      subject: string
      body: string
      closing_tone: string
      door_left_open: boolean
      reasoning: string
    }>({
      tenantId,
      systemPrompt: BREAKUP_EMAIL_DAY9.system,
      userPrompt: BREAKUP_EMAIL_DAY9.user({
        lead: scoredLead,
        email1Subject: email1.subject,
        email2Subject: followup.subject,
        senderName,
        daysTotal: 9,
        probableReason: 'unknown'
      }),
      jsonMode: true,
      maxTokens: 300,
      temperature: 0.8
    })

    emails.push({
      day: 9,
      subject: breakup.subject,
      body: breakup.body,
      reasoning: breakup.reasoning
    })

  } catch (error) {
    // La séquence partielle est acceptable — ne pas bloquer
    console.warn(`[agent-leads] Sequence generation partial for lead ${lead.id}:`,
      error instanceof Error ? error.message : error
    )
  }

  return emails
}

// ------------------------------------------------------------
// SCHEDULE FOLLOWUP EMAILS
// Insère dans scheduled_actions pour exécution future.
// ------------------------------------------------------------

async function scheduleFollowupEmails(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  leadId: string,
  sequence: SequenceEmail[]
): Promise<void> {
  const actions = sequence.map(email => ({
    tenant_id: tenantId,
    action_type: 'send_email',
    scheduled_at: new Date(
      Date.now() + email.day * 24 * 60 * 60 * 1000
    ).toISOString(),
    payload: {
      lead_id: leadId,
      email_day: email.day,
      subject: email.subject,
      body: email.body
    },
    status: 'pending',
    attempts: 0,
    max_attempts: 3
  }))

  if (actions.length > 0) {
    await supabase
      .from('scheduled_actions')
      .insert(actions)
      .then(({ error }) => {
        if (error) {
          console.error('[agent-leads] Failed to schedule followup emails:', error.message)
        }
      })
  }
}
