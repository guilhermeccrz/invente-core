#!/usr/bin/env bash
set -euo pipefail

PROJECT="${GOOGLE_CLOUD_PROJECT:-project-639ad7da-da3d-4115-970}"
REGION="${TASKS_LOCATION:-southamerica-east1}"
TAG="${IMAGE_TAG:-local}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/inventa/invente-core:${TAG}"
SA="inventa-api@${PROJECT}.iam.gserviceaccount.com"
BUCKET="inventa-media-${PROJECT}"

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
docker build -t "${IMAGE}" .
docker push "${IMAGE}"

SECRETS="SESSION_SECRET=inventa-session-secret:latest"
if gcloud secrets describe inventa-resend-api-key --project "${PROJECT}" >/dev/null 2>&1; then
  SECRETS="${SECRETS},RESEND_API_KEY=inventa-resend-api-key:latest"
fi
if gcloud secrets describe inventa-google-client-id --project "${PROJECT}" >/dev/null 2>&1; then
  SECRETS="${SECRETS},GOOGLE_CLIENT_ID=inventa-google-client-id:latest,GOOGLE_CLIENT_SECRET=inventa-google-client-secret:latest"
fi

COMMON="^|^GOOGLE_CLOUD_PROJECT=${PROJECT}|PUBLIC_API_URL=https://api.invente.ai|PUBLIC_APP_URL=https://invente.ai|MEDIA_BUCKET=${BUCKET}|MEDIA_PREFIX=invente.ai/|TASKS_LOCATION=${REGION}|TASKS_QUEUE=inventa-jobs|TASKS_INVOKER_EMAIL=${SA}|DATA_BACKEND=firestore|POD_USD_PER_HOUR=0.70|TOKEN_USD=0.001|TOKEN_MARGIN=1.5|EMAIL_FROM=Invente.AI <support@invente.ai>|MAIL_FROM=Invente.AI <support@invente.ai>"

gcloud run deploy inventa-worker \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --service-account "${SA}" \
  --min-instances=0 \
  --max-instances=2 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=1800 \
  --concurrency=1 \
  --no-allow-unauthenticated \
  --set-env-vars="${COMMON}|ROLE=worker" \
  --set-secrets="${SECRETS}" \
  --quiet

WORKER_URL="$(gcloud run services describe inventa-worker --region "${REGION}" --project "${PROJECT}" --format='value(status.url)')"

gcloud run deploy inventa-api \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --service-account "${SA}" \
  --min-instances=0 \
  --max-instances=2 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=60 \
  --concurrency=80 \
  --allow-unauthenticated \
  --set-env-vars="${COMMON}|ROLE=api|TASKS_WORKER_URL=${WORKER_URL}/v1/tasks/jobs" \
  --set-secrets="${SECRETS}" \
  --quiet

gcloud run services add-iam-policy-binding inventa-worker \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --member="serviceAccount:${SA}" \
  --role="roles/run.invoker" \
  --quiet

echo "api $(gcloud run services describe inventa-api --region "${REGION}" --project "${PROJECT}" --format='value(status.url)')"
echo "worker ${WORKER_URL}"
