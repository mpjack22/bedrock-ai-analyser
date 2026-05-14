# Bedrock AI Analyser

A real-time monitoring dashboard for AWS Bedrock and Bedrock AgentCore usage, capacity, and quotas. Track model invocations, token consumption, latency, throttling, agent metrics, and predict when you'll hit limits — all from a single web interface.

## Features

### Dashboard
- **10 Model Metric Charts** — TPM, RPM, invocations, token usage, latency (avg + p50/p90/p99), errors & throttles, token I/O ratio, throttle rate
- **6 AgentCore Metric Charts** — agent invocations/errors, agent latency percentiles, step count, KB retrieval, guardrail activity, KB errors
- **View Selector** — switch between Model, AgentCore, or All Metrics views
- **Multi-Region Support** — switch between all Bedrock-enabled regions
- **Model Filtering** — select one, multiple, or all models
- **Flexible Time Ranges** — 1h, 3h, 6h, 12h, 24h, 3d, 7d, 30d
- **Quota Limit Lines** — red dashed lines on charts showing your service quota limits
- **Auto-Discovery** — automatically detects which Bedrock models you've used via CloudWatch

### Capacity Planning
- **Predictions & Alerts** — predict when quotas will be exhausted based on usage trends
- **Quota Increase Requests** — submit AWS Service Quotas increase requests directly from the dashboard
- **AI Chat Assistant** — ask questions about usage, get predictions, and get guidance on quota increases (powered by Claude Sonnet 4.5)

### Multi-Account Support
- **Account Selector** — searchable dropdown to switch between AWS accounts
- **AWS Organizations Integration** — auto-discovers accounts if running from the management account
- **Manual Account Management** — add accounts manually via the admin panel
- **Cross-Account Role Assumption** — uses `BedrockAnalyserReadRole` in member accounts

### Security & Access
- **Login Authentication** — session-based auth with configurable credentials
- **User Management** — admin panel to create/delete users and reset passwords
- **IP Restriction** — restrict dashboard access to specific IP addresses
- **HTTPS via CloudFront** — CloudFront distribution for HTTPS without a custom domain

## Quick Start

### Run Locally

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

---

### Prerequisites

- Node.js 20+ installed
- `mwinit` run to get valid Midway credentials
- Customer account ID and access via Isengard/Conduit

### Step 1: Clone and install (one-time)

```bash
git clone https://github.com/mpjack22/bedrock-ai-analyser.git
cd bedrock-ai-analyser
npm install
cp .env.example .env
```

### Step 2: Assume a read-only role in the customer account

Use Isengard or Conduit to assume a role with CloudWatch and Bedrock read permissions in the customer account. The role needs these permissions:

```
cloudwatch:GetMetricStatistics
cloudwatch:ListMetrics
cloudwatch:GetMetricData
servicequotas:ListServiceQuotas
servicequotas:GetServiceQuota
bedrock:ListFoundationModels
bedrock:GetFoundationModel
sts:GetCallerIdentity
iam:ListAccountAliases
```

Most read-only roles (e.g. `ReadOnlyAccess` managed policy) cover these. Once assumed, your terminal will have `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` set.

### Step 3: Start the analyser

```bash
npm run web
```

Open http://localhost:3000 — the account badge in the header will confirm you're looking at the correct customer account.

### Step 4: Navigate the dashboard

- Use the **Region** selector to switch to the region where the customer uses Bedrock
- The **Model** filter auto-discovers which models the customer has invoked
- Use the **time range** buttons to look at different windows (1h for recent activity, 7d for trends)
- The **Predictions & Alerts** panel shows which quotas are at risk
- The **Chat Assistant** can answer questions like "which models are closest to their limits?" or "when might they hit throttling?"

### Step 5: When done

Close the browser and stop the server (`Ctrl+C`). Your assumed credentials expire automatically (typically after 1 hour).

---

### Deploy to AWS (CloudFormation)

