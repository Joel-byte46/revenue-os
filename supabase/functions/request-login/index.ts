// ============================================================
// REVENUE OS — REQUEST LOGIN (PRODUCTION SAFE)
// Envoie un magic link sans révéler si l'email existe.
//
// POST { email: "user@example.com" }
// Toujours retourne success.
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
    return jsonSuccess()
  }

  try {
    const body = await req.json().catch(() => null)
    const email = body?.email?.toLowerCase()?.trim()

    if (email && typeof email === 'string' && email.includes('@')) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      // generateLink ne révèle pas si l'user n'existe pas
      // Supabase gère ça proprement en interne
      await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: {
          redirectTo: `${Deno.env.get('APP_URL') ?? ''}/dashboard`
        }
      }).catch(() => {
        // On ignore volontairement toute erreur
      })
    }

    return jsonSuccess()

  } catch (error) {
    console.error('[request-login] Unexpected error:', error)
    return jsonSuccess()
  }
})

function jsonSuccess() {
  return new Response(
    JSON.stringify({
      success: true,
      message: 'Si un compte existe avec cet email, un lien de connexion a été envoyé.'
    }),
    {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json'
      }
    }
  )
}
