#!/usr/bin/env bash
# Builds the detector image LOCALLY and pushes it to the Azure Container Registry.
#
# It is called by `terraform apply` (infra/detector.tf, terraform_data.detector_image),
# not by hand — that is what makes the ordering
#
#   azurerm_container_registry -> the image -> azurerm_container_app
#
# a real dependency edge instead of a sequence somebody has to remember.
#
#   ./scripts/build-detector-image.sh <registry> <login-server> <tag> <dockerfile> <context>
#   ./scripts/build-detector-image.sh --local-only    # build it, push nothing, touch no Azure
#
# WHY THE BUILD RUNS LOCALLY AND NOT ON AZURE'S SIDE:
#
#   What building here buys: the image can be RUN and smoke-tested before it ever
#   reaches Azure, the build does not depend on an Azure-side build agent, and it is
#   reproducible offline.
#
#   What it costs, stated honestly: the heavy lifting happens on this machine and
#   leaves over this connection — ~450 MB (compressed) on the first push. Later pushes
#   only send the layers the registry lacks.
#
# WHERE PODMAN RUNS: on the HOST, reached with distrobox-host-exec. NOT inside the box.
# Podman-inside-Podman rootless has no overlay-on-overlay, so it falls back to the `vfs`
# storage driver, which copies the whole filesystem per layer — for a ~1 GB Spark image
# that is slow and enormous. The project already rejected Docker-inside-distrobox as too
# fragile; this would be the same mistake with a different binary. The host's engine is
# the one that runs this box: it is present, and it works.
set -euo pipefail

# --local-only: build and stop there. No registry, no token, no Azure session — so it
# works with the deployment torn down, which is most of the time. `make detector-image`.
LOCAL_ONLY=0
if [ "${1:-}" = "--local-only" ]; then
  LOCAL_ONLY=1
  REGISTRY=""
  LOGIN_SERVER=""
  TAG="local"
  DOCKERFILE="$(cd "$(dirname "$0")/.." && pwd)/pipeline/Dockerfile"
  CONTEXT="$(cd "$(dirname "$0")/.." && pwd)/pipeline"
else
  REGISTRY="${1:?falta el nombre del registro (ACR)}"
  LOGIN_SERVER="${2:?falta el login server del registro}"
  TAG="${3:?falta el tag de la imagen}"
  DOCKERFILE="${4:?falta la ruta del Dockerfile}"
  CONTEXT="${5:?falta el contexto de build}"
fi

IMAGE="${LOGIN_SERVER:+${LOGIN_SERVER}/}red-point-detector:${TAG}"

bold=$'\033[1m'; red=$'\033[31m'; green=$'\033[32m'; off=$'\033[0m'
say() { printf '%s▶ %s%s\n' "$bold" "$1" "$off"; }
ok()  { printf '  %s✓%s %s\n' "$green" "$off" "$1"; }
die() { printf '\n  %s✗ %s%s\n\n' "$red" "$1" "$off" >&2; exit 1; }

# --- Find a container engine ------------------------------------------------
# Preference order, and the reason for it:
#   1. An engine inside the box, if somebody installed one. Nothing to hop over.
#   2. The HOST's engine via distrobox-host-exec. This is the normal path here.
#
# distrobox-host-exec propagates the exit code (verified: `false` -> 1). That is not a
# detail: if it swallowed failures, a broken build would hand Terraform a green apply
# and the Container App would be pointed at an image that does not exist.
engine=()
for candidate in podman docker; do
  if command -v "$candidate" >/dev/null 2>&1; then
    engine=("$candidate")
    break
  fi
done

if [ ${#engine[@]} -eq 0 ] && command -v distrobox-host-exec >/dev/null 2>&1; then
  for candidate in podman docker; do
    if distrobox-host-exec "$candidate" --version >/dev/null 2>&1; then
      engine=(distrobox-host-exec "$candidate")
      break
    fi
  done
fi

[ ${#engine[@]} -gt 0 ] || die "No hay podman ni docker, ni en esta caja ni en el host.
     En el host (Fedora): sudo dnf install podman
     Es el mismo motor que ya corre esta distrobox."

say "Motor de build: ${engine[*]}"

# --- Is it already in the registry? -----------------------------------------
# The tag is the CONTENT HASH of the image (Dockerfile + detector + entrypoint), so a
# tag that already exists in the registry is byte-for-byte the image we would build.
# Building and pushing it again would send ~450 MB to prove they are equal.
#
# Terraform's triggers_replace already skips the re-run when the tag has not changed;
# this covers the other case — a tag that survived in the registry while the Terraform
# state did not (a `destroy` that left the registry, a state moved between machines).
if [ "$LOCAL_ONLY" -eq 0 ] \
  && az acr repository show --name "$REGISTRY" --image "red-point-detector:${TAG}" >/dev/null 2>&1; then
  ok "La imagen ya está en el registro (tag ${TAG}) — no hay nada que construir."
  exit 0
fi

# --- Build ------------------------------------------------------------------
# --platform linux/amd64 explicitly: Container Apps runs amd64, and the image must not
# silently inherit the architecture of whoever happens to be building it.
say "Construyendo la imagen (~4 min la primera vez)"
"${engine[@]}" build \
  --platform linux/amd64 \
  --file "$DOCKERFILE" \
  --tag "$IMAGE" \
  "$CONTEXT" \
  || die "Falló el build de la imagen del detector."
ok "Imagen construida: ${IMAGE}"

if [ "$LOCAL_ONLY" -eq 1 ]; then
  printf '\n  Para mirarla adentro:  %s run --rm -it --entrypoint bash %s\n\n' "${engine[*]}" "$IMAGE"
  exit 0
fi

# --- Log in to the registry -------------------------------------------------
# The registry has NO admin user (admin_enabled = false in infra/detector.tf), on
# purpose: there is no registry password to leak into the Terraform state. So the login
# is a short-lived ARM token, and the username is the null GUID that ACR requires with
# token auth.
#
# The token goes in through STDIN, never as --password: an argument is visible in `ps`
# on the host for as long as the push runs. (Verified that distrobox-host-exec forwards
# stdin.)
say "Autenticando contra el registro"
token="$(az acr login --name "$REGISTRY" --expose-token --query accessToken -o tsv)" \
  || die "No se pudo obtener un token para el registro '$REGISTRY'.
     ¿La sesión de Azure sigue viva? Probá: az login"

printf '%s' "$token" | "${engine[@]}" login "$LOGIN_SERVER" \
  --username 00000000-0000-0000-0000-000000000000 \
  --password-stdin \
  || die "Falló el login contra ${LOGIN_SERVER}."
unset token
ok "Autenticado contra ${LOGIN_SERVER}"

# --- Push -------------------------------------------------------------------
say "Empujando la imagen al registro"
"${engine[@]}" push "$IMAGE" || die "Falló el push de ${IMAGE}."
ok "Imagen en el registro: ${IMAGE}"
