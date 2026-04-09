import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { config } from '../config.js';
import type { PredictionResult } from '../types/index.js';

export interface AlertConfig {
  email?: string;
  snsTopicArn?: string;
  slackWebhook?: string;
}

export class AlertService {
  private snsClient: SNSClient;
  private alertConfig: AlertConfig;

  constructor(alertConfig: AlertConfig) {
    this.snsClient = new SNSClient({ region: config.region });
    this.alertConfig = alertConfig;
  }

  async sendAlert(prediction: PredictionResult): Promise<void> {
    if (prediction.utilizationPercent < config.alertThreshold) {
      return;
    }

    const message = this.formatAlertMessage(prediction);
    const subject = `⚠️ Bedrock Quota Alert: ${prediction.modelId}`;

    const alerts: Promise<void>[] = [];

    if (this.alertConfig.snsTopicArn) {
      alerts.push(this.sendSNSAlert(subject, message));
    }

    if (this.alertConfig.slackWebhook) {
      alerts.push(this.sendSlackAlert(message));
    }

    if (this.alertConfig.email) {
      console.log(`\n📧 Email alert would be sent to: ${this.alertConfig.email}`);
      console.log(message);
    }

    await Promise.all(alerts);
  }

  private formatAlertMessage(prediction: PredictionResult): string {
    let message = `*Bedrock Quota Alert*\n\n`;
    message += `*Model:* \`${prediction.modelId}\`\n`;
    message += `*Current Usage:* ${prediction.currentUsage.toFixed(0)}\n`;
    message += `*Quota Limit:* ${prediction.quotaLimit}\n`;
    message += `*Utilization:* *${prediction.utilizationPercent.toFixed(1)}%* ${this.getUtilizationEmoji(prediction.utilizationPercent)}\n\n`;
    
    if (prediction.predictedExhaustionDate) {
      message += `⚠️ *Predicted Exhaustion:* ${prediction.predictedExhaustionDate.toLocaleDateString()}\n\n`;
    }
    
    message += `*Recommendation:* ${prediction.recommendation}\n\n`;
    message += `*Action Required:* Consider requesting a quota increase via AWS Service Quotas console.`;
    
    return message;
  }

  private getUtilizationEmoji(percent: number): string {
    if (percent >= 95) return '🔴';
    if (percent >= 90) return '🟠';
    if (percent >= 80) return '🟡';
    return '🟢';
  }

  private async sendSNSAlert(subject: string, message: string): Promise<void> {
    try {
      const command = new PublishCommand({
        TopicArn: this.alertConfig.snsTopicArn,
        Subject: subject,
        Message: message,
      });

      await this.snsClient.send(command);
      console.log('✓ SNS alert sent');
    } catch (error) {
      console.error('Error sending SNS alert:', error);
    }
  }

  private async sendSlackAlert(message: string): Promise<void> {
    try {
      const response = await fetch(this.alertConfig.slackWebhook!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: '#capacity-alerts-jacksmp',
          username: 'Bedrock AI Analyser',
          icon_emoji: ':warning:',
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '⚠️ Bedrock Quota Alert',
                emoji: true
              }
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: message
              }
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `*Region:* ${config.region} | *Time:* ${new Date().toLocaleString()}`
                }
              ]
            }
          ]
        }),
      });

      if (response.ok) {
        console.log('✓ Slack alert sent to #capacity-alerts-jacksmp');
      } else {
        console.error('Error sending Slack alert:', await response.text());
      }
    } catch (error) {
      console.error('Error sending Slack alert:', error);
    }
  }
}
