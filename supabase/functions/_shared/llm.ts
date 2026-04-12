// ============================================================
// REVENUE OS — LLM GATEWAY
// Point d'entrée unique pour tous les appels LLM.
// Gère : BYOK, retry, JSON mode, logging des tokens,
//        timeout, fallback model.
//
// RÈGLE ABSOLUE :
// Ce module est le SEUL endroit où on appelle l'API OpenAI/Anthropic.
// Jamais d'appels directs dans les agents.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { decryptSecret } from './crypto.ts'
import type { LLMCallParams, LLMResponse } from './types.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const DEFAULT_MODEL = 'gpt-4o'
const FALLBACK_MODEL = 'gpt-4o-mini'
const DEFAULT_MAX_TOKENS = 600
const DEFAULT_TEMPERATURE = 0.7
const TIMEOUT_MS = 25_000  // 25 secondes max par appel LLM
const MAX_RETRIES = 1       // 1 retry sur échec (pas plus)

// ------------------------------------------------------------
// CALL LLM
// Fonction principale. Appelée par tous les agents.
// ------------------------------------------------------------

export async function callLLM(params: LLMCallParams): Promise<LLMResponse> {
  const startTime = Date.now()

  // 1. Récupérer la clé OpenAI du tenant (BYOK)
  const apiKey = await getTenantLLMKey(params.tenantId)

  // 2. Sélectionner le modèle
  const model = await getTenantModel(params.tenantId)

  // 3. Appel avec retry
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await callOpenAI({
        apiKey,
        model: attempt === 0 ? model : FALLBACK_MODEL,
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
        jsonMode: params.jsonMode ?? true,
        maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: params.temperature ?? DEFAULT_TEMPERATURE
      })

      const durationMs = Date.now() - startTime

      // Log usage (async, ne bloque pas)
      logTokenUsage(params.tenantId, result.tokensUsed, model, durationMs)
        .catch(err => console.error('[llm] Failed to log usage:', err))

      return { ...result, durationMs }

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < MAX_RETRIES) {
        console.warn(
          `[llm] Attempt ${attempt + 1} failed for tenant ${params.tenantId}. ` +
          `Retrying with fallback model... Error: ${lastError.message}`
        )
        await sleep(1000) // Attendre 1 seconde avant retry
      }
    }
  }

  throw new Error(
    `[llm] All attempts failed for tenant ${params.tenantId}: ${lastError?.message}`
  )
}

// ------------------------------------------------------------
// CALL LLM — JSON ONLY
// Wrapper qui force JSON mode et parse automatiquement.
// Lève une erreur si le JSON n'est pas valide.
// ------------------------------------------------------------

export async function callLLMJson<T = Record<string, unknown>>(
  params: LLMCallParams
): Promise<T> {
  const response = await callLLM({ ...params, jsonMode: true })

  try {
    return JSON.parse(response.content) as T
  } catch {
    // Dernière tentative : extraire le JSON du texte
    const jsonMatch = response.content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as T
      } catch {
        // Fail silencieux avec log
      }
    }

    throw new Error(
      `[llm] Failed to parse JSON response. Content: ${response.content.slice(0, 200)}`
    )
  }
}

// ------------------------------------------------------------
// GENERATE EMBEDDING
// Pour le RAG (pattern_embeddings). Utilise text-embedding-ada-002.
// ------------------------------------------------------------

export async function generateEmbedding(
  tenantId: string,
  text: string
): Promise<number[]> {
  const apiKey = await getTenantLLMKey(tenantId)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'text-embedding-ada-002',
        input: text.slice(0, 8000) // Limite de sécurité
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(`OpenAI Embeddings API error: ${error.error?.message}`)
    }

    const data = await response.json()
    return data.data[0].embedding as number[]

  } finally {
    clearTimeout(timeoutId)
  }
}

// ------------------------------------------------------------
// INTERNAL : CALL OPENAI
// ------------------------------------------------------------

