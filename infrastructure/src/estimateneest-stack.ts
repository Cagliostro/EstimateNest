import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import * as path from 'path';

export interface EstimateNestStackProps extends cdk.StackProps {
  envName: string;
  domainName: string;
  certificateArn: string;
  hostedZoneId: string;
  hostedZoneName: string;
}

export class EstimateNestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EstimateNestStackProps) {
    super(scope, id, props);

    // ====================
    // DynamoDB Tables
    // ====================

    const roomsTable = new dynamodb.Table(this, 'RoomsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
    });

    const roomCodesTable = new dynamodb.Table(this, 'RoomCodesTable', {
      partitionKey: { name: 'shortCode', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
    });

    const participantsTable = new dynamodb.Table(this, 'ParticipantsTable', {
      partitionKey: { name: 'roomId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'participantId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
    });

    participantsTable.addGlobalSecondaryIndex({
      indexName: 'ConnectionIdIndex',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const roundsTable = new dynamodb.Table(this, 'RoundsTable', {
      partitionKey: { name: 'roomId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'roundId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
    });

    const votesTable = new dynamodb.Table(this, 'VotesTable', {
      partitionKey: { name: 'roundId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'participantId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
    });

    // ====================
    // Lambda Functions
    // ====================

    const createRoomHandler = new lambdaNodejs.NodejsFunction(this, 'CreateRoomHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../backend/dist/handlers/create-room.js',
      handler: 'handler',
      projectRoot: path.join(__dirname, '..', '..'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),

      environment: {
        ROOMS_TABLE: roomsTable.tableName,
        ROOM_CODES_TABLE: roomCodesTable.tableName,
        DOMAIN_NAME: props.domainName || 'example.com',
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.ESM,
      },
    });

    const websocketConnectHandler = new lambdaNodejs.NodejsFunction(
      this,
      'WebSocketConnectHandler',
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: '../backend/dist/handlers/websocket-connect.js',
        handler: 'handler',
        projectRoot: path.join(__dirname, '..', '..'),
        depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),
        environment: {
          PARTICIPANTS_TABLE: participantsTable.tableName,
        },
        bundling: {
          format: lambdaNodejs.OutputFormat.ESM,
        },
      }
    );

    const websocketDisconnectHandler = new lambdaNodejs.NodejsFunction(
      this,
      'WebSocketDisconnectHandler',
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: '../backend/dist/handlers/websocket-disconnect.js',
        handler: 'handler',
        projectRoot: path.join(__dirname, '..', '..'),
        depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),
        environment: {
          PARTICIPANTS_TABLE: participantsTable.tableName,
        },
        bundling: {
          format: lambdaNodejs.OutputFormat.ESM,
        },
      }
    );

    const voteHandler = new lambdaNodejs.NodejsFunction(this, 'VoteHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../backend/dist/handlers/vote.js',
      handler: 'handler',
      projectRoot: path.join(__dirname, '..', '..'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),

      environment: {
        VOTES_TABLE: votesTable.tableName,
        ROUNDS_TABLE: roundsTable.tableName,
        PARTICIPANTS_TABLE: participantsTable.tableName,
        ROOMS_TABLE: roomsTable.tableName,
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.ESM,
      },
    });

    const webSocketApi = new apigatewayv2.WebSocketApi(this, 'WebSocketApi', {
      apiName: `estimatenest-ws-${props.envName}`,
      routeSelectionExpression: '$request.body.type',
      connectRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          'ConnectIntegration',
          websocketConnectHandler
        ),
      },
      disconnectRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          'DisconnectIntegration',
          websocketDisconnectHandler
        ),
      },
    });

    webSocketApi.addRoute('vote', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'VoteIntegration',
        voteHandler
      ),
    });

    webSocketApi.addRoute('reveal', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'RevealIntegration',
        voteHandler
      ),
    });

    webSocketApi.addRoute('join', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'JoinIntegration',
        voteHandler
      ),
    });

    webSocketApi.addRoute('updateParticipant', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'UpdateParticipantIntegration',
        voteHandler
      ),
    });

    webSocketApi.addRoute('newRound', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'NewRoundIntegration',
        voteHandler
      ),
    });

    webSocketApi.addRoute('updateRound', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'UpdateRoundIntegration',
        voteHandler
      ),
    });

    webSocketApi.addRoute('$default', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'DefaultIntegration',
        voteHandler
      ),
    });

    const webSocketStage = new apigatewayv2.WebSocketStage(this, 'WebSocketStage', {
      webSocketApi,
      stageName: props.envName,
      autoDeploy: true,
    });

    const joinRoomHandler = new lambdaNodejs.NodejsFunction(this, 'JoinRoomHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../backend/dist/handlers/join-room.js',
      handler: 'handler',
      projectRoot: path.join(__dirname, '..', '..'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),

      environment: {
        ROOM_CODES_TABLE: roomCodesTable.tableName,
        PARTICIPANTS_TABLE: participantsTable.tableName,
        WEBSOCKET_URL: webSocketStage.url,
        ROUNDS_TABLE: roundsTable.tableName,
        VOTES_TABLE: votesTable.tableName,
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.ESM,
      },
    });

    const roundHistoryHandler = new lambdaNodejs.NodejsFunction(this, 'RoundHistoryHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../backend/dist/handlers/round-history.js',
      handler: 'handler',
      projectRoot: path.join(__dirname, '..', '..'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),

      environment: {
        ROOM_CODES_TABLE: roomCodesTable.tableName,
        ROUNDS_TABLE: roundsTable.tableName,
        VOTES_TABLE: votesTable.tableName,
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.ESM,
      },
    });

    const updateRoomHandler = new lambdaNodejs.NodejsFunction(this, 'UpdateRoomHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: '../backend/dist/handlers/update-room.js',
      handler: 'handler',
      projectRoot: path.join(__dirname, '..', '..'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),

      environment: {
        ROOMS_TABLE: roomsTable.tableName,
        ROOM_CODES_TABLE: roomCodesTable.tableName,
        PARTICIPANTS_TABLE: participantsTable.tableName,
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.ESM,
      },
    });

    // Grant permissions
    roomsTable.grantReadWriteData(createRoomHandler);
    roomCodesTable.grantReadWriteData(createRoomHandler);
    roomCodesTable.grantReadData(joinRoomHandler);
    participantsTable.grantReadWriteData(joinRoomHandler);
    roundsTable.grantReadData(joinRoomHandler);
    votesTable.grantReadData(joinRoomHandler);
    roomCodesTable.grantReadData(roundHistoryHandler);
    roundsTable.grantReadData(roundHistoryHandler);
    votesTable.grantReadData(roundHistoryHandler);
    participantsTable.grantReadWriteData(websocketConnectHandler);
    participantsTable.grantReadWriteData(websocketDisconnectHandler);
    votesTable.grantReadWriteData(voteHandler);
    roundsTable.grantReadWriteData(voteHandler);
    participantsTable.grantReadWriteData(voteHandler);
    roomsTable.grantReadData(voteHandler);
    roomsTable.grantReadWriteData(updateRoomHandler);
    roomCodesTable.grantReadData(updateRoomHandler);
    participantsTable.grantReadData(updateRoomHandler);

    // Grant WebSocket API permissions for broadcasting
    webSocketApi.grantManageConnections(websocketConnectHandler);
    webSocketApi.grantManageConnections(websocketDisconnectHandler);
    webSocketApi.grantManageConnections(voteHandler);
    webSocketApi.grantManageConnections(joinRoomHandler);

    // ====================
    // API Gateway (REST)
    // ====================

    // Configure CORS: allow custom domain if configured, otherwise all origins
    const corsAllowOrigins =
      props.certificateArn && props.hostedZoneId
        ? [`https://${props.domainName}`]
        : apigateway.Cors.ALL_ORIGINS;

    const restApi = new apigateway.RestApi(this, 'RestApi', {
      restApiName: `estimatenest-rest-${props.envName}`,
      defaultCorsPreflightOptions: {
        allowOrigins: corsAllowOrigins,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['*'],
        allowCredentials: false,
      },
    });

    const roomsResource = restApi.root.addResource('rooms');
    roomsResource.addMethod('POST', new apigateway.LambdaIntegration(createRoomHandler));
    const roomByCodeResource = roomsResource.addResource('{code}');
    roomByCodeResource.addMethod('GET', new apigateway.LambdaIntegration(joinRoomHandler));
    roomByCodeResource.addMethod('PUT', new apigateway.LambdaIntegration(updateRoomHandler));
    const roomHistoryResource = roomByCodeResource.addResource('history');
    roomHistoryResource.addMethod('GET', new apigateway.LambdaIntegration(roundHistoryHandler));

    // ====================
    // API Gateway (WebSocket)
    // ====================

    // ====================
    // Frontend Hosting (S3 + CloudFront)
    // ====================

    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Security headers policy for CloudFront
    const securityHeadersPolicy = cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS;

    // If domain is provided, set up custom domain
    let distributionProps: cloudfront.DistributionProps = {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: new cloudfrontOrigins.S3Origin(frontendBucket),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeadersPolicy,
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    };

    // If certificate ARN is provided, add domain and certificate
    let certificate: acm.ICertificate | undefined;
    let hostedZone: route53.IHostedZone | undefined;
    if (props.certificateArn && props.hostedZoneId) {
      certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn);
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      });

      distributionProps = {
        ...distributionProps,
        domainNames: [props.domainName],
        certificate,
      };
    }

    const distribution = new cloudfront.Distribution(this, 'Distribution', distributionProps);

    if (certificate && hostedZone) {
      new route53.ARecord(this, 'CloudFrontAliasRecord', {
        zone: hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
      });

      // Create www redirect for production root domain
      if (props.envName === 'prod' && props.domainName === 'estimatenest.net') {
        const wwwDomainName = `www.${props.domainName}`;

        // CloudFront function for www→root redirect
        const redirectFunction = new cloudfront.Function(this, 'WwwRedirectFunction', {
          code: cloudfront.FunctionCode.fromInline(`
            function handler(event) {
              var request = event.request;
              var host = request.headers.host.value;
              var uri = request.uri;
              var qs = request.querystring;
              var qsParts = [];
              for (var key in qs) {
                if (qs.hasOwnProperty(key)) {
                  qsParts.push(key + '=' + encodeURIComponent(qs[key].value));
                }
              }
              var querystring = qsParts.length > 0 ? '?' + qsParts.join('&') : '';
              
              // Remove www. prefix if present
              var nonWwwHost = host;
              if (nonWwwHost.toLowerCase().indexOf('www.') === 0) {
                nonWwwHost = nonWwwHost.substring(4);
              }
              // Redirect to non‑www HTTPS
              return {
                statusCode: 301,
                statusDescription: 'Moved Permanently',
                headers: {
                  location: { value: 'https://' + nonWwwHost + uri + querystring }
                }
              };
            }
          `),
        });

        const wwwDistribution = new cloudfront.Distribution(this, 'WwwDistribution', {
          defaultRootObject: '',
          domainNames: [wwwDomainName],
          certificate,
          defaultBehavior: {
            origin: new cloudfrontOrigins.S3Origin(frontendBucket),
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            responseHeadersPolicy: securityHeadersPolicy,
            functionAssociations: [
              {
                function: redirectFunction,
                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
              },
            ],
          },
          errorResponses: [
            {
              httpStatus: 403,
              responseHttpStatus: 200,
              responsePagePath: '/index.html',
            },
            {
              httpStatus: 404,
              responseHttpStatus: 200,
              responsePagePath: '/index.html',
            },
          ],
        });

        new route53.ARecord(this, 'WwwCloudFrontAliasRecord', {
          zone: hostedZone,
          recordName: wwwDomainName,
          target: route53.RecordTarget.fromAlias(
            new route53Targets.CloudFrontTarget(wwwDistribution)
          ),
        });
      }
    }

    // ====================
    // Outputs
    // ====================

    // Determine frontend URL: custom domain if configured, otherwise CloudFront domain
    const frontendUrl =
      certificate && hostedZone
        ? `https://${props.domainName}`
        : `https://${distribution.distributionDomainName}`;

    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: frontendUrl,
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: frontendBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
    });

    new cdk.CfnOutput(this, 'RestApiUrl', {
      value: restApi.url,
    });

    new cdk.CfnOutput(this, 'WebSocketUrl', {
      value: webSocketStage.url,
    });
  }
}
