# ============================================================
# REVENUE OS — DÉTECTION D'ANOMALIES ET ZOMBIES
# Z-score pour les anomalies de dépenses.
# Heuristiques pour les abonnements zombies.
# Pipeline forecast pondéré.
#
# TOUT EST DÉTERMINISTE.
# Un même input produit toujours le même output.
# Aucune randomisation. Aucun LLM.
# ============================================================

import math
from datetime import datetime, date, timedelta
from typing import Optional
import numpy as np
import pandas as pd
from pydantic import BaseModel, Field, validator

# ------------------------------------------------------------
# MODELS : ANOMALIES
# ------------------------------------------------------------

class CurrentMonthCategoryExpense(BaseModel):
    category: str
    amount: float
    transactions: list[dict]
    # [{ merchant: str, amount: float, date: str }]


class AnomalyRequest(BaseModel):
    tenant_id: str
    monthly_expenses: list[dict]
    # [{ month_label: str, total_expense: float, breakdown: dict }]
    current_month_expenses: list[CurrentMonthCategoryExpense]
    lookback_months: int = 5
    # Nombre de mois historiques pour calculer la baseline


class AnomalyResult(BaseModel):
    category: str
    current_amount: float
    historical_avg: float
    historical_std: float
    excess_amount: float
    z_score: float
    severity: str
    # critical | high | medium
    type: str
    # spike | creeping_cost
    monthly_growth: Optional[float] = None
    projected_annual_impact: Optional[float] = None
    top_merchants: list[str]


class AnomalyResponse(BaseModel):
    anomalies: list[AnomalyResult]
    total_excess_spend: float
    analysis_period_months: int
    categories_analyzed: int
    calculated_at: str


# ------------------------------------------------------------
# MODELS : ZOMBIES
# ------------------------------------------------------------

class RecurringTransaction(BaseModel):
    merchant: str
    monthly_cost: float
    category: Optional[str] = None
    last_charge_date: str
    months_subscribed: int
    recurrence_id: str


class ZombieRequest(BaseModel):
    tenant_id: str
    recurring_transactions: list[RecurringTransaction]
    email_mentions: dict[str, Optional[str]]
    # { merchant_key: last_mention_date | null }
    crm_mentions: dict[str, Optional[str]]
    # { merchant_key: last_mention_date | null }
    inactivity_threshold_days: int = 60
    # Considérer zombie si inactif depuis N jours


class ZombieResult(BaseModel):
    merchant: str
    monthly_cost: float
    annual_cost: float
    category: Optional[str]
    last_activity: Optional[str]
    months_subscribed: int
    confidence: str
    # high | medium | low
    recommendation: str
    # cancel | downgrade | investigate
    inactivity_days: int


class ZombieResponse(BaseModel):
    zombies: list[ZombieResult]
    total_monthly_waste: float
    total_annual_waste: float
    calculated_at: str


# ------------------------------------------------------------
# MODELS : FORECAST
# ------------------------------------------------------------

class DealForForecast(BaseModel):
    id: str
    title: str
    amount: float
    stage: str
    close_date: Optional[str] = None
    days_stagnant: int = 0


class HistoricalCloseRate(BaseModel):
    stage: str
    close_rate: float
    # 0.0 à 1.0
    avg_days_to_close: float


class ForecastRequest(BaseModel):
    tenant_id: str
    deals: list[DealForForecast]
    historical_close_rates: list[HistoricalCloseRate]
    forecast_horizon_days: int = 30


class DealForecastBreakdown(BaseModel):
    id: str
    title: str
    amount: float
    stage: str
    close_probability: float
    weighted_value: float
    stagnation_penalty: float
    expected_close: Optional[str]


class ForecastResponse(BaseModel):
    monthly_forecast: float
    quarterly_forecast: float
    confidence_range: dict[str, float]
    # { low: float, high: float }
    weighted_pipeline: float
    deals_breakdown: list[DealForecastBreakdown]
    methodology: str
    calculated_at: str


# ------------------------------------------------------------
# BENCHMARKS SaaS par défaut
# Utilisés si l'historique client est insuffisant (< 10 deals)
# Source : benchmarks industrie SaaS B2B 2024
# ------------------------------------------------------------

