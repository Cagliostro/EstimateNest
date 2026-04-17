#!/usr/bin/env bash
set -euo pipefail

# Domain setup script for EstimateNest
# Automates ACM certificate creation and DNS validation for estimatenest.net

DOMAIN="estimatenest.net"
WILDCARD_DOMAIN="*.${DOMAIN}"
HOSTED_ZONE_NAME="${DOMAIN}."
CERT_REGION="us-east-1"  # CloudFront requires certificates from us-east-1

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
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
check_command aws
check_command jq

# Verify AWS credentials
log_info "Checking AWS credentials and permissions..."
aws sts get-caller-identity >/dev/null || {
    log_error "AWS CLI not configured or credentials invalid. Please run 'aws configure'."
    exit 1
}

# Check if hosted zone exists
log_info "Looking for Route 53 hosted zone for ${DOMAIN}..."
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones \
    --query "HostedZones[?Name=='${HOSTED_ZONE_NAME}'].Id" \
    --output text)

if [[ -z "${HOSTED_ZONE_ID}" ]]; then
    log_error "Hosted zone for ${DOMAIN} not found in Route 53."
    log_error "Please ensure the domain is registered and a hosted zone exists."
    exit 1
fi

# Extract zone ID (remove '/hostedzone/' prefix)
HOSTED_ZONE_ID="${HOSTED_ZONE_ID#/hostedzone/}"
log_info "Found hosted zone: ${HOSTED_ZONE_ID}"

# Check for existing ACM certificate
log_info "Checking for existing ACM certificate for ${WILDCARD_DOMAIN} and ${DOMAIN}..."
EXISTING_CERT_ARN=$(aws acm list-certificates --region "${CERT_REGION}" \
    --query "CertificateSummaryList[?DomainName=='${WILDCARD_DOMAIN}' || DomainName=='${DOMAIN}'].CertificateArn" \
    --output text)

if [[ -n "${EXISTING_CERT_ARN}" ]]; then
    log_info "Found existing certificate: ${EXISTING_CERT_ARN}"
    CERT_ARN="${EXISTING_CERT_ARN}"
    
    # Check certificate status
    CERT_STATUS=$(aws acm describe-certificate \
        --certificate-arn "${CERT_ARN}" \
        --region "${CERT_REGION}" \
        --query "Certificate.Status" \
        --output text)
    
    log_info "Certificate status: ${CERT_STATUS}"
    
    case "${CERT_STATUS}" in
        "ISSUED")
            log_info "Certificate already issued."
            ;;
        "PENDING_VALIDATION")
            log_info "Certificate pending validation; proceeding to DNS validation."
            ;;
        "FAILED")
            log_error "Certificate validation failed. Please check DNS records and request a new certificate."
            exit 1
            ;;
        *)
            log_warn "Certificate status: ${CERT_STATUS}. Proceeding with validation."
            ;;
    esac
else
    log_info "No existing certificate found. Requesting new ACM certificate..."
    
    # Request certificate with both wildcard and root domain
    CERT_ARN=$(aws acm request-certificate \
        --domain-name "${WILDCARD_DOMAIN}" \
        --subject-alternative-names "${DOMAIN}" \
        --validation-method DNS \
        --region "${CERT_REGION}" \
        --query "CertificateArn" \
        --output text)
    
    if [[ -z "${CERT_ARN}" ]]; then
        log_error "Failed to request ACM certificate."
        exit 1
    fi
    
    log_info "Certificate requested: ${CERT_ARN}"
    log_info "Waiting 10 seconds for certificate details to be available..."
    sleep 10
fi

# Get DNS validation records
log_info "Retrieving DNS validation records..."
VALIDATION_RECORDS=$(aws acm describe-certificate \
    --certificate-arn "${CERT_ARN}" \
    --region "${CERT_REGION}" \
    --query "Certificate.DomainValidationOptions[?ValidationMethod=='DNS'].ResourceRecord" \
    --output json)

if [[ "${VALIDATION_RECORDS}" == "null" ]] || [[ "${VALIDATION_RECORDS}" == "[]" ]]; then
    log_error "No DNS validation records found. Certificate may be using email validation."
    log_error "Please check the certificate in AWS Console and validate manually."
    exit 1
fi

# Count validation records
RECORD_COUNT=$(echo "${VALIDATION_RECORDS}" | jq '. | length')
log_info "Found ${RECORD_COUNT} DNS validation record(s)."

# Prepare changes array for Route 53 (deduplicate by CNAME name)
SEEN_NAMES=()
CHANGES=()

