#!/usr/bin/env bash
set -euo pipefail

# Update CDK configuration with certificate ARN and hosted zone ID

CDK_JSON_PATH="infrastructure/cdk.json"
OUTPUTS_FILE="scripts/domain-setup-outputs.json"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

check_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        log_error "Required command '$1' not found. Please install it and try again."
        exit 1
    fi
}

# Check prerequisites
check_command jq

# Check if outputs file exists
if [[ ! -f "${OUTPUTS_FILE}" ]]; then
    log_error "Outputs file not found: ${OUTPUTS_FILE}"
    log_error "Please run setup-domain.sh first."
    exit 1
fi

# Read values
HOSTED_ZONE_ID=$(jq -r '.hostedZoneId' "${OUTPUTS_FILE}")
CERTIFICATE_ARN=$(jq -r '.certificateArn' "${OUTPUTS_FILE}")

if [[ -z "${HOSTED_ZONE_ID}" ]] || [[ "${HOSTED_ZONE_ID}" == "null" ]]; then
    log_error "Invalid hostedZoneId in outputs file."
    exit 1
fi

if [[ -z "${CERTIFICATE_ARN}" ]] || [[ "${CERTIFICATE_ARN}" == "null" ]]; then
    log_error "Invalid certificateArn in outputs file."
    exit 1
fi

log_info "Updating CDK configuration..."
log_info "Hosted Zone ID: ${HOSTED_ZONE_ID}"
log_info "Certificate ARN: ${CERTIFICATE_ARN}"

# Backup original file
BACKUP_PATH="${CDK_JSON_PATH}.backup.$(date +%Y%m%d%H%M%S)"
cp "${CDK_JSON_PATH}" "${BACKUP_PATH}"
log_info "Backup created: ${BACKUP_PATH}"

# Update cdk.json using jq
jq \
    --arg hostedZoneId "${HOSTED_ZONE_ID}" \
    --arg certificateArn "${CERTIFICATE_ARN}" \
    '.context.dev.hostedZoneId = $hostedZoneId |
     .context.dev.certificateArn = $certificateArn |
     .context.prod.hostedZoneId = $hostedZoneId |
     .context.prod.certificateArn = $certificateArn' \
    "${CDK_JSON_PATH}" > "${CDK_JSON_PATH}.tmp"

# Check if jq succeeded
if [[ $? -ne 0 ]]; then
    log_error "Failed to update CDK configuration with jq."
    exit 1
fi

mv "${CDK_JSON_PATH}.tmp" "${CDK_JSON_PATH}"
log_info "CDK configuration updated successfully."

# Show diff
log_info "Changes made:"
diff -u "${BACKUP_PATH}" "${CDK_JSON_PATH}" || true

log_info "================================================"
log_info "Next steps:"
log_info "1. Deploy dev stack: npm run deploy:dev"
log_info "2. Deploy prod stack: npm run deploy:prod"
log_info "================================================"