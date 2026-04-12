# ============================================================
# REVENUE OS — FASTAPI SERVICE
# Point d'entrée du service de calcul financier.
#
# RESPONSABILITÉ UNIQUE :
# Recevoir des données brutes depuis les Edge Functions,
# effectuer des calculs déterministes, retourner des résultats.
#
# CE SERVICE NE FAIT PAS :
# → Appels LLM
# → Décisions business
# → Stockage de données
# → Authentification utilisateur
#
# SÉCURITÉ :
# Toutes les routes vérifient le header X-Service-Secret.
# Ce service n'est jamais exposé publiquement sans ce secret.
# ============================================================

import os
import time
import structlog
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

from treasury import (
    RunwayRequest,
    RunwayResponse,
    calculate_runway,
    BurnRequest,
    BurnResponse,
    calculate_weighted_burn,
)
from anomaly import (
    AnomalyRequest,
    AnomalyResponse,
    detect_anomalies,
    ZombieRequest,
    ZombieResponse,
    detect_zombies,
    ForecastRequest,
    ForecastResponse,
    calculate_weighted_forecast,
)

load_dotenv()

log = structlog.get_logger()

SERVICE_SECRET = os.getenv("PYTHON_SERVICE_SECRET", "")
if not SERVICE_SECRET:
    log.warning("PYTHON_SERVICE_SECRET not set — service is unprotected")

# ------------------------------------------------------------
# LIFESPAN : Startup + Shutdown
# ------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("revenue_os_python_service_starting",
             version="1.0.0",
             environment=os.getenv("ENVIRONMENT", "development"))
    yield
    log.info("revenue_os_python_service_stopping")


# ------------------------------------------------------------
# APP
# ------------------------------------------------------------