for (( i=0; i<RECORD_COUNT; i++ )); do
    CNAME_NAME=$(echo "${VALIDATION_RECORDS}" | jq -r ".[${i}].Name")
    CNAME_VALUE=$(echo "${VALIDATION_RECORDS}" | jq -r ".[${i}].Value")
    
    if [[ -z "${CNAME_NAME}" ]] || [[ -z "${CNAME_VALUE}" ]]; then
        log_error "Failed to parse CNAME validation record at index ${i}."
        exit 1
    fi
    
    # Skip if we've already processed this name
    SKIP=0
    if [[ ${#SEEN_NAMES[@]} -gt 0 ]]; then
        for seen in "${SEEN_NAMES[@]}"; do
            if [[ "${seen}" == "${CNAME_NAME}" ]]; then
                SKIP=1
                break
            fi
        done
    fi
    if [[ ${SKIP} -eq 1 ]]; then
        log_info "Skipping duplicate validation record for ${CNAME_NAME}"
        continue
    fi
    SEEN_NAMES+=("${CNAME_NAME}")
    
    log_info "Validation record: ${CNAME_NAME} → ${CNAME_VALUE}"
    
    # Check if record already exists
    EXISTING_VALUE=$(aws route53 list-resource-record-sets \
        --hosted-zone-id "${HOSTED_ZONE_ID}" \
        --query "ResourceRecordSets[?Type=='CNAME' && Name=='${CNAME_NAME}'].ResourceRecords[0].Value" \
        --output text)
    
    if [[ "${EXISTING_VALUE}" == "${CNAME_VALUE}" ]]; then
        log_info "Record already exists and is correct."
        continue
    fi
    
    # Create change entry
    CHANGE=$(jq -n \
        --arg name "${CNAME_NAME}" \
        --arg value "${CNAME_VALUE}" \
        '{
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": $name,
                "Type": "CNAME",
                "TTL": 300,
                "ResourceRecords": [{"Value": $value}]
            }
        }')
    
    CHANGES+=("${CHANGE}")
done

# Apply changes if any
if [[ ${#CHANGES[@]} -eq 0 ]]; then
    log_info "All validation records already exist and are correct."
else
    log_info "Adding ${#CHANGES[@]} validation record(s) to Route 53..."
    
    # Build change batch JSON
    CHANGE_BATCH=$(jq -n \
        --argjson changes "$(jq -s '.' <<<"$(printf '%s\n' "${CHANGES[@]}")")" \
        '{"Changes": $changes}')
    
    CHANGE_ID=$(aws route53 change-resource-record-sets \
        --hosted-zone-id "${HOSTED_ZONE_ID}" \
        --change-batch "${CHANGE_BATCH}" \
        --query "ChangeInfo.Id" \
        --output text)
    
    if [[ -n "${CHANGE_ID}" ]]; then
        log_info "DNS record change submitted: ${CHANGE_ID}"
        log_info "Waiting for DNS propagation (usually 30-60 seconds)..."
        sleep 60
    else
        log_error "Failed to submit DNS record change."
        exit 1
    fi
fi
# Wait for certificate issuance (poll every 30 seconds, max 10 minutes)
log_info "Waiting for certificate issuance..."
MAX_ATTEMPTS=20
ATTEMPT=1

while [[ ${ATTEMPT} -le ${MAX_ATTEMPTS} ]]; do
    CERT_STATUS=$(aws acm describe-certificate \
        --certificate-arn "${CERT_ARN}" \
        --region "${CERT_REGION}" \
        --query "Certificate.Status" \
        --output text)
    
    log_info "Certificate status: ${CERT_STATUS} (attempt ${ATTEMPT}/${MAX_ATTEMPTS})"
    
    if [[ "${CERT_STATUS}" == "ISSUED" ]]; then
        log_info "Certificate issued successfully!"
        break
    elif [[ "${CERT_STATUS}" == "FAILED" ]]; then
        log_error "Certificate validation failed. Please check DNS records."
        exit 1
    fi
    
    if [[ ${ATTEMPT} -eq ${MAX_ATTEMPTS} ]]; then
        log_warn "Certificate not issued after ${MAX_ATTEMPTS} attempts."
        log_warn "DNS propagation may take longer. You can check manually later."
        log_warn "Certificate ARN: ${CERT_ARN}"
        exit 0  # Continue anyway - validation may complete later
    fi
    
    sleep 30
    ((ATTEMPT++))
done

# Output results
log_info "================================================"
log_info "Domain setup completed successfully!"
log_info "Hosted Zone ID: ${HOSTED_ZONE_ID}"
log_info "Certificate ARN: ${CERT_ARN}"
log_info "================================================"

# Write outputs to file for use by other scripts
cat > "${PWD}/scripts/domain-setup-outputs.json" <<EOF
{
  "hostedZoneId": "${HOSTED_ZONE_ID}",
  "certificateArn": "${CERT_ARN}"
}
EOF

log_info "Outputs saved to: ${PWD}/scripts/domain-setup-outputs.json"