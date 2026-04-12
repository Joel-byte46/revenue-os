// ============================================================
// REVENUE OS — APPROVE / REJECT RECOMMENDATION
// Action principale du Feed UI.
//
// POST { tenant_id, recommendation_id, action: 'approve' | 'reject' }
// Response: { success, next_recommendation? }
//
// Quand approuvé :
// - Si email draft → crée scheduled_action immédiate
// - Met à jour le status
// - Crée system_event
// - Retourne la prochaine recommandation pending
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type {
  Recommendation,
  PipelinePayload,
  LeadEngagementPayload
} from '../_shared/types.ts'

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
    // Vérifier l'auth de l'utilisateur
    const authHeader = req.headers.get('Authorization') ?? ''
    const userToken = authHeader.replace('Bearer ', '')

    if (!userToken) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    const body = await req.json()
    const { tenant_id, recommendation_id, action } = body as {
      tenant_id: string
      recommendation_id: string
      action: 'approve' | 'reject'
    }

    if (!tenant_id || !recommendation_id || !action) {
      return new Response(
        JSON.stringify({ error: 'tenant_id, recommendation_id and action required' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    if (!['approve', 'reject'].includes(action)) {
      return new Response(
        JSON.stringify({ error: 'action must be approve or reject' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // Client avec token utilisateur pour respecter le RLS
    const supabaseUser = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    // On utilise service_role car on a vérifié le tenant_id

    // --------------------------------------------------------
    // ÉTAPE 1 : Récupérer la recommandation
    // --------------------------------------------------------
    const { data: rec, error: recError } = await supabaseUser
      .from('recommendations')
      .select('*')
      .eq('id', recommendation_id)
      .eq('tenant_id', tenant_id)
      .eq('status', 'pending')
      .single()

    if (recError || !rec) {
      return new Response(
        JSON.stringify({ error: 'Recommendation not found or already processed' }),
        { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    const recommendation = rec as Recommendation

    // --------------------------------------------------------
    // ÉTAPE 2 : Mettre à jour le status
    // --------------------------------------------------------
    const now = new Date().toISOString()
    const updateData = action === 'approve'
      ? { status: 'approved', approved_at: now }
      : { status: 'rejected', rejected_at: now }

    const { error: updateError } = await supabaseUser
      .from('recommendations')
      .update(updateData)
      .eq('id', recommendation_id)
      .eq('tenant_id', tenant_id)

    if (updateError) {
      throw new Error(`Failed to update recommendation: ${updateError.message}`)
    }

    // --------------------------------------------------------
    // ÉTAPE 3 : Si approuvé → créer les actions concrètes
    // --------------------------------------------------------
    if (action === 'approve') {
      await handleApproval(supabaseUser, tenant_id, recommendation)
    }

    // --------------------------------------------------------
    // ÉTAPE 4 : Recalculer le health_status
    // --------------------------------------------------------
    await supabaseUser.rpc('update_health_status', { p_tenant_id: tenant_id })

    // --------------------------------------------------------
    // ÉTAPE 5 : Récupérer la prochaine recommandation pending
    // (pour UX fluide — la carte suivante s'affiche immédiatement)
    // --------------------------------------------------------
    const { data: nextRec } = await supabaseUser
      .from('recommendations')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('status', 'pending')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    return new Response(
      JSON.stringify({
        success: true,
        action,
        recommendation_id,
        next_recommendation: nextRec ?? null
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[approve-recommendation] Error:', message)

    return new Response(
      JSON.stringify({ error: 'Erreur lors du traitement.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})

// ------------------------------------------------------------
// HANDLE APPROVAL
// Crée les actions concrètes selon le type de recommandation.
// ------------------------------------------------------------

async function handleApproval(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  rec: Recommendation
): Promise<void> {
  switch (rec.agent_type) {

    case 'pipeline_stagnation': {
      const payload = rec.payload as PipelinePayload

      if (!payload.action?.subject || !payload.action?.body) break
      if (!payload.contact_email) break

      // Créer l'action d'envoi d'email
      await supabase
        .from('scheduled_actions')
        .insert({
          tenant_id: tenantId,
          action_type: 'send_email',
          scheduled_at: new Date().toISOString(),
          // Immédiat
          payload: {
            to: payload.contact_email,
            subject: payload.action.subject,
            body: payload.action.body,
            deal_id: payload.deal_id,
            recommendation_id: rec.id,
            context: 'pipeline_followup'
          },
          status: 'pending',
          attempts: 0,
          max_attempts: 3
        })

      // Créer system_event "email queued"
      await supabase
        .from('system_events')
        .insert({
          tenant_id: tenantId,
          event_type: 'email_sent',
          title: `Email de relance planifié → ${payload.contact_name ?? payload.contact_email}`,
          body: `Sujet : "${payload.action.subject}"`,
          severity: 'success',
          metadata: {
            recommendation_id: rec.id,
            deal_id: payload.deal_id,
            contact_email: payload.contact_email
          }
        })
      break
    }

    case 'lead_engagement':
    case 'lead_reengagement': {
      const payload = rec.payload as LeadEngagementPayload
      const firstEmail = payload.sequence?.emails?.[0]

      if (!firstEmail || !payload.lead_email) break

      // Email immédiat (J0)
      await supabase
        .from('scheduled_actions')
        .insert({
          tenant_id: tenantId,
          action_type: 'send_email',
          scheduled_at: new Date().toISOString(),
          payload: {
            to: payload.lead_email,
            subject: firstEmail.subject,
            body: firstEmail.body,
            lead_id: payload.lead_id,
            recommendation_id: rec.id,
            sequence_step: 0,
            context: rec.agent_type
          },
          status: 'pending',
          attempts: 0,
          max_attempts: 3
        })

      // Emails de suivi (J+4, J+9) si présents dans la séquence
      const followupEmails = payload.sequence?.emails?.slice(1) ?? []
      for (const email of followupEmails) {
        await supabase
          .from('scheduled_actions')
          .insert({
            tenant_id: tenantId,
            action_type: 'send_email',
            scheduled_at: new Date(
              Date.now() + email.day * 24 * 60 * 60 * 1000
            ).toISOString(),
            payload: {
              to: payload.lead_email,
              subject: email.subject,
              body: email.body,
              lead_id: payload.lead_id,
              recommendation_id: rec.id,
              sequence_step: email.day,
              context: rec.agent_type
            },
            status: 'pending',
            attempts: 0,
            max_attempts: 3
          })
      }

      // Mettre à jour le statut du lead
      await supabase
        .from('leads')
        .update({
          status: 'in_sequence',
          sequence_status: 'active',
          sequence_step: 0,
          updated_at: new Date().toISOString()
        })
        .eq('id', payload.lead_id)
        .eq('tenant_id', tenantId)

      await supabase
        .from('system_events')
        .insert({
          tenant_id: tenantId,
          event_type: 'email_sent',
          title: `Séquence activée → ${payload.lead_name ?? payload.lead_email}`,
          body: `${payload.sequence?.emails?.length ?? 1} email(s) planifié(s).`,
          severity: 'success',
          metadata: {
            recommendation_id: rec.id,
            lead_id: payload.lead_id,
            emails_count: payload.sequence?.emails?.length ?? 1
          }
        })
      break
    }

    case 'ads_waste': {
      // Pour les pubs : on ne peut pas agir directement (read-only)
      // On crée juste un reminder dans le feed
      await supabase
        .from('system_events')
        .insert({
          tenant_id: tenantId,
          event_type: 'campaign_paused',
          title: 'Action pub approuvée — À exécuter dans votre gestionnaire de pubs',
          body: 'Les modifications doivent être appliquées manuellement dans Meta Ads ou Google Ads.',
          severity: 'info',
          metadata: { recommendation_id: rec.id }
        })
      break
    }

    case 'treasury_zombie': {
      // Reminder d'annulation d'abonnement
      await supabase
        .from('system_events')
        .insert({
          tenant_id: tenantId,
          event_type: 'zombie_detected',
          title: 'Annulation approuvée — À confirmer sur le site de l\'abonnement',
          body: 'Rendez-vous sur le site de l\'éditeur pour annuler manuellement.',
          severity: 'info',
          metadata: { recommendation_id: rec.id }
        })
      break
    }

    default:
      // Pour les autres types : juste l'event de statut (déjà géré par le trigger)
      break
  }
}
