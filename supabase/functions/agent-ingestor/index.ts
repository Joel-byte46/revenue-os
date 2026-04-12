// ============================================================
// REVENUE OS — AGENT INGESTOR (A1)
// Synchronise les données externes vers Supabase.
// Premier agent à tourner dans chaque cycle.
// Tous les autres agents dépendent de ses données.
//
// RESPONSABILITÉ UNIQUE :
// Données externes → Normalisation → Tables Supabase
//
// NE FAIT PAS :
// → Aucune analyse
// → Aucun appel LLM
// → Aucune recommandation
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getAccessToken, getConnection } from '../_shared/nango.ts'
import { notifyIntegrationError } from '../_shared/notify.ts'
import type {
  Provider,
  NormalizedStage,
  Deal,
  Transaction,
  AdCampaign,
  SyncResult,
  AgentResult
} from '../_shared/types.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Mapping par défaut HubSpot → NormalizedStage
const HUBSPOT_STAGE_MAP: Record<string, NormalizedStage> = {
  appointmentscheduled: 'qualified',
  qualifiedtobuy: 'qualified',
  presentationscheduled: 'demo_done',
  decisionmakerboughtin: 'negotiation',
  contractsent: 'proposal_sent',
  closedwon: 'closed_won',
  closedlost: 'closed_lost',
}

// Mapping par défaut Pipedrive
const PIPEDRIVE_STAGE_MAP: Record<number, NormalizedStage> = {
  1: 'new',
  2: 'qualified',
  3: 'demo_done',
  4: 'proposal_sent',
  5: 'negotiation',
}

// ------------------------------------------------------------
// ENTRY POINT
// ------------------------------------------------------------

