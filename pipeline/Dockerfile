# The red-point detector, containerised — the Spark runtime of record in v2.
#
# WHY this exists (v1 ran the detector as a Databricks continuous job):
# infra/databricks/main.tf created a job cluster with `num_workers = 0` and
# `spark.master = "local[*, 4]"`. The detector was therefore always a SINGLE JVM
# in Spark local mode — it never needed a cluster. Databricks was an expensive,
# capacity-bound wrapper around one Python process, and on 2026-07-13 it took the
# whole deployment down with it:
#
#   CLOUD_PROVIDER_RESOURCE_STOCKOUT: The requested VM size 'Standard_D4s_v3' is
#   currently not available in location 'eastus2'
#
# Standard_D4s_v3 is the ONLY 4-vCPU SKU an Azure for Students subscription can
# use in eastus2 (every other one is Location-restricted), so a stockout there is
# unrecoverable. A container has no VM SKU to be out of stock.
#
# What does NOT change: pipeline/red_point_detector.py is copied in byte for
# byte. This is still Apache Spark Structured Streaming — just without Databricks
# around it.

# Pinned by digest, not by tag: `python:3.12-slim-bookworm` is a moving target, and
# two builds of an unchanged Dockerfile must produce the same image. Refresh with:
#   docker buildx imagetools inspect python:3.12-slim-bookworm
FROM python:3.12-slim-bookworm@sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b

