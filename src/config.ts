export const config = {
  region: process.env.AWS_REGION || 'us-east-1',
  bedrockRegions: [
    'us-east-1',
    'us-west-2',
    'eu-west-1',
    'eu-west-2',
    'eu-central-1',
    'ap-southeast-1',
    'ap-southeast-2',
    'ap-northeast-1',
    'ca-central-1',
    'sa-east-1',
  ],
  monitoringInterval: 300000, // 5 minutes
  alertThreshold: 80, // Alert at 80% usage
  predictionWindow: 7, // Days to look ahead
  dataRetention: 30, // Days to keep historical data
  models: [
    'anthropic.claude-sonnet-4-20250514-v1:0',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'anthropic.claude-3-5-sonnet-20240620-v1:0',
    'anthropic.claude-3-5-haiku-20241022-v1:0',
    'anthropic.claude-3-sonnet-20240229-v1:0',
    'anthropic.claude-3-haiku-20240307-v1:0',
    'anthropic.claude-3-opus-20240229-v1:0',
    'amazon.titan-text-express-v1',
    'amazon.nova-pro-v1:0',
    'amazon.nova-lite-v1:0',
    'amazon.nova-micro-v1:0',
  ],
  alerts: {
    snsTopicArn: process.env.SNS_TOPIC_ARN,
    slackWebhook: process.env.SLACK_WEBHOOK_URL,
    email: process.env.ALERT_EMAIL,
  },
};
