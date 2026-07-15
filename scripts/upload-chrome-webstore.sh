#!/usr/bin/env bash
set -euo pipefail

# Richiede le stesse variabili usate nel workflow GitHub Actions.
# Puoi esportarle prima di lanciare lo script oppure metterle in un .env
# e fare `set -a; source .env; set +a` prima di eseguire questo file.
: "${EXTENSION_ID:?Manca EXTENSION_ID}"
: "${CLIENT_ID:?Manca CLIENT_ID}"
: "${CLIENT_SECRET:?Manca CLIENT_SECRET}"
: "${REFRESH_TOKEN:?Manca REFRESH_TOKEN}"
ZIP_PATH="${1:-extension.zip}"

echo "Refreshing access token..." >&2
ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "refresh_token=${REFRESH_TOKEN}" \
  -d "grant_type=refresh_token" \
  | grep -o '"access_token"[^,}]*' | cut -d'"' -f4)

if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "Impossibile ottenere l'access token" >&2
  exit 1
fi

echo "Uploading ${ZIP_PATH} to extension ${EXTENSION_ID}..." >&2
curl -s -X PUT \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "x-goog-api-version: 2" \
  -T "${ZIP_PATH}" \
  "https://www.googleapis.com/upload/chromewebstore/v1.1/items/${EXTENSION_ID}"

# https://chromewebstore.googleapis.com/v2/publishers/1e4245dd-279e-4c48-a184-9a13aa19394e/items/hhmdgdlfepdamfbpnofmnbgdfgdpfccl:fetchStatus