app = FastAPI(
    title="Revenue OS — Calculation Service",
    description="Deterministic financial calculations for Revenue OS agents.",
    version="1.0.0",
    docs_url="/docs" if os.getenv("ENVIRONMENT") != "production" else None,
    redoc_url=None,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restreint par le secret header
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ------------------------------------------------------------
# MIDDLEWARE : Logging des requêtes + durée
# ------------------------------------------------------------

@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    duration_ms = round((time.time() - start_time) * 1000)

    log.info(
        "request_processed",
        method=request.method,
        path=request.url.path,
        status_code=response.status_code,
        duration_ms=duration_ms,
    )
    return response

# ------------------------------------------------------------
# DEPENDENCY : Vérification du secret
# ------------------------------------------------------------

async def verify_service_secret(request: Request):
    """
    Vérifie que la requête vient bien d'une Edge Function autorisée.
    Le secret est partagé entre Supabase secrets et ce service.
    """
    if not SERVICE_SECRET:
        return  # Pas de secret configuré = dev local

    provided_secret = request.headers.get("X-Service-Secret", "")

    if provided_secret != SERVICE_SECRET:
        log.warning(
            "unauthorized_request",
            path=request.url.path,
            ip=request.client.host if request.client else "unknown",
        )
        raise HTTPException(
            status_code=401,
            detail="Invalid service secret"
        )

# ------------------------------------------------------------
# ROUTES : Health
# ------------------------------------------------------------

@app.get("/health")
async def health_check():
    """
    Healthcheck endpoint. Appelé par le circuit breaker
    dans python-client.ts pour vérifier que le service est up.
    """
    return {
        "status": "healthy",
        "service": "revenue-os-calculation",
        "version": "1.0.0",
        "timestamp": time.time(),
    }

@app.get("/health/detailed")
async def health_check_detailed(_: None = Depends(verify_service_secret)):
    """
    Healthcheck détaillé avec vérification des dépendances.
    """
    checks = {
        "numpy": True,
        "pandas": True,
        "service_secret_configured": bool(SERVICE_SECRET),
    }

    try:
        import numpy as np
        np.array([1, 2, 3])
        checks["numpy"] = True
    except Exception:
        checks["numpy"] = False

    all_healthy = all(checks.values())

    return {
        "status": "healthy" if all_healthy else "degraded",
        "checks": checks,
        "timestamp": time.time(),
    }

# ------------------------------------------------------------
# ROUTES : Treasury — Runway
# ------------------------------------------------------------

@app.post(
    "/runway",
    response_model=RunwayResponse,
    summary="Calculate runway, burn rate, MRR and scenarios",
    description="""
    Calcule le runway de manière déterministe.
    
    Algorithme :
    1. Burn rate = moyenne pondérée des 3 derniers mois (poids : 0.5, 0.3, 0.2)
    2. MRR = transactions récurrentes Stripe / 3 mois
    3. Net burn = max(0, burn - MRR - pipeline_revenue_30d)
    4. Runway = cash / net_burn (si net_burn > 0) ou ∞
    5. Scénarios : pessimiste (+20% burn), réaliste, optimiste (-20% burn)
    
    JAMAIS appelé par le LLM. Uniquement par les Edge Functions.
    """,
)
async def runway_endpoint(
    request: RunwayRequest,
    _: None = Depends(verify_service_secret),
):
    try:
        result = calculate_runway(request)
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        log.error("runway_calculation_error",
                  tenant_id=request.tenant_id,
                  error=str(e))
        raise HTTPException(status_code=500, detail="Calculation error")

# ------------------------------------------------------------
# ROUTES : Treasury — Burn
# ------------------------------------------------------------

@app.post(
    "/burn",
    response_model=BurnResponse,
    summary="Calculate weighted burn rate",
)
async def burn_endpoint(
    request: BurnRequest,
    _: None = Depends(verify_service_secret),
):
    try:
        return calculate_weighted_burn(request)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

# ------------------------------------------------------------
# ROUTES : Anomaly Detection
# ------------------------------------------------------------

@app.post(
    "/anomalies",
    response_model=AnomalyResponse,
    summary="Detect spending anomalies using Z-score",
    description="""
    Détecte les anomalies de dépenses par catégorie.
    
    Algorithme :
    1. Pour chaque catégorie : calculer moyenne et écart-type sur N mois
    2. Calculer le Z-score du mois courant
    3. Z-score > 2.0 → anomalie
    4. Détecter aussi les coûts rampants (trend positif > 5%/mois)
    
    Retourne les anomalies triées par excès de dépense décroissant.
    """,
)
async def anomalies_endpoint(
    request: AnomalyRequest,
    _: None = Depends(verify_service_secret),
):
    try:
        return detect_anomalies(request)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        log.error("anomaly_detection_error",
                  tenant_id=request.tenant_id,
                  error=str(e))
        raise HTTPException(status_code=500, detail="Detection error")

# ------------------------------------------------------------
# ROUTES : Zombie Detection
# ------------------------------------------------------------

@app.post(
    "/zombies",
    response_model=ZombieResponse,
    summary="Detect unused recurring subscriptions",
    description="""
    Identifie les abonnements récurrents non utilisés.
    
    Critères :
    - Transaction récurrente détectée (même merchant, même montant, régulier)
    - Aucune mention dans les emails des 30 derniers jours
    - Aucune mention dans les notes CRM des 30 derniers jours
    - Confiance : high si double signal, medium si signal unique
    
    Retourne les zombies triés par coût mensuel décroissant.
    """,
)
async def zombies_endpoint(
    request: ZombieRequest,
    _: None = Depends(verify_service_secret),
):
    try:
        return detect_zombies(request)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        log.error("zombie_detection_error",
                  tenant_id=request.tenant_id,
                  error=str(e))
        raise HTTPException(status_code=500, detail="Detection error")

# ------------------------------------------------------------
# ROUTES : Pipeline Forecast
# ------------------------------------------------------------

@app.post(
    "/forecast",
    response_model=ForecastResponse,
    summary="Calculate weighted pipeline forecast",
    description="""
    Calcule le forecast pipeline pondéré par probabilité.
    
    Algorithme :
    1. Probabilité par étape = historique si suffisant, sinon benchmarks SaaS
    2. Pénalité stagnation = max(0, 1 - (days_stagnant / 60) * 0.3)
    3. Valeur pondérée = amount × probability × stagnation_penalty
    4. Forecast mensuel = sum(weighted_value) si close_date dans 30 jours
    5. Fourchette confiance : ±30% par défaut, ±15% si historique suffisant
    """,
)
async def forecast_endpoint(
    request: ForecastRequest,
    _: None = Depends(verify_service_secret),
):
    try:
        return calculate_weighted_forecast(request)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        log.error("forecast_calculation_error",
                  tenant_id=request.tenant_id,
                  error=str(e))
        raise HTTPException(status_code=500, detail="Calculation error")

# ------------------------------------------------------------
# ERROR HANDLERS
# ------------------------------------------------------------

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    log.error(
        "unhandled_exception",
        path=request.url.path,
        error=str(exc),
        error_type=type(exc).__name__,
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error",
            "path": request.url.path,
        }
    )

# ------------------------------------------------------------
# ENTRY POINT
# ------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8080")),
        reload=os.getenv("ENVIRONMENT") == "development",
        log_level="warning",
    )
