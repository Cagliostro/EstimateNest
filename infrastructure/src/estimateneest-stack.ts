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
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import * as path from 'path';

export interface EstimateNestStackProps extends cdk.StackProps {
  envName: string;
  deploymentColor?: 'blue' | 'green';
  domainName: string;
  certificateArn: string;
  hostedZoneId: string;
  hostedZoneName: string;
  apiCertificateArn?: string;
}

export class EstimateNestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EstimateNestStackProps) {
    super(scope, id, props);

    const isProduction = props.envName === 'prod';
    const deploymentColor = props.deploymentColor || 'blue';
    const colorSuffix = deploymentColor ? `-${deploymentColor}` : '';

    // ====================
    // DynamoDB Tables
    // ====================

    const roomsTable = new dynamodb.Table(this, 'RoomsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: isProduction
        ? dynamodb.BillingMode.PROVISIONED
        : dynamodb.BillingMode.PAY_PER_REQUEST,
      readCapacity: isProduction ? 5 : undefined,
      writeCapacity: isProduction ? 5 : undefined,
      timeToLiveAttribute: 'expiresAt',
    });

    const roomCodesTable = new dynamodb.Table(this, 'RoomCodesTable', {
      partitionKey: { name: 'shortCode', type: dynamodb.AttributeType.STRING },
      billingMode: isProduction
        ? dynamodb.BillingMode.PROVISIONED
        : dynamodb.BillingMode.PAY_PER_REQUEST,
      readCapacity: isProduction ? 5 : undefined,
      writeCapacity: isProduction ? 5 : undefined,
      timeToLiveAttribute: 'expiresAt',
    });

    const participantsTable = new dynamodb.Table(this, 'ParticipantsTable', {
      partitionKey: { name: 'roomId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'participantId', type: dynamodb.AttributeType.STRING },
      billingMode: isProduction
        ? dynamodb.BillingMode.PROVISIONED
        : dynamodb.BillingMode.PAY_PER_REQUEST,
      readCapacity: isProduction ? 5 : undefined,
      writeCapacity: isProduction ? 5 : undefined,
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
      billingMode: isProduction
        ? dynamodb.BillingMode.PROVISIONED
        : dynamodb.BillingMode.PAY_PER_REQUEST,
      readCapacity: isProduction ? 5 : undefined,
      writeCapacity: isProduction ? 5 : undefined,
      timeToLiveAttribute: 'expiresAt',
    });

    const votesTable = new dynamodb.Table(this, 'VotesTable', {
      partitionKey: { name: 'roundId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'participantId', type: dynamodb.AttributeType.STRING },
      billingMode: isProduction
        ? dynamodb.BillingMode.PROVISIONED
        : dynamodb.BillingMode.PAY_PER_REQUEST,
      readCapacity: isProduction ? 5 : undefined,
      writeCapacity: isProduction ? 5 : undefined,
      timeToLiveAttribute: 'expiresAt',
    });

    votesTable.addGlobalSecondaryIndex({
      indexName: 'RoomIdIndex',
      partitionKey: { name: 'roomId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'roundId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const rateLimitTable = new dynamodb.Table(this, 'RateLimitTable', {
      partitionKey: { name: 'key', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: isProduction
        ? dynamodb.BillingMode.PROVISIONED
        : dynamodb.BillingMode.PAY_PER_REQUEST,
      readCapacity: isProduction ? 5 : undefined,
      writeCapacity: isProduction ? 5 : undefined,
      timeToLiveAttribute: 'expiresAt',
    });

    // ====================
    // DynamoDB Auto-Scaling (Production only)
    // ====================
    if (isProduction) {
      const tables = [
        roomsTable,
        roomCodesTable,
        participantsTable,
        roundsTable,
        votesTable,
        rateLimitTable,
      ];
      tables.forEach((table) => {
        const readScaling = table.autoScaleReadCapacity({
          minCapacity: 5,
          maxCapacity: 50,
        });
        readScaling.scaleOnUtilization({
          targetUtilizationPercent: 70,
        });
        const writeScaling = table.autoScaleWriteCapacity({
          minCapacity: 5,
          maxCapacity: 50,
        });
        writeScaling.scaleOnUtilization({
          targetUtilizationPercent: 70,
        });
      });
    }

    // ====================
    // Lambda Functions
    // ====================

    const createRoomHandler = new lambdaNodejs.NodejsFunction(this, 'CreateRoomHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: '../backend/dist/handlers/create-room.js',
      handler: 'handler',
      projectRoot: path.join(__dirname, '..', '..'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,

      environment: {
        ROOMS_TABLE: roomsTable.tableName,
        ROOM_CODES_TABLE: roomCodesTable.tableName,
        DOMAIN_NAME: props.domainName || 'example.com',
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.CJS,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    const websocketConnectHandler = new lambdaNodejs.NodejsFunction(
      this,
      'WebSocketConnectHandler',
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        entry: '../backend/dist/handlers/websocket-connect.js',
        handler: 'handler',
        projectRoot: path.join(__dirname, '..', '..'),
        depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),
        timeout: cdk.Duration.seconds(5),
        memorySize: 256,

        environment: {
          PARTICIPANTS_TABLE: participantsTable.tableName,
        },
        bundling: {
          format: lambdaNodejs.OutputFormat.CJS,
        },
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    const websocketDisconnectHandler = new lambdaNodejs.NodejsFunction(
      this,
      'WebSocketDisconnectHandler',
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        entry: '../backend/dist/handlers/websocket-disconnect.js',
        handler: 'handler',
        projectRoot: path.join(__dirname, '..', '..'),
        depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),
        timeout: cdk.Duration.seconds(5),
        memorySize: 256,

        environment: {
          PARTICIPANTS_TABLE: participantsTable.tableName,
        },
        bundling: {
          format: lambdaNodejs.OutputFormat.CJS,
        },
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    const voteHandler = new lambdaNodejs.NodejsFunction(this, 'VoteHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: '../backend/dist/handlers/vote.js',
      handler: 'handler',
      projectRoot: path.join(__dirname, '..', '..'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,

      environment: {
        VOTES_TABLE: votesTable.tableName,
        ROUNDS_TABLE: roundsTable.tableName,
        PARTICIPANTS_TABLE: participantsTable.tableName,
        ROOMS_TABLE: roomsTable.tableName,
        RATE_LIMIT_TABLE: rateLimitTable.tableName,
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.CJS,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    const webSocketApi = new apigatewayv2.WebSocketApi(this, 'WebSocketApi', {
      apiName: `estimatenest-ws-${props.envName}${colorSuffix}`,
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

    // Add throttling settings via L1 construct
    const cfnStage = webSocketStage.node.defaultChild as apigatewayv2.CfnStage;
    cfnStage.defaultRouteSettings = {
      throttlingBurstLimit: 20,
      throttlingRateLimit: 5,
    };

    // ====================
    // API Gateway Custom Domains
    // ====================
    let restApiDomain: apigateway.DomainName | undefined;
    let webSocketApiDomain: apigatewayv2.DomainName | undefined;
    let restApiCustomUrl: string | undefined;
    let webSocketCustomUrl: string | undefined;

    const restApiSubdomain =
      deploymentColor === 'blue'
        ? `api.${props.domainName}`
        : `api-${deploymentColor}.${props.domainName}`;
    const webSocketSubdomain =
      deploymentColor === 'blue'
        ? `ws.${props.domainName}`
        : `ws-${deploymentColor}.${props.domainName}`;

    // If API certificate is provided, set up custom domains for REST and WebSocket APIs
    const apiCertificateArn = props.apiCertificateArn || props.certificateArn;
    if (apiCertificateArn && props.hostedZoneId) {
      const apiCertificate = acm.Certificate.fromCertificateArn(
        this,
        'ApiCertificate',
        apiCertificateArn
      );
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ApiHostedZone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      });

      // REST API custom domain
      restApiDomain = new apigateway.DomainName(this, 'RestApiDomain', {
        domainName: restApiSubdomain,
        certificate: apiCertificate,
        endpointType: apigateway.EndpointType.REGIONAL,
        securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
      });

      // Map the domain to the REST API (deferred until REST API is created)

      // WebSocket API custom domain
      webSocketApiDomain = new apigatewayv2.DomainName(this, 'WebSocketApiDomain', {
        domainName: webSocketSubdomain,
        certificate: apiCertificate,
      });

      // Map the domain to the WebSocket API (deferred until WebSocket API is created)

      // Create Route53 A records for custom domains
      new route53.ARecord(this, 'RestApiAliasRecord', {
        zone: hostedZone,
        recordName: restApiSubdomain,
        target: route53.RecordTarget.fromAlias(new route53Targets.ApiGatewayDomain(restApiDomain)),
      });

      new route53.ARecord(this, 'WebSocketApiAliasRecord', {
        zone: hostedZone,
        recordName: webSocketSubdomain,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.ApiGatewayv2DomainProperties(
            webSocketApiDomain.regionalDomainName,
            webSocketApiDomain.regionalHostedZoneId
          )
        ),
      });

      // Custom URLs for outputs
      restApiCustomUrl = `https://${restApiSubdomain}`;
      webSocketCustomUrl = `wss://${webSocketSubdomain}`;
    }

    const joinRoomHandler = new lambdaNodejs.NodejsFunction(this, 'JoinRoomHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: '../backend/dist/handlers/join-room.js',
      handler: 'handler',
      projectRoot: path.join(__dirname, '..', '..'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,

      environment: {
        ROOM_CODES_TABLE: roomCodesTable.tableName,
        PARTICIPANTS_TABLE: participantsTable.tableName,
        WEBSOCKET_URL: webSocketCustomUrl || webSocketStage.url,
        ROUNDS_TABLE: roundsTable.tableName,
        VOTES_TABLE: votesTable.tableName,
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.CJS,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    const roundHistoryHandler = new lambdaNodejs.NodejsFunction(this, 'RoundHistoryHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: '../backend/dist/handlers/round-history.js',
      handler: 'handler',
      projectRoot: path.join(__dirname, '..', '..'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,

      environment: {
        ROOM_CODES_TABLE: roomCodesTable.tableName,
        ROUNDS_TABLE: roundsTable.tableName,
        VOTES_TABLE: votesTable.tableName,
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.CJS,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    const updateRoomHandler = new lambdaNodejs.NodejsFunction(this, 'UpdateRoomHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: '../backend/dist/handlers/update-room.js',
      handler: 'handler',
      projectRoot: path.join(__dirname, '..', '..'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,

      environment: {
        ROOMS_TABLE: roomsTable.tableName,
        ROOM_CODES_TABLE: roomCodesTable.tableName,
        PARTICIPANTS_TABLE: participantsTable.tableName,
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.CJS,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    const healthHandler = new lambdaNodejs.NodejsFunction(this, 'HealthHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: '../backend/dist/handlers/health.js',
      handler: 'handler',
      projectRoot: path.join(__dirname, '..', '..'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),
      timeout: cdk.Duration.seconds(3),
      memorySize: 128,

      environment: {
        ENVIRONMENT: props.envName,
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.CJS,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions - principle of least privilege
    // create-room.ts: Only writes to rooms and room codes tables
    roomsTable.grantWriteData(createRoomHandler);
    roomCodesTable.grantWriteData(createRoomHandler);
    // join-room.ts: Reads room codes, reads/writes participants, reads rounds and votes
    roomCodesTable.grantReadData(joinRoomHandler);
    // Granular permissions for participants table: GetItem, Query, PutItem, UpdateItem
    joinRoomHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [participantsTable.tableArn],
      })
    );
    roundsTable.grantReadData(joinRoomHandler);
    votesTable.grantReadData(joinRoomHandler);
    // round-history.ts: Reads room codes, rounds, and votes
    roomCodesTable.grantReadData(roundHistoryHandler);
    roundsTable.grantReadData(roundHistoryHandler);
    votesTable.grantReadData(roundHistoryHandler);
    // websocket-connect.ts and websocket-disconnect.ts: Read/write participants only
    participantsTable.grantReadWriteData(websocketConnectHandler);
    participantsTable.grantReadWriteData(websocketDisconnectHandler);
    // vote.ts (WebSocket): Read/write votes, rounds, participants; read rooms; rate limiting
    // Granular permissions per table
    // roomsTable: GetItem only
    voteHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [roomsTable.tableArn],
      })
    );
    // rateLimitTable: Query, PutItem
    voteHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:PutItem'],
        resources: [rateLimitTable.tableArn],
      })
    );
    // participantsTable: Query, UpdateItem (including GSI queries)
    voteHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:UpdateItem'],
        resources: [participantsTable.tableArn, `${participantsTable.tableArn}/index/*`],
      })
    );
    // roundsTable: GetItem, Query, PutItem, UpdateItem, TransactWriteItems
    voteHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:TransactWriteItems',
        ],
        resources: [roundsTable.tableArn],
      })
    );
    // votesTable: Query, PutItem, TransactWriteItems
    voteHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:TransactWriteItems'],
        resources: [votesTable.tableArn],
      })
    );
    // update-room.ts: Read/write rooms, read room codes, read participants (for moderator check)
    roomsTable.grantReadWriteData(updateRoomHandler);
    roomCodesTable.grantReadData(updateRoomHandler);
    participantsTable.grantReadData(updateRoomHandler);

    // Grant WebSocket API permissions for broadcasting
    webSocketApi.grantManageConnections(websocketConnectHandler);
    webSocketApi.grantManageConnections(websocketDisconnectHandler);
    webSocketApi.grantManageConnections(voteHandler);
    webSocketApi.grantManageConnections(joinRoomHandler);

    // Also grant invoke permissions for sending messages
    const invokeArn = webSocketApi.arnForExecuteApi('*', '/@connections/*');
    [websocketConnectHandler, websocketDisconnectHandler, voteHandler, joinRoomHandler].forEach(
      (handler) => {
        handler.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['execute-api:Invoke'],
            resources: [invokeArn],
          })
        );
      }
    );

    // ====================
    // API Gateway (REST)
    // ====================

    // Configure CORS: allow custom domain if configured, otherwise all origins
    // TODO: Revert to stricter CORS after debugging
    const corsAllowOrigins = apigateway.Cors.ALL_ORIGINS;

    const restApi = new apigateway.RestApi(this, 'RestApi', {
      restApiName: `estimatenest-rest-${props.envName}${colorSuffix}`,
      defaultCorsPreflightOptions: {
        allowOrigins: corsAllowOrigins,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['*'],
        allowCredentials: false,
      },
    });

    // Map custom domains if they were created
    if (restApiDomain) {
      restApiDomain.addBasePathMapping(restApi, {
        stage: restApi.deploymentStage,
      });
    }
    if (webSocketApiDomain) {
      new apigatewayv2.ApiMapping(this, 'WebSocketApiMapping', {
        api: webSocketApi,
        domainName: webSocketApiDomain,
        stage: webSocketStage,
      });
    }

    const healthResource = restApi.root.addResource('health');
    healthResource.addMethod('GET', new apigateway.LambdaIntegration(healthHandler));

    const roomsResource = restApi.root.addResource('rooms');
    roomsResource.addMethod('POST', new apigateway.LambdaIntegration(createRoomHandler), {
      apiKeyRequired: true,
    });
    const roomByCodeResource = roomsResource.addResource('{code}');
    roomByCodeResource.addMethod('GET', new apigateway.LambdaIntegration(joinRoomHandler), {
      apiKeyRequired: true,
    });
    roomByCodeResource.addMethod('PUT', new apigateway.LambdaIntegration(updateRoomHandler), {
      apiKeyRequired: true,
    });
    const roomHistoryResource = roomByCodeResource.addResource('history');
    roomHistoryResource.addMethod('GET', new apigateway.LambdaIntegration(roundHistoryHandler), {
      apiKeyRequired: true,
    });

    // ====================
    // API Gateway Rate Limiting (Usage Plan)
    // ====================
    const usagePlan = new apigateway.UsagePlan(this, 'RestApiUsagePlan', {
      name: `estimatenest-rest-${props.envName}-usage-plan`,
      throttle: {
        rateLimit: 1.67, // 100 requests per minute
        burstLimit: 10,
      },
      quota: {
        limit: 10000, // total requests per month (soft limit)
        period: apigateway.Period.MONTH,
      },
    });
    usagePlan.addApiStage({
      stage: restApi.deploymentStage,
    });

    // Create API Key for REST API with deterministic value for each environment
    const apiKeyValue = `estimatenest-${props.envName}${colorSuffix}-${this.account}-${this.region}`;
    const restApiKey = new apigateway.CfnApiKey(this, 'RestApiKey', {
      name: `estimatenest-rest-${props.envName}${colorSuffix}-key`,
      enabled: true,
      value: apiKeyValue,
    });

    // Associate API Key with Usage Plan
    usagePlan.addApiKey(restApiKey);

    // ====================
    // API Gateway (WebSocket)
    // ====================

    // ====================
    // Frontend Hosting (S3 + CloudFront)
    // ====================

    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `estimatenest-${props.envName}${colorSuffix}-frontend-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Security headers policy for CloudFront
    const securityHeadersPolicy = cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS;

    // Cache policy for static assets
    const cachePolicy = new cloudfront.CachePolicy(this, 'StaticCachePolicy', {
      defaultTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.days(1),
      maxTtl: cdk.Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // If domain is provided, set up custom domain
    let distributionProps: cloudfront.DistributionProps = {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: new cloudfrontOrigins.S3Origin(frontendBucket),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeadersPolicy,
        cachePolicy: cachePolicy,
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

      // Only add domain aliases for blue deployment to avoid CloudFront CNAME conflicts
      // Green deployment will still receive traffic via weighted Route 53 records pointing to its CloudFront domain
      const domainNames = deploymentColor === 'blue' ? [props.domainName] : [];
      distributionProps = {
        ...distributionProps,
        domainNames,
        certificate,
      };
    }

    const distribution = new cloudfront.Distribution(this, 'Distribution', distributionProps);

    if (certificate && hostedZone) {
      // Weighted Route 53 record for blue-green deployments
      // Each deployment color adds its own weighted record entry
      const weight = deploymentColor === 'blue' ? 100 : 0;
      new route53.ARecord(this, 'CloudFrontAliasRecord', {
        zone: hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
        weight: weight,
        setIdentifier: `cloudfront-${deploymentColor}`,
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
          domainNames: deploymentColor === 'blue' ? [wwwDomainName] : [],
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

        // Weighted Route 53 record for www redirect (blue-green)
        new route53.ARecord(this, 'WwwCloudFrontAliasRecord', {
          zone: hostedZone,
          recordName: wwwDomainName,
          target: route53.RecordTarget.fromAlias(
            new route53Targets.CloudFrontTarget(wwwDistribution)
          ),
          weight: weight,
          setIdentifier: `www-cloudfront-${deploymentColor}`,
        });

        // Output for www CloudFront domain (for blue-green traffic switching)
        new cdk.CfnOutput(this, 'WwwCloudFrontDomainName', {
          value: wwwDistribution.distributionDomainName,
        });
      }
    }

    // ====================
    // SNS Alerting Topic
    // ====================

    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      displayName: `EstimateNest-${props.envName}-${deploymentColor}-Alerts`,
    });

    // ====================
    // CloudWatch Alarms
    // ====================

    // Lambda error alarms (>1% error rate)
    const lambdaFunctions = [
      createRoomHandler,
      joinRoomHandler,
      updateRoomHandler,
      roundHistoryHandler,
      voteHandler,
      websocketConnectHandler,
      websocketDisconnectHandler,
    ];

    lambdaFunctions.forEach((func, index) => {
      const errorsMetric = func.metricErrors({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });
      const invocationsMetric = func.metricInvocations({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      // Error rate alarm (threshold: >1% error rate)
      const errorRateAlarm = new cloudwatch.Alarm(this, `LambdaErrorRateAlarm${index}`, {
        alarmName: `${func.functionName}-ErrorRate`,
        metric: new cloudwatch.MathExpression({
          expression: 'errors / invocations * 100',
          usingMetrics: {
            errors: errorsMetric,
            invocations: invocationsMetric,
          },
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1, // 1% error rate
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      // Add SNS alert actions
      errorRateAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
      errorRateAlarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));

      // Add alarm description
      errorRateAlarm.node.addMetadata('description', `Error rate >1% for ${func.functionName}`);
    });

    // DynamoDB throttling alarms
    const tables = [roomsTable, roomCodesTable, participantsTable, roundsTable, votesTable];
    tables.forEach((table, index) => {
      const throttledRequests = table.metricThrottledRequests({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      // Throttle alarm
      const throttleAlarm = new cloudwatch.Alarm(this, `DynamoDBThrottleAlarm${index}`, {
        alarmName: `${table.tableName}-Throttles`,
        metric: throttledRequests,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      // Add SNS alert actions
      throttleAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
      throttleAlarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));
    });

    // WebSocket API error alarm (using CloudWatch metrics from API Gateway)
    const webSocketApiMetricErrors = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '4XXError',
      dimensionsMap: {
        ApiId: webSocketApi.apiId,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const webSocketApi4xxAlarm = new cloudwatch.Alarm(this, 'WebSocketApi4xxAlarm', {
      alarmName: `WebSocketApi-${webSocketApi.apiId}-4XXErrors`,
      metric: webSocketApiMetricErrors,
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // Add SNS alert actions
    webSocketApi4xxAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
    webSocketApi4xxAlarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));

    // WebSocket disconnect alarm
    const webSocketDisconnectMetric = new cloudwatch.Metric({
      namespace: 'AWS/ApiGatewayV2',
      metricName: 'DisconnectCount',
      dimensionsMap: {
        ApiId: webSocketApi.apiId,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const webSocketDisconnectAlarm = new cloudwatch.Alarm(this, 'WebSocketDisconnectAlarm', {
      alarmName: `WebSocketApi-${webSocketApi.apiId}-DisconnectCount`,
      metric: webSocketDisconnectMetric,
      threshold: 20, // Alert if more than 20 disconnections in 5 minutes
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // Add SNS alert actions
    webSocketDisconnectAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
    webSocketDisconnectAlarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));

    // REST API error alarm (4XX errors including rate limiting)
    const restApiMetricErrors = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '4XXError',
      dimensionsMap: {
        ApiId: restApi.restApiId,
        Stage: restApi.deploymentStage.stageName,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const restApi4xxAlarm = new cloudwatch.Alarm(this, 'RestApi4xxAlarm', {
      alarmName: `RestApi-${restApi.restApiId}-4XXErrors`,
      metric: restApiMetricErrors,
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // Add SNS alert actions
    restApi4xxAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
    restApi4xxAlarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));

    // DynamoDB latency alarm (Votes table)
    const votesTableLatencyAlarm = new cloudwatch.Alarm(this, 'VotesTableLatencyAlarm', {
      alarmName: `DynamoDB-${votesTable.tableName}-LatencyP99`,
      metric: votesTable.metricSuccessfulRequestLatency({
        statistic: 'p99',
        period: cdk.Duration.minutes(5),
        dimensionsMap: { Operation: 'Query' },
      }),
      threshold: 100, // milliseconds
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    votesTableLatencyAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
    votesTableLatencyAlarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));

    // ====================
    // CloudWatch Dashboard
    // ====================

    const dashboard = new cloudwatch.Dashboard(this, 'MonitoringDashboard', {
      dashboardName: `EstimateNest-${props.envName}-${deploymentColor}-Monitoring`,
    });

    // Lambda error rate widget
    const lambdaErrorWidget = new cloudwatch.GraphWidget({
      title: 'Lambda Error Rates',
      left: lambdaFunctions.map((func) =>
        func.metricErrors({ statistic: 'Sum', period: cdk.Duration.minutes(5) })
      ),
      right: lambdaFunctions.map((func) =>
        func.metricInvocations({ statistic: 'Sum', period: cdk.Duration.minutes(5) })
      ),
      leftYAxis: { label: 'Errors', showUnits: false },
      rightYAxis: { label: 'Invocations', showUnits: false },
      width: 24,
    });

    // DynamoDB throttling widget
    const dynamoDbThrottleWidget = new cloudwatch.GraphWidget({
      title: 'DynamoDB Throttled Requests (Query)',
      left: tables.map((table) =>
        table.metricThrottledRequestsForOperation('Query', {
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        })
      ),
      leftYAxis: { label: 'Throttles', showUnits: false },
      width: 24,
    });

    // DynamoDB latency widget
    const dynamoDbLatencyWidget = new cloudwatch.GraphWidget({
      title: 'DynamoDB Query Latency (p99)',
      left: tables.map((table) =>
        table.metricSuccessfulRequestLatency({
          statistic: 'p99',
          period: cdk.Duration.minutes(5),
          dimensionsMap: { Operation: 'Query' },
        })
      ),
      leftYAxis: { label: 'Latency (ms)', showUnits: false },
      width: 24,
    });

    // WebSocket metrics widget
    const webSocketWidget = new cloudwatch.GraphWidget({
      title: 'WebSocket API Metrics',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/ApiGatewayV2',
          metricName: 'ConnectCount',
          dimensionsMap: { ApiId: webSocketApi.apiId },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/ApiGatewayV2',
          metricName: 'DisconnectCount',
          dimensionsMap: { ApiId: webSocketApi.apiId },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/ApiGatewayV2',
          metricName: 'MessageCount',
          dimensionsMap: { ApiId: webSocketApi.apiId },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
      ],
      leftYAxis: { label: 'Count', showUnits: false },
      width: 24,
    });

    // REST API errors widget
    const restApiWidget = new cloudwatch.GraphWidget({
      title: 'REST API 4XX Errors',
      left: [restApiMetricErrors],
      leftYAxis: { label: 'Errors', showUnits: false },
      width: 24,
    });

    // Add widgets to dashboard
    dashboard.addWidgets(lambdaErrorWidget);
    dashboard.addWidgets(dynamoDbThrottleWidget);
    dashboard.addWidgets(dynamoDbLatencyWidget);
    dashboard.addWidgets(webSocketWidget);
    dashboard.addWidgets(restApiWidget);

    // WAF blocked requests alarm (if WAF is enabled)
    // Will be added after WAF is created (see below)

    // ====================
    // WAF (Web Application Firewall)
    // ====================

    // Regional Web ACL for API Gateway (REST and WebSocket)
    const regionalWebAcl = new wafv2.CfnWebACL(this, 'RegionalWebACL', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `estimatenest-${props.envName}-regional-webacl`,
        sampledRequestsEnabled: true,
      },
      rules: [
        // Allow OPTIONS requests for CORS preflight
        {
          name: 'AllowOPTIONS',
          priority: 0,
          action: { allow: {} },
          statement: {
            byteMatchStatement: {
              fieldToMatch: { method: {} },
              positionalConstraint: 'EXACTLY',
              searchString: 'OPTIONS',
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `estimatenest-${props.envName}-allow-options`,
            sampledRequestsEnabled: true,
          },
        },
        // AWS Managed Rules - OWASP Top 10
        {
          name: 'AWS-AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `estimatenest-${props.envName}-owasp-common`,
            sampledRequestsEnabled: true,
          },
        },
        // Rate-based rule for REST API (limit 100 requests per 5 minutes per IP)
        {
          name: 'RateLimitREST',
          priority: 2,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 100,
              aggregateKeyType: 'IP',
              // Apply to REST API paths
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'STARTS_WITH',
                  searchString: '/rooms',
                  textTransformations: [{ priority: 0, type: 'NONE' }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `estimatenest-${props.envName}-rest-ratelimit`,
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Associate Web ACL with REST API Gateway
    new wafv2.CfnWebACLAssociation(this, 'RestApiWebACLAssociation', {
      resourceArn: restApi.deploymentStage.stageArn,
      webAclArn: regionalWebAcl.attrArn,
    });

    // Global Web ACL for CloudFront (if using custom domain)
    // Note: WAFv2 with CLOUDFRONT scope must be deployed in us-east-1 region
    if (certificate && hostedZone && this.region === 'us-east-1') {
      const globalWebAcl = new wafv2.CfnWebACL(this, 'GlobalWebACL', {
        defaultAction: { allow: {} },
        scope: 'CLOUDFRONT',
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `estimatenest-${props.envName}-global-webacl`,
          sampledRequestsEnabled: true,
        },
        rules: [
          {
            name: 'AWS-AWSManagedRulesCommonRuleSet',
            priority: 0,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: 'AWSManagedRulesCommonRuleSet',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: `estimatenest-${props.envName}-cf-owasp`,
              sampledRequestsEnabled: true,
            },
          },
        ],
      });

      // Associate with CloudFront distribution
      new wafv2.CfnWebACLAssociation(this, 'CloudFrontWebACLAssociation', {
        resourceArn: `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        webAclArn: globalWebAcl.attrArn,
      });

      // Global Web ACL blocked requests alarm
      const globalBlockedMetric = new cloudwatch.Metric({
        namespace: 'AWS/WAFV2',
        metricName: 'BlockedRequests',
        dimensionsMap: {
          WebACL: globalWebAcl.ref,
          Region: 'global', // CloudFront scope uses global region
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      const globalWebAclBlockedAlarm = new cloudwatch.Alarm(this, 'GlobalWebAclBlockedAlarm', {
        alarmName: `GlobalWebACL-${globalWebAcl.ref}-BlockedRequests`,
        metric: globalBlockedMetric,
        threshold: 10,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      // Add SNS alert actions
      globalWebAclBlockedAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
      globalWebAclBlockedAlarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));
    }

    // WAF blocked requests alarms
    // Regional Web ACL blocked requests
    const regionalBlockedMetric = new cloudwatch.Metric({
      namespace: 'AWS/WAFV2',
      metricName: 'BlockedRequests',
      dimensionsMap: {
        WebACL: regionalWebAcl.ref,
        Region: this.region,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const regionalWebAclBlockedAlarm = new cloudwatch.Alarm(this, 'RegionalWebAclBlockedAlarm', {
      alarmName: `RegionalWebACL-${regionalWebAcl.ref}-BlockedRequests`,
      metric: regionalBlockedMetric,
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // Add SNS alert actions
    regionalWebAclBlockedAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
    regionalWebAclBlockedAlarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));

    // WAF blocked requests widget
    const wafWidget = new cloudwatch.GraphWidget({
      title: 'WAF Blocked Requests',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/WAFV2',
          metricName: 'BlockedRequests',
          dimensionsMap: {
            WebACL: regionalWebAcl.ref,
            Region: this.region,
          },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
      ],
      leftYAxis: { label: 'Blocked Requests', showUnits: false },
      width: 24,
    });
    dashboard.addWidgets(wafWidget);

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

    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: distribution.distributionDomainName,
    });

    new cdk.CfnOutput(this, 'RestApiUrl', {
      value: restApiCustomUrl || restApi.url,
    });

    new cdk.CfnOutput(this, 'WebSocketUrl', {
      value: webSocketCustomUrl || webSocketStage.url,
    });

    new cdk.CfnOutput(this, 'RestApiKeyValue', {
      value: apiKeyValue,
      description: 'API Key value for REST API requests',
    });
  }
}
