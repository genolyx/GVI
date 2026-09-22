# SAM-VC curation engine worker.
#
# The engine opens a ClinVar tabix VCF and loads the HGMD spreadsheet into RAM at
# import time, so a container is a long-lived warm process that handles one
# curation run at a time. Scale with replicas, never with threads.
#
# Build from the repo root:  docker build -f infra/engine-worker.Dockerfile -t gvi-engine-worker .

FROM python:3.12-slim AS runtime
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# pysam wheels bundle htslib but still link against these at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libcurl4 \
      libbz2-1.0 \
      liblzma5 \
      zlib1g \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY engine/requirements.txt ./engine/requirements.txt
RUN pip install -r engine/requirements.txt

COPY engine ./engine
COPY contracts ./contracts

RUN useradd --create-home --shell /usr/sbin/nologin gvi \
 && mkdir -p /data/reference /data/pdfs \
 && chown -R gvi:gvi /app /data
USER gvi

# Reference data is mounted read-only at /data/reference in deployment.
ENV VC_DATA_ROOT=/data \
    ENGINE_HEALTH_PORT=8080

EXPOSE 8080

# Readiness only flips true once the reference data is mounted, which takes
# minutes for HGMD. Give the start period plenty of room.
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 \
  CMD python -c "import urllib.request,os,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('ENGINE_HEALTH_PORT','8080')+'/readyz', timeout=3).status==200 else 1)"

CMD ["python", "-m", "engine.service.worker"]
