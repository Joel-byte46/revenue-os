// ============================================================
// REVENUE OS — PROMPTS AGENT PIPELINE STAGNATION
// Tous les prompts utilisés par agent-pipeline.
//
// STRUCTURE DE CHAQUE PROMPT :
// - system : règles + contexte injectés au runtime
// - user   : fonction qui prend les données et retourne le prompt
// - schema : le JSON attendu en sortie (documentation + validation)
// - example: exemple de bonne réponse (few-shot learning)
// ============================================================

import {
  buildPipelineSystemPrompt,
  buildFinancialSystemPrompt
} from './system.rules.ts'
import { buildProductContext } from './shared.context.ts'
import type { StagnantDeal, RAGContext } from '../types.ts'

// ------------------------------------------------------------
// PROMPT 1 : ANALYZE_STUCK_DEAL
// Analyse un deal bloqué et génère une action de déblocage.
// Appelé une fois par deal détecté comme bloqué.
// ------------------------------------------------------------

export const ANALYZE_STUCK_DEAL = {

  system: buildPipelineSystemPrompt(),

  user: (params: {
    deal: StagnantDeal
    ragContext: RAGContext
    tenantVertical: 'saas' | 'ecom'
  }): string => {
    const { deal, ragContext } = params

    return `
${ragContext.formattedContext}

=== DEAL À ANALYSER ===

Identifiant interne : ${deal.id}
Titre du deal : ${deal.title ?? 'Non renseigné'}
Entreprise : ${deal.company_name ?? 'Non renseignée'}
Montant : ${deal.amount}€
Étape actuelle : ${deal.stage} (valeur CRM originale : "${deal.stage_raw ?? 'N/A'}")
Jours sans activité : ${deal.days_stagnant}
Email du contact : ${deal.contact_email ?? 'Non disponible'}
Nom du contact : ${deal.contact_name ?? 'Non renseigné'}
Responsable du deal : ${deal.owner_name ?? 'Non renseigné'}

Dernières notes CRM :
${deal.notes
  ? `"${deal.notes.slice(0, 500)}"`
  : 'Aucune note disponible dans le CRM.'}

Données brutes CRM (propriétés supplémentaires) :
${deal.raw_data
  ? JSON.stringify(deal.raw_data, null, 2).slice(0, 800)
  : 'Aucune donnée supplémentaire.'}

=== MISSION ===

Analyse ce deal bloqué et génère une recommandation de déblocage.
Produis UNIQUEMENT le JSON suivant, sans texte avant ou après :

{
  "blocking_reason": "Raison probable du blocage en 1 phrase (15 mots max). Basée sur les données disponibles.",
  "confidence": 75,
  "reasoning": "Explication de 2-3 phrases de ton diagnostic. Cite les éléments des notes CRM si disponibles.",
  "action": {
    "type": "email",
    "subject": "Sujet de l'email (max 8 mots)",
    "body": "Corps de l'email (max 80 mots). Doit sembler écrit par un humain. Jamais mentionner le nombre de jours sans réponse. Toujours apporter une valeur ou poser une question pertinente. Une seule demande d'action.",
    "why_this_works": "En 1 phrase : pourquoi cet angle est adapté à CE deal spécifique."
  },
  "urgency": "high",
  "estimated_impact": "Ce qui pourrait se débloquer si cette action fonctionne (1 phrase, chiffrée si possible).",
  "alternative_action": {
    "type": "call",
    "description": "Si l'email ne fonctionne pas dans 5 jours, faire ceci (1 phrase)."
  }
}

Valeurs possibles pour "urgency" : "critical" | "high" | "medium"
Valeurs possibles pour "confidence" : entier entre 30 et 95
Valeurs possibles pour "action.type" : "email" | "call" | "linkedin"
`.trim()
  },

  // Exemple de bonne réponse (injecté dans le few-shot si nécessaire)
  example: {
    blocking_reason: "Décideur en attente d'approbation budgétaire Q2",
    confidence: 78,
    reasoning: "La note CRM du 15 mars mentionne 'en attente validation CFO'. Le deal est en proposal_sent depuis 19 jours. Ce pattern correspond à un cycle budgétaire interne, pas à un désintérêt.",
    action: {
      type: "email",
      subject: "Une option pour démarrer sans attendre le Q2",
      body: "Bonjour Marie,\n\nEn attendant la validation Q2, certains de nos clients démarrent avec un pilot limité à 2 modules — ce qui leur permet d'avoir des résultats à montrer au CFO avant le vote final.\n\nCela pourrait être une option pour vous ?\n\nThomas",
      why_this_works: "Propose une voie de contournement du blocage budgétaire sans mettre la pression sur la décision principale."
    },
    urgency: "high",
    estimated_impact: "Si le pilot démarre, le deal full passera probablement en Q2 pour 8 500€.",
    alternative_action: {
      type: "call",
      description: "Si pas de réponse d'ici vendredi, appeler Marie pour comprendre où en est la validation CFO."
    }
  }
}

