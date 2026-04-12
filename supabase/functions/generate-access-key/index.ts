// ============================================================
// REVENUE OS — GENERATE ACCESS KEY
// ADMIN UNIQUEMENT — Génère des clés pour les nouveaux acheteurs.
//
// POST { email, plan, expires_in_hours }
// Header: X-Admin-Secret: <ton secret>
// Response: { key, email, expires_at }
//
// Appelé par toi depuis un script ou dashboard admin simple.
// Jamais exposé publiquement.
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ADMIN_SECRET = Deno.env.get('ADMIN_SECRET') ?? ''

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  // --------------------------------------------------------
  // VÉRIFICATION ADMIN — Stricte
  // --------------------------------------------------------
  const adminSecret = req.headers.get('X-Admin-Secret') ?? ''

  if (!ADMIN_SECRET || adminSecret !== ADMIN_SECRET) {
    console.warn('[generate-access-key] Unauthorized attempt')
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }

  try {
    const body = await req.json()
    const {
      email,
      plan = 'early_adopter',
      expires_in_hours = 48,
      send_email = true
    } = body as {
      email: string
      plan?: string
      expires_in_hours?: number
      send_email?: boolean
    }

    if (!email || !email.includes('@')) {
      return new Response(
        JSON.stringify({ error: 'Valid email required' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // --------------------------------------------------------
    // Générer la clé format REV-XXXX-XXXX-XXXX
    // --------------------------------------------------------
    const key = generateKey()
    const expiresAt = new Date(
      Date.now() + expires_in_hours * 60 * 60 * 1000
    ).toISOString()

    // --------------------------------------------------------
    // Vérifier qu'il n'existe pas déjà une clé active pour cet email
    // --------------------------------------------------------
    const { data: existingKey } = await supabase
      .from('access_keys')
      .select('id, key_value, expires_at')
      .eq('email', email)
      .eq('is_used', false)
      .gt('expires_at', new Date().toISOString())
      .single()

    if (existingKey) {
      // Retourner la clé existante plutôt qu'en créer une nouvelle
      return new Response(
        JSON.stringify({
          key: existingKey.key_value,
          email,
          expires_at: existingKey.expires_at,
          note: 'Clé existante non-utilisée retournée (la précédente est encore valide)'
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // --------------------------------------------------------
    // Insérer la nouvelle clé
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
    // Envoyer l'email au client (via Resend si configuré)
    // --------------------------------------------------------
    if (send_email) {
      await sendActivationEmail(email, key, expiresAt).catch(err => {
        console.error('[generate-access-key] Email send failed:', err)
        // Ne pas bloquer — la clé est créée, on peut renvoyer manuellement
      })
    }

    console.log(`[generate-access-key] Key generated: ${key} for ${email} (plan: ${plan})`)

    return new Response(
      JSON.stringify({
        key,
        email,
        plan,
        expires_at: expiresAt,
        expires_in_hours,
        activation_url: `${Deno.env.get('APP_URL') ?? 'https://app.revenue-os.ai'}/activate?key=${key}`,
        email_sent: send_email
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[generate-access-key] Error:', message)

    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})

// ------------------------------------------------------------
// GENERATE KEY
// Format : REV-XXXX-XXXX-XXXX (uppercase alphanumeric)
// ------------------------------------------------------------

function generateKey(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  // Pas de I, O, 0, 1 (confusion visuelle)

  const segment = (length: number): string =>
    Array.from(
      { length },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join('')

  return `REV-${segment(4)}-${segment(4)}-${segment(4)}`
}

// ------------------------------------------------------------
// SEND ACTIVATION EMAIL (via Resend)
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
  const expiryText = new Date(expiresAt).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  })

  const response = await fetch('https://api.resend.com/emails', {
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
        <div style="font-family: 'Geist', Inter, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; background: #0f172a; color: #f8fafc;">
          
          <p style="font-size: 24px; font-weight: 700; margin: 0 0 8px;">Revenue OS</p>
          <p style="font-size: 14px; opacity: 0.5; margin: 0 0 40px; letter-spacing: 0.1em; text-transform: uppercase;">Operating System for Founders</p>
          
          <p style="font-size: 16px; line-height: 1.6; margin: 0 0 24px;">
            Bienvenue. Votre accès early adopter est prêt.
          </p>
          
          <div style="background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; margin: 0 0 32px; text-align: center;">
            <p style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.15em; opacity: 0.5; margin: 0 0 12px;">Votre clé d'activation</p>
            <p style="font-size: 28px; font-weight: 700; font-family: 'Geist Mono', monospace; letter-spacing: 0.05em; margin: 0; color: #60a5fa;">${key}</p>
            <p style="font-size: 12px; opacity: 0.4; margin: 12px 0 0;">Expire le ${expiryText}</p>
          </div>
          
          <a href="${activationUrl}" style="display: block; background: #3b82f6; color: #ffffff; text-decoration: none; text-align: center; padding: 16px 32px; border-radius: 8px; font-weight: 600; font-size: 16px; margin: 0 0 32px;">
            Activer mon Revenue OS →
          </a>
          
          <p style="font-size: 13px; opacity: 0.5; line-height: 1.6;">
            Si vous ne pouvez pas cliquer sur le bouton, copiez ce lien dans votre navigateur :<br/>
            <span style="font-family: monospace; font-size: 11px;">${activationUrl}</span>
          </p>
          
          <hr style="border: none; border-top: 1px solid #334155; margin: 32px 0;" />
          
          <p style="font-size: 12px; opacity: 0.3;">
            Revenue OS · Pour toute question, répondez directement à cet email.
          </p>
        </div>
      `
    })
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Resend error: ${response.status} ${error}`)
  }
}