# PySpark 3.5.1 needs a JVM (Java 8/11/17 — 17 is the newest it supports) and
# Python 3.10-3.12. `procps` is not optional: Spark's launcher scripts shell out
# to `ps` while starting the JVM, and the slim image does not ship it.
#
# The apt versions are deliberately NOT pinned. Debian point releases withdraw
# superseded packages from the archive, so a pinned version becomes a build that
# fails a few weeks later — worse than a floating one. The base image digest above
# is what makes this layer reproducible: it fixes the apt snapshot it installs from.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    openjdk-17-jre-headless \
    procps \
    && rm -rf /var/lib/apt/lists/*

# JAVA_HOME is derived from the JRE that actually got installed rather than
# hardcoded to /usr/lib/jvm/java-17-openjdk-amd64: that path carries the CPU
# architecture in it, and the same Dockerfile has to survive an arm64 build agent.
RUN ln -s "$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")" /opt/java
ENV JAVA_HOME=/opt/java

RUN pip install --no-cache-dir pyspark==3.5.1

# Spark reads spark-defaults.conf from SPARK_CONF_DIR at every JVM start, both at
# build time and at run time. Two settings are written here at build:
#
#   spark.jars.ivy      pins the Ivy home to a known path instead of $HOME/.ivy2,
#                       so the cache warmed below is the same one the runtime reads
#                       — the build runs as root and the detector runs as `spark`,
#                       so a HOME-relative cache would simply be missed.
#   spark.driver.memory in local mode the driver IS the whole engine, and Spark's
#                       1g default wastes most of the 4 GiB the container gets.
#
# entrypoint.sh appends the ADLS storage key to this same file at start-up. None of
# these are set by red_point_detector.py, so nothing here fights the code.
ENV SPARK_CONF_DIR=/opt/spark-conf
RUN mkdir -p /opt/spark-conf /opt/ivy \
    && printf 'spark.jars.ivy /opt/ivy\nspark.driver.memory 2g\n' > /opt/spark-conf/spark-defaults.conf

# Spark local mode binds the driver to whatever the hostname resolves to. In a
# container that lookup is the classic startup failure ("Service 'sparkDriver'
# could not bind..."), and the driver has nothing to serve to anyone anyway.
ENV SPARK_LOCAL_IP=127.0.0.1

WORKDIR /app
COPY red_point_detector.py /app/red_point_detector.py
COPY entrypoint.sh /app/entrypoint.sh

# --- The Ivy cache, warmed at BUILD time (the point of this whole file) -------
#
# red_point_detector.py sets:
#
#   spark.jars.packages = org.apache.spark:spark-sql-kafka-0-10_2.12:3.5.1
#
# That is a SUBMIT-time config: PySpark forwards the builder's options to
# spark-submit, which resolves the coordinate through Ivy from Maven Central EVERY
# TIME THE JVM STARTS. On Databricks the Kafka connector shipped with the runtime
# and this was free. In an ephemeral container it would mean a runtime dependency on
# Maven Central, 30-60s of startup, and a detector that simply dies if Maven has a
# bad minute.
#
# So the resolution happens HERE, during the build: the JARs land in /opt/ivy and are
# baked into the image layer. At run time Ivy finds the module descriptor and the
# artifacts already in the cache and resolves them offline — the coordinate is a
# fixed revision, so Ivy never has to ask a repository what it means.
#
# Verified rather than assumed: with a cold cache and no route to Maven Central the
# session FAILS; with this cache warmed and the same dead network it starts and
# reports the connector on its classpath.
#
# The ARG is asserted against the detector source first. If someone bumps the
# connector version in the .py and not here, the cache would be warmed for a package
# nobody asks for and the runtime would silently go back to downloading from the
# internet — so the build fails loudly instead.
ARG SPARK_KAFKA_PACKAGE=org.apache.spark:spark-sql-kafka-0-10_2.12:3.5.1

RUN if ! grep -qF "$SPARK_KAFKA_PACKAGE" /app/red_point_detector.py; then \
    echo "BUILD ABORTED: red_point_detector.py does not declare $SPARK_KAFKA_PACKAGE." >&2; \
    echo "Update SPARK_KAFKA_PACKAGE so the cache is warmed for the package the detector really resolves." >&2; \
    exit 1; \
    fi

# `os.environ.pop("CONTAINER_ID")` is not paranoia and not copy-paste: it is the same
# guard main() opens with. Some container runtimes (distrobox, where this project is
# developed) export CONTAINER_ID, Spark reads it as "I am running inside a YARN
# container" and dies with "Yarn Local dirs can't be empty" before it ever starts. The
# build must not inherit that from whatever agent it happens to run on.
RUN python -c "import os; os.environ.pop('CONTAINER_ID', None); from pyspark.sql import SparkSession; SparkSession.builder.appName('ivy-warmup').master('local[1]').config('spark.jars.packages', '${SPARK_KAFKA_PACKAGE}').getOrCreate().stop()" \
    && if ! ls -R /opt/ivy | grep -q 'spark-sql-kafka'; then \
    echo "BUILD ABORTED: the warm-up left no Kafka connector in /opt/ivy — the runtime would go back to downloading it from Maven Central on every start." >&2; \
    exit 1; \
    fi

# --- The ADLS (ABFS) driver --------------------------------------------------
#
# pip-installed PySpark ships Hadoop 3.3.4 CLIENT libraries but NO Azure filesystem,
# so `abfss://` is unusable out of the box ("No FileSystem for scheme abfss").
# Databricks only made ADLS look free because DBR shipped these JARs. Two things need
# it now: the optional historical archive, and — on every run — the checkpoint.
#
# hadoop-azure MUST match the Hadoop client libraries PySpark bundles, or the driver
# links against a Hadoop API that is not on the classpath. That is ASSERTED below, not
# assumed: if pyspark ever stops shipping hadoop-client-api-<HADOOP_AZURE_VERSION>,
# the build fails and names the version it actually found.
#
# Only FOUR jars go onto the classpath, not the whole transitive closure. hadoop-azure
# also resolves guava-27, slf4j-1.7.36, jackson-2.12 and jetty — but Spark already
# ships its own (guava-14, slf4j-2.0.7, jackson-2.15), and dropping a second copy of
# each next to them is how you earn a NoSuchMethodError at 3am. Spark's versions win;
# these four are the ones Spark genuinely does not have.
ARG HADOOP_AZURE_VERSION=3.3.4
ARG AZURE_STORAGE_VERSION=7.0.1
ARG AZURE_KEYVAULT_CORE_VERSION=1.0.0
ARG WILDFLY_OPENSSL_VERSION=1.0.7.Final

# A SEPARATE Ivy home (/tmp/ivy-abfs, thrown away): this resolution is a build-time
# trick to fetch four jars. Pouring it into /opt/ivy would leave the RUNTIME cache
# holding packages the detector never asks for.
RUN SPARK_HOME="$(python -c 'import pyspark, pathlib; print(pathlib.Path(pyspark.__file__).parent)')" \
    && if [ ! -f "$SPARK_HOME/jars/hadoop-client-api-${HADOOP_AZURE_VERSION}.jar" ]; then \
    echo "BUILD ABORTED: pyspark does not bundle Hadoop ${HADOOP_AZURE_VERSION}." >&2; \
    echo "It ships: $(ls "$SPARK_HOME"/jars/hadoop-client-api-*.jar)" >&2; \
    echo "Set HADOOP_AZURE_VERSION to match it — a mismatched ABFS driver links against a Hadoop API that is not there." >&2; \
    exit 1; \
    fi \
    && python -c "import os; os.environ.pop('CONTAINER_ID', None); from pyspark.sql import SparkSession; SparkSession.builder.appName('abfs-fetch').master('local[1]').config('spark.jars.ivy', '/tmp/ivy-abfs').config('spark.jars.packages', 'org.apache.hadoop:hadoop-azure:${HADOOP_AZURE_VERSION}').getOrCreate().stop()" \
    && cp "/tmp/ivy-abfs/jars/org.apache.hadoop_hadoop-azure-${HADOOP_AZURE_VERSION}.jar" \
    "/tmp/ivy-abfs/jars/com.microsoft.azure_azure-storage-${AZURE_STORAGE_VERSION}.jar" \
    "/tmp/ivy-abfs/jars/com.microsoft.azure_azure-keyvault-core-${AZURE_KEYVAULT_CORE_VERSION}.jar" \
    "/tmp/ivy-abfs/jars/org.wildfly.openssl_wildfly-openssl-${WILDFLY_OPENSSL_VERSION}.jar" \
    "$SPARK_HOME/jars/" \
    && rm -rf /tmp/ivy-abfs

# Prove the driver resolves BEFORE shipping the image. This is the exact lookup Spark
# performs when it opens the checkpoint on abfss://, and it needs no network and no
# credentials. If the four jars were wrong, the image would otherwise fail at 3am in
# front of the class instead of here.
RUN python -c "import os; os.environ.pop('CONTAINER_ID', None); from pyspark.sql import SparkSession; s = SparkSession.builder.appName('abfs-check').master('local[1]').getOrCreate(); k = s._jvm.org.apache.hadoop.fs.FileSystem.getFileSystemClass('abfss', s._jsc.hadoopConfiguration()); assert 'AzureBlobFileSystem' in k.getName(), k.getName(); print('ABFS driver OK:', k.getName()); s.stop()"

# --- Runtime ----------------------------------------------------------------

# Unbuffered: the detector's print() lines are how you watch it come up in the
# Container Apps log stream. Buffered, they would arrive minutes late or never.
ENV PYTHONUNBUFFERED=1

# Least privilege: the detector is a background worker with no ingress. It needs to
# write the Ivy resolution cache and its own Spark conf (entrypoint.sh appends the
# storage key to it at start-up) and nothing else. 0700 on the conf dir because that
# is where the ADLS key lands.
RUN useradd --create-home --uid 10001 spark \
    && chown -R spark:spark /opt/ivy /opt/spark-conf \
    && chmod 0700 /opt/spark-conf \
    && chmod +x /app/entrypoint.sh
USER spark
ENV HOME=/home/spark

ENTRYPOINT ["/app/entrypoint.sh"]