SAAS_BENCHMARK_CLOSE_RATES: dict[str, float] = {
    "new": 0.05,
    "qualified": 0.20,
    "demo_done": 0.35,
    "proposal_sent": 0.55,
    "negotiation": 0.80,
    "closed_won": 1.00,
    "closed_lost": 0.00,
    "unknown": 0.10,
}

Z_SCORE_THRESHOLDS = {
    "critical": 3.0,
    "high": 2.0,
    "medium": 1.5,
}

# ------------------------------------------------------------
# DETECT ANOMALIES
# ------------------------------------------------------------

def detect_anomalies(request: AnomalyRequest) -> AnomalyResponse:
    """
    Détecte les anomalies de dépenses par catégorie.

    Pour chaque catégorie présente dans le mois courant :
    1. Construire la baseline historique (N mois passés)
    2. Calculer moyenne et écart-type
    3. Calculer le Z-score du mois courant
    4. Si Z-score > seuil → anomalie
    5. Détecter aussi les tendances rampantes
    """
    anomalies: list[AnomalyResult] = []

    # Construire un DataFrame des dépenses historiques par catégorie
    historical_df = _build_historical_dataframe(
        request.monthly_expenses,
        request.lookback_months
    )

    for current_expense in request.current_month_expenses:
        category = current_expense.category
        current_amount = current_expense.amount

        if current_amount <= 0:
            continue

        # Récupérer l'historique pour cette catégorie
        if category in historical_df.columns:
            category_history = historical_df[category].dropna().tolist()
        else:
            # Nouvelle catégorie — pas d'historique
            category_history = []

        if len(category_history) < 2:
            # Pas assez d'historique pour un Z-score fiable
            continue

        historical_avg = float(np.mean(category_history))
        historical_std = float(np.std(category_history, ddof=1))

        if historical_std == 0:
            # Dépense parfaitement stable — pas d'anomalie possible
            continue

        z_score = round((current_amount - historical_avg) / historical_std, 2)

        # Vérifier si c'est une anomalie
        if z_score < Z_SCORE_THRESHOLDS["medium"]:
            # Vérifier quand même les coûts rampants
            creeping = _detect_creeping_cost(category_history)
            if creeping["is_creeping"]:
                anomalies.append(AnomalyResult(
                    category=category,
                    current_amount=round(current_amount, 2),
                    historical_avg=round(historical_avg, 2),
                    historical_std=round(historical_std, 2),
                    excess_amount=round(current_amount - historical_avg, 2),
                    z_score=z_score,
                    severity="medium",
                    type="creeping_cost",
                    monthly_growth=creeping["monthly_growth"],
                    projected_annual_impact=creeping["projected_annual_impact"],
                    top_merchants=_extract_top_merchants(
                        current_expense.transactions, n=3
                    ),
                ))
            continue

        # Déterminer la sévérité
        severity = _classify_severity(z_score)
        excess_amount = round(current_amount - historical_avg, 2)

        # Top merchants responsables de cette catégorie ce mois
        top_merchants = _extract_top_merchants(current_expense.transactions, n=5)

        anomalies.append(AnomalyResult(
            category=category,
            current_amount=round(current_amount, 2),
            historical_avg=round(historical_avg, 2),
            historical_std=round(historical_std, 2),
            excess_amount=excess_amount,
            z_score=z_score,
            severity=severity,
            type="spike",
            top_merchants=top_merchants,
        ))

    # Trier par excès de dépense décroissant
    anomalies.sort(key=lambda x: x.excess_amount, reverse=True)

    total_excess = round(sum(a.excess_amount for a in anomalies if a.excess_amount > 0), 2)

    return AnomalyResponse(
        anomalies=anomalies,
        total_excess_spend=total_excess,
        analysis_period_months=request.lookback_months,
        categories_analyzed=len(request.current_month_expenses),
        calculated_at=datetime.utcnow().isoformat() + "Z",
    )


# ------------------------------------------------------------
# DETECT ZOMBIES
# ------------------------------------------------------------

