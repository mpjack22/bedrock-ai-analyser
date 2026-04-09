# Bedrock Quota Monitor

Monitor and predict AWS Bedrock quota usage across all services to avoid hitting limits.

## Features

- 🔍 Real-time quota monitoring for all Bedrock services
  - Bedrock (foundation models)
  - Bedrock Agents (AgentCore)
  - Bedrock Runtime
- 📈 Usage trend analysis  
- ⚠️ Predictive alerts for approaching limits
- 📊 Web dashboard with visual charts
- 🤖 Agent and Knowledge Base metrics
- 🔔 Multiple alert channels (SNS, Slack, Email)
- 📉 Historical data tracking

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure AWS credentials (ensure your AWS CLI is configured)

3. (Optional) Set up alerts by copying `.env.example` to `.env` and configuring:
   ```bash
   cp .env.example .env
   # Edit .env with your alert settings
   ```

## Usage

### Web Dashboard (Recommended)
Start the web interface for visual monitoring:
```bash
npm run web
```
Then open http://localhost:3000 in your browser

### CLI Commands
- `npm run monitor` - Start continuous monitoring with alerts
- `npm run predict` - Run prediction analysis
- `npm run dashboard` - View current status in terminal

## Alerts

The system sends alerts when usage exceeds 80% (configurable in `src/config.ts`):

### Slack Alerts (Recommended)

1. Create a Slack Incoming Webhook:
   - Go to https://api.slack.com/apps
   - Create a new app → "From scratch"
   - Enable "Incoming Webhooks"
   - Add webhook to your `#capacity-alerts-jacksmp` channel
   - Copy the webhook URL

2. Add to `.env`:
   ```
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
   ```

3. Test your integration:
   ```bash
   npm run test-slack
   ```

Slack alerts include:
- 🎨 Rich formatting with color-coded status
- 📊 Current usage and quota limits
- ⚠️ Predicted exhaustion dates
- 🔔 Automatic alerts when thresholds are exceeded

### SNS Alerts
Set `SNS_TOPIC_ARN` in `.env` to receive AWS SNS notifications

### Email Alerts  
Set `ALERT_EMAIL` in `.env` (requires SNS topic configured for email)

## Configuration

Edit `src/config.ts` to customize:
- `alertThreshold` - Percentage to trigger alerts (default: 80%)
- `monitoringInterval` - How often to check (default: 5 minutes)
- `predictionWindow` - Days to look ahead (default: 7)
- `models` - Which Bedrock models to track
- `region` - AWS region to monitor

