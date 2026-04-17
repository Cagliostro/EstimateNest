#!/usr/bin/env bash
set -euo pipefail

# Verify deployments and custom domain configuration

REGION="eu-central-1"
DEV_STACK="EstimateNest-dev"
PROD_STACK="EstimateNest-prod"
DEV_DOMAIN="dev.estimatenest.net"
PROD_DOMAIN="estimatenest.net"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
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
check_command curl

# Verify AWS credentials
log_info "Checking AWS credentials..."
aws sts get-caller-identity >/dev/null || {
    log_error "AWS CLI not configured or credentials invalid."
    exit 1
}

# Function to check CloudFormation stack
check_stack() {
    local stack_name="$1"
    local domain="$2"
    
    log_info "Checking stack: ${stack_name}"
    
    # Check if stack exists
    if ! aws cloudformation describe-stacks \
        --stack-name "${stack_name}" \
        --region "${REGION}" >/dev/null 2>&1; then
        log_error "Stack ${stack_name} not found in region ${REGION}."
        return 1
    fi
    
    # Get stack outputs
    log_info "Retrieving stack outputs..."
    OUTPUTS=$(aws cloudformation describe-stacks \
        --stack-name "${stack_name}" \
        --region "${REGION}" \
        --query "Stacks[0].Outputs" \
        --output json)
    
    # Extract specific outputs
    FRONTEND_URL=$(echo "${OUTPUTS}" | jq -r '.[] | select(.OutputKey=="FrontendUrl") | .OutputValue')
    CLOUDFRONT_ID=$(echo "${OUTPUTS}" | jq -r '.[] | select(.OutputKey=="CloudFrontDistributionId") | .OutputValue')
    REST_API_URL=$(echo "${OUTPUTS}" | jq -r '.[] | select(.OutputKey=="RestApiUrl") | .OutputValue')
    WEB_SOCKET_URL=$(echo "${OUTPUTS}" | jq -r '.[] | select(.OutputKey=="WebSocketUrl") | .OutputValue')
    
    log_info "  Frontend URL: ${FRONTEND_URL:-NOT FOUND}"
    log_info "  CloudFront Distribution ID: ${CLOUDFRONT_ID:-NOT FOUND}"
    log_info "  REST API URL: ${REST_API_URL:-NOT FOUND}"
    log_info "  WebSocket URL: ${WEB_SOCKET_URL:-NOT FOUND}"
    
    # Check CloudFront distribution aliases
    if [[ -n "${CLOUDFRONT_ID}" ]]; then
        log_info "  Checking CloudFront distribution aliases..."
        ALIASES=$(aws cloudfront get-distribution \
            --id "${CLOUDFRONT_ID}" \
            --query "Distribution.DistributionConfig.Aliases.Items" \
            --output json 2>/dev/null || echo "[]")
        
        if [[ "${ALIASES}" != "[]" ]]; then
            log_info "  CloudFront aliases: ${ALIASES}"
        else
            log_warn "  No custom domain aliases configured for CloudFront."
        fi
    fi
    
    # Test HTTP access to custom domain
    log_info "  Testing HTTP access to ${domain}..."
    if curl -s -f -I "https://${domain}" --max-time 10 >/dev/null 2>&1; then
        log_info "  ✓ ${domain} is accessible via HTTPS"
    else
        log_warn "  ✗ ${domain} is not accessible via HTTPS (may still be propagating)"
    fi
    
    # Test API endpoint
    if [[ -n "${REST_API_URL}" ]]; then
        log_info "  Testing API endpoint..."
        if curl -s -f "${REST_API_URL}" --max-time 10 >/dev/null 2>&1; then
            log_info "  ✓ API endpoint is responsive"
        else
            log_warn "  ✗ API endpoint may not be responsive"
        fi
    fi
    
    echo ""
}

log_info "================================================"
log_info "Verifying EstimateNest deployments"
log_info "Region: ${REGION}"
log_info "================================================"

# Check dev stack
if check_stack "${DEV_STACK}" "${DEV_DOMAIN}"; then
    log_info "Dev stack check completed."
else
    log_error "Dev stack check failed."
fi

# Check prod stack
if check_stack "${PROD_STACK}" "${PROD_DOMAIN}"; then
    log_info "Prod stack check completed."
else
    log_error "Prod stack check failed."
fi

log_info "================================================"
log_info "Verification complete!"
log_info "Note: CloudFront distribution changes may take 15-30 minutes to propagate."
log_info "================================================"