def detect_zombies(request: ZombieRequest) -> ZombieResponse:
    """
    Identifie les abonnements récurrents potentiellement inutilisés.

    Logique :
    1. Pour chaque transaction récurrente :
       a. Chercher une mention email récente (< threshold_days)
       b. Chercher une mention CRM récente (< threshold_days)
       c. Si aucune mention → zombie potentiel
    2. Confidence : high = double absence, medium = absence simple
    3. Recommandation : cancel (high), investigate (low/medium)
    """
    zombies: list[ZombieResult] = []
    today = date.today()
    threshold = request.inactivity_threshold_days

    for tx in request.recurring_transactions:
        merchant_key = _normalize_merchant_key(tx.merchant)

        # Vérifier les mentions email
        email_last = request.email_mentions.get(merchant_key)
        email_active = _is_recently_active(email_last, threshold, today)

        # Vérifier les mentions CRM
        crm_last = request.crm_mentions.get(merchant_key)
        crm_active = _is_recently_active(crm_last, threshold, today)

        # Déterminer la dernière activité
        last_activity = _get_most_recent(email_last, crm_last)

        # Calculer les jours d'inactivité
        if last_activity:
            try:
                last_date = date.fromisoformat(last_activity[:10])
                inactivity_days = (today - last_date).days
            except ValueError:
                inactivity_days = threshold + 1
        else:
            inactivity_days = threshold + 1

        # Pas de signal d'utilisation → zombie potentiel
        if not email_active and not crm_active:

            # Déterminer la confiance
            if email_last is None and crm_last is None:
                # Jamais de mention trouvée
                confidence = "high"
                recommendation = "cancel"
            elif not email_active and not crm_active:
                # Double signal d'inactivité
                confidence = "high"
                recommendation = "cancel"
            else:
                confidence = "medium"
                recommendation = "investigate"

            # Abonnements très récents (< 30 jours) → toujours investigate
            if tx.months_subscribed <= 1:
                confidence = "low"
                recommendation = "investigate"

            # Coûts élevés (> 500€/mois) → toujours investigate avant d'annuler
            if tx.monthly_cost > 500:
                recommendation = "investigate" if confidence != "high" else recommendation

            zombies.append(ZombieResult(
                merchant=tx.merchant,
                monthly_cost=round(tx.monthly_cost, 2),
                annual_cost=round(tx.monthly_cost * 12, 2),
                category=tx.category,
                last_activity=last_activity,
                months_subscribed=tx.months_subscribed,
                confidence=confidence,
                recommendation=recommendation,
                inactivity_days=inactivity_days,
            ))

    # Trier par coût mensuel décroissant
    zombies.sort(key=lambda x: x.monthly_cost, reverse=True)

    total_monthly = round(sum(z.monthly_cost for z in zombies), 2)
    total_annual = round(total_monthly * 12, 2)

    return ZombieResponse(
        zombies=zombies,
        total_monthly_waste=total_monthly,
        total_annual_waste=total_annual,
        calculated_at=datetime.utcnow().isoformat() + "Z",
    )


# ------------------------------------------------------------
# CALCULATE WEIGHTED FORECAST
# ------------------------------------------------------------

