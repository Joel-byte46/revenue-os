// ============================================================
// REVENUE OS — PROMPTS AGENT FEEDBACK
// Prompts utilisés par agent-feedback.
//
// CET AGENT EST DIFFÉRENT DES AUTRES :
// Il analyse la performance du système lui-même.
// Il ne génère pas de recommandations pour le founder.
// Il génère des suggestions d'amélioration des prompts.
// Ces suggestions sont revues par un humain avant application.
//
// UTILISATION DU LLM ICI : Rare et ciblée.
// 90% du travail de feedback = SQL + code Python.
// Le LLM intervient uniquement pour :
// 1. Identifier les patterns dans les échecs
// 2. Suggérer des reformulations de prompts
// ============================================================

import { buildSystemPrompt, SYSTEM_RULES } from './system.rules.ts'

// ------------------------------------------------------------
// PROMPT 1 : PROMPT_IMPROVEMENT_SUGGESTION
// Analyse les patterns d'échec et suggère des améliorations.
// Appelé une fois par mois par agent-feedback.
// Output : suggestions pour revue humaine, pas application auto.
// ------------------------------------------------------------

export const PROMPT_IMPROVEMENT_SUGGESTION = {

  system: `${SYSTEM_RULES}

Tu es un ingénieur en prompts qui analyse la performance d'un système d'agents IA.
Tu n'es pas le système lui-même — tu l'analyses de l'extérieur.
Tu identifies les patterns d'échec et proposes des améliorations concrètes.
Tes suggestions seront revues par un humain avant toute application.
Tu ne modifies jamais les prompts toi-même — tu proposes uniquement.`,

  user: (params: {
    agentType: string
    periodAnalyzed: string
    successPatterns: Array<{
      context_summary: string
      action_taken: string
      outcome_score: number
      frequency: number
    }>
    failurePatterns: Array<{
      context_summary: string
      action_taken: string
      outcome_score: number
      frequency: number
      probable_failure_reason: string
    }>
    approvalRate: number
    avgOutcomeScore: number
    totalRecommendations: number
    currentPromptExcerpt: string
  }): string => {
    const {
      agentType, periodAnalyzed, successPatterns, failurePatterns,
      approvalRate, avgOutcomeScore, totalRecommendations, currentPromptExcerpt
    } = params

    return `
=== ANALYSE DE PERFORMANCE — AGENT : ${agentType.toUpperCase()} ===

Période analysée : ${periodAnalyzed}
Total recommandations : ${totalRecommendations}
Taux d'approbation par le founder : ${approvalRate.toFixed(1)}%
Score moyen des outcomes (0-100) : ${avgOutcomeScore.toFixed(1)}

=== PATTERNS DE SUCCÈS (outcome_score >= 70) ===

${successPatterns.length > 0
  ? successPatterns.map((p, i) => `
Succès ${i + 1} (fréquence: ${p.frequency}x, score: ${p.outcome_score}) :
- Contexte : ${p.context_summary}
- Action générée : ${p.action_taken}
`).join('')
  : 'Pas encore assez de données de succès.'}

=== PATTERNS D'ÉCHEC (outcome_score < 30 OU rejeté par le founder) ===

${failurePatterns.length > 0
  ? failurePatterns.map((p, i) => `
Échec ${i + 1} (fréquence: ${p.frequency}x, score: ${p.outcome_score}) :
- Contexte : ${p.context_summary}
- Action générée : ${p.action_taken}
- Raison probable d'échec : ${p.probable_failure_reason}
`).join('')
  : 'Pas encore assez de données d\'échec.'}

=== EXTRAIT DU PROMPT ACTUEL ===

${currentPromptExcerpt.slice(0, 600)}

=== MISSION ===

Analyse ces patterns et propose des améliorations concrètes au prompt.

CONTRAINTES :
→ Maximum 3 suggestions d'amélioration
→ Chaque suggestion doit être directement applicable (pas vague)
→ Inclure le "avant / après" pour chaque suggestion
→ Justifier avec les données d'échec ou de succès
→ Ne pas suggérer de changements qui contredisent les RÈGLES SYSTÈME
→ Prioriser les suggestions par impact potentiel

Produis UNIQUEMENT ce JSON :

{
  "performance_assessment": "Évaluation globale en 2 phrases.",
  "main_failure_pattern": "Le pattern d'échec le plus fréquent (1 phrase).",
  "main_success_pattern": "Ce qui fonctionne le mieux (1 phrase).",
  "suggestions": [
    {
      "priority": 1,
      "target_section": "La section du prompt à modifier",
      "current_text": "Texte actuel problématique (extrait court)",
      "suggested_text": "Texte de remplacement proposé",
      "rationale": "Pourquoi ce changement améliorerait les résultats (1-2 phrases).",
      "expected_impact": "Impact attendu sur le taux de succès",
      "risk": "Risque potentiel de ce changement"
    },
    {
      "priority": 2,
      "target_section": "...",
      "current_text": "...",
      "suggested_text": "...",
      "rationale": "...",
      "expected_impact": "...",
      "risk": "..."
    }
  ],
  "data_sufficient": ${totalRecommendations >= 20},
  "minimum_data_note": ${totalRecommendations < 20
    ? '"Pas assez de données pour des suggestions fiables. Revenir quand 20+ recommandations ont été mesurées."'
    : 'null'}
}
`.trim()
  }
}

// ------------------------------------------------------------
// PROMPT 2 : OUTCOME_CLASSIFICATION
// Quand l'outcome est ambigu, le LLM aide à le classifier.
// Ex : un deal a changé de stage mais pour une raison externe.
// Ce prompt est appelé rarement (cas limites uniquement).
// ------------------------------------------------------------

export const OUTCOME_CLASSIFICATION = {

  system: buildSystemPrompt(),

  user: (params: {
    recommendationType: string
    recommendationPayload: Record<string, unknown>
    actionTaken: string
    beforeState: Record<string, unknown>
    afterState: Record<string, unknown>
    daysBetween: number
    ambiguityReason: string
  }): string => {
    const {
      recommendationType, recommendationPayload, actionTaken,
      beforeState, afterState, daysBetween, ambiguityReason
    } = params

    return `
=== CLASSIFICATION D'OUTCOME AMBIGUË ===

Type de recommandation : ${recommendationType}
Action recommandée : ${actionTaken}

État avant (${daysBetween} jours avant) :
${JSON.stringify(beforeState, null, 2)}

État après :
${JSON.stringify(afterState, null, 2)}

Raison de l'ambiguïté :
${ambiguityReason}

Contexte de la recommandation :
${JSON.stringify(recommendationPayload, null, 2).slice(0, 300)}

=== MISSION ===

Détermine si le changement observé est attribuable à la recommandation
ou à un facteur externe.

Produis UNIQUEMENT ce JSON :

{
  "attribution": "partial",
  "outcome_score": 45,
  "reasoning": "Explication de l'attribution en 2 phrases.",
  "confidence": 60,
  "external_factors": ["Facteur externe identifié si applicable"],
  "learning": "Ce que ce cas apprend au système (1 phrase)."
}

Valeurs pour "attribution" :
"full" (le changement est clairement dû à la recommandation),
"partial" (contribution partielle probable),
"none" (changement dû à des facteurs externes),
"unknown" (impossible de déterminer)

"outcome_score" :
- full + positif : 80-100
- partial + positif : 40-70
- none : 10-20
- unknown : null
`.trim()
  }
}