1. Download: [bedrock-ai-analyser.yaml](cloudformation/bedrock-ai-analyser.yaml)
2. Open the [AWS CloudFormation Console](https://console.aws.amazon.com/cloudformation)
3. Create stack → Upload a template file → upload the YAML
4. Fill in:
   - **Stack name**: `BedrockAIAnalyser`
   - **Admin Password**: choose a password (min 6 chars)
   - **Allowed IP**: your IP with `/32` (e.g. `203.0.113.50/32`) or `0.0.0.0/0`
   - **Instance Type**: `t3.small`
5. Next → Next → check "I acknowledge that AWS CloudFormation might create IAM resources" → Submit
6. Wait ~10 minutes, find the dashboard URL in the Outputs tab
7. Login with username `admin` and your password

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_REGION` | `us-east-1` | Default AWS region |
| `PORT` | `3000` | Server port |
| `LOGIN_USERNAME` | `admin` | Admin username |
| `LOGIN_PASSWORD` | `changeme` | Admin password — **change this** |
| `SLACK_WEBHOOK_URL` | — | Slack webhook for alerts (optional) |
| `SNS_TOPIC_ARN` | — | SNS topic for alerts (optional) |

### AWS Permissions Required

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

| Control | Description |
|---------|-------------|
| Account Badge | Shows the AWS account ID and alias you're connected to |
| Account Selector | Switch between accounts (org-discovered or manually added) |
| Region Selector | Switch between Bedrock-enabled regions |
| Model Filter | Select which models to display |
| Time Range | 1h / 3h / 6h / 12h / 24h / 3d / 7d / 30d |
| Refresh | Manually reload all data |

### View Selector (above charts)

- **Model** — shows model invocation, token, latency, and error charts
- **AgentCore** — shows agent, knowledge base, and guardrail charts
- **All Metrics** — shows everything

### Charts Explained

**Model Charts**

| Chart | What It Shows |
|-------|--------------|
| TPM | Tokens per minute — approaching the red limit line means throttling risk |
| RPM | Requests per minute — spikes near the limit indicate quota increase needed |
| Invocations Over Time | Raw API call counts per model |
| Token Usage | Input and output tokens separately |
| Latency (Average) | Mean response time in ms |
| Latency Percentiles | p50/p90/p99 — large gaps suggest inconsistent performance |
| Errors & Throttles | 4xx errors, 5xx errors, throttled requests |
| Token I/O Ratio | Input/output ratio — rising = prompt bloat |
| Throttle Rate | Throttles as % of total requests |
| Model Invocations | Pie chart breakdown by model |

**AgentCore Charts**

| Chart | What It Shows |
|-------|--------------|
| Agent Invocations & Errors | Agent call volume with error overlay |
| Agent Latency | End-to-end agent response time (p50/p90/p99) |
| Agent Step Count | Tool calls per invocation — more steps = higher cost |
| KB Retrieval | RAG retrieval volume and latency |
| Guardrail Activity | Invocations vs blocked content |
| KB Errors | Failed retrieval operations |

### Chat Assistant

The AI assistant (Claude Sonnet 4.5) can help with:
- "Which models are closest to their limits?"
- "When will I run out of capacity for Claude?"
- "Help me request a quota increase"
- "What's my usage trend over the last week?"

Click the "Capacity Assistant" header to minimise/expand the chat panel.

### Requesting Quota Increases

1. Ask the chat assistant or click a suggestion about increasing limits
2. The quota increase form appears below the chat
3. Select region, service, quota, and desired value
4. Click **Submit Request** — calls the AWS Service Quotas API directly

## Multi-Account Setup

### AWS Organizations (automatic)

If running from the management account, the account selector auto-populates with all org accounts. Add these permissions to the IAM role:

```json
{
  "Effect": "Allow",
  "Action": [
    "organizations:ListAccounts",
    "sts:AssumeRole"
  ],
  "Resource": [
    "*",
    "arn:aws:iam::*:role/BedrockAnalyserReadRole"
  ]
}
```

### Manual Account Configuration

Go to `/admin` → "Linked AWS Accounts" → add account ID and name.

### Cross-Account Role Deployment

Deploy `cloudformation/cross-account-role.yaml` as a StackSet to member accounts:

1. CloudFormation → StackSets → Create StackSet
2. Upload `cross-account-role.yaml`
3. Set `LinkedAccountId` to the account running the analyser
4. Deploy to all member accounts

## User Management

Admin users can manage dashboard access at `/admin`:
- Create users with username, password, and role (viewer or admin)
- Reset passwords for existing users
- Delete users

The primary admin account is configured via environment variables and cannot be deleted.

## Updating the EC2 Deployment

After pushing changes to GitHub:

```bash
aws ssm send-command \
  --region us-west-2 \
  --instance-ids i-02fbc9afd941773e9 \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["cd /opt/bedrock-analyser","git fetch origin","git reset --hard origin/main","npm install","systemctl restart bedrock-analyser"]'
```

Or from the project root:

```bash
bash upload-code.sh <instance-id>
```

## Generating Test Traffic

To populate CloudWatch with test data:

```bash
npm run generate-traffic
```

Defaults to 15 minutes, every 30 seconds. Customize:

```bash
npx tsx src/generate-traffic.ts <duration-minutes> <interval-seconds>
```

Uses Claude Sonnet 4.6 and Nova Micro (cheap models). Press `Ctrl+C` to stop.

## Architecture

```
src/
├── web/server.ts              # HTTP server, all API routes, HTML dashboard
├── lib/
│   ├── quotaService.ts        # CloudWatch metrics & Service Quotas API
│   ├── organizationService.ts # AWS Organizations account discovery & STS AssumeRole
│   ├── v2QuotaFactory.ts      # Cross-account QuotaService with credential injection
│   ├── accountStore.ts        # File-based manual account store
│   ├── predictionService.ts   # Usage trend prediction
│   ├── chatService.ts         # Bedrock-powered AI chat (Claude Sonnet 4.5)
│   ├── alertService.ts        # SNS & Slack alerting
│   └── userStore.ts           # File-based user management
├── config.ts                  # App configuration
├── types/index.ts             # TypeScript interfaces
└── generate-traffic.ts        # Test traffic generator
cloudformation/
├── bedrock-ai-analyser.yaml   # EC2 deployment template (single account)
└── cross-account-role.yaml    # StackSet template for cross-account access
```

## Deployment Infrastructure

| Component | Details |
|-----------|---------|
| EC2 Instance | `t3.small`, Amazon Linux 2023, `us-west-2` |
| Elastic IP | `35.91.67.53` (static, survives restarts) |
| CloudFront | `https://d25tskhptmttsp.cloudfront.net` (HTTPS) |
| Systemd Service | `bedrock-analyser.service`, auto-restarts on failure |
| App Directory | `/opt/bedrock-analyser` |

## Supported Regions

us-east-1, us-west-2, eu-west-1, eu-west-2, eu-central-1, ap-southeast-1, ap-southeast-2, ap-northeast-1, ca-central-1, sa-east-1

## Security Notes

- Dashboard access is protected by session-based authentication
- Restrict access by IP using the `AllowedIP` parameter in CloudFormation or the EC2 security group
- Passwords are hashed with SHA-256 + salt before storage
- No AWS credentials are stored in the app — it uses IAM roles (EC2) or environment credentials (local)
- HTTPS available via CloudFront distribution

## License

MIT
