#!/bin/bash
# Switch traffic between blue and green deployments
# Usage: ./switch-traffic.sh <environment> <active-color> [domain]
# Example: ./switch-traffic.sh prod green estimatenest.net

set -e

ENV=$1
ACTIVE_COLOR=$2
DOMAIN=${3:-"estimatenest.net"}

if [[ -z "$ENV" || -z "$ACTIVE_COLOR" ]]; then
  echo "Usage: $0 <environment> <active-color> [domain]"
  echo "  environment: dev or prod"
  echo "  active-color: blue, green, or rollback"
  exit 1
fi

if [[ "$ACTIVE_COLOR" != "blue" && "$ACTIVE_COLOR" != "green" && "$ACTIVE_COLOR" != "rollback" ]]; then
  echo "Error: active-color must be 'blue', 'green', or 'rollback'"
  exit 1
fi

echo "Switching traffic to $ACTIVE_COLOR for $ENV environment ($DOMAIN)"

# Determine hosted zone ID from domain
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$DOMAIN" --query "HostedZones[0].Id" --output text | cut -d'/' -f3)

if [[ -z "$HOSTED_ZONE_ID" ]]; then
  echo "Error: Could not find hosted zone for domain $DOMAIN"
  exit 1
fi

echo "Found hosted zone: $HOSTED_ZONE_ID"

# Determine active color if rollback requested
if [[ "$ACTIVE_COLOR" == "rollback" ]]; then
  echo "Determining current active color for rollback..."
  # Function to get weight for a set identifier
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

# Weight mapping: active color gets weight 100, inactive gets weight 0
BLUE_WEIGHT=0
GREEN_WEIGHT=0

if [[ "$ACTIVE_COLOR" == "blue" ]]; then
  BLUE_WEIGHT=100
  GREEN_WEIGHT=0
else
  BLUE_WEIGHT=0
  GREEN_WEIGHT=100
fi

# Function to get CloudFormation stack output value
get_stack_output() {
  local stack_name=$1
  local output_key=$2
  aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$output_key'].OutputValue" \
    --output text 2>/dev/null || echo ""
}

# Determine stack names (blue has no suffix for backward compatibility)
BLUE_STACK="EstimateNest-$ENV"
GREEN_STACK="EstimateNest-$ENV-green"

echo "Fetching CloudFront distribution domains from stacks..."
BLUE_CLOUDFRONT_DOMAIN=$(get_stack_output "$BLUE_STACK" "CloudFrontDomainName")
GREEN_CLOUDFRONT_DOMAIN=$(get_stack_output "$GREEN_STACK" "CloudFrontDomainName")
BLUE_WWW_CLOUDFRONT_DOMAIN=$(get_stack_output "$BLUE_STACK" "WwwCloudFrontDomainName")
GREEN_WWW_CLOUDFRONT_DOMAIN=$(get_stack_output "$GREEN_STACK" "WwwCloudFrontDomainName")

# Validate we have at least one domain for each color we're updating
if [[ -z "$BLUE_CLOUDFRONT_DOMAIN" && "$BLUE_WEIGHT" -gt 0 ]]; then
  echo "Error: Blue stack CloudFront domain not found, but blue is active. Cannot switch traffic."
  exit 1
fi
if [[ -z "$GREEN_CLOUDFRONT_DOMAIN" && "$GREEN_WEIGHT" -gt 0 ]]; then
  echo "Error: Green stack CloudFront domain not found, but green is active. Cannot switch traffic."
  exit 1
fi

# Default to placeholder if domain missing (for inactive stack)
BLUE_CLOUDFRONT_DOMAIN=${BLUE_CLOUDFRONT_DOMAIN:-"d3q7tqwkq6fq3t.cloudfront.net"}
GREEN_CLOUDFRONT_DOMAIN=${GREEN_CLOUDFRONT_DOMAIN:-"d3q7tqwkq6fq3t.cloudfront.net"}
BLUE_WWW_CLOUDFRONT_DOMAIN=${BLUE_WWW_CLOUDFRONT_DOMAIN:-"d3q7tqwkq6fq3t.cloudfront.net"}
GREEN_WWW_CLOUDFRONT_DOMAIN=${GREEN_WWW_CLOUDFRONT_DOMAIN:-"d3q7tqwkq6fq3t.cloudfront.net"}

echo "Blue CloudFront domain: $BLUE_CLOUDFRONT_DOMAIN"
echo "Green CloudFront domain: $GREEN_CLOUDFRONT_DOMAIN"
if [[ -n "$BLUE_WWW_CLOUDFRONT_DOMAIN" || -n "$GREEN_WWW_CLOUDFRONT_DOMAIN" ]]; then
  echo "Blue www CloudFront domain: $BLUE_WWW_CLOUDFRONT_DOMAIN"
  echo "Green www CloudFront domain: $GREEN_WWW_CLOUDFRONT_DOMAIN"
fi

# Build change batch JSON
CHANGES='['

# Root domain records
CHANGES="$CHANGES"'
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

# Add www redirect records if domains are available (only for prod)
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

echo "Traffic switched successfully!"
echo "Active: $ACTIVE_COLOR (weight 100), Inactive: $([ "$ACTIVE_COLOR" == "blue" ] && echo "green" || echo "blue") (weight 0)"