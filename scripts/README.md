# Domain Setup Scripts

These scripts automate the configuration of custom domains for EstimateNest environments.

## Prerequisites

- AWS CLI configured with appropriate credentials
- `jq` command-line JSON processor
- Domain `estimatenest.net` registered and hosted in Route 53
- AWS permissions for:
  - ACM (`acm:RequestCertificate`, `acm:DescribeCertificate`)
  - Route 53 (`route53:ChangeResourceRecordSets`, `route53:ListHostedZones`)
  - CloudFormation (`cloudformation:DescribeStacks`)

## Scripts

### 1. `setup-domain.sh`

**Purpose**: Creates an ACM wildcard certificate for `*.estimatenest.net` (with SAN `estimatenest.net`) and sets up DNS validation.

**Steps**:

1. Verifies the Route 53 hosted zone exists.
2. Checks for an existing ACM certificate; if none, requests a new one.
3. Retrieves DNS validation CNAME records.
4. Adds the validation records to the hosted zone.
5. Waits for certificate issuance (up to 10 minutes).

**Outputs**: `scripts/domain-setup-outputs.json` with `hostedZoneId` and `certificateArn`.

### 2. `update-cdk-config.sh`

**Purpose**: Inserts the certificate ARN and hosted‑zone ID into `infrastructure/cdk.json`.

**Steps**:

1. Reads `domain-setup-outputs.json`.
2. Updates the `dev` and `prod` contexts in `cdk.json`.
3. Creates a backup of the original file.

### 3. `verify-deployments.sh`

**Purpose**: Verifies that both dev and prod stacks are deployed and accessible via their custom domains.

**Steps**:

1. Checks CloudFormation stack existence and outputs.
2. Verifies CloudFront distribution aliases.
3. Tests HTTPS access to `dev.estimatenest.net` and `estimatenest.net`.

## Usage

### First‑time setup (manual)

```bash
# 1. Ensure prerequisites are met
aws sts get-caller-identity
jq --version

# 2. Run domain setup (creates certificate, updates DNS)
./scripts/setup-domain.sh

# 3. Update CDK configuration
./scripts/update-cdk-config.sh

# 4. Deploy stacks (or let CI/CD deploy on next push)
npm run deploy:dev
npm run deploy:prod

# 5. Verify deployments (optional)
./scripts/verify-deployments.sh
```

### CI/CD Integration

After the manual steps above, the custom domains are configured in the CDK stacks. Subsequent pushes to `development` and `main` branches will automatically deploy updates via GitHub Actions, using the custom domains.

## Notes

- The ACM certificate must be in **us‑east‑1** (CloudFront requirement).
- DNS changes may take a few minutes to propagate.
- CloudFront distribution updates can take **15–30 minutes** to propagate globally.
- The same wildcard certificate is used for both dev and prod environments.
- If certificate validation fails, check the CNAME records in Route 53 and wait longer.

## Troubleshooting

**Certificate stuck in “PENDING_VALIDATION”**  
Verify the CNAME records exist in the hosted zone and match the values from ACM. Use `aws route53 list-resource-record-sets --hosted-zone-id <zone-id>`.

**CloudFront distribution shows “The request could not be satisfied”**  
Ensure the certificate is issued and the domain aliases are correctly attached to the distribution. Check the CloudFront console.

**Stack deployment fails with “Certificate not found”**  
Confirm the certificate ARN in `cdk.json` is correct and the certificate is in `us‑east‑1`.
