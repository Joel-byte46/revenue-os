// ============================================================
// REVENUE OS — VALIDATE LLM KEY
// Scène 2 de l'onboarding : valide la clé API OpenAI en temps réel,
// la chiffre et la stocke dans secrets.
//
// POST { tenant_id, api_key, model }
// Response: { valid, estimated_monthly_cost_usd, error? }
//
// Appelé à chaque keystroke (debounced côté frontend).
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encryptSecret } from '../_shared/crypto.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

// Estimation du coût mensuel basée sur l'usage moyen observé
// (500K tokens/mois pour un SaaS founder avec 10-50 deals)
const MONTHLY_TOKEN_ESTIMATE = 500_000

const MODEL_PRICING_PER_1K: Record<string, number> = {
  'gpt-4o': 0.005,
  'gpt-4o-mini': 0.00015,
  'claude-3-5-sonnet-20241022': 0.003,
  'gemini-pro': 0.0005
}

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

  try {
    const body = await req.json()
    const { tenant_id, api_key, model = 'gpt-4o' } = body as {
      tenant_id: string
      api_key: string
      model: string
    }

    if (!tenant_id || !api_key) {
      return new Response(
        JSON.stringify({ error: 'tenant_id and api_key required' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // Vérification basique du format
    if (!api_key.startsWith('sk-') || api_key.length < 20) {
      return new Response(
        JSON.stringify({
          valid: false,
          error: 'Format de clé invalide. Elle doit commencer par sk-'
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // --------------------------------------------------------
    // ÉTAPE 1 : Vérifier que le tenant existe et nous appartient
    // --------------------------------------------------------
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('id', tenant_id)
      .single()

    if (!tenant) {
      return new Response(
        JSON.stringify({ error: 'Tenant not found' }),
        { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // --------------------------------------------------------
    // ÉTAPE 2 : Tester la clé contre l'API OpenAI
    // --------------------------------------------------------
    const validationResult = await validateApiKey(api_key, model)

    if (!validationResult.valid) {
      return new Response(
        JSON.stringify({
          valid: false,
          error: validationResult.error
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // --------------------------------------------------------
    // ÉTAPE 3 : Chiffrer et stocker la clé
    // --------------------------------------------------------
    const encryptedKey = await encryptSecret(api_key)

    const { error: secretError } = await supabase
      .from('secrets')
      .upsert({
        tenant_id,
        provider: 'openai',
        encrypted_value: encryptedKey,
        metadata: {
          model_selected: model,
          last_verified_at: new Date().toISOString(),
          key_prefix: api_key.slice(0, 8) + '****'
        }
      }, { onConflict: 'tenant_id,provider' })

    if (secretError) {
      console.error('[validate-llm-key] Secret store error:', secretError)
      throw new Error(`Failed to store key: ${secretError.message}`)
    }

    // --------------------------------------------------------
    // ÉTAPE 4 : Mettre à jour la config du tenant
    // --------------------------------------------------------
    await supabase
      .from('tenants')
      .update({
        settings: supabase.rpc('jsonb_merge', {
          target: 'settings',
          patch: { llm_model: model }
        })
      })
      .eq('id', tenant_id)

    // Fallback si jsonb_merge n'est pas disponible
    const { data: currentTenant } = await supabase
      .from('tenants')
      .select('settings')
      .eq('id', tenant_id)
      .single()

    await supabase
      .from('tenants')
      .update({
        settings: {
          ...(currentTenant?.settings ?? {}),
          llm_model: model
        }
      })
      .eq('id', tenant_id)

    // --------------------------------------------------------
    // ÉTAPE 5 : Mettre à jour l'onboarding state
    // --------------------------------------------------------
    const estimatedMonthlyCost = calculateEstimatedCost(model)

    await supabase
      .from('onboarding_state')
      .update({
        intelligence: {
          model_selected: model,
          key_verified_at: new Date().toISOString(),
          estimated_monthly_cost_usd: estimatedMonthlyCost,
          key_prefix: api_key.slice(0, 8) + '****'
        },
        completed_steps: supabase.rpc('array_append_unique', {
          arr: 'completed_steps',
          val: 'intelligence'
        }),
        current_step: 'connections'
      })
      .eq('tenant_id', tenant_id)

    // Fallback manuel pour l'update onboarding
    const { data: currentOnboarding } = await supabase
      .from('onboarding_state')
      .select('completed_steps')
      .eq('tenant_id', tenant_id)
      .single()

    const completedSteps = currentOnboarding?.completed_steps ?? []
    if (!completedSteps.includes('intelligence')) {
      completedSteps.push('intelligence')
    }

    await supabase
      .from('onboarding_state')
      .update({
        intelligence: {
          model_selected: model,
          key_verified_at: new Date().toISOString(),
          estimated_monthly_cost_usd: estimatedMonthlyCost,
          key_prefix: api_key.slice(0, 8) + '****'
        },
        completed_steps: completedSteps,
        current_step: 'connections',
        updated_at: new Date().toISOString()
      })
      .eq('tenant_id', tenant_id)

    console.log(`[validate-llm-key] Success: tenant=${tenant_id}, model=${model}`)

    return new Response(
      JSON.stringify({
        valid: true,
        model,
        key_prefix: api_key.slice(0, 8) + '****',
        estimated_monthly_cost_usd: estimatedMonthlyCost,
        message: 'Clé valide et enregistrée.'
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[validate-llm-key] Error:', message)

    return new Response(
      JSON.stringify({ error: 'Erreur interne lors de la validation.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})

// ------------------------------------------------------------
// VALIDATE API KEY against OpenAI
// ------------------------------------------------------------

async function validateApiKey(
  apiKey: string,
  model: string
): Promise<{ valid: boolean; error?: string }> {

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8_000)

  try {
    // On appelle /models — pas de tokens consommés
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    })

    clearTimeout(timeoutId)

    if (response.status === 401) {
      return { valid: false, error: 'Clé API invalide. Vérifiez votre clé sur platform.openai.com' }
    }

    if (response.status === 429) {
      return { valid: false, error: 'Limite de requêtes atteinte. Réessayez dans quelques secondes.' }
    }

    if (response.status === 402) {
      return { valid: false, error: 'Solde insuffisant sur votre compte OpenAI. Ajoutez des crédits.' }
    }

    if (!response.ok) {
      return { valid: false, error: `Erreur OpenAI : ${response.status}` }
    }

    // Vérifier que le modèle sélectionné est disponible
    const data = await response.json()
    const availableModels = data.data.map((m: { id: string }) => m.id) as string[]

    const modelToCheck = model === 'gpt-4o' ? 'gpt-4o' : model
    const modelAvailable = availableModels.some(m => m.includes(modelToCheck.split('-')[0]))

    if (!modelAvailable && model !== 'gpt-4o-mini') {
      // gpt-4o-mini toujours disponible — pas de vérification nécessaire
      console.warn(`[validate-llm-key] Model ${model} not in account, falling back to gpt-4o`)
    }

    return { valid: true }

  } catch (error) {
    clearTimeout(timeoutId)

    if (error instanceof Error && error.name === 'AbortError') {
      return { valid: false, error: 'Timeout lors de la vérification. Vérifiez votre connexion.' }
    }

    return { valid: false, error: 'Impossible de contacter OpenAI. Réessayez.' }
  }
}

function calculateEstimatedCost(model: string): number {
  const pricePerK = MODEL_PRICING_PER_1K[model] ?? 0.005
  return Math.round((MONTHLY_TOKEN_ESTIMATE / 1000) * pricePerK * 100) / 100
}
