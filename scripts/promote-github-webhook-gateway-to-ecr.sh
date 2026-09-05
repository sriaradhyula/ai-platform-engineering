#!/usr/bin/env bash
set -euo pipefail

# Promote the immutable GHCR gateway image into both Lambda ECR registries.
# Terraform creates the destination repositories before this script runs.

VERSION="${1:?usage: $0 <image-tag>}"
SOURCE_IMAGE="ghcr.io/cisco-eti/github-webhook-gateway:${VERSION}"
REGION="us-east-2"

if ! command -v skopeo >/dev/null 2>&1; then
  echo "skopeo is required" >&2
  exit 1
fi

: "${GHCR_USERNAME:?set GHCR_USERNAME}"
: "${GHCR_TOKEN:?set GHCR_TOKEN}"

echo "Logging in to GHCR"
printf '%s' "${GHCR_TOKEN}" | skopeo login ghcr.io \
  --username "${GHCR_USERNAME}" \
  --password-stdin

for target in \
  "outshift-common-dev:471112537430:caipe-preview-github-webhook/gateway" \
  "outshift-common-prod:058264538874:caipe-prod-github-webhook/gateway"; do
  IFS=: read -r profile account repository <<<"${target}"
  destination="${account}.dkr.ecr.${REGION}.amazonaws.com/${repository}:${VERSION}"

  echo "Promoting ${SOURCE_IMAGE} to ${destination}"
  env AWS_PROFILE="${profile}" aws ecr get-login-password --region "${REGION}" \
    | skopeo login "${account}.dkr.ecr.${REGION}.amazonaws.com" \
        --username AWS \
        --password-stdin
  skopeo copy "docker://${SOURCE_IMAGE}" "docker://${destination}"

  digest=$(env AWS_PROFILE="${profile}" aws ecr describe-images \
    --repository-name "${repository}" \
    --image-ids "imageTag=${VERSION}" \
    --region "${REGION}" \
    --query 'imageDetails[0].imageDigest' \
    --output text)
  echo "${profile}: ${account}.dkr.ecr.${REGION}.amazonaws.com/${repository}@${digest}"
done
