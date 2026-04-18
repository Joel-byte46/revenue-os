// ============================================================
// REVENUE OS — ACTIVATE KEY
// Scène 1 de l'onboarding : valide la clé d'accès,
// crée le compte utilisateur, ouvre la session.
//
// POST { key: "REV-XXXX-XXXX-XXXX" }
// Response: { session, redirect: '/setup/intelligence' }
//
// Appelé uniquement par le frontend d'onboarding.
// Jamais par les agents.
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

serve(async (req: Request) => {
  // CORS preflight
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
    const { key } = body as { key: string }

    if (!key || typeof key !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing key' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // Normaliser la clé (uppercase, trim)
    const normalizedKey = key.trim().toUpperCase()

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

        // --------------------------------------------------------
    // MASTER KEY (DEV OVERRIDE)
    // --------------------------------------------------------
// --------------------------------------------------------
// MASTER KEY (BOOTSTRAP ADMIN)
// --------------------------------------------------------
if (normalizedKey === 'REV-1234554321') {
  console.warn('[activate-key] MASTER KEY USED')

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const masterEmail = 'tchoupe4466@gmail.com'

  // --------------------------------------------------------
  // 1. Vérifier si user existe
  // --------------------------------------------------------
  let { data: userData } = await supabase.auth.admin.getUserByEmail(masterEmail)
  let user = userData?.user

  // --------------------------------------------------------
  // 2. Si pas de user → le créer
  // --------------------------------------------------------
  if (!user) {
    const { data: createdUser, error: createError } =
      await supabase.auth.admin.createUser({
        email: masterEmail,
        password: crypto.randomUUID(),
        email_confirm: true,
        user_metadata: {
          plan: 'early_adopter',
          activated_at: new Date().toISOString(),
          source: 'master_key_bootstrap'
        }
      })

    if (createError || !createdUser?.user) {
      console.error('[MASTER] User creation failed:', createError)
      return new Response(
        JSON.stringify({ success: false, error: 'Failed to bootstrap admin.' }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    user = createdUser.user
  }

  const userId = user.id

  // --------------------------------------------------------
  // 3. Vérifier si profile existe
  // --------------------------------------------------------
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('tenant_id')
    .eq('id', userId)
    .maybeSingle()

  let tenantId: string

  // --------------------------------------------------------
  // 4. Si pas de profile → créer tenant + profile
  // --------------------------------------------------------
  if (!existingProfile) {
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .insert({
        name: 'Revenue OS',
        status: 'trial',
        vertical: 'saas',
        timezone: 'Europe/Paris',
        currency: 'EUR',
        settings: {
          llm_model: 'gpt-4o',
          auto_send_sequences: false
        }
      })
      .select('id')
      .single()

    if (tenantError || !tenant) {
      console.error('[MASTER] Tenant creation failed:', tenantError)
      return new Response(
        JSON.stringify({ success: false, error: 'Failed to create tenant.' }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    tenantId = tenant.id

    await supabase.from('profiles').insert({
      id: userId,
      tenant_id: tenantId,
      role: 'owner',
      plan: 'early_adopter',
      plan_activated_at: new Date().toISOString(),
      onboarding_step: 1,
      onboarding_completed: false
    })
  } else {
    tenantId = existingProfile.tenant_id
  }

  // --------------------------------------------------------
  // 5. Générer magic link
  // --------------------------------------------------------
  const { data: sessionData } =
    await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: masterEmail,
      options: {
        redirectTo: `${Deno.env.get('APP_URL') ?? ''}/dashboard`
      }
    })

  console.log('[MASTER] Bootstrap success')

  return new Response(
    JSON.stringify({
      success: true,
      email: masterEmail,
      tenant_id: tenantId,
      magic_link: sessionData?.properties?.action_link ?? null,
      redirect: '/dashboard',
      message: 'Master access granted.'
    }),
    { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
  )
        }
    // --------------------------------------------------------
    // ÉTAPE 1 : Vérifier la clé
    // --------------------------------------------------------
    const { data: accessKey, error: keyError } = await supabase
      .from('access_keys')
      .select('id, email, plan, expires_at, is_used')
      .eq('key_value', normalizedKey)
      .single()

    if (keyError || !accessKey) {
      console.warn('[activate-key] Key not found:', normalizedKey)
      return new Response(
        JSON.stringify({ error: 'Clé invalide ou inexistante.' }),
        { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    if (accessKey.is_used) {
      return new Response(
        JSON.stringify({ error: 'Cette clé a déjà été utilisée.' }),
        { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    if (new Date(accessKey.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: 'Cette clé a expiré. Contactez-nous pour en obtenir une nouvelle.' }),
        { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // --------------------------------------------------------
    // ÉTAPE 2 : Créer le compte utilisateur
    // --------------------------------------------------------
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: accessKey.email,
      password: crypto.randomUUID(),
      // Password aléatoire — l'utilisateur se connectera via magic link uniquement
      email_confirm: true,
      user_metadata: {
        plan: accessKey.plan,
        activated_at: new Date().toISOString(),
        source: 'access_key'
      }
    })

    if (authError || !authData.user) {
      // Si l'utilisateur existe déjà (re-activation)
      if (authError?.message?.includes('already registered')) {
        return new Response(
          JSON.stringify({
            error: 'Un compte existe déjà avec cet email. Utilisez le lien de connexion.'
          }),
          { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }
      console.error('[activate-key] Auth create error:', authError)
      throw new Error(`Failed to create user: ${authError?.message}`)
    }

    const userId = authData.user.id

    // --------------------------------------------------------
    // ÉTAPE 3 : Créer le tenant
    // --------------------------------------------------------
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .insert({
        name: null,
        // Sera rempli pendant l'onboarding
        status: 'trial',
        vertical: 'saas',
        // Défaut SaaS, modifiable dans le Control Panel
        timezone: 'Europe/Paris',
        currency: 'EUR',
        settings: {
          llm_model: 'gpt-4o',
          auto_send_sequences: false,
          stage_thresholds: {
            new: 3,
            qualified: 7,
            demo_done: 10,
            proposal_sent: 14,
            negotiation: 21
          }
        }
      })
      .select('id')
      .single()

    if (tenantError || !tenant) {
      console.error('[activate-key] Tenant create error:', tenantError)
      // Rollback : supprimer le user créé
      await supabase.auth.admin.deleteUser(userId)
      throw new Error(`Failed to create tenant: ${tenantError?.message}`)
    }

    const tenantId = tenant.id

    // --------------------------------------------------------
    // ÉTAPE 4 : Créer le profil
    // --------------------------------------------------------
    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        id: userId,
        tenant_id: tenantId,
        role: 'owner',
        plan: accessKey.plan,
        plan_activated_at: new Date().toISOString(),
        onboarding_step: 1,
        onboarding_completed: false
      })

    if (profileError) {
      console.error('[activate-key] Profile create error:', profileError)
      await supabase.auth.admin.deleteUser(userId)
      await supabase.from('tenants').delete().eq('id', tenantId)
      throw new Error(`Failed to create profile: ${profileError?.message}`)
    }

    // --------------------------------------------------------
    // ÉTAPE 5 : Créer l'état d'onboarding
    // --------------------------------------------------------
    await supabase
      .from('onboarding_state')
      .insert({
        tenant_id: tenantId,
        user_id: userId,
        current_step: 'intelligence',
        completed_steps: [],
        connections: {
          hubspot: 'pending',
          plaid: 'pending',
          stripe: 'pending',
          slack: 'pending'
        }
      })

    // --------------------------------------------------------
    // ÉTAPE 6 : Créer le premier system_event
    // --------------------------------------------------------
    await supabase
      .from('system_events')
      .insert({
        tenant_id: tenantId,
        event_type: 'system_initialized',
        title: 'Revenue OS activé',
        body: `Bienvenue. Votre OS démarre. Configurez votre intelligence et vos connexions.`,
        severity: 'info',
        metadata: { plan: accessKey.plan }
      })

    // --------------------------------------------------------
    // ÉTAPE 7 : Marquer la clé comme utilisée
    // --------------------------------------------------------
    await supabase
      .from('access_keys')
      .update({
        is_used: true,
        used_at: new Date().toISOString(),
        used_by_user_id: userId
      })
      .eq('id', accessKey.id)

    // --------------------------------------------------------
    // ÉTAPE 8 : Créer une session pour l'utilisateur
    // --------------------------------------------------------
    const { data: sessionData, error: sessionError } = await supabase.auth.admin
      .generateLink({
        type: 'magiclink',
        email: accessKey.email,
        options: {
          redirectTo: `${Deno.env.get('APP_URL') ?? ''}/setup/intelligence`
        }
      })

    if (sessionError) {
      console.error('[activate-key] Session error:', sessionError)
      // On continue — l'utilisateur existe, il peut se connecter via magic link
    }

    console.log(`[activate-key] Success: tenant=${tenantId}, user=${userId}, plan=${accessKey.plan}`)

    return new Response(
      JSON.stringify({
        success: true,
        email: accessKey.email,
        tenant_id: tenantId,
        magic_link: sessionData?.properties?.action_link ?? null,
        redirect: '/setup/intelligence',
        message: 'Compte créé. Vérifiez votre email pour vous connecter.'
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[activate-key] Unexpected error:', message)

    return new Response(
      JSON.stringify({ error: 'Erreur interne. Contactez le support.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})