serve(async (req: Request) => {
  const startTime = Date.now()

  const body = await req.json().catch(() => ({}))
  const tenantId = body.tenant_id as string
  const providers = body.providers as Provider[] | undefined

  if (!tenantId) {
    return new Response(
      JSON.stringify({ error: 'tenant_id required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  console.log(`[agent-ingestor] Starting for tenant ${tenantId}`)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const syncResults: SyncResult[] = []

  // Récupérer les intégrations actives si providers non spécifiés
  let activeProviders = providers

  if (!activeProviders) {
    const { data: integrations } = await supabase
      .from('integrations')
      .select('provider')
      .eq('tenant_id', tenantId)
      .eq('status', 'active')

    activeProviders = (integrations ?? []).map(i => i.provider as Provider)
  }

  // Récupérer le mapping CRM du tenant
  const { data: tenantData } = await supabase
    .from('tenants')
    .select('settings, currency')
    .eq('id', tenantId)
    .single()

  const stageMapping: Record<string, NormalizedStage> =
    tenantData?.settings?.crm_field_mapping ?? {}
  const tenantCurrency: string = tenantData?.currency ?? 'EUR'

  // Syncer chaque provider
  for (const provider of activeProviders) {
    try {
      const result = await syncProvider(
        supabase,
        tenantId,
        provider,
        stageMapping,
        tenantCurrency
      )
      syncResults.push(result)

      // Mettre à jour last_sync_at
      await supabase
        .from('integrations')
        .update({
          last_sync_at: new Date().toISOString(),
          status: 'active',
          last_error: null
        })
        .eq('tenant_id', tenantId)
        .eq('provider', provider)

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[agent-ingestor] Failed to sync ${provider}:`, message)

      syncResults.push({
        provider,
        success: false,
        recordsSynced: 0,
        error: message
      })

      // Mettre à jour le statut d'erreur
      await supabase
        .from('integrations')
        .update({
          status: 'degraded',
          last_error: message,
          last_error_at: new Date().toISOString()
        })
        .eq('tenant_id', tenantId)
        .eq('provider', provider)

      // Notifier le founder si erreur d'auth
      if (message.includes('401') || message.includes('token')) {
        await notifyIntegrationError(tenantId, provider, message)
      }
    }
  }

  const totalSynced = syncResults.reduce((sum, r) => sum + r.recordsSynced, 0)

  const result: AgentResult = {
    tenantId,
    agentType: 'pipeline_stagnation', // placeholder
    success: syncResults.every(r => r.success),
    recommendationsCreated: 0,
    durationMs: Date.now() - startTime
  }

  console.log(
    `[agent-ingestor] Done for ${tenantId}: ${totalSynced} records synced in ${result.durationMs}ms`
  )

  return new Response(
    JSON.stringify({ ...result, sync_results: syncResults }),
    { headers: { 'Content-Type': 'application/json' } }
  )
})

// ------------------------------------------------------------
// SYNC PROVIDER — Dispatcher
// ------------------------------------------------------------

async function syncProvider(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  provider: Provider,
  stageMapping: Record<string, NormalizedStage>,
  tenantCurrency: string
): Promise<SyncResult> {
  switch (provider) {
    case 'hubspot':
      return syncHubSpot(supabase, tenantId, stageMapping, tenantCurrency)
    case 'salesforce':
      return syncSalesforce(supabase, tenantId, stageMapping, tenantCurrency)
    case 'pipedrive':
      return syncPipedrive(supabase, tenantId, stageMapping, tenantCurrency)
    case 'stripe':
      return syncStripe(supabase, tenantId, tenantCurrency)
    case 'plaid':
      return syncPlaid(supabase, tenantId)
    case 'tink':
      return syncTink(supabase, tenantId)
    case 'meta_ads':
      return syncMetaAds(supabase, tenantId, tenantCurrency)
    case 'google_ads':
      return syncGoogleAds(supabase, tenantId, tenantCurrency)
    default:
      console.log(`[agent-ingestor] Provider ${provider} not yet implemented — skipping`)
      return { provider, success: true, recordsSynced: 0 }
  }
}

// ------------------------------------------------------------
// SYNC HUBSPOT
// ------------------------------------------------------------

async function syncHubSpot(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  customStageMapping: Record<string, NormalizedStage>,
  tenantCurrency: string
): Promise<SyncResult> {
  const token = await getAccessToken(tenantId, 'hubspot')
  const mergedMapping = { ...HUBSPOT_STAGE_MAP, ...customStageMapping }

  const properties = [
    'dealname', 'amount', 'dealstage', 'closedate',
    'notes_last_updated', 'hs_lastmodifieddate',
    'hs_deal_stage_probability', 'description',
    'hubspot_owner_id', 'hs_contact_email'
  ]

  let allDeals: Record<string, unknown>[] = []
  let after: string | null = null
  let page = 0

  do {
    const url = new URL('https://api.hubapi.com/crm/v3/objects/deals')
    url.searchParams.set('limit', '100')
    url.searchParams.set('properties', properties.join(','))
    if (after) url.searchParams.set('after', after)

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000)
    })

    if (response.status === 401) {
      throw new Error('HubSpot token expired (401) — please reconnect')
    }

    if (response.status === 429) {
      // Rate limit — attendre 10 secondes
      await sleep(10_000)
      continue
    }

    if (!response.ok) {
      throw new Error(`HubSpot API error: ${response.status}`)
    }

    const data = await response.json()
    allDeals = [...allDeals, ...data.results]
    after = data.paging?.next?.after ?? null
    page++

    // Sécurité : max 50 pages (5000 deals)
    if (page >= 50) break

  } while (after)

  // Normaliser et upsert
  const normalizedDeals = allDeals.map(deal => {
    const props = deal.properties as Record<string, string>
    const stageRaw = props.dealstage ?? ''
    const stage = mergedMapping[stageRaw.toLowerCase()] ?? 'unknown'

    const lastActivity = [
      props.notes_last_updated,
      props.hs_lastmodifieddate
    ]
      .filter(Boolean)
      .sort()
      .reverse()[0] ?? null

    return {
      tenant_id: tenantId,
      external_id: deal.id as string,
      external_source: 'hubspot',
      title: props.dealname || 'Deal sans nom',
      amount: parseFloat(props.amount ?? '0') || 0,
      currency: tenantCurrency,
      stage,
      stage_raw: stageRaw,
      probability: props.hs_deal_stage_probability
        ? parseFloat(props.hs_deal_stage_probability)
        : null,
      close_date: props.closedate || null,
      contact_email: props.hs_contact_email || null,
      notes: props.description || null,
      last_activity_at: lastActivity,
      raw_data: props,
      synced_at: new Date().toISOString()
    }
  })

  if (normalizedDeals.length > 0) {
    const { error } = await supabase
      .from('deals')
      .upsert(normalizedDeals, {
        onConflict: 'tenant_id,external_id,external_source',
        ignoreDuplicates: false
      })

    if (error) throw new Error(`HubSpot upsert error: ${error.message}`)
  }

  return { provider: 'hubspot', success: true, recordsSynced: normalizedDeals.length }
}

// ------------------------------------------------------------
// SYNC SALESFORCE
// ------------------------------------------------------------

async function syncSalesforce(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  customStageMapping: Record<string, NormalizedStage>,
  tenantCurrency: string
): Promise<SyncResult> {
  const connection = await getConnection(tenantId, 'salesforce')
  const token = connection.credentials.access_token!
  const instanceUrl = connection.metadata.instance_url as string

  if (!instanceUrl) {
    throw new Error('Salesforce instance URL missing from connection metadata')
  }

  // SOQL Query pour les opportunities
  const soql = `
    SELECT Id, Name, Amount, StageName, CloseDate,
           LastModifiedDate, Description, OwnerId,
           Account.Name, Contact.Email,
           Probability
    FROM Opportunity
    WHERE IsClosed = false
    OR (IsClosed = true AND LastModifiedDate >= LAST_N_DAYS:90)
    ORDER BY LastModifiedDate DESC
    LIMIT 2000
  `.replace(/\s+/g, ' ').trim()

  const url = `${instanceUrl}/services/data/v58.0/query?q=${encodeURIComponent(soql)}`

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    signal: AbortSignal.timeout(20_000)
  })

  if (!response.ok) {
    throw new Error(`Salesforce API error: ${response.status}`)
  }

  const data = await response.json()
  const records = data.records as Record<string, unknown>[]

  const SALESFORCE_STAGE_MAP: Record<string, NormalizedStage> = {
    'prospecting': 'new',
    'qualification': 'qualified',
    'needs analysis': 'qualified',
    'value proposition': 'demo_done',
    'id. decision makers': 'demo_done',
    'perception analysis': 'negotiation',
    'proposal/price quote': 'proposal_sent',
    'negotiation/review': 'negotiation',
    'closed won': 'closed_won',
    'closed lost': 'closed_lost',
    ...customStageMapping
  }

  const normalizedDeals = records.map(record => {
    const stageName = (record.StageName as string ?? '').toLowerCase()
    const stage = SALESFORCE_STAGE_MAP[stageName] ?? 'unknown'

    return {
      tenant_id: tenantId,
      external_id: record.Id as string,
      external_source: 'salesforce',
      title: record.Name as string || 'Opportunity sans nom',
      amount: parseFloat(String(record.Amount ?? '0')) || 0,
      currency: tenantCurrency,
      stage,
      stage_raw: record.StageName as string,
      probability: record.Probability ? parseFloat(String(record.Probability)) : null,
      close_date: record.CloseDate as string || null,
      company_name: (record.Account as Record<string, string>)?.Name ?? null,
      contact_email: (record.Contact as Record<string, string>)?.Email ?? null,
      notes: record.Description as string || null,
      last_activity_at: record.LastModifiedDate as string || null,
      raw_data: record,
      synced_at: new Date().toISOString()
    }
  })

  if (normalizedDeals.length > 0) {
    const { error } = await supabase
      .from('deals')
      .upsert(normalizedDeals, {
        onConflict: 'tenant_id,external_id,external_source'
      })

    if (error) throw new Error(`Salesforce upsert error: ${error.message}`)
  }

  return { provider: 'salesforce', success: true, recordsSynced: normalizedDeals.length }
}

// ------------------------------------------------------------
// SYNC PIPEDRIVE
// ------------------------------------------------------------

async function syncPipedrive(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  customStageMapping: Record<string, NormalizedStage>,
  tenantCurrency: string
): Promise<SyncResult> {
  const token = await getAccessToken(tenantId, 'pipedrive')

  let allDeals: Record<string, unknown>[] = []
  let start = 0
  const limit = 100

  do {
    const url = new URL('https://api.pipedrive.com/v1/deals')
    url.searchParams.set('status', 'all_not_deleted')
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('start', String(start))
    url.searchParams.set('api_token', token)

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000)
    })

    if (!response.ok) {
      throw new Error(`Pipedrive API error: ${response.status}`)
    }

    const data = await response.json()

    if (!data.success || !data.data) break

    allDeals = [...allDeals, ...data.data]

    if (!data.additional_data?.pagination?.more_items_in_collection) break
    start += limit

    // Max 2000 deals
    if (allDeals.length >= 2000) break

  } while (true)

  const normalizedDeals = allDeals.map(deal => {
    const stageId = deal.stage_id as number
    const stageKey = String(stageId)
    const stage = customStageMapping[stageKey]
      ?? PIPEDRIVE_STAGE_MAP[stageId]
      ?? 'unknown'

    const statusMap: Record<string, NormalizedStage> = {
      won: 'closed_won',
      lost: 'closed_lost'
    }

    const finalStage = (deal.status === 'won' || deal.status === 'lost')
      ? statusMap[deal.status as string]
      : stage

    return {
      tenant_id: tenantId,
      external_id: String(deal.id),
      external_source: 'pipedrive',
      title: deal.title as string || 'Deal sans nom',
      amount: parseFloat(String(deal.value ?? '0')) || 0,
      currency: (deal.currency as string) || tenantCurrency,
      stage: finalStage,
      stage_raw: String(stageId),
      probability: deal.probability
        ? parseFloat(String(deal.probability))
        : null,
      close_date: deal.expected_close_date as string || null,
      contact_name: (deal.person_id as Record<string, string>)?.name ?? null,
      company_name: (deal.org_id as Record<string, string>)?.name ?? null,
      last_activity_at: deal.update_time as string || null,
      notes: deal.notes_count ? `${deal.notes_count} notes` : null,
      raw_data: deal,
      synced_at: new Date().toISOString()
    }
  })

  if (normalizedDeals.length > 0) {
    const { error } = await supabase
      .from('deals')
      .upsert(normalizedDeals, {
        onConflict: 'tenant_id,external_id,external_source'
      })

    if (error) throw new Error(`Pipedrive upsert error: ${error.message}`)
  }

  return { provider: 'pipedrive', success: true, recordsSynced: normalizedDeals.length }
}

// ------------------------------------------------------------
// SYNC STRIPE
// ------------------------------------------------------------

async function syncStripe(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  tenantCurrency: string
): Promise<SyncResult> {
  const stripeKey = await getAccessToken(tenantId, 'stripe')

  // Récupérer les charges des 90 derniers jours
  const since = Math.floor(Date.now() / 1000 - 90 * 24 * 60 * 60)

  let allCharges: Record<string, unknown>[] = []
  let hasMore = true
  let startingAfter: string | null = null

  while (hasMore) {
    const url = new URL('https://api.stripe.com/v1/charges')
    url.searchParams.set('limit', '100')
    url.searchParams.set('created[gte]', String(since))
    if (startingAfter) url.searchParams.set('starting_after', startingAfter)

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Stripe-Version': '2023-10-16'
      },
      signal: AbortSignal.timeout(15_000)
    })

    if (response.status === 401) {
      throw new Error('Stripe API key invalid (401)')
    }

    if (!response.ok) {
      throw new Error(`Stripe API error: ${response.status}`)
    }

    const data = await response.json()
    allCharges = [...allCharges, ...data.data]
    hasMore = data.has_more
    startingAfter = hasMore ? (data.data[data.data.length - 1].id as string) : null

    if (allCharges.length >= 5000) break
  }

  const transactions = allCharges
    .filter(c => c.status === 'succeeded')
    .map(charge => {
      const amount = (charge.amount as number) / 100
      const currency = (charge.currency as string).toUpperCase()
      const isRecurring = charge.invoice !== null && charge.invoice !== undefined

      return {
        tenant_id: tenantId,
        external_id: `stripe_${charge.id}`,
        external_source: 'stripe',
        date: new Date((charge.created as number) * 1000)
          .toISOString()
          .split('T')[0],
        amount: amount, // Positif = revenu
        currency,
        type: 'revenue',
        category: 'revenue_stripe',
        merchant: (charge.billing_details as Record<string, string>)?.name
          ?? 'Stripe Customer',
        description: charge.description as string || 'Stripe charge',
        is_recurring: isRecurring,
        recurrence_id: isRecurring
          ? (charge.customer as string || null)
          : null
      }
    })

  if (transactions.length > 0) {
    const { error } = await supabase
      .from('transactions')
      .upsert(transactions, {
        onConflict: 'tenant_id,external_id,external_source'
      })

    if (error) throw new Error(`Stripe upsert error: ${error.message}`)
  }

  return { provider: 'stripe', success: true, recordsSynced: transactions.length }
}

// ------------------------------------------------------------
// SYNC PLAID
// ------------------------------------------------------------

async function syncPlaid(
  supabase: ReturnType<typeof createClient>,
  tenantId: string
): Promise<SyncResult> {
  const plaidToken = await getAccessToken(tenantId, 'plaid')

  const PLAID_ENV = Deno.env.get('PLAID_ENV') ?? 'production'
  const PLAID_BASE = PLAID_ENV === 'sandbox'
    ? 'https://sandbox.plaid.com'
    : 'https://production.plaid.com'

  const endDate = new Date().toISOString().split('T')[0]
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0]

  const response = await fetch(`${PLAID_BASE}/transactions/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: Deno.env.get('PLAID_CLIENT_ID'),
      secret: Deno.env.get('PLAID_SECRET'),
      access_token: plaidToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: 500 }
    }),
    signal: AbortSignal.timeout(20_000)
  })

  if (!response.ok) {
    const errorData = await response.json()
    throw new Error(`Plaid API error: ${errorData.error_message ?? response.status}`)
  }

  const data = await response.json()
  const plaidTransactions = data.transactions as Record<string, unknown>[]

  // Mettre à jour les balances
  const accounts = data.accounts as Record<string, unknown>[]
  if (accounts?.length > 0) {
    const bankAccounts = accounts.map(acc => ({
      tenant_id: tenantId,
      external_id: acc.account_id as string,
      external_source: 'plaid',
      institution_name: null,
      account_name: acc.name as string,
      account_type: mapPlaidAccountType(acc.type as string),
      currency: 'EUR',
      current_balance: (acc.balances as Record<string, number>)?.current ?? null,
      available_balance: (acc.balances as Record<string, number>)?.available ?? null,
      last_updated_at: new Date().toISOString()
    }))

    await supabase
      .from('bank_accounts')
      .upsert(bankAccounts, { onConflict: 'tenant_id,external_id,external_source' })
  }

  // Normaliser les transactions
  const transactions = plaidTransactions.map(tx => {
    const amount = -(tx.amount as number)
    // Plaid: positif = dépense, on inverse
    const isExpense = amount < 0

    return {
      tenant_id: tenantId,
      external_id: `plaid_${tx.transaction_id}`,
      external_source: 'plaid',
      date: tx.date as string,
      amount: parseFloat(amount.toFixed(2)),
      currency: (tx.iso_currency_code as string ?? 'EUR').toUpperCase(),
      type: isExpense ? 'expense' : 'revenue',
      category: categorizePlaidTransaction(tx.category as string[]),
      merchant: (tx.merchant_name as string) || (tx.name as string),
      description: tx.name as string,
      is_recurring: detectRecurring(tx.name as string),
      recurrence_id: detectRecurring(tx.name as string)
        ? normalizeKey(tx.merchant_name as string || tx.name as string)
        : null
    }
  })

  if (transactions.length > 0) {
    const { error } = await supabase
      .from('transactions')
      .upsert(transactions, {
        onConflict: 'tenant_id,external_id,external_source'
      })

    if (error) throw new Error(`Plaid upsert error: ${error.message}`)
  }

  return { provider: 'plaid', success: true, recordsSynced: transactions.length }
}

// ------------------------------------------------------------
// SYNC TINK (Banking Europe)
// ------------------------------------------------------------

async function syncTink(
  supabase: ReturnType<typeof createClient>,
  tenantId: string
): Promise<SyncResult> {
  const token = await getAccessToken(tenantId, 'tink')

  // Récupérer les comptes
  const accountsResponse = await fetch('https://api.tink.com/data/v2/accounts', {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000)
  })

  if (!accountsResponse.ok) {
    throw new Error(`Tink accounts API error: ${accountsResponse.status}`)
  }

  const accountsData = await accountsResponse.json()
  const accounts = accountsData.accounts as Record<string, unknown>[]

  if (accounts?.length > 0) {
    const bankAccounts = accounts.map(acc => ({
      tenant_id: tenantId,
      external_id: acc.id as string,
      external_source: 'tink',
      institution_name: (acc.financialInstitutionId as string) ?? null,
      account_name: acc.name as string,
      account_type: (acc.type as string)?.toLowerCase() ?? 'checking',
      currency: (acc.balances as Record<string, Record<string, number>>)
        ?.booked?.amount?.currencyCode ?? 'EUR',
      current_balance: (acc.balances as Record<string, Record<string, number>>)
        ?.booked?.amount?.value?.unscaledValue
        ? (acc.balances as Record<string, Record<string, number>>)
            .booked.amount.value.unscaledValue / 100
        : null,
      last_updated_at: new Date().toISOString()
    }))

    await supabase
      .from('bank_accounts')
      .upsert(bankAccounts, { onConflict: 'tenant_id,external_id,external_source' })
  }

  // Récupérer les transactions
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

  const txResponse = await fetch(
    `https://api.tink.com/data/v2/transactions?bookedDateGte=${since.split('T')[0]}&pageSize=500`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000)
    }
  )

  if (!txResponse.ok) {
    throw new Error(`Tink transactions API error: ${txResponse.status}`)
    }

  const txData = await txResponse.json()
  const tinkTxs = txData.transactions as Record<string, unknown>[]

  const transactions = tinkTxs.map(tx => {
    const rawAmount = (tx.amount as Record<string, Record<string, number>>)
      ?.value?.unscaledValue ?? 0
    const amount = rawAmount / 100
    const currency = (tx.amount as Record<string, Record<string, string>>)
      ?.currencyCode ?? 'EUR'

    return {
      tenant_id: tenantId,
      external_id: `tink_${tx.id}`,
      external_source: 'tink',
      date: (tx.dates as Record<string, string>)?.booked ?? new Date().toISOString().split('T')[0],
      amount: parseFloat(amount.toFixed(2)),
      currency,
      type: amount > 0 ? 'revenue' : 'expense',
      category: 'unknown',
      merchant: (tx.merchantInformation as Record<string, string>)?.merchantName
        ?? (tx.descriptions as Record<string, string>)?.original
        ?? 'Unknown',
      description: (tx.descriptions as Record<string, string>)?.original ?? null,
      is_recurring: false,
      recurrence_id: null
    }
  })

  if (transactions.length > 0) {
    const { error } = await supabase
      .from('transactions')
      .upsert(transactions, {
        onConflict: 'tenant_id,external_id,external_source'
      })

    if (error) throw new Error(`Tink upsert error: ${error.message}`)
  }

  return { provider: 'tink', success: true, recordsSynced: transactions.length }
}

