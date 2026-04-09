# Bedrock AI Analyser

A real-time monitoring dashboard for AWS Bedrock usage, capacity, and quotas. Track model invocations, token consumption, latency, throttling, and predict when you'll hit limits — all from a single web interface.

## Features

- **TPM & RPM Monitoring** — Tokens per minute and requests per minute with quota limit lines
- **Multi-Region Support** — Switch between AWS regions or view data across all Bedrock-enabled regions
- **Model Filtering** — Select one, multiple, or all models to focus your analysis
- **Flexible Time Ranges** — 1h, 3h, 6h, 12h, 24h, 3d, 7d, and 30d views
- **10 Dashboard Charts**
  - Tokens Per Minute (TPM)
  - Requests Per Minute (RPM)
  - Model Invocations Over Time
  - Token Usage (Input/Output)
  - Average Latency
  - Latency Percentiles (p50/p90/p99)
  - Errors & Throttles
  - Token Input/Output Ratio
  - Throttle Rate (%)
  - Model Invocations Breakdown
- **AI Chat Assistant** — Ask questions about your usage, get predictions, and get guidance on quota increases
- **Quota Increase Requests** — Submit AWS Service Quotas increase requests directly from the dashboard
- **Capacity Predictions** — Predict when quotas will be exhausted based on usage trends
- **User Management** — Admin panel to create and manage dashboard users
- **Login Authentication** — Session-based auth with configurable credentials
- **Auto-Discovery** — Automatically detects which Bedrock models you've used via CloudWatch

## Quick Start

### Option 1: Run Locally

Prerequisites: Node.js 20+, AWS credentials configured (`aws configure`)

```bash
git clone https://github.com/mpjack22/bedrock-ai-analyser.git
cd bedrock-ai-analyser
npm install
cp .env.example .env
# Edit .env with your settings
npm run web
```

Open http://localhost:3000 and login with the credentials from your `.env` file.

### Option 2: Deploy to AWS (CloudFormation)

Deploy directly into your AWS account with a CloudFormation template — no local setup needed.