def calculate_weighted_forecast(request: ForecastRequest) -> ForecastResponse:
    """
    Calcule le forecast pipeline pondéré.

    Pour chaque deal actif :
    1. Trouver la probabilité de closing selon l'étape
    2. Appliquer une pénalité de stagnation si le deal est bloqué
    3. Calculer la valeur pondérée = amount × probability × penalty
    4. Agréger pour le forecast mensuel et trimestriel

    Pénalité de stagnation :
    - Aucune si days_stagnant < 14
    - Progressive jusqu'à -30% si days_stagnant = 60
    - Plafonnée à -30% au-delà de 60 jours
    """
    today = date.today()
    end_of_month = date(today.year, today.month + 1
                        if today.month < 12 else 1,
                        1) - timedelta(days=1)
    end_of_quarter = _get_end_of_quarter(today)

    # Construire le mapping des probabilités
    close_rate_map = _build_close_rate_map(
        request.historical_close_rates,
        minimum_reliable_deals=10,
    )

    deals_breakdown: list[DealForecastBreakdown] = []
    monthly_forecast = 0.0
    quarterly_forecast = 0.0
    total_weighted_pipeline = 0.0

    for deal in request.deals:
        if deal.stage in ("closed_won", "closed_lost"):
            continue

        # Probabilité de closing
        base_probability = close_rate_map.get(deal.stage, 0.10)

        # Pénalité de stagnation
        stagnation_penalty = _calculate_stagnation_penalty(deal.days_stagnant)

        # Probabilité ajustée
        adjusted_probability = round(base_probability * stagnation_penalty, 4)

        # Valeur pondérée
        weighted_value = round(deal.amount * adjusted_probability, 2)
        total_weighted_pipeline += weighted_value

        # Est-ce que le close_date est dans la période ?
        in_monthly_window = False
        in_quarterly_window = False

        if deal.close_date:
            try:
                close_dt = date.fromisoformat(deal.close_date[:10])
                in_monthly_window = close_dt <= end_of_month
                in_quarterly_window = close_dt <= end_of_quarter
            except ValueError:
                # Date invalide → inclure dans les deux fenêtres par défaut
                in_monthly_window = True
                in_quarterly_window = True
        else:
            # Pas de close_date → inclure dans les deux (conservateur)
            in_monthly_window = True
            in_quarterly_window = True

        if in_monthly_window:
            monthly_forecast += weighted_value
        if in_quarterly_window:
            quarterly_forecast += weighted_value

        deals_breakdown.append(DealForecastBreakdown(
            id=deal.id,
            title=deal.title,
            amount=deal.amount,
            stage=deal.stage,
            close_probability=round(adjusted_probability * 100, 1),
            weighted_value=weighted_value,
            stagnation_penalty=round(stagnation_penalty, 3),
            expected_close=deal.close_date,
        ))

    # Trier par valeur pondérée décroissante
    deals_breakdown.sort(key=lambda x: x.weighted_value, reverse=True)

    # Fourchette de confiance
    confidence_range = _calculate_confidence_range(
        monthly_forecast=monthly_forecast,
        has_sufficient_history=len(request.historical_close_rates) >= 5,
    )

    # Déterminer la méthodologie utilisée
    methodology = (
        "Historical close rates (client data)"
        if _has_sufficient_history(request.historical_close_rates)
        else "SaaS benchmark close rates (insufficient client history)"
    )

    return ForecastResponse(
        monthly_forecast=round(monthly_forecast, 2),
        quarterly_forecast=round(quarterly_forecast, 2),
        confidence_range=confidence_range,
        weighted_pipeline=round(total_weighted_pipeline, 2),
        deals_breakdown=deals_breakdown,
        methodology=methodology,
        calculated_at=datetime.utcnow().isoformat() + "Z",
    )


# ------------------------------------------------------------
# INTERNAL HELPERS
# ------------------------------------------------------------

def _build_historical_dataframe(
    monthly_expenses: list[dict],
    lookback_months: int,
) -> pd.DataFrame:
    """
    Construit un DataFrame avec une colonne par catégorie
    et une ligne par mois.
    """
    if not monthly_expenses:
        return pd.DataFrame()

    rows = []
    for expense in monthly_expenses[-lookback_months:]:
        row = {"month": expense.get("month_label", "")}
        breakdown = expense.get("breakdown", {})
        row.update(breakdown)
        rows.append(row)

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    df = df.set_index("month")
    return df.fillna(0.0)


def _classify_severity(z_score: float) -> str:
    if z_score >= Z_SCORE_THRESHOLDS["critical"]:
        return "critical"
    elif z_score >= Z_SCORE_THRESHOLDS["high"]:
        return "high"
    else:
        return "medium"


def _detect_creeping_cost(history: list[float]) -> dict:
    """
    Détecte si un coût augmente progressivement (trend rampant).
    Utilise une régression linéaire sur l'historique.

    Retourne { is_creeping, monthly_growth, projected_annual_impact }
    """
    if len(history) < 3:
        return {"is_creeping": False, "monthly_growth": 0.0, "projected_annual_impact": 0.0}

    x = np.arange(len(history), dtype=float)
    y = np.array(history, dtype=float)
    slope = float(np.polyfit(x, y, 1)[0])

    avg = float(np.mean(y))
    if avg == 0:
        return {"is_creeping": False, "monthly_growth": 0.0, "projected_annual_impact": 0.0}

    growth_pct = slope / avg

    # Considérer rampant si croissance > 5%/mois
    is_creeping = growth_pct > 0.05

    return {
        "is_creeping": is_creeping,
        "monthly_growth": round(slope, 2),
        "projected_annual_impact": round(slope * 12, 2),
    }