// ------------------------------------------------------------
// SYNC META ADS
// ------------------------------------------------------------

async function syncMetaAds(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  tenantCurrency: string
): Promise<SyncResult> {
  const token = await getAccessToken(tenantId, 'meta_ads')
  const connection = await getConnection(tenantId, 'meta_ads')
  const adAccountId = connection.metadata.ad_account_id as string

  if (!adAccountId) {
    throw new Error('Meta Ads account ID missing from connection metadata')
  }

  const fields = [
    'campaign_id', 'campaign_name', 'status', 'objective',
    'daily_budget', 'lifetime_budget',
    'impressions', 'clicks', 'ctr', 'cpc',
    'actions', 'spend', 'cost_per_action_type'
  ].join(',')

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0]
  const until = new Date().toISOString().split('T')[0]

  const url = new URL(
    `https://graph.facebook.com/v18.0/${adAccountId}/campaigns`
  )
  url.searchParams.set('fields', `id,name,status,objective,daily_budget,lifetime_budget,insights.time_range({"since":"${since}","until":"${until}"}){${fields}}`)
  url.searchParams.set('limit', '100')
  url.searchParams.set('access_token', token)

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(20_000)
  })

  if (!response.ok) {
    const errData = await response.json()
    throw new Error(`Meta Ads API error: ${errData.error?.message ?? response.status}`)
  }

  const data = await response.json()
  const campaigns = data.data as Record<string, unknown>[]

  const normalizedCampaigns = campaigns.map(campaign => {
    const insights = (campaign.insights as Record<string, Record<string, unknown>[]>)
      ?.data?.[0] ?? {}

    const conversions = (insights.actions as Record<string, unknown>[] ?? [])
      .find(a => a.action_type === 'purchase' || a.action_type === 'lead')
    const conversionCount = conversions ? parseFloat(String(conversions.value ?? '0')) : 0

    const spend = parseFloat(String(insights.spend ?? '0'))
    const cpa = conversionCount > 0 ? spend / conversionCount : null

    return {
      tenant_id: tenantId,
      external_id: campaign.id as string,
      platform: 'meta' as const,
      name: campaign.name as string,
      status: (campaign.status as string ?? '').toLowerCase(),
      objective: campaign.objective as string || null,
      daily_budget: campaign.daily_budget
        ? parseFloat(String(campaign.daily_budget)) / 100
        : null,
      lifetime_budget: campaign.lifetime_budget
        ? parseFloat(String(campaign.lifetime_budget)) / 100
        : null,
      currency: tenantCurrency,
      impressions: parseInt(String(insights.impressions ?? '0')),
      clicks: parseInt(String(insights.clicks ?? '0')),
      ctr: parseFloat(String(insights.ctr ?? '0')) / 100,
      avg_cpc: parseFloat(String(insights.cpc ?? '0')),
      conversions: conversionCount,
      spend,
      cost_per_conversion: cpa,
      roas: null,
      snapshot_date: until,
      synced_at: new Date().toISOString()
    }
  })

  if (normalizedCampaigns.length > 0) {
    const { error } = await supabase
      .from('ad_campaigns')
      .upsert(normalizedCampaigns, {
        onConflict: 'tenant_id,external_id,platform,snapshot_date'
      })

    if (error) throw new Error(`Meta Ads upsert error: ${error.message}`)
  }

  return { provider: 'meta_ads', success: true, recordsSynced: normalizedCampaigns.length }
}

