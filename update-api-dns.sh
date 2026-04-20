#!/bin/bash
set -e

# Update api.estimatenest.net to point to green API Gateway
DOMAIN="estimatenest.net"
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$DOMAIN" --query "HostedZones[0].Id" --output text | cut -d'/' -f3)

if [[ -z "$HOSTED_ZONE_ID" ]]; then
  echo "Error: Could not find hosted zone for domain $DOMAIN"
  exit 1
fi

echo "Hosted zone ID: $HOSTED_ZONE_ID"

# Get current record
CURRENT_RECORD=$(aws route53 list-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --query "ResourceRecordSets[?Name=='api.estimatenest.net.' && Type=='A']" --output json)

echo "Current record:"
echo "$CURRENT_RECORD" | jq .

# Get green API Gateway domain (from green stack)
GREEN_API_DOMAIN="d-lponzjc9bj.execute-api.eu-central-1.amazonaws.com"

echo "Updating api.estimatenest.net to point to green API: $GREEN_API_DOMAIN"

# Create change batch
CHANGE_BATCH=$(cat <<EOF
{
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.estimatenest.net.",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z1FJD7UAW7VQJV",
          "DNSName": "$GREEN_API_DOMAIN",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
EOF
)

echo "Change batch:"
echo "$CHANGE_BATCH" | jq .

read -p "Apply this change? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch "$CHANGE_BATCH"
  echo "DNS updated successfully"
else
  echo "Cancelled"
fi