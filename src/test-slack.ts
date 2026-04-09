import { AlertService } from './lib/alertService.js';
import { config } from './config.js';
import type { PredictionResult } from './types/index.js';

async function testSlackAlert() {
  console.log('🧪 Testing Slack Alert Integration\n');
  
  if (!config.alerts.slackWebhook) {
    console.error('❌ SLACK_WEBHOOK_URL not configured in .env file');
    console.log('\nPlease add your Slack webhook URL to the .env file:');
    console.log('SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL\n');
    return;
  }

  console.log(`📡 Sending test alert to #capacity-alerts-jacksmp...`);
  console.log(`Webhook: ${config.alerts.slackWebhook.substring(0, 50)}...\n`);

  const alertService = new AlertService(config.alerts);

  // Create a test prediction that triggers an alert
  const testPrediction: PredictionResult = {
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    currentUsage: 85000,
    quotaLimit: 100000,
    utilizationPercent: 85,
    predictedExhaustionDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days from now
    recommendation: '⚠️ Quota may be exhausted in 3 days. Consider requesting an increase.',
  };

  try {
    await alertService.sendAlert(testPrediction);
    console.log('\n✅ Test alert sent successfully!');
    console.log('Check your #capacity-alerts-jacksmp channel in Slack.\n');
  } catch (error) {
    console.error('\n❌ Failed to send test alert:', error);
    console.log('\nTroubleshooting:');
    console.log('1. Verify your webhook URL is correct');
    console.log('2. Ensure the Slack app has permission to post to #capacity-alerts-jacksmp');
    console.log('3. Check that the webhook is active in your Slack app settings\n');
  }
}

testSlackAlert().catch(console.error);
