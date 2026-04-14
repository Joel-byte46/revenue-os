// ============================================================
// REVENUE OS — PROMPTS AGENT LEADS
// Tous les prompts utilisés par agent-leads.
//
// AGENTS COUVERTS :
// - Scoring et explication du score
// - Email initial (premier contact)
// - Follow-up J+4 (relance avec nouvelle valeur)
// - Break-up J+9 (dernier email)
// - Ré-engagement leads dormants (batch)
// - Qualification post-réponse
// ============================================================

import {
  buildEmailSystemPrompt,
  buildSystemPrompt,
  SYSTEM_RULES
} from './system.rules.ts'
import { buildProductContext } from './shared.context.ts'
import type { Lead, RAGContext } from '../types.ts'

// ------------------------------------------------------------
// PROMPT 1 : SCORE_EXPLAIN
// Explique pourquoi un lead a ce score.
// Courte. Factuelle. Appelée après le scoring SQL.
// ------------------------------------------------------------

export const SCORE_EXPLAIN = {

  system: buildSystemPrompt(),

  user: (params: {
    lead: Lead
    fitScore: number
    intentScore: number
    timingScore: number
    totalScore: number
    scoringDetails: {
      company_size_match: boolean
      industry_match: boolean
      pricing_page_visits: number
      demo_watched: boolean
      trial_started: boolean
      timing_declared: string | null
    }
  }): string => {
    const { lead, scoringDetails: sd } = params

    return `
=== LEAD À SCORER ===

Prénom : ${lead.first_name ?? 'Inconnu'}
Entreprise : ${lead.company ?? 'Inconnue'}
Industrie : ${lead.industry ?? 'Non renseignée'}
Taille entreprise : ${lead.company_size ?? 'Non renseignée'}

Scores calculés (par le système, ne pas modifier) :
- Fit score : ${params.fitScore}/40
- Intent score : ${params.intentScore}/40
- Timing score : ${params.timingScore}/20
- Total : ${params.totalScore}/100

Détails du scoring :
- Taille entreprise correspond à l'ICP : ${sd.company_size_match ? 'Oui' : 'Non'}
- Industrie correspond à l'ICP : ${sd.industry_match ? 'Oui' : 'Non'}
- Visites page pricing : ${sd.pricing_page_visits}
- A regardé la démo : ${sd.demo_watched ? 'Oui' : 'Non'}
- A démarré un trial : ${sd.trial_started ? 'Oui' : 'Non'}
- Timing déclaré : ${sd.timing_declared ?? 'Non précisé'}

=== MISSION ===

En UNE phrase (20 mots max), explique pourquoi ce lead
mérite ou non une attention immédiate.
Commence par le facteur le plus déterminant.

Puis donne la recommandation d'action.

Produis UNIQUEMENT ce JSON :

{
  "explanation": "Une phrase sur pourquoi ce score reflète le potentiel de ce lead.",
  "recommended_action": "immediate_sequence",
  "action_reasoning": "Pourquoi cette action spécifiquement (1 phrase).",
  "priority_signals": ["signal1", "signal2"],
  "risk_signals": ["risque1"]
}

Valeurs pour "recommended_action" :
- "immediate_sequence" : score >= 80, contacter dans les 24h
- "standard_sequence" : score 60-79, contacter dans les 48h
- "nurture" : score 40-59, séquence longue basse fréquence
- "no_action" : score < 40, ne pas contacter maintenant

"priority_signals" : liste des 1-3 signaux positifs les plus forts
"risk_signals" : liste des 0-2 signaux négatifs ou manquants
`.trim()
  }
}

// ------------------------------------------------------------
// PROMPT 2 : INITIAL_EMAIL
// Premier email de contact.
// Le plus important. Définit la relation.
// ------------------------------------------------------------

