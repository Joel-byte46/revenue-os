// ============================================================
// REVENUE OS — ACTIVATE KEY
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return jsonError('Method not allowed', 405)
  }

  try {
    const body = await req.json()
    const { key } = body as { key: string }

    if (!key || typeof key !== 'string') {
      return jsonError('Missing key', 400)
    }

    const normalizedKey = key.trim().toUpperCase()
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // ========================================================
    // MASTER KEY (BOOTSTRAP ADMIN)
    // ========================================================

    if (normalizedKey === 'REV-1234554321') {
      console.warn('[activate-key] MASTER KEY USED')

      const masterEmail = 'tchoupe4466@gmail.com'

      // 1️⃣ Vérifier si user existe
      const { data: usersData, error: listError } =
        await supabase.auth.admin.listUsers()

      if (listError) {
        console.error('[MASTER] listUsers error:', listError)
        return jsonError('Auth error', 500)
      }

      let user = usersData?.users?.find(u => u.email === masterEmail)

      // 2️⃣ Si pas de user → créer
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
          console.error('[MASTER] createUser error:', createError)
          return jsonError('Failed to create master user', 500)
        }

        user = createdUser.user
      }

      const userId = user.id

      // 3️⃣ Vérifier si profile existe
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('tenant_id')
        .eq('id', userId)
        .maybeSingle()

      let tenantId: string

      // 4️⃣ Si pas de profile → créer tenant + profile
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
          console.error('[MASTER] tenant error:', tenantError)
          return jsonError('Failed to create tenant', 500)
        }

        tenantId = tenant.id

        const { error: profileError } = await supabase
          .from('profiles')
          .insert({
            id: userId,
            tenant_id: tenantId,
            role: 'owner',
            plan: 'early_adopter',
            plan_activated_at: new Date().toISOString(),
            onboarding_step: 1,
            onboarding_completed: false
          })

        if (profileError) {
          console.error('[MASTER] profile error:', profileError)
          return jsonError('Failed to create profile', 500)
        }
      } else {
        tenantId = existingProfile.tenant_id
      }

      // 5️⃣ Générer magic link
      const { data: sessionData, error: sessionError } =
        await supabase.auth.admin.generateLink({
          type: 'magiclink',
          email: masterEmail,
          options: {
            redirectTo: `${Deno.env.get('APP_URL') ?? ''}/dashboard`
          }
        })

      if (sessionError) {
        console.error('[MASTER] magic link error:', sessionError)
        return jsonError('Failed to generate login link', 500)
      }

      return new Response(
        JSON.stringify({
          success: true,
          email: masterEmail,
          tenant_id: tenantId,
          magic_link: sessionData?.properties?.action_link ?? null,
          redirect: '/dashboard'
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // ========================================================
    // NORMAL ACCESS KEY FLOW
    // ========================================================

    const { data: accessKey, error: keyError } = await supabase
      .from('access_keys')
      .select('id, email, plan, expires_at, is_used')
      .eq('key_value', normalizedKey)
      .single()

    if (keyError || !accessKey) {
      return jsonError('Clé invalide ou inexistante.', 403)
    }

    if (accessKey.is_used) {
      return jsonError('Cette clé a déjà été utilisée.', 403)
    }

    if (new Date(accessKey.expires_at) < new Date()) {
      return jsonError('Cette clé a expiré.', 403)
    }

    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email: accessKey.email,
        password: crypto.randomUUID(),
        email_confirm: true,
        user_metadata: {
          plan: accessKey.plan,
          activated_at: new Date().toISOString(),
          source: 'access_key'
        }
      })

    if (authError || !authData?.user) {
      return jsonError('Failed to create user', 500)
    }

    const userId = authData.user.id

    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .insert({
        name: null,
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
      return jsonError('Failed to create tenant', 500)
    }

    const tenantId = tenant.id

    await supabase.from('profiles').insert({
      id: userId,
      tenant_id: tenantId,
      role: 'owner',
      plan: accessKey.plan,
      plan_activated_at: new Date().toISOString(),
      onboarding_step: 1,
      onboarding_completed: false
    })

    await supabase.from('access_keys').update({
      is_used: true,
      used_at: new Date().toISOString(),
      used_by_user_id: userId
    }).eq('id', accessKey.id)

    const { data: sessionData } =
      await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: accessKey.email,
        options: {
          redirectTo: `${Deno.env.get('APP_URL') ?? ''}/setup/intelligence`
        }
      })

    return new Response(
      JSON.stringify({
        success: true,
        email: accessKey.email,
        tenant_id: tenantId,
        magic_link: sessionData?.properties?.action_link ?? null,
        redirect: '/setup/intelligence'
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('[activate-key] Unexpected error:', error)
    return jsonError('Erreur interne.', 500)
  }
})

function jsonError(message: string, status = 400) {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
  )
                  }
