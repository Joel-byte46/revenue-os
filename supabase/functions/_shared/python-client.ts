// ============================================================
// REVENUE OS — PYTHON SERVICE CLIENT
// Bridge entre les Edge Functions (Deno) et le service
// FastAPI Python (Fly.io) qui fait les calculs financiers.
//
// RÈGLE : Tout calcul impliquant de l'argent passe par ici.
// Les Edge Functions orchestrent. Python calcule.
// Le LLM narrativise. Jamais l'inverse.
// ============================================================

const PYTHON_SERVICE_URL = Deno.env.get('PYTHON_SERVICE_URL') ?? ''
const PYTHON_SERVICE_SECRET = Deno.env.get('PYTHON_SERVICE_SECRET') ?? ''
// Secret partagé entre Edge Functions et Python service
// Pour éviter que n'importe qui appelle le service Python directement

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RETRIES = 2

if (!PYTHON_SERVICE_URL) {
  console.warn('[python-client] PYTHON_SERVICE_URL not set')
}

// ------------------------------------------------------------
// TYPES — Requêtes et réponses du service Python
// ------------------------------------------------------------

export interface RunwayRequest {
  tenant_id: string
  current_balance: number
  // Récupéré depuis bank_accounts (SQL)
  monthly_expenses: MonthlyExpense[]
  // Derniers 6 mois depuis transactions (SQL)
  mrr_transactions: MRRTransaction[]
  // Transactions Stripe récurrentes (SQL)
  pipeline_data: {
    expected_30d_revenue: number
    total_weighted_value: number
  }
}

export interface MonthlyExpense {
  month_label: string
  // Format : 'YYYY-MM'
  total_expense: number
  breakdown: Record<string, number>
  // { "marketing": 5000, "payroll": 20000, ... }
}

export interface MRRTransaction {
  amount: number
  date: string
  merchant: string
  is_recurring: boolean
}

export interface RunwayResponse {
  current_balance: number
  monthly_burn_gross: number
  monthly_revenue: number
  monthly_net_burn: number
  runway_months: number
  runway_date: string
  mrr: number
  arr: number
  scenarios: {
    pessimistic: number
    realistic: number
    optimistic: number
  }
  is_profitable: boolean
  data_confidence: 'full' | 'partial' | 'insufficient'
  calculation_details: {
    burn_weights_used: number[]
    months_analyzed: number
    mrr_method: string
  }
  calculated_at: string
}

export interface AnomalyRequest {
  tenant_id: string
  monthly_expenses: MonthlyExpense[]
  current_month_expenses: {
    category: string
    amount: number
    transactions: Array<{
      merchant: string
      amount: number
      date: string
    }>
  }[]
}

export interface AnomalyResponse {
  anomalies: Anomaly[]
  total_excess_spend: number
  analysis_period_months: number
}

export interface Anomaly {
  category: string
  current_amount: number
  historical_avg: number
  historical_std: number
  excess_amount: number
  z_score: number
  severity: 'critical' | 'high' | 'medium'
  type: 'spike' | 'creeping_cost'
  monthly_growth?: number
  projected_annual_impact?: number
  top_merchants: string[]
}

export interface ZombieRequest {
  tenant_id: string
  recurring_transactions: Array<{
    merchant: string
    monthly_cost: number
    category: string | null
    last_charge_date: string
    months_subscribed: number
    recurrence_id: string
  }>
  email_mentions: Record<string, string | null>
  // { merchant_key: last_mention_date | null }
  crm_mentions: Record<string, string | null>
  // { merchant_key: last_mention_date | null }
}

export interface ZombieResponse {
  zombies: ZombieSubscription[]
  total_monthly_waste: number
  total_annual_waste: number
}

export interface ZombieSubscription {
  merchant: string
  monthly_cost: number
  annual_cost: number
  category: string | null
  last_activity: string | null
  months_subscribed: number
  confidence: 'high' | 'medium' | 'low'
  recommendation: 'cancel' | 'downgrade' | 'investigate'
  inactivity_days: number
}

