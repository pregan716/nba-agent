FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
RUN apt-get update && apt-get install -y --no-install-recommends libfuse2 libseccomp2 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir numpy==2.2.6 pandas==2.2.3 scipy==1.15.3 scikit-learn==1.6.1 fusepy==3.0.1 && pip uninstall -y pip setuptools wheel
RUN mkdir /data /workspace /scratch && chmod 755 /workspace && echo user_allow_other > /etc/fuse.conf
COPY server.py worker.py /opt/
COPY nba_data.py /usr/local/lib/python3.12/site-packages/nba_data.py
ENV PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 HOME=/scratch
ENTRYPOINT ["python", "-I", "/opt/server.py"]
