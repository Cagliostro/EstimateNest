#!/bin/bash
# Switch traffic between blue and green deployments
# Usage: ./switch-traffic.sh <environment> <active-color> [certificate-arn] [domain]
# Example: ./switch-traffic.sh prod green arn:aws:acm:us-east-1:851725560801:certificate/a314a5fe-5815-4c44-9119-231eb5528a58
#   For rollback: ./switch-traffic.sh prod rollback

set -e

ENV=$1
ACTIVE_COLOR=$2
CERT_ARN=${3:-"arn:aws:acm:us-east-1:851725560801:certificate/a314a5fe-5815-4c44-9119-231eb5528a58"}
DOMAIN=${4:-"estimatenest.net"}
WWW_DOMAIN="www.$DOMAIN"
CLOUDFRONT_REGION="us-east-1"

if [[ -z "$ENV" || -z "$ACTIVE_COLOR" ]]; then
  echo "Usage: $0 <environment> <active-color> [certificate-arn] [domain]"
  echo "  environment: dev or prod"
  echo "  active-color: blue, green, or rollback"
  echo "  certificate-arn: ACM certificate ARN (in us-east-1)"
  exit 1
fi

if [[ "$ACTIVE_COLOR" != "blue" && "$ACTIVE_COLOR" != "green" && "$ACTIVE_COLOR" != "rollback" ]]; then
  echo "Error: active-color must be 'blue', 'green', or 'rollback'"
  exit 1
fi

echo "Switching traffic to $ACTIVE_COLOR for $ENV environment ($DOMAIN)"

# -------------------------------
# CloudFormation stack names
# -------------------------------
BLUE_STACK="EstimateNest-$ENV"
GREEN_STACK="EstimateNest-$ENV-green"

# -------------------------------
# Helper: Get CloudFormation output
# -------------------------------
get_stack_output() {
  local stack_name=$1
  local output_key=$2
  aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$output_key'].OutputValue" \
    --output text 2>/dev/null || echo ""
}

# -------------------------------
# Helper: Get CloudFront distribution ID from stack outputs or resources
# -------------------------------
get_distribution_id() {
  local stack_name=$1
  local output_key=$2
  local logical_id=$3

  # First try CloudFormation outputs
  local dist_id
  dist_id=$(get_stack_output "$stack_name" "$output_key")
  if [[ -n "$dist_id" ]]; then
    echo "$dist_id"
    return 0
  fi

  # Fall back to looking up the physical resource ID from stack resources
  # (useful for old blue stack that lacks WwwCloudFrontDistributionId output)
  local physical_id
  physical_id=$(aws cloudformation describe-stack-resources \
    --stack-name "$stack_name" \
    --logical-resource-id "$logical_id" \
    --query "StackResources[0].PhysicalResourceId" \
    --output text 2>/dev/null || echo "")
  if [[ -n "$physical_id" && "$physical_id" != "None" ]]; then
    echo "$physical_id"
  else
    echo ""
  fi
}

