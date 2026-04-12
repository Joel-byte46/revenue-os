# ============================================================
# REVENUE OS — CALCULS TRÉSORERIE
# Toute la logique financière déterministe.
#
# PRINCIPES :
# 1. Zéro ambiguïté — un calcul = un résultat
# 2. Tous les edge cases sont gérés explicitement
# 3. Chaque fonction est testable indépendamment
# 4. Les résultats sont arrondis à 2 décimales max
# 5. Jamais de division par zéro non gérée
# ============================================================

import math
from datetime import datetime, date, timedelta
from typing import Optional
import numpy as np
from pydantic import BaseModel, Field, validator

# ------------------------------------------------------------
# MODELS : Requêtes et réponses
# ------------------------------------------------------------

class MonthlyExpense(BaseModel):
    month_label: str
    # Format : 'YYYY-MM'
    total_expense: float
    breakdown: dict[str, float] = {}
    # { "marketing": 5000.0, "payroll": 20000.0, ... }


class MRRTransaction(BaseModel):
    amount: float
    date: str
    merchant: str
    is_recurring: bool


class PipelineData(BaseModel):
    expected_30d_revenue: float = 0.0
    total_weighted_value: float = 0.0


class RunwayRequest(BaseModel):
    tenant_id: str
    current_balance: float
    monthly_expenses: list[MonthlyExpense]
    mrr_transactions: list[MRRTransaction]
    pipeline_data: PipelineData

    @validator('current_balance')
    def balance_must_be_valid(cls, v):
        if v < 0:
            raise ValueError('current_balance cannot be negative')
        return round(v, 2)


class RunwayScenarios(BaseModel):
    pessimistic: float
    # Burn +20%
    realistic: float
    optimistic: float
    # Burn -20%


class RunwayCalculationDetails(BaseModel):
    burn_weights_used: list[float]
    months_analyzed: int
    mrr_method: str
    pipeline_included: bool
    data_quality_issues: list[str]


class RunwayResponse(BaseModel):
    current_balance: float
    monthly_burn_gross: float
    monthly_revenue: float
    monthly_net_burn: float
    runway_months: float
    runway_date: str
    mrr: float
    arr: float
    scenarios: RunwayScenarios
    is_profitable: bool
    data_confidence: str
    # full | partial | insufficient
    calculation_details: RunwayCalculationDetails
    calculated_at: str


class BurnRequest(BaseModel):
    tenant_id: str
    monthly_expenses: list[MonthlyExpense]
    months_to_use: int = 3


class BurnResponse(BaseModel):
    weighted_burn: float
    raw_monthly_burns: list[float]
    weights_used: list[float]
    months_analyzed: int
    trend: str
    # increasing | stable | decreasing
    trend_pct_per_month: float


# ------------------------------------------------------------
# CALCULATE RUNWAY
# Fonction principale appelée par l'endpoint /runway
# ------------------------------------------------------------