// ---------------------------------------------------------------------
// SYNC GOOGLE ADS
// ------------------------------------------------------------

async function syncGoogleAds(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  tenantCurrency: string
): Promise<SyncResult> {
  const token = await getAccessToken(tenantId, 'google_ads')
  const connection = await getConnection(tenantId, 'google_ads')
  const customerId = connection.metadata.customer_id as string
  const devToken = Deno.env.get('GOOGLE_ADS_DEVELOPER_TOKEN') ?? ''

  if (!customerId) {
    throw new Error('Google Ads customer ID missing from connection metadata')
  }

  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign_budget.amount_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.conversions,
      metrics.cost_micros,
      metrics.cost_per_conversion
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
      AND campaign.status != 'REMOVED'
  `.replace(/\s+/g, ' ').trim()

  const response = await fetch(
    `https://googleads.googleapis.com/v14/customers/${customerId}/googleAds:searchStream`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'developer-token': devToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(20_000)
    }
  )

  if (!response.ok) {
    throw new Error(`Google Ads API error: ${response.status}`)
  }

  const batches = await response.json() as Record<string, unknown>[]
  const allResults = batches.flatMap(batch =>
    (batch.results as Record<string, unknown>[] ?? [])
  )

  const today = new Date().toISOString().split('T')[0]

  const normalizedCampaigns = allResults.map(r => {
    const campaign = r.campaign as Record<string, unknown>
    const metrics = r.metrics as Record<string, unknown>
    const budget = r.campaign_budget as Record<string, unknown>

    const spend = parseInt(String(metrics.cost_micros ?? '0')) / 1_000_000
    const conversions = parseFloat(String(metrics.conversions ?? '0'))
    const cpa = conversions > 0
      ? parseInt(String(metrics.cost_per_conversion ?? '0')) / 1_000_000
      : null

    const statusMap: Record<string, string> = {
      ENABLED: 'active',
      PAUSED: 'paused',
      REMOVED: 'removed'
    }

    return {
      tenant_id: tenantId,
      external_id: String(campaign.id),
      platform: 'google' as const,
      name: campaign.name as string,
      status: statusMap[campaign.status as string] ?? 'unknown',
      objective: campaign.advertising_channel_type as string || null,
      daily_budget: budget?.amount_micros
        ? parseInt(String(budget.amount_micros)) / 1_000_000
        : null,
      currency: tenantCurrency,
      impressions: parseInt(String(metrics.impressions ?? '0')),
      clicks: parseInt(String(metrics.clicks ?? '0')),
      ctr: parseFloat(String(metrics.ctr ?? '0')),
      avg_cpc: parseInt(String(metrics.average_cpc ?? '0')) / 1_000_000,
      conversions,
      spend,
      cost_per_conversion: cpa,
      roas: null,
      snapshot_date: today,
      synced_at: new Date().toISOString()
    }
  })

  if (normalizedCampaigns.length > 0) {
    const { error } = await supabase
      .from('ad_campaigns')
      .upsert(normalizedCampaigns, {
        onConflict: 'tenant_id,external_id,platform,snapshot_date'
      })

    if (error) throw new Error(`Google Ads upsert error: ${error.message}`)
  }

  return { provider: 'google_ads', success: true, recordsSynced: normalizedCampaigns.length }
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function mapPlaidAccountType(plaidType: string): string {
  const map: Record<string, string> = {
    depository: 'checking',
    credit: 'credit',
    loan: 'loan',
    investment: 'investment',
    other: 'other'
  }
  return map[plaidType] ?? 'checking'
}