// ------------------------------------------------------------
// PROMPT 2 : PIPELINE_BATCH_SUMMARY
// Résumé exécutif du pipeline pour le brief hebdomadaire.
// Appelé une fois par cycle par A6 (Brief Agent).
// ------------------------------------------------------------

export const PIPELINE_BATCH_SUMMARY = {

  system: buildFinancialSystemPrompt(),

  user: (params: {
    totalDeals: number
    totalValue: number
    stagnantCount: number
    stagnantValue: number
    criticalCount: number
    monthlyForecast: number
    dealsClosedThisWeek: number
    revenueThisWeek: number
    vsLastWeek: {
      stagnantChange: number
      valueChange: number
    }
  }): string => {
    const p = params

    return `
=== DONNÉES PIPELINE DE LA SEMAINE ===

Pipeline actif :
- Total deals : ${p.totalDeals}
- Valeur totale : ${p.totalValue}€
- Deals bloqués : ${p.stagnantCount} (${p.stagnantValue}€ à risque)
- Deals critiques (>30j) : ${p.criticalCount}
- Forecast mensuel pondéré : ${p.monthlyForecast}€

Cette semaine :
- Deals closés : ${p.dealsClosedThisWeek}
- Revenus encaissés : ${p.revenueThisWeek}€

Évolution vs semaine précédente :
- Deals bloqués : ${p.vsLastWeek.stagnantChange > 0 ? '+' : ''}${p.vsLastWeek.stagnantChange}
- Valeur pipeline : ${p.vsLastWeek.valueChange > 0 ? '+' : ''}${p.vsLastWeek.valueChange}€

=== MISSION ===

Rédige un résumé exécutif du pipeline pour un fondateur.
Maximum 80 mots. 2-3 phrases.
Commence directement par le fait le plus important.
Ne pas commencer par "Cette semaine" ou "Le pipeline".

Produis UNIQUEMENT ce JSON :

{
  "narrative": "Ton résumé en 2-3 phrases.",
  "health_status": "green",
  "key_insight": "Le point le plus important en 1 phrase courte.",
  "recommended_focus": "Sur quoi le founder devrait concentrer son attention pipeline cette semaine (1 phrase)."
}

Valeurs pour "health_status" : "green" | "yellow" | "red"
Green = < 20% des deals bloqués
Yellow = 20-40% des deals bloqués
Red = > 40% des deals bloqués OU forecast < 50% de l'objectif mensuel
`.trim()
  }
}

// ------------------------------------------------------------
// PROMPT 3 : REENGAGEMENT_BATCH
// Pour les relances de leads dormants groupées par pattern.
// Génère un template de groupe personnalisable.
// ------------------------------------------------------------

