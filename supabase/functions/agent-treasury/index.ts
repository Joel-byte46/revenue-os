// ============================================================
// REVENUE OS — AGENT TREASURY (A5)
// Calcule l'état de trésorerie. Détecte les anomalies.
// Protège le runway.
//
// FLUX :
// 1. SQL : Récupérer balance, transactions, MRR
// 2. Python : Calculs déterministes (runway, burn, anomalies, zombies)
// 3. LLM : Narratif uniquement (jamais de chiffres inventés)
// 4. DB  : treasury_snapshots + recommendations
//
// RÈGLE ABSOLUE :
// Python calcule. Le LLM narre.
// Aucun chiffre financier ne sort du LLM.
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLMJson } from '../_shared/llm.ts'
import { getRAGContext, buildTreasuryContextText } from '../_shared/rag.ts'
import { notifyCritical } from '../_shared/notify.ts'
import {
  calculateRunway,
  detectAnomalies,
  detectZombies,
  checkPythonHealth
} from '../_shared/python-client.ts'
import {
  RUNWAY_ALERT_NARRATIVE,
  ZOMBIE_SUBSCRIPTION_EXPLAIN,
  ANOMALY_EXPLAIN
} from '../_shared/prompts/treasury.prompts.ts'
import type {
  RunwayResult,
  Anomaly,
  ZombieSubscription,
  TreasuryRunwayPayload,
  TreasuryZombiePayload,
  TreasuryAnomalyPayload,
  Recommendation,
  RecommendationPriority,
  AgentResult
} from '../_shared/types.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Seuils d'alerte runway (en mois)
const RUNWAY_THRESHOLDS = {
  critical: 3,
  high: 6,
  medium: 12
}