def _extract_top_merchants(
    transactions: list[dict],
    n: int = 3
) -> list[str]:
    """
    Retourne les N merchants responsables des plus grosses dépenses.
    """
    merchant_totals: dict[str, float] = {}
    for tx in transactions:
        merchant = tx.get("merchant", "Unknown")
        amount = float(tx.get("amount", 0))
        merchant_totals[merchant] = merchant_totals.get(merchant, 0) + abs(amount)

    sorted_merchants = sorted(
        merchant_totals.items(),
        key=lambda x: x[1],
        reverse=True
    )
    return [m[0] for m in sorted_merchants[:n]]


def _normalize_merchant_key(merchant: str) -> str:
    """
    Normalise le nom d'un merchant pour la recherche de mentions.
    Ex: "GITHUB INC." → "github"
    """
    return merchant.lower().strip().replace(" inc.", "").replace(" ltd", "").replace(".", "").strip()


def _is_recently_active(
    last_mention: Optional[str],
    threshold_days: int,
    today: date,
) -> bool:
    """
    Retourne True si la dernière mention est dans les threshold_days.
    """
    if last_mention is None:
        return False
    try:
        mention_date = date.fromisoformat(last_mention[:10])
        return (today - mention_date).days <= threshold_days
    except (ValueError, TypeError):
        return False


def _get_most_recent(date1: Optional[str], date2: Optional[str]) -> Optional[str]:
    """
    Retourne la date la plus récente entre deux dates optionnelles.
    """
    if date1 is None and date2 is None:
        return None
    if date1 is None:
        return date2
    if date2 is None:
        return date1
    return date1 if date1 > date2 else date2


def _build_close_rate_map(
    historical_rates: list[HistoricalCloseRate],
    minimum_reliable_deals: int = 10,
) -> dict[str, float]:
    """
    Construit le mapping étape → probabilité.
    Utilise l'historique client si suffisant, sinon les benchmarks.
    """
    if _has_sufficient_history(historical_rates):
        return {r.stage: r.close_rate for r in historical_rates}
    else:
        # Blender : 30% historique client + 70% benchmark si peu de données
        blended = dict(SAAS_BENCHMARK_CLOSE_RATES)
        for r in historical_rates:
            if r.stage in blended:
                blended[r.stage] = round(
                    0.7 * blended[r.stage] + 0.3 * r.close_rate,
                    3
                )
        return blended


def _has_sufficient_history(rates: list[HistoricalCloseRate]) -> bool:
    return len(rates) >= 5

def _calculate_stagnation_penalty(days_stagnant: int) -> float:
    """
    Calcule la pénalité de stagnation.

    0-14 jours  : pas de pénalité (1.0)
    14-60 jours : pénalité progressive de 0 à 30%
    60+ jours   : pénalité maximale (0.70)
    """
    if days_stagnant <= 14:
        return 1.0
    elif days_stagnant >= 60:
        return 0.70
    else:
        # Interpolation linéaire entre 14 et 60 jours
        penalty_rate = (days_stagnant - 14) / (60 - 14) * 0.30
        return round(1.0 - penalty_rate, 4)


def _calculate_confidence_range(
    monthly_forecast: float,
    has_sufficient_history: bool,
) -> dict[str, float]:
    """
    Calcule la fourchette de confiance du forecast.

    Avec historique suffisant : ±15%
    Sans historique suffisant  : ±30%
    """
    if monthly_forecast == 0:
        return {"low": 0.0, "high": 0.0}

    margin = 0.15 if has_sufficient_history else 0.30

    return {
        "low": round(monthly_forecast * (1 - margin), 2),
        "high": round(monthly_forecast * (1 + margin), 2),
    }


def _get_end_of_quarter(today: date) -> date:
    """
    Retourne le dernier jour du trimestre courant.
    """
    quarter_end_months = {1: 3, 2: 3, 3: 3, 4: 6, 5: 6, 6: 6,
                          7: 9, 8: 9, 9: 9, 10: 12, 11: 12, 12: 12}
    end_month = quarter_end_months[today.month]

    if end_month == 12:
        return date(today.year, 12, 31)
    else:
        return date(today.year, end_month + 1, 1) - timedelta(days=1)