export const INITIAL_EMAIL = {

  system: buildEmailSystemPrompt(),

  user: (params: {
    lead: Lead
    ragContext: RAGContext
    productContext: string
    tenantVertical: 'saas' | 'ecom'
    senderName: string
    senderTitle?: string
  }): string => {
    const { lead, ragContext, productContext, senderName, senderTitle } = params

    const behaviorSummary: string[] = []
    if (lead.behavior_data) {
      const b = lead.behavior_data
      if (b.pricing_page_visits && Number(b.pricing_page_visits) > 0) {
        behaviorSummary.push(
          `A visité la page pricing ${b.pricing_page_visits} fois`
        )
      }
      if (b.demo_watched) behaviorSummary.push('A regardé la vidéo démo')
      if (b.trial_started) behaviorSummary.push('A démarré un trial')
      if (b.docs_visited) behaviorSummary.push('A consulté la documentation')
      if (b.webinar_attended) behaviorSummary.push('A participé à un webinar')
    }

    return `
${ragContext.formattedContext}

${productContext}

=== PROFIL DU LEAD ===

Prénom : ${lead.first_name ?? 'Non disponible'}
Nom : ${lead.last_name ?? ''}
Entreprise : ${lead.company ?? 'Non disponible'}
Industrie : ${lead.industry ?? 'Non renseignée'}
Taille entreprise : ${lead.company_size ?? 'Non renseignée'}
Titre / Poste : ${lead.form_data?.job_title ?? 'Non renseigné'}
LinkedIn : ${lead.linkedin_url ?? 'Non disponible'}

Score de lead : ${lead.total_score}/100
- Fit : ${lead.fit_score}/40
- Intent : ${lead.intent_score}/40
- Timing : ${lead.timing_score}/20

Comportement sur le site :
${behaviorSummary.length > 0
  ? behaviorSummary.map(b => `- ${b}`).join('\n')
  : '- Aucun signal comportemental enregistré'}

Données du formulaire :
${lead.form_data
  ? JSON.stringify(lead.form_data, null, 2).slice(0, 400)
  : 'Aucune donnée formulaire'}

Source d'acquisition : ${lead.utm_source ?? 'Directe'} / ${lead.utm_campaign ?? 'N/A'}

Expéditeur de l'email :
- Prénom : ${senderName}
${senderTitle ? `- Titre : ${senderTitle}` : ''}

=== MISSION ===

Rédige le premier email de contact pour ce lead.

CONTRAINTES ABSOLUES :
→ Corps : maximum 80 mots
→ Sujet : maximum 8 mots
→ Ton : peer-to-peer, comme si tu écrivais à quelqu'un de ton réseau
→ UNE seule demande d'action (pas "appelle-moi OU réponds OU visite le site")
→ L'email doit sembler écrit par un humain, pas par un système
→ Si le prénom du lead n'est pas disponible, ne pas utiliser de formule d'appel
→ Signer avec le prénom de l'expéditeur uniquement (pas de signature complète)
→ Ne JAMAIS mentionner que le lead a visité le site ou la page pricing
  (ça donne une impression de surveillance)

ANGLE À UTILISER (choisir le plus pertinent selon le profil) :
→ Question ouverte sur un challenge spécifique à leur industrie
→ Insight ou stat récente pertinente pour leur secteur
→ Cas client dans leur industrie (si disponible dans le contexte RAG)
→ Observation sur leur business (uniquement si info publique disponible)

Produis UNIQUEMENT ce JSON :

{
  "subject": "Sujet de l'email",
  "body": "Corps complet de l'email incluant la signature",
  "angle_used": "L'angle choisi parmi les options ci-dessus",
  "personalization_elements": ["élément1", "élément2"],
  "cta": "La demande d'action exacte formulée dans l'email",
  "reasoning": "En 1 phrase : pourquoi cet angle pour ce lead spécifiquement."
}
`.trim()
  },

  example: {
    subject: "SaaS à 50 employés : votre RevOps",
    body: `Martin,

La plupart des SaaS B2B à votre stade perdent 15-20% de leur pipeline faute de suivi systématique — pas par manque de volonté, mais parce que personne n'a le temps de surveiller 200 deals simultanément.

On a résolu ça pour Luko et Pennylane avec un système qui tourne en autonomie.

15 minutes cette semaine pour voir si c'est pertinent pour Acme ?

Thomas`,
    angle_used: "Insight industrie + référence clients",
    personalization_elements: ["Taille entreprise 50 employés", "SaaS B2B"],
    cta: "15 minutes cette semaine",
    reasoning: "Le lead a un intent score élevé (visite pricing) mais pas de timing déclaré. L'angle 'coût d'opportunité' crée une urgence sans pression."
  }
}

