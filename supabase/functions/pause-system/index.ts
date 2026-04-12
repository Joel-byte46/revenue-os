// ============================================================
// REVENUE OS — PAUSE / RESUME SYSTEM
// Control Panel : met en pause ou réactive tous les agents.
//
// POST { tenant_id, paused: bool, paused_until?: string }
// Response: { success, system_paused, paused_until }
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const EDGE_BASE = `${SUPABASE_URL}/functions/v1`

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  try {
    const body = await req.json()
    const { tenant_id, paused, paused_until } = body as {
      tenant_id: string
      paused: boolean
      paused_until?: string
    }

    if (!tenant_id || typeof paused !== 'boolean') {
      return new Response(
        JSON.stringify({ error: 'tenant_id and paused (boolean) required' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // --------------------------------------------------------
    // Mettre à jour le statut pause
    // --------------------------------------------------------
    await supabase
      .from('tenants')
      .update({
        system_paused: paused,
        paused_until: paused ? (paused_until ?? null) : null
      })
      .eq('id', tenant_id)

    // --------------------------------------------------------
    // Créer le system_event correspondant
    // --------------------------------------------------------
    if (paused) {
      const pauseMessage = paused_until
        ? `Système mis en pause jusqu'au ${new Date(paused_until).toLocaleDateString('fr-FR')}.`
        : `Système mis en pause. Aucun agent ne tournera jusqu'à la réactivation.`

      await supabase
        .from('system_events')
        .insert({
          tenant_id,
          event_type: 'system_paused',
          title: '💤 Système en pause',
          body: pauseMessage,
          severity: 'info',
          metadata: { paused_until: paused_until ?? null }
        })
    } else {
      await supabase
        .from('system_events')
        .insert({
          tenant_id,
          event_type: 'system_resumed',
          title: '⚡ Système réactivé',
          body: 'Les agents reprennent leur surveillance.',
          severity: 'success',
          metadata: {}
        })

      // Lancer un run immédiat pour rattraper le retard
      fetch(`${EDGE_BASE}/orchestrator`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
        },
        body: JSON.stringify({
          mode: 'full',
          tenant_id,
          triggered_by: 'resume'
        })
      }).catch(err => {
        console.error('[pause-system] Resume run failed:', err)
      })
    }

    return new Response(
      JSON.stringify({
        success: true,
        system_paused: paused,
        paused_until: paused ? (paused_until ?? null) : null
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[pause-system] Error:', message)

    return new Response(
      JSON.stringify({ error: 'Erreur lors du changement de statut.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})