def calculate_runway(request: RunwayRequest) -> RunwayResponse:
    """
    Calcule le runway de manière déterministe.

    Étapes :
    1. Calculer le burn rate pondéré (3 derniers mois)
    2. Calculer le MRR depuis les transactions récurrentes
    3. Calculer le net burn = burn - MRR - pipeline_revenue
    4. Runway = cash / net_burn
    5. Générer les scénarios et métadonnées
    """
    issues: list[str] = []

    # --------------------------------------------------------
    # ÉTAPE 1 : BURN RATE PONDÉRÉ
    # --------------------------------------------------------
    expenses = sorted(
        request.monthly_expenses,
        key=lambda x: x.month_label
    )

    if len(expenses) == 0:
        # Cas edge : aucune dépense historique
        issues.append("No expense history available")
        monthly_burn_gross = 0.0
        weights_used = []
        months_analyzed = 0
    else:
        # Utiliser les 3 derniers mois disponibles
        recent_expenses = expenses[-3:]
        months_analyzed = len(recent_expenses)
        burn_values = [e.total_expense for e in recent_expenses]

        # Poids : le plus récent a le plus de poids
        # 1 mois   → [1.0]
        # 2 mois   → [0.4, 0.6]
        # 3 mois   → [0.2, 0.3, 0.5]
        weight_configs = {
            1: [1.0],
            2: [0.4, 0.6],
            3: [0.2, 0.3, 0.5],
        }
        weights = weight_configs.get(months_analyzed, [1/months_analyzed] * months_analyzed)

        monthly_burn_gross = round(
            float(np.average(burn_values, weights=weights)),
            2
        )
        weights_used = weights

        if months_analyzed < 3:
            issues.append(f"Only {months_analyzed} month(s) of expense history available")

    # --------------------------------------------------------
    # ÉTAPE 2 : MRR
    # --------------------------------------------------------
    mrr, mrr_method = _calculate_mrr(request.mrr_transactions, issues)
    arr = round(mrr * 12, 2)

    # --------------------------------------------------------
    # ÉTAPE 3 : REVENUS ADDITIONNELS (pipeline)
    # --------------------------------------------------------
    # On inclut seulement 50% du pipeline attendu (conservative)
    pipeline_contribution = round(
        request.pipeline_data.expected_30d_revenue * 0.5,
        2
    )
    monthly_revenue = round(mrr + pipeline_contribution, 2)
    pipeline_included = pipeline_contribution > 0

    # --------------------------------------------------------
    # ÉTAPE 4 : NET BURN
    # --------------------------------------------------------
    monthly_net_burn = round(
        max(0.0, monthly_burn_gross - monthly_revenue),
        2
    )
    is_profitable = monthly_net_burn == 0.0 and monthly_burn_gross > 0

    # --------------------------------------------------------
    # ÉTAPE 5 : RUNWAY
    # --------------------------------------------------------
    if monthly_net_burn == 0:
        # Profitable ou zéro dépenses — runway infini
        runway_months = 999.0
        runway_date = "2099-12-31"
    elif request.current_balance == 0:
        # Pas de cash
        runway_months = 0.0
        runway_date = date.today().isoformat()
    else:
        runway_months = round(
            request.current_balance / monthly_net_burn,
            1
        )
        runway_date = (
            date.today() + timedelta(days=int(runway_months * 30.44))
        ).isoformat()

    # --------------------------------------------------------
    # ÉTAPE 6 : SCÉNARIOS
    # --------------------------------------------------------
    scenarios = _calculate_scenarios(
        current_balance=request.current_balance,
        monthly_net_burn=monthly_net_burn,
        mrr=mrr,
    )

    # --------------------------------------------------------
    # ÉTAPE 7 : CONFIANCE DES DONNÉES
    # --------------------------------------------------------
    data_confidence = _assess_data_confidence(
        months_analyzed=months_analyzed,
        has_mrr=mrr > 0,
        has_bank_data=request.current_balance > 0,
        issues=issues,
    )

    return RunwayResponse(
        current_balance=round(request.current_balance, 2),
        monthly_burn_gross=monthly_burn_gross,
        monthly_revenue=monthly_revenue,
        monthly_net_burn=monthly_net_burn,
        runway_months=runway_months,
        runway_date=runway_date,
        mrr=mrr,
        arr=arr,
        scenarios=scenarios,
        is_profitable=is_profitable,
        data_confidence=data_confidence,
        calculation_details=RunwayCalculationDetails(
            burn_weights_used=weights_used,
            months_analyzed=months_analyzed,
            mrr_method=mrr_method,
            pipeline_included=pipeline_included,
            data_quality_issues=issues,
        ),
        calculated_at=datetime.utcnow().isoformat() + "Z",
    )

# ------------------------------------------------------------
# CALCULATE WEIGHTED BURN
# Endpoint séparé pour les appels qui veulent seulement le burn.
# ------------------------------------------------------------

def calculate_weighted_burn(request: BurnRequest) -> BurnResponse:
    """
    Calcule le burn rate pondéré sur N mois.
    """
    expenses = sorted(
        request.monthly_expenses,
        key=lambda x: x.month_label
    )[-request.months_to_use:]

    if not expenses:
        return BurnResponse(
            weighted_burn=0.0,
            raw_monthly_burns=[],
            weights_used=[],
            months_analyzed=0,
            trend="unknown",
            trend_pct_per_month=0.0,
        )

    burn_values = [e.total_expense for e in expenses]
    n = len(burn_values)

    weight_configs = {
        1: [1.0],
        2: [0.4, 0.6],
        3: [0.2, 0.3, 0.5],
    }
    weights = weight_configs.get(n, [1/n] * n)

    weighted_burn = float(np.average(burn_values, weights=weights))

    # Calculer la tendance
    trend, trend_pct = _calculate_burn_trend(burn_values)

    return BurnResponse(
        weighted_burn=round(weighted_burn, 2),
        raw_monthly_burns=[round(b, 2) for b in burn_values],
        weights_used=weights,
        months_analyzed=n,
        trend=trend,
        trend_pct_per_month=round(trend_pct, 2),
    )