// ------------------------------------------------------------
// PROMPT 3 : FOLLOWUP_EMAIL_DAY4
// Relance J+4. Pas de réponse à l'email 1.
// Nouvelle valeur obligatoire. Pas "juste pour suivre".
// ------------------------------------------------------------

export const FOLLOWUP_EMAIL_DAY4 = {

  system: buildEmailSystemPrompt(),

  user: (params: {
    lead: Lead
    email1Subject: string
    email1Body: string
    ragContext: RAGContext
    newValueToAdd: 'case_study' | 'stat' | 'question' | 'insight' | 'offer'
    senderName: string
    daysSinceEmail1: number
  }): string => {
    const { lead, email1Subject, email1Body, ragContext, newValueToAdd, senderName: _senderName } = params
    
    const newValueDescriptions = {
      case_study: "Un cas client concret dans leur industrie (résultat chiffré)",
      stat: "Une statistique récente et contre-intuitive sur leur secteur",
      question: "Une question ouverte sur leur priorité actuelle (sans mentionner le premier email)",
      insight: "Un insight opérationnel qu'ils peuvent utiliser immédiatement, même sans nous",
      offer: "Une proposition d'entrée différente (pilot, audit gratuit, accès limité)"
    }

    return `
${ragContext.formattedContext}

=== CONTEXTE DU PREMIER EMAIL ===

Sujet email 1 : "${email1Subject}"
Corps email 1 :
"${email1Body}"

Jours depuis l'envoi : ${params.daysSinceEmail1}
Résultat : Pas de réponse

=== PROFIL DU LEAD ===

Prénom : ${lead.first_name ?? 'Non disponible'}
Entreprise : ${lead.company ?? 'Non disponible'}
Industrie : ${lead.industry ?? 'Non renseignée'}
Score total : ${lead.total_score}/100

=== TYPE DE NOUVELLE VALEUR À APPORTER ===

Type choisi par le système : ${newValueToAdd}
Description : ${newValueDescriptions[newValueToAdd]}

=== MISSION ===

Rédige l'email de relance J+4.

RÈGLES STRICTES :
→ Corps : maximum 70 mots (plus court que l'email 1)
→ Ne JAMAIS commencer par "Je reviens vers vous"
→ Ne JAMAIS mentionner que tu n'as pas eu de réponse
→ Apporter une NOUVELLE valeur — pas reformuler l'email 1
→ L'email doit pouvoir se lire sans avoir lu l'email 1
→ Même CTA bas-friction que l'email 1 (15 min, pas "une démo complète")
→ Signer avec le prénom uniquement

Produis UNIQUEMENT ce JSON :

{
  "subject": "Sujet (différent de l'email 1, max 8 mots)",
  "body": "Corps complet incluant signature",
  "new_value_delivered": "En 1 phrase : quelle nouvelle valeur est apportée",
  "differentiation_from_email1": "En 1 phrase : en quoi cet email est différent du premier",
  "reasoning": "Pourquoi ce type de valeur pour ce lead maintenant."
}
`.trim()
  },

  example: {
    subject: "Ce que font les SaaS qui gardent leur pipeline sain",
    body: `Martin,

Les équipes SaaS qui maintiennent un taux de deals bloqués < 15% ont une chose en commun : un processus de détection automatique, pas une réunion pipeline hebdomadaire.

On a publié une analyse de 50 pipelines SaaS cette semaine — je peux vous l'envoyer si c'est utile.

Thomas`,
    new_value_delivered: "Stat et insight opérationnel sur la gestion de pipeline SaaS",
    differentiation_from_email1: "L'email 1 parlait du problème, celui-ci apporte une ressource concrète",
    reasoning: "Après 4 jours sans réponse, apporter de la valeur gratuite réduit la friction et repositionne comme expert, pas comme vendeur."
  }
}

