FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
RUN pip install --no-cache-dir numpy==2.2.6 pandas==2.2.3 scipy==1.15.3 scikit-learn==1.6.1 && pip uninstall -y pip setuptools wheel && mkdir /package /scratch /starter
COPY worker.py batch.py /opt/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 HOME=/scratch TZ=UTC OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
USER 65534:65534
WORKDIR /scratch
ENTRYPOINT ["python", "-s", "-B", "/opt/worker.py"]