# -------------------------------
# Helper: Update CloudFront distribution aliases and certificate
# -------------------------------
update_cloudfront_aliases() {
  local dist_id=$1
  local action=$2  # "add" or "remove"
  shift 2
  local domains=("$@")  # remaining args are domain names

  if [[ -z "$dist_id" ]]; then
    echo "  Skipping (no distribution ID provided)"
    return 0
  fi

  echo "  Distribution: $dist_id"

  # Get current config and ETag
  local config_json
  config_json=$(aws cloudfront get-distribution-config --id "$dist_id" --region "$CLOUDFRONT_REGION" 2>/dev/null)
  if [[ -z "$config_json" ]]; then
    echo "  Error: Could not get distribution config"
    return 1
  fi

  local etag
  etag=$(echo "$config_json" | jq -r '.ETag')
  local dist_config
  dist_config=$(echo "$config_json" | jq '.DistributionConfig')

  # Modify aliases
  if [[ "$action" == "add" ]]; then
    # Add domains to aliases (idempotent — uses unique to prevent duplicates)
    for domain in "${domains[@]}"; do
      dist_config=$(echo "$dist_config" | jq '
        .Aliases.Items = (((.Aliases.Items // []) + ["'"$domain"'"]) | unique) |
        .Aliases.Quantity = (.Aliases.Items | length)
      ')
    done

    # Set custom certificate
    dist_config=$(echo "$dist_config" | jq '
      .ViewerCertificate = {
        "ACMCertificateArn": "'"$CERT_ARN"'",
        "SSLSupportMethod": "sni-only",
        "MinimumProtocolVersion": "TLSv1.2_2021"
      }
    ')
  elif [[ "$action" == "remove" ]]; then
    # Remove domains from aliases (idempotent)
    for domain in "${domains[@]}"; do
      dist_config=$(echo "$dist_config" | jq '
        .Aliases.Items = ((.Aliases.Items // []) - ["'"$domain"'"]) |
        .Aliases.Quantity = (.Aliases.Items | length) |
        if .Aliases.Quantity == 0 then .Aliases = { Quantity: 0, Items: [] } else . end
      ')
    done

    # Reset to default CloudFront certificate
    dist_config=$(echo "$dist_config" | jq '
      .ViewerCertificate = {
        "CloudFrontDefaultCertificate": true,
        "SSLSupportMethod": "sni-only",
        "MinimumProtocolVersion": "TLSv1.2_2021"
      }
    ')
  fi

  # Apply update
  local temp_file
  temp_file=$(mktemp)
  echo "$dist_config" > "$temp_file"

  echo "  Applying update..."
  local aws_output
  local exit_code=0
  aws_output=$(aws cloudfront update-distribution --id "$dist_id" --if-match "$etag" --distribution-config "file://$temp_file" --region "$CLOUDFRONT_REGION" 2>&1) || exit_code=$?
  if [[ "$exit_code" -eq 0 ]]; then
    echo "  Success"
    rm -f "$temp_file"
  else
    echo "  Failed (exit code: $exit_code)"
    echo "  AWS output: $aws_output"
    echo "  Config saved to: $temp_file"
    return 1
  fi

  # Wait for distribution to deploy
  echo "  Waiting for distribution to deploy..."
  if aws cloudfront wait distribution-deployed --id "$dist_id" --region "$CLOUDFRONT_REGION" 2>/dev/null; then
    echo "  Distribution deployed"
  else
    echo "  Warning: wait failed (may still succeed shortly)"
  fi
}

# -------------------------------
# Determine active color for rollback
# -------------------------------
if [[ "$ACTIVE_COLOR" == "rollback" ]]; then
  echo "Determining current active color for rollback..."

  HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$DOMAIN" --query "HostedZones[0].Id" --output text | cut -d'/' -f3)
  if [[ -z "$HOSTED_ZONE_ID" ]]; then
    echo "Error: Could not find hosted zone for domain $DOMAIN"
    exit 1
  fi

  get_weight() {
    local set_id=$1
    aws route53 list-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
      --query "ResourceRecordSets[?Name=='$DOMAIN.' && Type=='A' && SetIdentifier=='$set_id'].Weight" \
      --output text 2>/dev/null || echo "0"
  }
  BLUE_WEIGHT_CURRENT=$(get_weight "cloudfront-blue")
  GREEN_WEIGHT_CURRENT=$(get_weight "cloudfront-green")
  if [[ "$BLUE_WEIGHT_CURRENT" -eq 100 ]]; then
    ACTIVE_COLOR="green"
    echo "Current active color is blue, switching to green (rollback)"
  elif [[ "$GREEN_WEIGHT_CURRENT" -eq 100 ]]; then
    ACTIVE_COLOR="blue"
    echo "Current active color is green, switching to blue (rollback)"
  else
    echo "Warning: No active color found (both weights 0 or missing). Defaulting to blue."
    ACTIVE_COLOR="blue"
  fi
  echo "Rollback: switching traffic to $ACTIVE_COLOR"
fi

# Determine which color becomes active and which becomes inactive
if [[ "$ACTIVE_COLOR" == "blue" ]]; then
  ADD_COLOR="blue"
  REMOVE_COLOR="green"
  BLUE_WEIGHT=100
  GREEN_WEIGHT=0
else
  ADD_COLOR="green"
  REMOVE_COLOR="blue"
  BLUE_WEIGHT=0
  GREEN_WEIGHT=100
fi

echo "Adding aliases to: $ADD_COLOR"
echo "Removing aliases from: $REMOVE_COLOR"

# -------------------------------
# Step 1: Swap CloudFront distribution aliases
# -------------------------------
echo ""
echo "=== Step 1: Swapping CloudFront distribution aliases ==="

# Get distribution IDs from stack outputs
BLUE_DIST_ID=$(get_stack_output "$BLUE_STACK" "CloudFrontDistributionId")
GREEN_DIST_ID=$(get_stack_output "$GREEN_STACK" "CloudFrontDistributionId")
BLUE_WWW_DIST_ID=$(get_distribution_id "$BLUE_STACK" "WwwCloudFrontDistributionId" "WwwDistributionCF7E043F")
GREEN_WWW_DIST_ID=$(get_distribution_id "$GREEN_STACK" "WwwCloudFrontDistributionId" "WwwDistributionCF7E043F")

echo "Blue  main distribution: $BLUE_DIST_ID"
echo "Green main distribution: $GREEN_DIST_ID"
echo "Blue  www  distribution: ${BLUE_WWW_DIST_ID:-N/A}"
echo "Green www  distribution: ${GREEN_WWW_DIST_ID:-N/A}"

# Remove aliases from the inactive distribution FIRST to avoid CNAME conflicts
if [[ "$REMOVE_COLOR" == "blue" && -n "$BLUE_DIST_ID" ]]; then
  echo ""
  echo "Removing $DOMAIN from blue main distribution..."
  update_cloudfront_aliases "$BLUE_DIST_ID" "remove" "$DOMAIN"
elif [[ "$REMOVE_COLOR" == "green" && -n "$GREEN_DIST_ID" ]]; then
  echo ""
  echo "Removing $DOMAIN from green main distribution..."
  update_cloudfront_aliases "$GREEN_DIST_ID" "remove" "$DOMAIN"
fi

# Add aliases to the active distribution
if [[ "$ADD_COLOR" == "blue" && -n "$BLUE_DIST_ID" ]]; then
  echo ""
  echo "Adding $DOMAIN to blue main distribution..."
  update_cloudfront_aliases "$BLUE_DIST_ID" "add" "$DOMAIN"
elif [[ "$ADD_COLOR" == "green" && -n "$GREEN_DIST_ID" ]]; then
  echo ""
  echo "Adding $DOMAIN to green main distribution..."
  update_cloudfront_aliases "$GREEN_DIST_ID" "add" "$DOMAIN"
fi

# Handle www redirect distribution if applicable
if [[ "$ENV" == "prod" && "$DOMAIN" == "estimatenest.net" ]]; then
  # Remove www aliases from inactive distribution
  if [[ "$REMOVE_COLOR" == "blue" && -n "$BLUE_WWW_DIST_ID" ]]; then
    echo ""
    echo "Removing $WWW_DOMAIN from blue www distribution..."
    update_cloudfront_aliases "$BLUE_WWW_DIST_ID" "remove" "$WWW_DOMAIN"
  elif [[ "$REMOVE_COLOR" == "green" && -n "$GREEN_WWW_DIST_ID" ]]; then
    echo ""
    echo "Removing $WWW_DOMAIN from green www distribution..."
    update_cloudfront_aliases "$GREEN_WWW_DIST_ID" "remove" "$WWW_DOMAIN"
  fi

  # Add www aliases to active distribution
  if [[ "$ADD_COLOR" == "blue" && -n "$BLUE_WWW_DIST_ID" ]]; then
    echo ""
    echo "Adding $WWW_DOMAIN to blue www distribution..."
    update_cloudfront_aliases "$BLUE_WWW_DIST_ID" "add" "$WWW_DOMAIN"
  elif [[ "$ADD_COLOR" == "green" && -n "$GREEN_WWW_DIST_ID" ]]; then
    echo ""
    echo "Adding $WWW_DOMAIN to green www distribution..."
    update_cloudfront_aliases "$GREEN_WWW_DIST_ID" "add" "$WWW_DOMAIN"
  fi
fi

# -------------------------------
# Step 2: Update Route 53 weighted records
# -------------------------------
echo ""
echo "=== Step 2: Updating Route 53 weighted records ==="

HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$DOMAIN" --query "HostedZones[0].Id" --output text | cut -d'/' -f3)
if [[ -z "$HOSTED_ZONE_ID" ]]; then
  echo "Error: Could not find hosted zone for domain $DOMAIN"
  exit 1
fi
echo "Found hosted zone: $HOSTED_ZONE_ID"

# Get CloudFront domain names from stacks
BLUE_CLOUDFRONT_DOMAIN=$(get_stack_output "$BLUE_STACK" "CloudFrontDomainName")
GREEN_CLOUDFRONT_DOMAIN=$(get_stack_output "$GREEN_STACK" "CloudFrontDomainName")
BLUE_WWW_CLOUDFRONT_DOMAIN=$(get_stack_output "$BLUE_STACK" "WwwCloudFrontDomainName")
GREEN_WWW_CLOUDFRONT_DOMAIN=$(get_stack_output "$GREEN_STACK" "WwwCloudFrontDomainName")

# Default to placeholder if domain missing (for inactive stack)
BLUE_CLOUDFRONT_DOMAIN=${BLUE_CLOUDFRONT_DOMAIN:-"d3q7tqwkq6fq3t.cloudfront.net"}
GREEN_CLOUDFRONT_DOMAIN=${GREEN_CLOUDFRONT_DOMAIN:-"d3q7tqwkq6fq3t.cloudfront.net"}
BLUE_WWW_CLOUDFRONT_DOMAIN=${BLUE_WWW_CLOUDFRONT_DOMAIN:-"d3q7tqwkq6fq3t.cloudfront.net"}
GREEN_WWW_CLOUDFRONT_DOMAIN=${GREEN_WWW_CLOUDFRONT_DOMAIN:-"d3q7tqwkq6fq3t.cloudfront.net"}

echo "Blue CloudFront domain: $BLUE_CLOUDFRONT_DOMAIN"
echo "Green CloudFront domain: $GREEN_CLOUDFRONT_DOMAIN"

# Build change batch JSON
CHANGES='[

  {
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "'"$DOMAIN"'",
      "Type": "A",
      "SetIdentifier": "cloudfront-blue",
      "Weight": '"$BLUE_WEIGHT"',
      "AliasTarget": {
        "HostedZoneId": "Z2FDTNDATAQYW2",
        "DNSName": "'"$BLUE_CLOUDFRONT_DOMAIN"'",
        "EvaluateTargetHealth": false
      }
    }
  },
  {
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "'"$DOMAIN"'",
      "Type": "A",
      "SetIdentifier": "cloudfront-green",
      "Weight": '"$GREEN_WEIGHT"',
      "AliasTarget": {
        "HostedZoneId": "Z2FDTNDATAQYW2",
        "DNSName": "'"$GREEN_CLOUDFRONT_DOMAIN"'",
        "EvaluateTargetHealth": false
      }
    }
  }'

# Add www redirect records if applicable
if [[ "$ENV" == "prod" && "$DOMAIN" == "estimatenest.net" ]]; then
  CHANGES="$CHANGES"',
  {
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "www.'"$DOMAIN"'",
      "Type": "A",
      "SetIdentifier": "www-cloudfront-blue",
      "Weight": '"$BLUE_WEIGHT"',
      "AliasTarget": {
        "HostedZoneId": "Z2FDTNDATAQYW2",
        "DNSName": "'"$BLUE_WWW_CLOUDFRONT_DOMAIN"'",
        "EvaluateTargetHealth": false
      }
    }
  },
  {
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "www.'"$DOMAIN"'",
      "Type": "A",
      "SetIdentifier": "www-cloudfront-green",
      "Weight": '"$GREEN_WEIGHT"',
      "AliasTarget": {
        "HostedZoneId": "Z2FDTNDATAQYW2",
        "DNSName": "'"$GREEN_WWW_CLOUDFRONT_DOMAIN"'",
        "EvaluateTargetHealth": false
      }
    }
  }'
fi

CHANGES="$CHANGES"']'

CHANGE_BATCH='{"Changes": '"$CHANGES"'}'

echo "Updating Route 53 weighted records..."
aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch "$CHANGE_BATCH" > /dev/null

echo ""
echo "============================================"
echo "Traffic switched successfully!"
echo "Active: $ACTIVE_COLOR (weight 100)"
echo "Inactive: $([ "$ACTIVE_COLOR" == "blue" ] && echo "green" || echo "blue") (weight 0)"
echo "CloudFront aliases reassigned to: $ACTIVE_COLOR"
echo "============================================"