// ------------------------------------------------------------
// PROMPT 4 : BREAKUP_EMAIL_DAY9
// Dernier email. J+9.
// Objectif : déclencher une réponse (même négative)
// ou fermer proprement la relation.
// ------------------------------------------------------------

export const BREAKUP_EMAIL_DAY9 = {

  system: buildEmailSystemPrompt(),

  user: (params: {
    lead: Lead
    email1Subject: string
    email2Subject: string
    senderName: string
    daysTotal: number
    probableReason: 'timing' | 'budget' | 'no_need' | 'competitor' | 'unknown'
  }): string => {
    const { lead, email1Subject, email2Subject, senderName: _senderName, daysTotal, probableReason } = params
    
    const toneByReason = {
      timing: "Proposer de revenir à une date précise et fermer pour l'instant",
      budget: "Proposer une option d'entrée minimale ou de revenir quand le budget est disponible",
      no_need: "Accepter que ce n'est pas le bon moment, laisser la porte ouverte",
      competitor: "Souhaiter bonne chance et proposer un feedback honnête",
      unknown: "Email de rupture classique, court, direct, sans amertume"
    }

    return `
=== CONTEXTE DE LA SÉQUENCE ===

Lead : ${lead.first_name ?? 'Contact'} chez ${lead.company ?? 'l\'entreprise'}
Industrie : ${lead.industry ?? 'Non renseignée'}
Score : ${lead.total_score}/100

Email 1 : "${email1Subject}"
Email 2 : "${email2Subject}"
Jours depuis le début : ${daysTotal}
Raison probable du silence : ${probableReason}

Ton recommandé : ${toneByReason[probableReason]}

=== MISSION ===

Rédige le dernier email de la séquence.

RÈGLES ABSOLUES :
→ Corps : maximum 50 mots (le plus court des trois)
→ Ton : mature, sans rancune, respectueux
→ Objectif double : soit déclencher une réponse, soit fermer proprement
→ Ne JAMAIS être passif-agressif ("je suppose que vous êtes occupé...")
→ Ne JAMAIS mentionner le nombre d'emails envoyés
→ Laisser une porte ouverte sans mendier une réponse
→ Pas de pression. Pas d'urgence artificielle.
→ Signer avec le prénom uniquement

Produis UNIQUEMENT ce JSON :

{
  "subject": "Sujet (max 6 mots)",
  "body": "Corps complet (max 50 mots) incluant signature",
  "closing_tone": "respectful_close",
  "door_left_open": true,
  "reasoning": "Pourquoi cette approche pour ce profil et cette raison de silence."
}

Valeurs pour "closing_tone" :
"respectful_close" | "future_timing" | "honest_check" | "value_gift"
`.trim()
  },

  example: {
    subject: "Clôture de mon côté",
    body: `Martin,

Je ferme ce dossier pour l'instant pour ne pas encombrer votre boîte.

Si la priorité pipeline revient sur la table dans 3-6 mois, je serai là.

Bonne suite,
Thomas`,
    closing_tone: "respectful_close",
    door_left_open: true,
    reasoning: "Le silence de 9 jours sur un lead score 75 suggère un timing mauvais plutôt qu'un désintérêt. Fermer proprement maximise les chances d'une réouverture future."
  }
}

// ------------------------------------------------------------
// PROMPT 5 : REENGAGEMENT_DORMANT
// Pour les leads qui ont eu un intérêt il y a 30-180 jours
// et n'ont jamais avancé. Batch mensuel.
// ------------------------------------------------------------

