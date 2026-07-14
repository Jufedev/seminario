#!/usr/bin/env bash
# Container entrypoint for the Spark red-point detector.
#
# It exists for two reasons, and it does NOT contain any detection logic:
# pipeline/red_point_detector.py is byte-identical to the one that runs locally, and
# that is the whole point. Everything below is runtime plumbing around it.
#
#   1. The ADLS storage key. The checkpoint (and, optionally, the archive) live on
#      abfss://, and Hadoop takes the credential as a SPARK CONF, not an env var.
#      Spark reads spark-defaults.conf before the JVM starts, so the key is appended
#      to it here — the alternative, passing it on the spark-submit command line,
#      would leave it visible in `ps`.
#   2. A loud start banner. A Container Apps replica that OOMs or gets evicted is
#      restarted silently; without a marker in the log stream, "the detector went
#      quiet for 30 seconds" and "the detector has been dead for an hour" look
#      exactly the same when you tail the logs.
set -euo pipefail

SPARK_DEFAULTS="${SPARK_CONF_DIR:-/opt/spark-conf}/spark-defaults.conf"

# --- The credential ---------------------------------------------------------
# Required ALWAYS, not only when archiving: the checkpoint itself is on ADLS. A
# missing key here would surface as an opaque Hadoop auth error on the first batch,
# minutes later, so fail now and say why.
if [ -z "${ADLS_ACCOUNT:-}" ] || [ -z "${ADLS_ACCOUNT_KEY:-}" ]; then
  echo "FATAL: ADLS_ACCOUNT / ADLS_ACCOUNT_KEY are not set." >&2
  echo "       The Spark checkpoint lives on abfss:// and cannot be opened without them." >&2
  exit 1
fi

# Appended (not rewritten) so the build-time settings — spark.jars.ivy, the driver
# memory — survive. Written once per container start into an ephemeral filesystem.
printf 'spark.hadoop.fs.azure.account.key.%s.dfs.core.windows.net %s\n' \
  "$ADLS_ACCOUNT" "$ADLS_ACCOUNT_KEY" >> "$SPARK_DEFAULTS"

# --- The banner -------------------------------------------------------------
# Deliberately noisy and deliberately greppable. If this block appears TWICE in a log
# stream, the container restarted — that is the signal the reliability review asked
# for, and it is the difference between "Spark is warming up" and "Spark has been
# crash-looping for ten minutes".
echo "=================================================================="
echo "  RED-POINT DETECTOR — CONTAINER START"
echo "  utc          : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  checkpoint   : ${CHECKPOINT_DIR:-<detector default>}"
echo "  archive      : ${ARCHIVE_PATH:-<off>}"
echo "  input->output: ${INPUT_TOPIC:-?} -> ${OUTPUT_TOPIC:-?}"
echo "  window       : ${WINDOW_DURATION:-?} / slide ${WINDOW_SLIDE:-?}"
echo "  thresholds   : ${MIN_STATIONARY_AVATARS:-?} avatars, dwell ${MIN_MEAN_DWELL_S:-?}s"
echo ""
echo "  If you see this banner more than once, the detector RESTARTED."
echo "  The checkpoint is persistent, so it resumes from committed offsets —"
echo "  but a restart loop means red points are not being emitted."
echo "=================================================================="

# exec: the detector becomes PID 1, so Container Apps' SIGTERM reaches Spark instead
# of this shell. Without it, a stop would kill the wrapper and leave the JVM to be
# SIGKILLed — mid-checkpoint-commit, which is exactly when you least want that.
exec python /app/red_point_detector.py