# ------------------------------------------------------------
# INTERNAL HELPERS
# ------------------------------------------------------------

def _calculate_mrr(
    transactions: list[MRRTransaction],
    issues: list[str],
) -> tuple[float, str]:
    """
    Calcule le MRR depuis les transactions récurrentes.

    Méthode 1 (préférée) : Transactions récurrentes Stripe sur 90j / 3
    Méthode 2 (fallback) : Si < 3 mois de données, utiliser ce qu'on a

    Retourne (mrr, method_used)
    """
    recurring = [t for t in transactions if t.is_recurring and t.amount > 0]

    if not recurring:
        issues.append("No recurring revenue transactions found")
        return 0.0, "no_data"

    # Grouper par mois
    monthly_recurring: dict[str, float] = {}
    for t in recurring:
        try:
            month = t.date[:7]  # 'YYYY-MM'
            monthly_recurring[month] = monthly_recurring.get(month, 0) + t.amount
        except (IndexError, ValueError):
            continue

    if not monthly_recurring:
        return 0.0, "no_data"

    months_sorted = sorted(monthly_recurring.keys())
    recent_months = months_sorted[-3:]
    recent_values = [monthly_recurring[m] for m in recent_months]

    if len(recent_values) >= 3:
        mrr = round(float(np.mean(recent_values)), 2)
        method = "3_month_average"
    elif len(recent_values) == 2:
        mrr = round(float(np.mean(recent_values)), 2)
        method = "2_month_average"
        issues.append("MRR based on only 2 months of data")
    else:
        mrr = round(recent_values[0], 2)
        method = "single_month"
        issues.append("MRR based on single month of data — may be inaccurate")

    return mrr, method


def _calculate_scenarios(
    current_balance: float,
    monthly_net_burn: float,
    mrr: float,
) -> RunwayScenarios:
    """
    Calcule les 3 scénarios de runway.

    Pessimiste : burn +20% (ou MRR -20% si profitable)
    Réaliste   : situation actuelle
    Optimiste  : burn -20% (ou MRR +20% si profitable)
    """
    if monthly_net_burn == 0:
        # Cas profitable : les scénarios sont basés sur une dégradation hypothétique
        pessimistic_burn = mrr * 0.2  # Et si le MRR baissait de 20% ?
        realistic_burn = 0.0
        optimistic_burn = 0.0
    else:
        pessimistic_burn = monthly_net_burn * 1.20
        realistic_burn = monthly_net_burn
        optimistic_burn = monthly_net_burn * 0.80

    def safe_runway(burn: float) -> float:
        if burn <= 0:
            return 999.0
        return round(current_balance / burn, 1)

    return RunwayScenarios(
        pessimistic=safe_runway(pessimistic_burn),
        realistic=safe_runway(realistic_burn),
        optimistic=safe_runway(optimistic_burn),
    )


def _assess_data_confidence(
    months_analyzed: int,
    has_mrr: bool,
    has_bank_data: bool,
    issues: list[str],
) -> str:
    """
    Évalue la confiance dans les calculs selon la qualité des données.

    full        : >= 3 mois d'historique + MRR + solde bancaire
    partial     : données partielles (quelques sources manquantes)
    insufficient: données insuffisantes (< 1 mois ou aucune source)
    """
    if months_analyzed >= 3 and has_mrr and has_bank_data:
        return "full"
    elif months_analyzed >= 1 and (has_mrr or has_bank_data):
        return "partial"
    else:
        return "insufficient"


def _calculate_burn_trend(burn_values: list[float]) -> tuple[str, float]:
    """
    Calcule la tendance du burn sur les N derniers mois.

    Retourne (trend_label, pct_per_month)
    trend_label : "increasing" | "stable" | "decreasing"
    pct_per_month : variation en % par mois (peut être négatif)
    """
    if len(burn_values) < 2:
        return "unknown", 0.0

    # Régression linéaire simple
    x = np.arange(len(burn_values), dtype=float)
    y = np.array(burn_values, dtype=float)

    if np.std(y) == 0:
        return "stable", 0.0

    # Coefficient de la droite de régression
    slope = float(np.polyfit(x, y, 1)[0])

    # Pourcentage de variation par mois par rapport à la moyenne
    avg_burn = float(np.mean(y))
    if avg_burn == 0:
        return "stable", 0.0

    pct_per_month = (slope / avg_burn) * 100

    if pct_per_month > 5:
        return "increasing", pct_per_month
    elif pct_per_month < -5:
        return "decreasing", pct_per_month
    else:
        return "stable", pct_per_month