export const REENGAGEMENT_DORMANT = {

  system: buildEmailSystemPrompt(),

  user: (params: {
    lead: Lead & { days_silent: number }
    ragContext: RAGContext
    triggerReason: 'score_high' | 'company_news' | 'industry_event' | 'product_update' | 'seasonal'
    triggerDetail: string | null
    senderName: string
  }): string => {
    const { lead, ragContext, triggerReason, triggerDetail, senderName: _senderName } = params
    
    const triggerFraming = {
      score_high: "Ce lead avait un score élevé mais n'a jamais avancé. Réengagement basé sur le potentiel.",
      company_news: `Nouvelle détectée sur l'entreprise : ${triggerDetail ?? 'changement récent'}`,
      industry_event: `Événement industrie pertinent : ${triggerDetail ?? 'actualité sectorielle'}`,
      product_update: `Mise à jour produit pertinente pour ce profil : ${triggerDetail ?? 'nouvelle fonctionnalité'}`,
      seasonal: `Timing saisonnier pertinent : ${triggerDetail ?? 'début de période stratégique'}`
    }

    return `
${ragContext.formattedContext}

=== LEAD DORMANT À RÉENGAGER ===

Prénom : ${lead.first_name ?? 'Non disponible'}
Entreprise : ${lead.company ?? 'Non disponible'}
Industrie : ${lead.industry ?? 'Non renseignée'}
Taille : ${lead.company_size ?? 'Non renseignée'}
Score original : ${lead.total_score}/100
Jours de silence : ${lead.days_silent}

Raison du réengagement : ${triggerReason}
Contexte : ${triggerFraming[triggerReason]}

=== MISSION ===

Rédige un email de réengagement pour ce lead dormant.

CONTRAINTES SPÉCIALES RÉENGAGEMENT :
→ Corps : maximum 65 mots
→ NE PAS faire référence au silence ou au temps écoulé
   ("je n'ai pas eu de vos nouvelles depuis X mois" → INTERDIT)
→ Traiter comme un premier contact, mais avec un contexte plus riche
→ L'accroche doit être liée à la raison du réengagement
   (la news, l'événement, la mise à jour) — pas à notre produit
→ Notre produit est mentionné seulement si c'est naturel
→ CTA minimal : une question ouverte suffit

Produis UNIQUEMENT ce JSON :

{
  "subject": "Sujet (max 8 mots, idéalement lié à leur actualité)",
  "body": "Corps complet incluant signature",
  "trigger_used": "${triggerReason}",
  "natural_connection": "Comment tu relies leur actualité à notre valeur (1 phrase)",
  "reasoning": "Pourquoi ce lead vaut la peine d'être réengagé maintenant."
}
`.trim()
  }
}

// ------------------------------------------------------------
// PROMPT 6 : QUALIFICATION_POST_REPLY
// Quand un lead répond à un email de séquence.
// Analyse la réponse et recommande l'étape suivante.
// ------------------------------------------------------------

export const QUALIFICATION_POST_REPLY = {

  system: buildSystemPrompt(),

  user: (params: {
    lead: Lead
    emailSent: string
    replyReceived: string
    replyDate: string
  }): string => {
    const { lead, emailSent, replyReceived } = params

    return `
=== CONTEXTE ===

Lead : ${lead.first_name ?? 'Contact'} chez ${lead.company ?? 'l\'entreprise'}
Score : ${lead.total_score}/100
Industrie : ${lead.industry ?? 'Non renseignée'}

Email envoyé :
"${emailSent.slice(0, 300)}"

Réponse reçue :
"${replyReceived.slice(0, 500)}"

=== MISSION ===

Analyse la réponse et détermine la qualification du lead
et l'action immédiate recommandée.

Produis UNIQUEMENT ce JSON :

{
  "sentiment": "positive",
  "intent_level": "high",
  "qualification_update": "qualified",
  "key_signals": ["signal extrait de la réponse"],
  "objections_detected": ["objection si présente"],
  "recommended_next_action": {
    "type": "book_call",
    "urgency": "within_24h",
    "suggested_message": "Suggestion de réponse courte (max 40 mots)"
  },
  "reasoning": "Analyse de la réponse en 1-2 phrases."
}

Valeurs pour "sentiment" : "positive" | "neutral" | "negative" | "question"
Valeurs pour "intent_level" : "high" | "medium" | "low" | "none"
Valeurs pour "qualification_update" :
  "qualified" | "nurture" | "disqualified" | "needs_more_info"
Valeurs pour "type" :
  "book_call" | "send_info" | "answer_question" | "close" | "archive"
Valeurs pour "urgency" :
  "within_24h" | "within_48h" | "this_week" | "no_urgency"
`.trim()
  }
}