interface OpenAICallParams {
  apiKey: string
  model: string
  systemPrompt: string
  userPrompt: string
  jsonMode: boolean
  maxTokens: number
  temperature: number
}

async function callOpenAI(params: OpenAICallParams): Promise<LLMResponse> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt }
      ],
      max_tokens: params.maxTokens,
      temperature: params.temperature
    }

    // JSON mode : garantit un JSON valide en sortie
    if (params.jsonMode) {
      body.response_format = { type: 'json_object' }
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    if (response.status === 401) {
      throw new Error('Invalid OpenAI API key. Ask the user to update their key in settings.')
    }

    if (response.status === 429) {
      throw new Error('OpenAI rate limit exceeded. Will retry.')
    }

    if (response.status === 402) {
      throw new Error('OpenAI billing limit reached. Ask the user to add credits.')
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        `OpenAI API error ${response.status}: ${
          (errorData as { error?: { message?: string } }).error?.message ?? 'Unknown error'
        }`
      )
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content ?? ''
    const tokensUsed = data.usage?.total_tokens ?? 0

    if (!content) {
      throw new Error('OpenAI returned empty content')
    }

    return {
      content,
      tokensUsed,
      model: params.model,
      durationMs: 0 // Sera rempli par callLLM
    }

  } finally {
    clearTimeout(timeoutId)
  }
}

// ------------------------------------------------------------
// INTERNAL : GET TENANT LLM KEY
// Récupère et déchiffre la clé OpenAI du tenant.
// ------------------------------------------------------------

async function getTenantLLMKey(tenantId: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  const { data, error } = await supabase
    .from('secrets')
    .select('encrypted_value')
    .eq('tenant_id', tenantId)
    .eq('provider', 'openai')
    .single()

  if (error || !data) {
    throw new Error(
      `[llm] No OpenAI key found for tenant ${tenantId}. ` +
      `User must add their API key in settings.`
    )
  }

  try {
    return await decryptSecret(data.encrypted_value)
  } catch {
    throw new Error(
      `[llm] Failed to decrypt OpenAI key for tenant ${tenantId}`
    )
  }
}

// ------------------------------------------------------------
// INTERNAL : GET TENANT MODEL PREFERENCE
// ------------------------------------------------------------

async function getTenantModel(tenantId: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  const { data } = await supabase
    .from('tenants')
    .select('settings')
    .eq('id', tenantId)
    .single()

  return data?.settings?.llm_model ?? DEFAULT_MODEL
}

// ------------------------------------------------------------
// INTERNAL : LOG TOKEN USAGE
// Stocke l'usage pour que le tenant puisse suivre ses coûts.
// ------------------------------------------------------------

async function logTokenUsage(
  tenantId: string,
  tokensUsed: number,
  model: string,
  durationMs: number
): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // On stocke dans les settings du tenant pour simplicité
  // En prod : table dédiée llm_usage
  await supabase.rpc('increment_token_usage', {
    p_tenant_id: tenantId,
    p_tokens: tokensUsed,
    p_model: model,
    p_duration_ms: durationMs
  }).catch(() => {
    // Ne pas bloquer si le log échoue
  })
}

// ------------------------------------------------------------
// UTILITY
// ------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ------------------------------------------------------------
// ESTIMATE COST
// Estimation du coût en USD pour un appel.
// Utilisé dans les logs pour information.
// ------------------------------------------------------------

export function estimateCost(
  tokensUsed: number,
  model: string
): number {
  // Prix en USD pour 1000 tokens (input + output)
  const pricing: Record<string, number> = {
    'gpt-4o': 0.005,
    'gpt-4o-mini': 0.00015,
    'gpt-4-turbo': 0.01,
    'text-embedding-ada-002': 0.0001
  }

  const pricePerK = pricing[model] ?? 0.005
  return (tokensUsed / 1000) * pricePerK
}