1. Download the template: [bedrock-ai-analyser.yaml](cloudformation/bedrock-ai-analyser.yaml)
2. Open the [AWS CloudFormation Console](https://console.aws.amazon.com/cloudformation)
3. Click **Create stack** → **With new resources** → **Upload a template file**
4. Upload the YAML file and click **Next**
5. Fill in the parameters:
   - **Stack name**: `BedrockAIAnalyser`
   - **Admin Password**: choose a password (min 6 characters)
   - **Allowed IP**: your IP with `/32` (e.g. `203.0.113.50/32`) or `0.0.0.0/0` for open access
   - **Instance Type**: `t3.small` (default)
6. Click **Next** → **Next** → check **I acknowledge that AWS CloudFormation might create IAM resources** → **Submit**
7. Wait ~10 minutes for the stack to complete
8. Find the dashboard URL in the **Outputs** tab
9. Login with username `admin` and the password you set

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_REGION` | `us-east-1` | Default AWS region |
| `PORT` | `3000` | Server port |
| `LOGIN_USERNAME` | `admin` | Admin username |
| `LOGIN_PASSWORD` | `changeme` | Admin password |
| `SLACK_WEBHOOK_URL` | — | Slack webhook for alerts (optional) |
| `SNS_TOPIC_ARN` | — | SNS topic for alerts (optional) |
| `ALERT_EMAIL` | — | Email for alerts (optional) |

### AWS Permissions Required

The IAM role or user running the app needs these permissions:

```json
{
  "Effect": "Allow",
  "Action": [
    "cloudwatch:GetMetricStatistics",
    "cloudwatch:ListMetrics",
    "cloudwatch:GetMetricData",
    "servicequotas:ListServiceQuotas",
    "servicequotas:GetServiceQuota",
    "servicequotas:RequestServiceQuotaIncrease",
    "bedrock:ListFoundationModels",
    "bedrock:GetFoundationModel",
    "bedrock:InvokeModel",
    "sts:GetCallerIdentity",
    "iam:ListAccountAliases"
  ],
  "Resource": "*"
}
```


## Dashboard Guide

### Header Controls

- **Account Badge** — Shows the AWS account ID and alias you're connected to
- **Region Selector** — Switch between Bedrock-enabled regions
- **Model Filter** — Select which models to display (click "All Models" dropdown)
- **Time Range** — Choose from 1h to 30d to control the chart window
- **Refresh** — Manually reload all data

### Charts Explained

| Chart | What It Shows | Why It Matters |
|-------|--------------|----------------|
| TPM | Tokens per minute (input + output combined) | Approaching the red limit line means throttling risk |
| RPM | Requests per minute | Spikes near the limit indicate you need a quota increase |
| Invocations Over Time | Raw API call counts per model | Track usage trends and peak periods |
| Token Usage | Input and output tokens separately | Monitor costs and spot prompt bloat |
| Latency (Average) | Mean response time in ms | Higher latency may indicate load or large prompts |
| Latency Percentiles | p50, p90, p99 response times | Large gaps between p50 and p99 suggest inconsistent performance |
| Errors & Throttles | 4xx errors, 5xx errors, throttled requests | Any throttles mean you're hitting limits |
| Token I/O Ratio | Input tokens divided by output tokens | Rising ratio = prompt bloat, falling = longer responses |
| Throttle Rate | Throttles as % of total requests | Above 0% means capacity action needed |
| Model Invocations | Pie chart breakdown by model | See which models dominate your usage |

### Chat Assistant

The built-in AI assistant can help with:
- "Which models are closest to their limits?"
- "When will I run out of capacity for Claude?"
- "Help me request a quota increase"
- "What's my usage trend over the last week?"

Click the suggested prompts or type your own question.

### Requesting Quota Increases

1. Ask the chat assistant about increasing limits, or click a suggestion
2. The quota increase form appears below the chat
3. Select the region, service, quota, and desired value
4. Click **Submit Request** — this calls the AWS Service Quotas API directly
5. Track the request in the AWS Service Quotas console

## User Management

Admin users can manage dashboard access at `/admin`:

- **Create users** with username, password, and role (viewer or admin)
- **Reset passwords** for existing users
- **Delete users**

The primary admin account is configured via environment variables and cannot be deleted.

## Architecture

```
src/
├── web/server.ts          # HTTP server, API routes, HTML dashboard
├── lib/
│   ├── quotaService.ts    # CloudWatch metrics & Service Quotas API
│   ├── predictionService.ts # Usage trend prediction
│   ├── chatService.ts     # Bedrock-powered AI chat assistant
│   ├── alertService.ts    # SNS & Slack alerting
│   └── userStore.ts       # File-based user management
├── config.ts              # App configuration
├── types/index.ts         # TypeScript interfaces
└── generate-traffic.ts    # Test traffic generator
```

The app is a single Node.js server with no external database. User data is stored in `users.json` (file-based). All AWS data is fetched in real-time from CloudWatch and Service Quotas APIs.

## Development

```bash
# Run locally with hot reload
npm run web

# Generate test traffic (for testing with low usage accounts)
npm run generate-traffic

# Build TypeScript
npm run build
```

### Deploying Updates to EC2

```bash
bash upload-code.sh <instance-id>
```

## Supported Regions

us-east-1, us-west-2, eu-west-1, eu-west-2, eu-central-1, ap-southeast-1, ap-southeast-2, ap-northeast-1, ca-central-1, sa-east-1

## Security Notes

- Dashboard access is protected by session-based authentication
- Restrict access by IP using the `AllowedIP` parameter in CloudFormation or the EC2 security group
- Passwords are hashed with SHA-256 + salt before storage
- No AWS credentials are stored in the app — it uses IAM roles (EC2) or environment credentials (local)
- The CloudFormation template creates a least-privilege IAM role with only the permissions listed above

## License

MIT
