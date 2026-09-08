#!/usr/bin/env bash
# One-shot setup: collect settings, get the Google token, deploy to Cloud Run,
# create the reminder scheduler, upload the rich menu, register the webhook.
#
# Run it from Google Cloud Shell (recommended: gcloud, node and git are
# preinstalled and you are already logged in) or from any machine that has
# gcloud (logged in) and Node.js 20+:
#
#   ./scripts/setup.sh
#
# Safe to re-run. Values already in .env are reused; the script only asks for
# what is missing. Re-running redeploys the latest code.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE="${SERVICE:-line-assistant}"
REGION="${REGION:-asia-southeast1}"
ENV_FILE=".env"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null || die "gcloud is not installed. Open https://shell.cloud.google.com and run this there."
command -v node   >/dev/null || die "node is not installed."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "Node.js 20+ is required (found $(node -v))."

touch "$ENV_FILE"
getenv() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
setenv() {
  local key="$1" val="$2"
  if grep -qE "^$key=" "$ENV_FILE"; then
    # replace in place (portable sed)
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
ask() { # ask KEY "question" [secret]
  local key="$1" q="$2" secret="${3:-}" cur val
  cur="$(getenv "$key")"
  if [ -n "$cur" ]; then note "$key: already set"; return; fi
  if [ -n "$secret" ]; then read -r -s -p "   $q: " val; echo; else read -r -p "   $q: " val; fi
  [ -n "$val" ] || die "$key is required."
  setenv "$key" "$val"
}

askopt() { # like ask, but blank is allowed
  local key="$1" q="$2" secret="${3:-}" cur val
  cur="$(getenv "$key")"
  if [ -n "$cur" ]; then note "$key: already set"; return; fi
  if [ -n "$secret" ]; then read -r -s -p "   $q: " val; echo; else read -r -p "   $q: " val; fi
  [ -n "$val" ] && setenv "$key" "$val" || true
}

bold "1/7  Settings (stored in .env, never committed)"
ask LINE_CHANNEL_SECRET        "LINE channel secret (Developers Console > Basic settings)" secret
ask LINE_CHANNEL_ACCESS_TOKEN  "LINE long-lived channel access token (Messaging API tab > Issue)" secret
ask ALLOWED_USER_IDS           "Your LINE user ID (starts with U, bottom of Basic settings)"
ask GOOGLE_CLIENT_ID           "Google OAuth client ID (Desktop app)"
ask GOOGLE_CLIENT_SECRET       "Google OAuth client secret" secret
askopt GEMINI_API_KEY          "Gemini API key, free at https://aistudio.google.com/apikey (Enter to skip)" secret
askopt ANTHROPIC_API_KEY       "Anthropic API key, paid (Enter to skip)" secret
if [ -z "$(getenv BOT_NAME)" ]; then read -r -p "   Bot name as shown in LINE [JaiJa]: " v; setenv BOT_NAME "${v:-JaiJa}"; fi
if [ -z "$(getenv USER_NAME)" ]; then read -r -p "   What should the bot call you? (optional): " v; setenv USER_NAME "${v:-}"; fi
[ -n "$(getenv TIMEZONE)" ]     || setenv TIMEZONE "Asia/Bangkok"
[ -n "$(getenv GEMINI_MODEL)" ] || setenv GEMINI_MODEL "gemini-3.6-flash"
[ -n "$(getenv CLAUDE_MODEL)" ] || setenv CLAUDE_MODEL "claude-opus-5"
if [ -z "$(getenv GEMINI_API_KEY)" ] && [ -z "$(getenv ANTHROPIC_API_KEY)" ]; then
  note "No AI key given: archiving and keyword commands only. Re-run later with a Gemini key to enable chat, reminders and calendar."
fi
[ -n "$(getenv CLAUDE_EFFORT)" ] || setenv CLAUDE_EFFORT "low"
[ -n "$(getenv AUTO_SCAN)" ]     || setenv AUTO_SCAN "always"
[ -n "$(getenv CRON_SECRET)" ]  || setenv CRON_SECRET "$(openssl rand -hex 16 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"

bold "2/7  Installing dependencies"
npm install --no-audit --no-fund --silent

bold "3/7  Google Drive + Calendar permission (one time)"
if [ -z "$(getenv GOOGLE_REFRESH_TOKEN)" ]; then
  log="$(mktemp)"
  GOOGLE_CLIENT_ID="$(getenv GOOGLE_CLIENT_ID)" GOOGLE_CLIENT_SECRET="$(getenv GOOGLE_CLIENT_SECRET)" \
    node scripts/get-refresh-token.js | tee "$log"
  tok="$(grep -E '^GOOGLE_REFRESH_TOKEN=' "$log" | tail -1 | cut -d= -f2-)"
  rm -f "$log"
  [ -n "$tok" ] || die "did not get a refresh token; run again."
  setenv GOOGLE_REFRESH_TOKEN "$tok"
else
  note "GOOGLE_REFRESH_TOKEN: already set"
fi

bold "4/7  Google Cloud project"
PROJECT="$(getenv GCP_PROJECT)"
if [ -z "$PROJECT" ]; then
  PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
    gcloud projects list --format='table(projectId,name)'
    read -r -p "   Project ID to deploy into: " PROJECT
  fi
  setenv GCP_PROJECT "$PROJECT"
fi
gcloud config set project "$PROJECT" >/dev/null 2>&1
note "project: $PROJECT, region: $REGION"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com cloudscheduler.googleapis.com compute.googleapis.com --quiet
# New projects give the default build service account no permissions, which
# makes "gcloud run deploy --source" fail with PERMISSION_DENIED. Grant them.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for role in roles/cloudbuild.builds.builder roles/storage.objectViewer roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$BUILD_SA" --role="$role" --quiet >/dev/null 2>&1 || note "could not grant $role (continuing)"
done

bold "5/7  Deploying to Cloud Run (first time takes 3-5 minutes)"
envyaml="$(mktemp --suffix=.yaml 2>/dev/null || mktemp)"
# Only the variables the app reads; quoted so tokens with + / = are safe.
for key in LINE_CHANNEL_SECRET LINE_CHANNEL_ACCESS_TOKEN ALLOWED_USER_IDS GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET \
           GOOGLE_REFRESH_TOKEN GOOGLE_CALENDAR_ID DRIVE_ROOT_FOLDER_NAME TIMEZONE LLM_PROVIDER GEMINI_API_KEY GEMINI_MODEL ANTHROPIC_API_KEY CLAUDE_MODEL \
           CLAUDE_EFFORT AUTO_SCAN BOT_NAME USER_NAME CRON_SECRET; do
  val="$(getenv "$key")"
  [ -n "$val" ] && printf '%s: "%s"\n' "$key" "${val//\"/\\\"}" >> "$envyaml"
done
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 512Mi --timeout 300 \
  --min-instances 0 --max-instances 1 \
  --env-vars-file "$envyaml" \
  --quiet
rm -f "$envyaml"
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
note "service URL: $URL"

bold "6/7  Reminder scheduler (every minute)"
JOB="$SERVICE-reminders"
if gcloud scheduler jobs describe "$JOB" --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" --location "$REGION" --schedule "* * * * *" \
    --uri "$URL/cron/reminders" --http-method GET --update-headers "X-Cron-Secret=$(getenv CRON_SECRET)" --quiet >/dev/null
else
  gcloud scheduler jobs create http "$JOB" --location "$REGION" --schedule "* * * * *" \
    --uri "$URL/cron/reminders" --http-method GET --headers "X-Cron-Secret=$(getenv CRON_SECRET)" --quiet >/dev/null
fi
note "job: $JOB"

bold "7/7  LINE rich menu + webhook"
LINE_CHANNEL_ACCESS_TOKEN="$(getenv LINE_CHANNEL_ACCESS_TOKEN)" node scripts/setup-rich-menu.js
LINE_CHANNEL_ACCESS_TOKEN="$(getenv LINE_CHANNEL_ACCESS_TOKEN)" node scripts/set-webhook.js "$URL"

echo
bold "Done."
note "Health check: $URL"
note "Open LINE, add the bot as a friend, and send it a photo or \"เตือนกินยา 19.00\"."
note "Re-run ./scripts/setup.sh any time to redeploy after pulling new code."