export interface ForecastRequest {
  tenant_id: string
  deals: Array<{
    id: string
    title: string
    amount: number
    stage: string
    close_date: string | null
    days_stagnant: number
  }>
  historical_close_rates: Array<{
    stage: string
    close_rate: number
    avg_days_to_close: number
  }>
}

export interface ForecastResponse {
  monthly_forecast: number
  quarterly_forecast: number
  confidence_range: {
    low: number
    high: number
  }
  weighted_pipeline: number
  deals_breakdown: Array<{
    id: string
    title: string
    amount: number
    stage: string
    close_probability: number
    weighted_value: number
    stagnation_penalty: number
    expected_close: string | null
  }>
  methodology: string
}

// ------------------------------------------------------------
// CALL PYTHON — Fonction générique
// ------------------------------------------------------------

async function callPython<TRequest, TResponse>(
  endpoint: string,
  body: TRequest,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<TResponse> {
  if (!PYTHON_SERVICE_URL) {
    throw new Error('[python-client] PYTHON_SERVICE_URL is not configured')
  }

  const url = `${PYTHON_SERVICE_URL}${endpoint}`
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Secret': PYTHON_SERVICE_SECRET,
          'X-Attempt': String(attempt)
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (response.status === 422) {
        // Erreur de validation Pydantic — pas la peine de retry
        const error = await response.json()
        throw new Error(
          `[python-client] Validation error on ${endpoint}: ${JSON.stringify(error)}`
        )
      }

      if (response.status === 503) {
        // Service indisponible — retry
        throw new Error(`[python-client] Service unavailable: ${endpoint}`)
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `[python-client] HTTP ${response.status} on ${endpoint}: ${errorText}`
        )
      }

      return await response.json() as TResponse

    } catch (error) {
      clearTimeout(timeoutId)

      if (error instanceof Error && error.name === 'AbortError') {
        lastError = new Error(
          `[python-client] Timeout after ${timeoutMs}ms on ${endpoint}`
        )
      } else {
        lastError = error instanceof Error ? error : new Error(String(error))
      }

      if (attempt < MAX_RETRIES) {
        const backoffMs = Math.pow(2, attempt) * 500
        // 500ms, 1000ms
        console.warn(
          `[python-client] Attempt ${attempt + 1} failed on ${endpoint}. ` +
          `Retrying in ${backoffMs}ms... Error: ${lastError.message}`
        )
        await sleep(backoffMs)
      }
    }
  }

  throw lastError ?? new Error(`[python-client] Unknown error on ${endpoint}`)
}

// ------------------------------------------------------------
// API PUBLIQUE — Fonctions typées par endpoint
// ------------------------------------------------------------

// RUNWAY : Calcule le runway, burn, MRR, scénarios
export function calculateRunway(
  request: RunwayRequest
): Promise<RunwayResponse> {
  return callPython<RunwayRequest, RunwayResponse>('/runway', request)
}

// ANOMALIES : Détecte les dépenses anormales (Z-score)
export function detectAnomalies(
  request: AnomalyRequest
): Promise<AnomalyResponse> {
  return callPython<AnomalyRequest, AnomalyResponse>('/anomalies', request)
}

// ZOMBIES : Détecte les abonnements non utilisés
export function detectZombies(
  request: ZombieRequest
): Promise<ZombieResponse> {
  return callPython<ZombieRequest, ZombieResponse>('/zombies', request)
}

// FORECAST : Pipeline forecast pondéré par probabilité
export function calculateForecast(
  request: ForecastRequest
): Promise<ForecastResponse> {
  return callPython<ForecastRequest, ForecastResponse>('/forecast', request)
}

// HEALTH CHECK : Vérifie que le service Python est up
export async function checkPythonHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${PYTHON_SERVICE_URL}/health`, {
      headers: { 'X-Service-Secret': PYTHON_SERVICE_SECRET },
      signal: AbortSignal.timeout(5000)
    })
    return response.ok
  } catch {
    return false
  }
}

// ------------------------------------------------------------
// HELPER
// ------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
