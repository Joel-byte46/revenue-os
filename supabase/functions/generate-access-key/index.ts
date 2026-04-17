// ============================================================
// REVENUE OS — GENERATE ACCESS KEY (WEBHOOK VERSION)
// Déclenché automatiquement par Chariow (Successful sale)
//
// POST webhook → génère clé → envoie email
//
// Response: { success: true }
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
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }

  try {
    const body = await req.json().catch(() => ({}))
    console.log('[generate-access-key] Incoming webhook:', JSON.stringify(body))

    // --------------------------------------------------------
    // EXTRACTION TOLÉRANTE DES DONNÉES
    // --------------------------------------------------------
    const email =
      body?.email ??
      body?.customer?.email ??
      body?.buyer?.email ??
      body?.data?.email ??
      body?.data?.customer?.email ??
      body?.data?.buyer?.email ??
      null

    const productName =
      body?.product?.name ??
      body?.data?.product?.name ??
      body?.product_name ??
      body?.data?.product_name ??
      'early_access'

    if (!email || !email.includes('@')) {
      console.warn('[generate-access-key] No valid email found in webhook')
      return new Response(
        JSON.stringify({ success: false, error: 'No valid email found' }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    const plan = 'early_adopter'
    const expires_in_hours = 48

    const key = generateKey()
    const expiresAt = new Date(
      Date.now() + expires_in_hours * 60 * 60 * 1000
    ).toISOString()

    // --------------------------------------------------------
    // ÉVITER LES DOUBLONS (clé active existante)
    // --------------------------------------------------------
    const { data: existingKey } = await supabase
      .from('access_keys')
      .select('id, key_value, expires_at')
      .eq('email', email)
      .eq('is_used', false)
      .gt('expires_at', new Date().toISOString())
      .single()

    if (existingKey) {
      console.log('[generate-access-key] Existing valid key returned')
      return new Response(
        JSON.stringify({ success: true, key: existingKey.key_value }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // --------------------------------------------------------
    // INSÉRER NOUVELLE CLÉ
    // --------------------------------------------------------
    const { error: insertError } = await supabase
      .from('access_keys')
      .insert({
        key_value: key,
        email,
        plan,
        is_used: false,
        expires_at: expiresAt
      })

    if (insertError) {
      throw new Error(`Failed to insert key: ${insertError.message}`)
    }

    // --------------------------------------------------------
    // ENVOYER EMAIL
    // --------------------------------------------------------
    await sendActivationEmail(email, key, expiresAt).catch(err => {
      console.error('[generate-access-key] Email send failed:', err)
    })

    console.log(`[generate-access-key] Key generated: ${key} for ${email}`)

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[generate-access-key] Error:', message)

    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})

// ------------------------------------------------------------
// GENERATE KEY
// Format : REV-XXXX-XXXX-XXXX
// ------------------------------------------------------------

function generateKey(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

  const segment = (length: number): string =>
    Array.from(
      { length },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join('')

  return `REV-${segment(4)}-${segment(4)}-${segment(4)}`
}

// ------------------------------------------------------------
// SEND ACTIVATION EMAIL (Resend)
// ------------------------------------------------------------

async function sendActivationEmail(
  email: string,
  key: string,
  expiresAt: string
): Promise<void> {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')

  if (!RESEND_API_KEY) {
    console.warn('[generate-access-key] RESEND_API_KEY not set — skipping email')
    return
  }

  const appUrl = Deno.env.get('APP_URL') ?? 'https://app.revenue-os.ai'
  const activationUrl = `${appUrl}/activate?key=${key}`

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Revenue OS <onboarding@revenue-os.ai>',
      to: [email],
      subject: 'Votre accès Revenue OS — Activez votre OS',
      html: `
        <div style="font-family: Inter, sans-serif; padding: 40px; background: #0f172a; color: #f8fafc;">
          <h1>Revenue OS</h1>
          <p>Votre accès early adopter est prêt.</p>
          <p style="font-size: 24px; font-weight: bold;">${key}</p>
          <a href="${activationUrl}" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#3b82f6;color:white;text-decoration:none;border-radius:6px;">
            Activer mon accès
          </a>
        </div>
      `
    })
  })
  if (!response.ok) {
const error = await response.text()
throw new Error(`Resend error: ${response.status} ${error}`)
}
}