function categorizePlaidTransaction(categories: string[]): string {
  const cat = (categories ?? []).join(' ').toLowerCase()
  if (cat.includes('software') || cat.includes('subscription')) return 'saas'
  if (cat.includes('advertising') || cat.includes('marketing')) return 'marketing'
  if (cat.includes('payroll') || cat.includes('salary')) return 'payroll'
  if (cat.includes('service') && cat.includes('computer')) return 'infrastructure'
  if (cat.includes('tax') || cat.includes('government')) return 'tax'
  return 'ops'
}

function detectRecurring(name: string): boolean {
  const recurringKeywords = [
    'github', 'slack', 'notion', 'figma', 'ahrefs', 'hubspot',
    'salesforce', 'aws', 'google cloud', 'digitalocean', 'stripe',
    'intercom', 'zendesk', 'mailchimp', 'sendgrid', 'twilio',
    'zapier', 'make', 'monday', 'asana', 'jira', 'linear',
    'loom', 'zoom', 'calendly', 'typeform', 'webflow', 'vercel',
    'supabase', 'openai', 'anthropic', 'adobe', 'microsoft 365',
    'google workspace', 'dropbox', '1password', 'gusto'
  ]
  const nameLower = name.toLowerCase()
  return recurringKeywords.some(kw => nameLower.includes(kw))
}

function normalizeKey(name: string): string {
  return name.toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 50)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
