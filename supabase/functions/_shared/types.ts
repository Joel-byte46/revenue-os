// ============================================================
// REVENUE OS — TYPES GLOBAUX
// Tous les types TypeScript du système.
// Importé par tous les agents et shared modules.
// ============================================================

// ------------------------------------------------------------
// CORE
// ------------------------------------------------------------

export type TenantStatus = 'trial' | 'active' | 'suspended' | 'cancelled'
export type TenantVertical = 'saas' | 'ecom'

export interface Tenant {
  id: string
  name: string | null
  status: TenantStatus
  vertical: TenantVertical
  timezone: string
  currency: string
  created_at: string
  updated_at: string
  settings: TenantSettings
}

export interface TenantSettings {
  crm_field_mapping?: Record<string, NormalizedStage>
  stage_thresholds?: Partial<Record<NormalizedStage, number>>
  target_industries?: string[]
  auto_send_sequences?: boolean
  slack_webhook?: string
  alert_email?: string
  llm_model?: 'gpt-4o' | 'gpt-4o-mini' | 'claude-3-5-sonnet-20241022'
}

export interface Profile {
  id: string
  tenant_id: string
  role: 'owner' | 'admin' | 'viewer'
  onboarding_step: number
  onboarding_completed: boolean
  created_at: string
}

// ------------------------------------------------------------
// INTEGRATIONS
// ------------------------------------------------------------

export type Provider =
  | 'openai'
  | 'anthropic'
  | 'hubspot'
  | 'salesforce'
  | 'pipedrive'
  | 'close'
  | 'attio'
  | 'stripe'
  | 'plaid'
  | 'tink'
  | 'meta_ads'
  | 'google_ads'
  | 'linkedin_ads'
  | 'tiktok_ads'
  | 'quickbooks'
  | 'xero'
  | 'pennylane'
  | 'slack'
  | 'gmail'
  | 'calendly'
  | 'google_calendar'
  | 'shopify'
  | 'paypal'

export type IntegrationStatus =
  | 'pending'
  | 'active'
  | 'degraded'
  | 'expired'
  | 'error'
  | 'disconnected'