// Seuil de gaspillage zombie pour générer une reco (€/mois)
const ZOMBIE_MIN_MONTHLY_COST = 50

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

  console.log(`[agent-treasury] Starting for tenant ${tenantId}`)

  try {
    const result = await runTreasuryAgent(tenantId)

    const agentResult: AgentResult = {
      tenantId,
      agentType: 'treasury_runway',
      success: true,
      recommendationsCreated: result.recommendationsCreated,
      durationMs: Date.now() - startTime
    }

    console.log(
      `[agent-treasury] Done for ${tenantId}: ` +
      `runway=${result.runwayMonths?.toFixed(1)}m, ` +
      `${result.anomaliesDetected} anomalies, ` +
      `${result.zombiesDetected} zombies, ` +
      `${result.recommendationsCreated} recommendations`
    )

    return new Response(JSON.stringify(agentResult), {
      headers: { 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[agent-treasury] Error for tenant ${tenantId}:`, message)

    return new Response(
      JSON.stringify({
        tenantId,
        agentType: 'treasury_runway',
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

interface TreasuryRunResult {
  runwayMonths: number | null
  anomaliesDetected: number
  zombiesDetected: number
  recommendationsCreated: number
}

async function runTreasuryAgent(tenantId: string): Promise<TreasuryRunResult> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // --------------------------------------------------------
  // ÉTAPE 0 : Vérifier que le service Python est up
  // --------------------------------------------------------
  const pythonHealthy = await checkPythonHealth()

  if (!pythonHealthy) {
    // Utiliser le dernier snapshot connu
    console.warn('[agent-treasury] Python service down — using cached snapshot')
    const cached = await getLastSnapshot(supabase, tenantId)

    if (!cached) {
      throw new Error('Python service unavailable and no cached snapshot found')
    }

    // Alerter DevOps via Slack
    await notifyCritical(
      tenantId,
      'Service de calcul indisponible',
      'Le service Python est hors ligne. Les données affichées sont celles du dernier calcul connu.',
    ).catch(() => {})

    return {
      runwayMonths: cached.runway_months,
      anomaliesDetected: 0,
      zombiesDetected: 0,
      recommendationsCreated: 0
    }
  }

  // --------------------------------------------------------
  // ÉTAPE 1 : Collecter les données SQL
  // --------------------------------------------------------

  // Balance bancaire
  const { data: balanceData } = await supabase
    .rpc('get_current_balance', { p_tenant_id: tenantId })

  const currentBalance = (balanceData as number) ?? 0

  // Dépenses mensuelles (6 derniers mois)
  const { data: expenseData } = await supabase
    .rpc('get_monthly_expense_summary', {
      p_tenant_id: tenantId,
      p_months: 6
    })

  const monthlyExpenses = (expenseData ?? []) as Array<{
    month_label: string
    total_expense: number
    breakdown: Record<string, number>
  }>

  // Transactions MRR (récurrentes Stripe)
  const { data: mrrData } = await supabase
    .from('transactions')
    .select('amount, date, merchant, is_recurring')
    .eq('tenant_id', tenantId)
    .eq('type', 'revenue')
    .eq('is_recurring', true)
    .gte('date', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0])
    .order('date', { ascending: false })

  const mrrTransactions = (mrrData ?? []) as Array<{
    amount: number
    date: string
    merchant: string
    is_recurring: boolean
  }>

  // Pipeline pondéré
  const { data: pipelineData } = await supabase
    .rpc('get_weighted_pipeline', {
      p_tenant_id: tenantId,
      p_days: 30
    })

  const pipeline = (pipelineData as {
    expected_30d_revenue: number
    total_weighted_value: number
  }) ?? { expected_30d_revenue: 0, total_weighted_value: 0 }

  // Transactions récurrentes pour zombie detection
  const { data: recurringData } = await supabase
    .from('transactions')
    .select('merchant, amount, category, date, recurrence_id, is_recurring')
    .eq('tenant_id', tenantId)
    .eq('type', 'expense')
    .eq('is_recurring', true)
    .gte('date', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0])

  // Transactions du mois courant par catégorie (pour anomalies)
  const currentMonthStart = new Date()
  currentMonthStart.setDate(1)
  currentMonthStart.setHours(0, 0, 0, 0)

  const { data: currentMonthData } = await supabase
    .from('transactions')
    .select('category, amount, merchant, date')
    .eq('tenant_id', tenantId)
    .eq('type', 'expense')
    .gte('date', currentMonthStart.toISOString().split('T')[0])

  // --------------------------------------------------------
  // ÉTAPE 2 : Calcul runway (Python)
  // --------------------------------------------------------
  const runwayResult = await calculateRunway({
    tenant_id: tenantId,
    current_balance: currentBalance,
    monthly_expenses: monthlyExpenses,
    mrr_transactions: mrrTransactions,
    pipeline_data: pipeline
  })

  // --------------------------------------------------------
  // ÉTAPE 3 : Stocker le snapshot quotidien
  // --------------------------------------------------------
  const today = new Date().toISOString().split('T')[0]

  await supabase
    .from('treasury_snapshots')
    .upsert({
      tenant_id: tenantId,
      snapshot_date: today,
      current_balance: runwayResult.current_balance,
      monthly_burn_gross: runwayResult.monthly_burn_gross,
      monthly_revenue: runwayResult.monthly_revenue,
      monthly_net_burn: runwayResult.monthly_net_burn,
      runway_months: runwayResult.runway_months === 999 ? null : runwayResult.runway_months,
      runway_date: runwayResult.runway_date === '2099-12-31' ? null : runwayResult.runway_date,
      mrr: runwayResult.mrr,
      arr: runwayResult.arr,
      scenario_pessimistic: runwayResult.scenarios.pessimistic,
      scenario_realistic: runwayResult.scenarios.realistic,
      scenario_optimistic: runwayResult.scenarios.optimistic,
      is_profitable: runwayResult.is_profitable,
      data_confidence: runwayResult.data_confidence
    }, { onConflict: 'tenant_id,snapshot_date' })

  let recommendationsCreated = 0

  // --------------------------------------------------------
  // ÉTAPE 4 : Alerte runway si sous les seuils
  // --------------------------------------------------------
  const runwayMonths = runwayResult.runway_months === 999
    ? null
    : runwayResult.runway_months

  if (runwayMonths !== null && runwayMonths < RUNWAY_THRESHOLDS.medium) {
    const alertLevel = runwayMonths < RUNWAY_THRESHOLDS.critical
      ? 'critical'
      : runwayMonths < RUNWAY_THRESHOLDS.high
        ? 'high'
        : 'medium'

    const created = await generateRunwayAlert(
      supabase,
      tenantId,
      runwayResult,
      alertLevel,
      monthlyExpenses
    )

    if (created) recommendationsCreated++
  }

  // --------------------------------------------------------
  // ÉTAPE 5 : Détection d'anomalies (Python)
  // --------------------------------------------------------
  let anomaliesDetected = 0

  if (monthlyExpenses.length >= 2 && currentMonthData && currentMonthData.length > 0) {
    // Grouper les transactions du mois courant par catégorie
    const categoryMap = new Map<string, {
      amount: number
      transactions: Array<{ merchant: string; amount: number; date: string }>
    }>()

    for (const tx of currentMonthData) {
      const cat = tx.category ?? 'unknown'
      const existing = categoryMap.get(cat) ?? { amount: 0, transactions: [] }
      existing.amount += Math.abs(tx.amount)
      existing.transactions.push({
        merchant: tx.merchant ?? 'Unknown',
        amount: Math.abs(tx.amount),
        date: tx.date
      })
      categoryMap.set(cat, existing)
    }

    const currentMonthExpenses = Array.from(categoryMap.entries()).map(
      ([category, data]) => ({
        category,
        amount: data.amount,
        transactions: data.transactions
      })
    )

    try {
      const anomalyResult = await detectAnomalies({
        tenant_id: tenantId,
        monthly_expenses: monthlyExpenses,
        current_month_expenses: currentMonthExpenses,
        lookback_months: 5
      })

      for (const anomaly of anomalyResult.anomalies) {
        if (anomaly.severity === 'medium' && anomaly.z_score < 2.5) continue
        // Ignorer les anomalies medium peu significatives

        const created = await generateAnomalyRecommendation(
          supabase,
          tenantId,
          anomaly,
          currentMonthExpenses.find(c => c.category === anomaly.category)?.transactions ?? []
        )

        if (created) {
          anomaliesDetected++
          recommendationsCreated++
        }
      }
    } catch (err) {
      console.error('[agent-treasury] Anomaly detection failed:', err)
      // Ne pas bloquer — continuer avec zombies
    }
  }

  // --------------------------------------------------------
  // ÉTAPE 6 : Détection zombies (Python)
  // --------------------------------------------------------
  let zombiesDetected = 0

  if (recurringData && recurringData.length > 0) {
    // Agréger par merchant (coût mensuel moyen)
    const merchantMap = new Map<string, {
      total: number
      count: number
      category: string | null
      lastDate: string
      recurrenceId: string
    }>()

    for (const tx of recurringData) {
      const key = tx.merchant ?? 'Unknown'
      const existing = merchantMap.get(key)

      if (existing) {
        existing.total += Math.abs(tx.amount)
        existing.count++
        if (tx.date > existing.lastDate) existing.lastDate = tx.date
      } else {
        merchantMap.set(key, {
          total: Math.abs(tx.amount),
          count: 1,
          category: tx.category,
          lastDate: tx.date,
          recurrenceId: tx.recurrence_id ?? key
        })
      }
    }

    const recurringTransactions = Array.from(merchantMap.entries())
      .map(([merchant, data]) => ({
        merchant,
        monthly_cost: data.count > 0 ? data.total / Math.max(1, data.count / 3) : 0,
        category: data.category,
        last_charge_date: data.lastDate,
        months_subscribed: Math.ceil(data.count / 1),
        recurrence_id: data.recurrenceId
      }))
      .filter(t => t.monthly_cost >= ZOMBIE_MIN_MONTHLY_COST)

    if (recurringTransactions.length > 0) {
      try {
        const zombieResult = await detectZombies({
          tenant_id: tenantId,
          recurring_transactions: recurringTransactions,
          email_mentions: {},
          // TODO: brancher sur Gmail quand connecté
          crm_mentions: {},
          // TODO: brancher sur CRM notes quand disponible
          inactivity_threshold_days: 60
        })

        for (const zombie of zombieResult.zombies) {
          if (zombie.monthly_cost < ZOMBIE_MIN_MONTHLY_COST) continue

          const created = await generateZombieRecommendation(
            supabase,
            tenantId,
            zombie
          )

          if (created) {
            zombiesDetected++
            recommendationsCreated++
          }
        }
      } catch (err) {
        console.error('[agent-treasury] Zombie detection failed:', err)
      }
    }
  }

  // --------------------------------------------------------
  // ÉTAPE 7 : Notifier si critique
  // --------------------------------------------------------
  if (runwayMonths !== null && runwayMonths < RUNWAY_THRESHOLDS.critical) {
    await notifyCritical(
      tenantId,
      `🚨 Runway critique : ${runwayMonths.toFixed(1)} mois`,
      `Cash disponible : ${runwayResult.current_balance.toLocaleString('fr-FR')}€. ` +
      `Burn net : ${runwayResult.monthly_net_burn.toLocaleString('fr-FR')}€/mois. ` +
      `Action immédiate requise.`,
      `${Deno.env.get('APP_URL') ?? ''}/command`
    ).catch(err => console.error('[agent-treasury] Critical notify failed:', err))
  }

  return {
    runwayMonths: runwayMonths ?? runwayResult.runway_months,
    anomaliesDetected,
    zombiesDetected,
    recommendationsCreated
  }
}

// ------------------------------------------------------------
// GENERATE RUNWAY ALERT
// ------------------------------------------------------------

async function generateRunwayAlert(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  runway: RunwayResult,
  alertLevel: 'critical' | 'high' | 'medium',
  monthlyExpenses: Array<{ month_label: string; total_expense: number; breakdown: Record<string, number> }>
): Promise<boolean> {

  // Déduplication : pas de reco runway si déjà pending cette semaine
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { count } = await supabase
    .from('recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('agent_type', 'treasury_runway')
    .eq('status', 'pending')
    .gte('created_at', oneWeekAgo)

  if ((count ?? 0) > 0) return false

  // Récupérer le snapshot précédent pour la comparaison
  const { data: prevSnapshot } = await supabase
    .from('treasury_snapshots')
    .select('runway_months, monthly_net_burn, mrr')
    .eq('tenant_id', tenantId)
    .lt('snapshot_date', new Date().toISOString().split('T')[0])
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .single()

  const previousRunway = prevSnapshot?.runway_months ?? null
  const runwayChange = previousRunway !== null && runway.runway_months !== 999
    ? runway.runway_months - previousRunway
    : null

  // Top catégories de dépenses
  const allCategories: Record<string, number> = {}
  for (const month of monthlyExpenses.slice(-3)) {
    for (const [cat, amount] of Object.entries(month.breakdown)) {
      allCategories[cat] = (allCategories[cat] ?? 0) + amount
    }
  }

  const topExpenseCategories = Object.entries(allCategories)
    .map(([category, total]) => ({
      category,
      amount: Math.round(total / Math.min(3, monthlyExpenses.length)),
      percentage: 0
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map(c => ({
      ...c,
      percentage: runway.monthly_burn_gross > 0
        ? Math.round((c.amount / runway.monthly_burn_gross) * 100)
        : 0
    }))

  // Croissance MRR sur 3 mois
  const mrrGrowthRate: number | null = null
  // TODO: calculer depuis treasury_snapshots quand historique suffisant

  // RAG context
  const contextText = buildTreasuryContextText({
    runway_months: runway.runway_months === 999 ? 99 : runway.runway_months,
    monthly_net_burn: runway.monthly_net_burn,
    mrr: runway.mrr,
    alert_type: `runway_${alertLevel}`
  })

  const ragContext = await getRAGContext(tenantId, 'treasury_runway', contextText)

  // LLM — narratif uniquement
  const narrative = await callLLMJson<{
    narrative: string
    alert_level: string
    key_number: number
    key_number_label: string
    actions: Array<{
      description: string
      impact_months: number | null
      impact_amount: number | null
      effort: string
      deadline: string
    }>
    data_confidence_note: string | null
    positive_signal: string | null
    reasoning: string
  }>({
    tenantId,
    systemPrompt: RUNWAY_ALERT_NARRATIVE.system,
    userPrompt: RUNWAY_ALERT_NARRATIVE.user({
      runway,
      alertLevel,
      previousRunway,
      runwayChange,
      topExpenseCategories,
      mrrGrowthRate,
      ragContext
    }),
    jsonMode: true,
    maxTokens: 700,
    temperature: 0.5
  })

  const priority: RecommendationPriority = alertLevel === 'critical'
    ? 'critical'
    : alertLevel === 'high'
      ? 'high'
      : 'medium'

  const payload: TreasuryRunwayPayload = {
    runway_months: runway.runway_months === 999 ? 99 : runway.runway_months,
    runway_date: runway.runway_date,
    current_balance: runway.current_balance,
    monthly_net_burn: runway.monthly_net_burn,
    mrr: runway.mrr,
    scenario_pessimistic: runway.scenarios.pessimistic,
    scenario_optimistic: runway.scenarios.optimistic,
    narrative: narrative.narrative,
    actions: narrative.actions.map(a => ({
      description: a.description,
      impact_months: a.impact_months ?? 0,
      impact_amount: a.impact_amount,
      urgency: a.effort === 'low' ? 'high' : a.effort === 'medium' ? 'medium' : 'high'
    }))
  }

  const { error } = await supabase
    .from('recommendations')
    .insert({
      tenant_id: tenantId,
      agent_type: 'treasury_runway',
      priority,
      title: `Runway ${alertLevel === 'critical' ? 'critique' : alertLevel === 'high' ? 'en baisse' : 'à surveiller'} : ${(runway.runway_months === 999 ? 99 : runway.runway_months).toFixed(1)} mois`,
      summary: narrative.narrative.split('.')[0] + '.',
      payload,
      status: 'pending',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    })

  if (error) {
    console.error('[agent-treasury] Insert runway rec error:', error.message)
    return false
  }

  return true
}

// ------------------------------------------------------------
// GENERATE ANOMALY RECOMMENDATION
// ------------------------------------------------------------

async function generateAnomalyRecommendation(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  anomaly: Anomaly,
  topTransactions: Array<{ merchant: string; amount: number; date: string }>
): Promise<boolean> {

  // Déduplication par catégorie dans les 7 derniers jours
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { count } = await supabase
    .from('recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('agent_type', 'treasury_anomaly')
    .eq('status', 'pending')
    .gte('created_at', oneWeekAgo)
    .like('payload->>category', anomaly.category)

  if ((count ?? 0) > 0) return false

  const currentMonth = new Date().toLocaleDateString('fr-FR', {
    month: 'long',
    year: 'numeric'
  })

  const historicalContext = `Moyenne historique : ${anomaly.historical_avg.toLocaleString('fr-FR')}€/mois`

  const topMerchants = topTransactions
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map(t => ({ merchant: t.merchant, amount: t.amount }))

  // LLM — explication de l'anomalie
  const explanation = await callLLMJson<{
    anomaly_summary: string
    probable_causes: string[]
    investigation_steps: string[]
    urgency: string
    monthly_impact: number
    annual_impact_if_recurring: number
    type_specific_note: string
  }>({
    tenantId,
    systemPrompt: ANOMALY_EXPLAIN.system,
    userPrompt: ANOMALY_EXPLAIN.user({
      anomaly,
      currentMonth,
      topMerchants,
      historicalContext
    }),
    jsonMode: true,
    maxTokens: 500,
    temperature: 0.5
  })

  const priority: RecommendationPriority = anomaly.severity === 'critical'
    ? 'critical'
    : anomaly.severity === 'high'
      ? 'high'
      : 'medium'

  const payload: TreasuryAnomalyPayload = {
    category: anomaly.category,
    current_amount: anomaly.current_amount,
    historical_avg: anomaly.historical_avg,
    excess_amount: anomaly.excess_amount,
    z_score: anomaly.z_score,
    explanation: explanation.anomaly_summary,
    investigation_steps: explanation.investigation_steps
  }

  const { error } = await supabase
    .from('recommendations')
    .insert({
      tenant_id: tenantId,
      agent_type: 'treasury_anomaly',
      priority,
      title: `Anomalie dépenses : ${anomaly.category} — +${anomaly.excess_amount.toLocaleString('fr-FR')}€ vs normale`,
      summary: explanation.anomaly_summary,
      payload,
      status: 'pending',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    })

  if (error) {
    console.error('[agent-treasury] Insert anomaly rec error:', error.message)
    return false
  }

  return true
}

// ------------------------------------------------------------
// GENERATE ZOMBIE RECOMMENDATION
// ------------------------------------------------------------

async function generateZombieRecommendation(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  zombie: ZombieSubscription
): Promise<boolean> {

  // Déduplication par merchant
  const { count } = await supabase
    .from('recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('agent_type', 'treasury_zombie')
    .eq('status', 'pending')
    .like(`payload->>merchant`, zombie.merchant)

  if ((count ?? 0) > 0) return false

  const inactivityDays = zombie.inactivity_days ?? 61

  // LLM — explication du diagnostic zombie
  const explanation = await callLLMJson<{
    explanation: string
    confidence_justified: boolean
    recommendation: string
    recommendation_rationale: string
    before_cancelling: string
    potential_alternative: string | null
    annual_savings: number
    caveat: string
  }>({
    tenantId,
    systemPrompt: ZOMBIE_SUBSCRIPTION_EXPLAIN.system,
    userPrompt: ZOMBIE_SUBSCRIPTION_EXPLAIN.user({
      zombie,
      inactivityDays,
      accountingCategory: zombie.category,
      similarToolsSuggestions: [],
      annualWaste: zombie.annual_cost
    }),
    jsonMode: true,
    maxTokens: 400,
    temperature: 0.5
  })

  const priority: RecommendationPriority = zombie.monthly_cost >= 500
    ? 'high'
    : zombie.monthly_cost >= 100
    ? 'medium'
      : 'low'

  const payload: TreasuryZombiePayload = {
    merchant: zombie.merchant,
    monthly_cost: zombie.monthly_cost,
    annual_cost: zombie.annual_cost,
    last_activity: zombie.last_activity,
    category: zombie.category,
    confidence: 85,
    recommendation: explanation.recommendation as TreasuryZombiePayload['recommendation'],
    explanation: explanation.explanation,
    potential_alternative: explanation.potential_alternative
  }

  const { error } = await supabase
    .from('recommendations')
    .insert({
      tenant_id: tenantId,
      agent_type: 'treasury_zombie',
      priority,
      title: `Abonnement zombie : ${zombie.merchant} — ${zombie.monthly_cost.toLocaleString('fr-FR')}€/mois`,
      summary: explanation.explanation,
      payload,
      status: 'pending',
      expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      // Zombies ont 14 jours (moins urgents que runway)
    })

  if (error) {
    console.error('[agent-treasury] Insert zombie rec error:', error.message)
    return false
  }

  return true
}

// ------------------------------------------------------------
// GET LAST SNAPSHOT (fallback si Python down)
// ------------------------------------------------------------

async function getLastSnapshot(
  supabase: ReturnType<typeof createClient>,
  tenantId: string
): Promise<{ runway_months: number } | null> {
  const { data } = await supabase
    .from('treasury_snapshots')
    .select('runway_months')
    .eq('tenant_id', tenantId)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .single()

  return data
}

    
