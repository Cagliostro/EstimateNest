#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EstimateNestStack } from './estimateneest-stack';

const app = new cdk.App();

// Read environment from context (default: dev)
const envName = app.node.tryGetContext('env') || 'dev';
const deploymentColor = app.node.tryGetContext('color') || 'blue';
const envConfig = app.node.tryGetContext(envName);

if (!envConfig) {
  throw new Error(`No configuration found for environment "${envName}"`);
}

const stackId = `EstimateNest-${envName}${deploymentColor === 'blue' ? '' : `-${deploymentColor}`}`;

new EstimateNestStack(app, stackId, {
  envName: envConfig.envName,
  deploymentColor,
  domainName: envConfig.domainName,
  certificateArn: envConfig.certificateArn,
  apiCertificateArn: envConfig.apiCertificateArn,
  hostedZoneId: envConfig.hostedZoneId,
  hostedZoneName: envConfig.hostedZoneName,
  // AWS account/region from environment or default
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  tags: {
    Project: 'EstimateNest',
    Environment: envName,
    DeploymentColor: deploymentColor,
    DeploymentTimestamp: new Date().toISOString(),
  },
});

app.synth();