export interface Integration {
  id: string
  tenant_id: string
  provider: Provider
  status: IntegrationStatus
  nango_connection_id: string | null
  last_sync_at: string | null
  last_error: string | null
  last_error_at: string | null
  sync_cursor: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

// ------------------------------------------------------------
// DEALS
// ------------------------------------------------------------

export type NormalizedStage =
  | 'new'
  | 'qualified'
  | 'demo_done'
  | 'proposal_sent'
  | 'negotiation'
  | 'closed_won'
  | 'closed_lost'
  | 'unknown'

export interface Deal {
  id: string
  tenant_id: string
  external_id: string
  external_source: string
  title: string | null
  amount: number
  currency: string
  stage: NormalizedStage
  stage_raw: string | null
  probability: number | null
  close_date: string | null
  contact_email: string | null
  contact_name: string | null
  company_name: string | null
  owner_name: string | null
  last_activity_at: string | null
  notes: string | null
  raw_data: Record<string, unknown> | null
  days_stagnant: number
  synced_at: string
  created_at: string
  updated_at: string
}

export interface StagnantDeal extends Deal {
  criticality_score: number
}

// ------------------------------------------------------------
// LEADS
// ------------------------------------------------------------

export type LeadStatus =
  | 'new'
  | 'in_sequence'
  | 'replied'
  | 'qualified'
  | 'disqualified'
  | 'nurture'
  | 'won'
  | 'lost'
  | 'unsubscribed'

export interface Lead {
  id: string
  tenant_id: string
  email: string
  first_name: string | null
  last_name: string | null
  company: string | null
  company_size: string | null
  industry: string | null
  linkedin_url: string | null
  fit_score: number
  intent_score: number
  timing_score: number
  total_score: number
  status: LeadStatus
  form_data: Record<string, unknown> | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  behavior_data: LeadBehavior | null
  sequence_status: 'none' | 'active' | 'completed' | 'paused'
  sequence_step: number
  created_at: string
  updated_at: string
}

export interface LeadBehavior {
  pricing_page_visits?: number
  demo_watched?: boolean
  docs_visited?: boolean
  trial_started?: boolean
  webinar_attended?: boolean
  last_page_viewed?: string
  session_count?: number
}

// ------------------------------------------------------------
// TRANSACTIONS
// ------------------------------------------------------------

export type TransactionType = 'revenue' | 'expense' | 'transfer' | 'refund'

export type TransactionCategory =
  | 'saas'
  | 'marketing'
  | 'payroll'
  | 'infrastructure'
  | 'ops'
  | 'cogs'
  | 'revenue_stripe'
  | 'revenue_paypal'
  | 'tax'
  | 'unknown'

export interface Transaction {
  id: string
  tenant_id: string
  external_id: string
  external_source: string
  date: string
  amount: number
  currency: string
  amount_eur: number | null
  type: TransactionType
  category: TransactionCategory | null
  subcategory: string | null
  merchant: string | null
  description: string | null
  is_recurring: boolean
  recurrence_id: string | null
  account_name: string | null
  created_at: string
}

export interface BankAccount {
  id: string
  tenant_id: string
  external_id: string
  external_source: string
  institution_name: string | null
  account_name: string | null
  account_type: string | null
  currency: string
  current_balance: number | null
  available_balance: number | null
  last_updated_at: string | null
}

// ------------------------------------------------------------
// ADS
// ------------------------------------------------------------

export type AdPlatform = 'meta' | 'google' | 'linkedin' | 'tiktok'

export interface AdCampaign {
  id: string
  tenant_id: string
  external_id: string
  platform: AdPlatform
  name: string | null
  status: string | null
  objective: string | null
  daily_budget: number | null
  lifetime_budget: number | null
  currency: string
  impressions: number
  clicks: number
  ctr: number
  avg_cpc: number
  conversions: number
  spend: number
  cost_per_conversion: number | null
  roas: number | null
  snapshot_date: string
  synced_at: string
}

export interface AdAccountAverages {
  avg_cpa: number
  avg_ctr: number
  avg_roas: number
  total_spend_30d: number
  total_conversions_30d: number
}

// ------------------------------------------------------------
// RECOMMENDATIONS
// ------------------------------------------------------------

export type AgentType =
  | 'pipeline_stagnation'
  | 'lead_engagement'
  | 'lead_reengagement'
  | 'ads_waste'
  | 'ads_scaling'
  | 'treasury_runway'
  | 'treasury_zombie'
  | 'treasury_anomaly'
  | 'weekly_brief'

export type RecommendationPriority = 'critical' | 'high' | 'medium' | 'low'
export type RecommendationStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'expired'
  | 'failed'

export interface Recommendation {
  id: string
  tenant_id: string
  agent_type: AgentType
  priority: RecommendationPriority
  title: string
  summary: string | null
  payload: RecommendationPayload
  status: RecommendationStatus
  approved_at: string | null
  rejected_at: string | null
  executed_at: string | null
  expires_at: string | null
  outcome_score: number | null
  outcome_data: OutcomeData | null
  outcome_measured_at: string | null
  created_at: string
  updated_at: string
}

// Payload typé par agent_type
export type RecommendationPayload =
  | PipelinePayload
  | LeadEngagementPayload
  | AdsWastePayload
  | AdsScalingPayload
  | TreasuryRunwayPayload
  | TreasuryZombiePayload
  | TreasuryAnomalyPayload
  | BriefPayload

export interface PipelinePayload {
  deal_id: string
  deal_title: string
  deal_amount: number
  deal_stage: string
  days_stagnant: number
  contact_email: string | null
  contact_name: string | null
  company_name: string | null
  blocking_reason: string
  confidence: number
  action: EmailAction
  urgency: 'critical' | 'high' | 'medium'
  estimated_impact: string
}

export interface LeadEngagementPayload {
  lead_id: string
  lead_email: string
  lead_name: string
  lead_score: number
  industry: string | null
  company: string | null
  sequence: EmailSequence
  score_explanation: string
}

export interface AdsWastePayload {
  campaign_id: string
  campaign_name: string
  platform: AdPlatform
  waste_type: 'zero_conversion' | 'high_cpa' | 'low_ctr' | 'budget_inefficiency'
  monthly_waste: number
  diagnosis: string
  recommended_action: 'pause' | 'reduce_budget' | 'change_audience' | 'refresh_creative'
  implementation_steps: string[]
  monthly_savings_estimate: number
}

export interface AdsScalingPayload {
  campaign_id: string
  campaign_name: string
  platform: AdPlatform
  current_cpa: number
  avg_cpa: number
  cpa_advantage_pct: number
  recommended_budget_increase: number
  projected_additional_conversions: number
}

export interface TreasuryRunwayPayload {
  runway_months: number
  runway_date: string
  current_balance: number
  monthly_net_burn: number
  mrr: number
  scenario_pessimistic: number
  scenario_optimistic: number
  narrative: string
  actions: TreasuryAction[]
}

export interface TreasuryZombiePayload {
  merchant: string
  monthly_cost: number
  annual_cost: number
  last_activity: string | null
  category: string | null
  confidence: number
  recommendation: 'cancel' | 'downgrade' | 'investigate'
  explanation: string
  potential_alternative: string | null
}

export interface TreasuryAnomalyPayload {
  category: string
  current_amount: number
  historical_avg: number
  excess_amount: number
  z_score: number
  explanation: string
  investigation_steps: string[]
}

export interface BriefPayload {
  week_of: string
  metrics: WeeklyMetrics
  narrative: string
  top_actions: BriefAction[]
  overall_score: number
}

// ------------------------------------------------------------
// SUB-TYPES
// ------------------------------------------------------------

export interface EmailAction {
  type: 'email'
  subject: string
  body: string
  why_this_works: string
}

export interface EmailSequence {
  emails: SequenceEmail[]
}

export interface SequenceEmail {
  day: number
  subject: string
  body: string
  reasoning: string
}

export interface TreasuryAction {
  description: string
  impact_months: number
  impact_amount: number | null
  urgency: 'critical' | 'high' | 'medium'
}

export interface BriefAction {
  title: string
  impact_estimate: string
  recommendation_id: string | null
  priority: RecommendationPriority
}

export interface WeeklyMetrics {
  pipeline_value: number
  pipeline_change_pct: number
  stagnant_count: number
  stagnant_value: number
  deals_closed: number
  revenue_this_week: number
  monthly_forecast: number
  new_leads: number
  hot_leads: number
  reply_rate: number
  runway_months: number
  mrr: number
  net_burn: number
  ads_spend: number
  avg_cpa: number
  waste_detected: number
  pending_actions: number
}

export interface OutcomeData {
  measured_at: string
  before_state: Record<string, unknown>
  after_state: Record<string, unknown>
  details: string
}

// ------------------------------------------------------------
// TREASURY (Python service responses)
// ------------------------------------------------------------

export interface RunwayResult {
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
  calculated_at: string
}

export interface Anomaly {
  category: string
  current_amount: number
  historical_avg: number
  excess_amount: number
  z_score: number
  severity: 'critical' | 'high' | 'medium'
  type?: 'spike' | 'creeping_cost'
  monthly_growth?: number
  projected_annual_impact?: number
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
}

// ------------------------------------------------------------
// AGENT RUNTIME
// ------------------------------------------------------------

export interface AgentContext {
  tenantId: string
  tenant: Tenant
  runId: string
  // ID unique du run (pour les logs et dedup)
  triggeredBy: 'cron' | 'manual' | 'webhook'
  startedAt: string
}

export interface AgentResult {
  tenantId: string
  agentType: AgentType
  success: boolean
  recommendationsCreated: number
  error?: string
  durationMs: number
}

export interface OrchestratorResult {
  mode: string
  tenantsProcessed: number
  totalRecommendations: number
  errors: Array<{ tenantId: string; error: string }>
  durationMs: number
}

// ------------------------------------------------------------
// LLM
// ------------------------------------------------------------

export interface LLMCallParams {
  tenantId: string
  systemPrompt: string
  userPrompt: string
  jsonMode?: boolean
  maxTokens?: number
  temperature?: number
}

export interface LLMResponse {
  content: string
  parsed?: Record<string, unknown>
  tokensUsed: number
  model: string
  durationMs: number
}

// ------------------------------------------------------------
// RAG
// ------------------------------------------------------------

export interface Pattern {
  content: string
  result_score: number
  agent_source: string
  metadata: Record<string, unknown>
  similarity: number
}

export interface RAGContext {
  patterns: Pattern[]
  formattedContext: string
  // String prête à injecter dans le prompt
}

// ------------------------------------------------------------
// PIPELINE HEALTH (SQL function return)
// ------------------------------------------------------------

export interface PipelineHealth {
  total_deals: number
  total_value: number
  stagnant_count: number
  stagnant_value: number
  critical_count: number
  avg_deal_size: number
  deals_closed_30d: number
  revenue_closed_30d: number
}

// ------------------------------------------------------------
// SLACK
// ------------------------------------------------------------

export interface SlackBlock {
  type: string
  text?: { type: string; text: string }
  elements?: unknown[]
  fields?: unknown[]
}

export interface SlackMessage {
  text: string
  blocks?: SlackBlock[]
}

// ------------------------------------------------------------
// SCHEDULED ACTIONS
// ------------------------------------------------------------

export interface ScheduledAction {
  id: string
  tenant_id: string
  action_type: 'send_email' | 'check_reply' | 'run_agent' | 'send_notification'
  scheduled_at: string
  payload: Record<string, unknown>
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  attempts: number
  max_attempts: number
  created_at: string
  executed_at: string | null
  error: string | null
}

// ------------------------------------------------------------
// SYNC
// ------------------------------------------------------------

export interface SyncResult {
  provider: Provider
  success: boolean
  recordsSynced: number
  error?: string
  nextCursor?: string
}
