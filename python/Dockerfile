# ============================================================
# REVENUE OS — DOCKERFILE PYTHON SERVICE
# Image optimisée pour Fly.io
# Multi-stage build pour minimiser la taille finale
# ============================================================

# --------------------------------------------------------
# STAGE 1 : Builder
# Installe les dépendances dans un environnement isolé
# --------------------------------------------------------
FROM python:3.11-slim AS builder

# Éviter les fichiers .pyc et bufferiser stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

# Copier uniquement requirements pour maximiser le cache Docker
COPY requirements.txt .

# Créer le virtual environment et installer les dépendances
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --upgrade pip && \
    /opt/venv/bin/pip install -r requirements.txt

# --------------------------------------------------------
# STAGE 2 : Runtime
# Image finale légère sans les outils de build
# --------------------------------------------------------
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    ENVIRONMENT=production \
    PORT=8080

# Créer un utilisateur non-root pour la sécurité
RUN groupadd -r appuser && \
    useradd -r -g appuser -d /app -s /bin/bash appuser

WORKDIR /app

# Copier le virtual environment depuis le builder
COPY --from=builder /opt/venv /opt/venv

# Copier le code source
COPY --chown=appuser:appuser main.py treasury.py anomaly.py ./

# Utiliser l'utilisateur non-root
USER appuser

# Port exposé (Fly.io utilise 8080 par défaut)
EXPOSE 8080

# Healthcheck intégré
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" \
    || exit 1

# Commande de démarrage
# Workers = 2 (Fly.io shared CPU — ne pas dépasser)
# Timeout = 30s (aligné avec le timeout Edge Function)
CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "2", \
     "--timeout-keep-alive", "30", \
     "--log-level", "warning", \
     "--access-log"]

# ============================================================
# FLY.IO DEPLOYMENT
# ============================================================
#
# 1. Installer flyctl :
#    curl -L https://fly.io/install.sh | sh
#
# 2. Login :
#    fly auth login
#
# 3. Créer l'app (première fois) :
#    fly launch --name revenue-os-python --region cdg
#    (cdg = Paris, le plus proche pour clients EU)
#
# 4. Configurer les secrets :
#    fly secrets set PYTHON_SERVICE_SECRET=<secret_partagé>
#    fly secrets set ENVIRONMENT=production
#
# 5. Déployer :
#    fly deploy
#
# 6. Vérifier :
#    fly status
#    fly logs
#
# 7. URL de production :
#    https://revenue-os-python.fly.dev
#    → Cette URL va dans PYTHON_SERVICE_URL (Supabase secrets)
#
# ============================================================
# fly.toml (créé automatiquement par fly launch, à personnaliser)
# ============================================================
#
# app = "revenue-os-python"
# primary_region = "cdg"
#
# [build]
#   dockerfile = "Dockerfile"
#
# [http_service]
#   internal_port = 8080
#   force_https = true
#   auto_stop_machines = true
#   auto_start_machines = true
#   min_machines_running = 0
#
# [[vm]]
#   memory = "512mb"
#   cpu_kind = "shared"
#   cpus = 1
#
# ============================================================