export const REENGAGEMENT_BATCH = {

  system: buildPipelineSystemPrompt(),

  user: (params: {
    blockingPattern: 'timing' | 'budget' | 'ghost' | 'competitor'
    leadsCount: number
    sampleLeads: Array<{
      first_name: string
      company: string
      industry: string
      amount: number
      days_silent: number
    }>
    ragContext: RAGContext
    tenantVertical: 'saas' | 'ecom'
  }): string => {
    const { blockingPattern, leadsCount, sampleLeads, ragContext } = params

    const patternDescriptions = {
      timing: "Ces leads ont signalé un mauvais timing (mentions de 'rappelle-moi', 'Q3', 'après les vacances', etc.)",
      budget: "Ces leads semblaient intéressés mais n'ont jamais confirmé leur budget",
      ghost: "Ces leads ont simplement disparu sans raison apparente après un intérêt initial",
      competitor: "Ces leads évaluaient des concurrents lors de notre dernier contact"
    }

    const angleDescriptions = {
      timing: "Référencer le temps passé et apporter un nouvel insight ou cas client pertinent",
      budget: "Proposer une option d'entrée plus accessible ou un essai limité",
      ghost: "Email très court, direct, qui rend facile la réponse (même négative)",
      competitor: "Mettre en avant un élément différenciateur spécifique à leur situation"
    }

    return `
${ragContext.formattedContext}

=== CONTEXTE DU BATCH DE RELANCE ===

Pattern de blocage : ${blockingPattern}
Description : ${patternDescriptions[blockingPattern]}
Angle recommandé : ${angleDescriptions[blockingPattern]}
Nombre de leads dans ce groupe : ${leadsCount}

Exemples de leads dans ce groupe :
${sampleLeads.slice(0, 5).map(l =>
  `- ${l.first_name} chez ${l.company} (${l.industry}), deal ~${l.amount}€, silencieux depuis ${l.days_silent}j`
).join('\n')}

=== MISSION ===

Génère UN template d'email pour ce groupe.
Utilise [PRENOM] et [ENTREPRISE] comme variables de personnalisation.
L'email doit fonctionner pour tous les leads du groupe, pas seulement les exemples.

Produis UNIQUEMENT ce JSON :

{
  "subject": "Sujet de l'email (max 8 mots, peut contenir [PRENOM] si pertinent)",
  "body": "Corps de l'email (max 75 mots). Utilise [PRENOM] et [ENTREPRISE] aux endroits appropriés.",
  "personalization_hint": "Ce que le commercial devrait vérifier/adapter pour chaque lead avant envoi (1 phrase).",
  "pattern_angle": "${blockingPattern}",
  "reasoning": "En 1-2 phrases : pourquoi cet angle est adapté à ce pattern de blocage spécifique."
}
`.trim()
  }
}

// ------------------------------------------------------------
// PROMPT 4 : FORECAST_NARRATIVE
// Transforme les chiffres de forecast en narration.
// Appelé par A6 (Brief Agent).
// ------------------------------------------------------------

export const FORECAST_NARRATIVE = {

  system: buildFinancialSystemPrompt(),

  user: (params: {
    monthlyForecast: number
    quarterlyForecast: number
    confidenceRange: { low: number; high: number }
    topDeals: Array<{
      title: string
      amount: number
      close_probability: number
      expected_close: string | null
    }>
    dealsAtRisk: number
    totalWeightedPipeline: number
  }): string => {
    const p = params

    return `
=== DONNÉES DE FORECAST ===

Forecast mensuel (30j) : ${p.monthlyForecast}€
Forecast trimestriel : ${p.quarterlyForecast}€
Fourchette de confiance : ${p.confidenceRange.low}€ — ${p.confidenceRange.high}€
Pipeline pondéré total : ${p.totalWeightedPipeline}€
Deals à risque (bloqués) : ${p.dealsAtRisk}

Top deals attendus ce mois :
${p.topDeals.slice(0, 3).map(d =>
  `- "${d.title}" : ${d.amount}€ (prob. ${d.close_probability}%${d.expected_close ? `, close prévu ${d.expected_close}` : ''})`
).join('\n')}

=== MISSION ===

Transforme ces données de forecast en 2 phrases maximum.
Commencer par le chiffre le plus important.
Mentionner la fourchette de confiance seulement si elle est large (> 30% d'écart).
Ne pas lister les deals individuels dans le narratif.

Produis UNIQUEMENT ce JSON :

{
  "narrative": "2 phrases maximum sur le forecast.",
  "confidence_level": "high",
  "main_risk": "Le principal risque sur ce forecast en 1 phrase.",
  "main_opportunity": "La principale opportunité en 1 phrase."
}

Valeurs pour "confidence_level" : "high" | "medium" | "low"
High = fourchette < 20% d'écart
Medium = fourchette 20-40%
Low = fourchette > 40% ou trop peu de deals pour être fiable
`.trim()
  }
}
