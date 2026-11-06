FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
RUN pip uninstall -y pip setuptools wheel && mkdir /package /scratch
COPY worker.py /opt/worker.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 HOME=/scratch TZ=UTC
USER 65534:65534
WORKDIR /scratch
ENTRYPOINT ["python", "-s", "-B", "/opt/worker.py"]
