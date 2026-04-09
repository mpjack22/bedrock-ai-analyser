#!/bin/bash
# Deploy latest code to the EC2 instance
# Usage: bash upload-code.sh
set -e

INSTANCE_ID=${1:?"Usage: bash upload-code.sh <instance-id>"}
REGION="us-east-1"
BUCKET="bedrock-ai-analyser-deploy-tmp"
APP_DIR="/opt/bedrock-analyser"

echo "=== Deploying to $INSTANCE_ID ==="

# Create tarball
echo "Packaging source..."
tar czf /tmp/bedrock-monitor.tar.gz \
  --exclude=node_modules --exclude=dist --exclude=cdk --exclude=.git \
  --exclude=users.json --exclude=.env --exclude='*.log' --exclude=cdk.out \
  -C "$(pwd)" .

# Upload to S3
echo "Uploading to S3..."
aws s3 cp /tmp/bedrock-monitor.tar.gz s3://$BUCKET/app.tar.gz --region $REGION

# Deploy on instance
echo "Installing on EC2..."
COMMAND_ID=$(aws ssm send-command \
  --region $REGION \
  --instance-ids $INSTANCE_ID \
  --document-name "AWS-RunShellScript" \
  --timeout-seconds 120 \
  --parameters "{\"commands\":[
    \"cd $APP_DIR\",
    \"rm -rf src package.json tsconfig.json package-lock.json\",
    \"aws s3 cp s3://$BUCKET/app.tar.gz /tmp/app.tar.gz --region $REGION\",
    \"tar xzf /tmp/app.tar.gz -C $APP_DIR/\",
    \"cd $APP_DIR && npm install 2>&1 | tail -3\",
    \"systemctl restart bedrock-monitor\",
    \"sleep 3\",
    \"systemctl status bedrock-monitor --no-pager | head -10\"
  ]}" \
  --query "Command.CommandId" \
  --output text)

echo "Running: $COMMAND_ID"
echo "Waiting..."
sleep 30

# Show result
aws ssm get-command-invocation \
  --command-id $COMMAND_ID \
  --instance-id $INSTANCE_ID \
  --region $REGION \
  --query "[Status,StandardOutputContent]" \
  --output text 2>&1 | tail -15

# Clean up
rm /tmp/bedrock-monitor.tar.gz
aws s3 rm s3://$BUCKET/app.tar.gz --region $REGION 2>/dev/null

PUBLIC_IP=$(aws ec2 describe-instances --region $REGION --instance-ids $INSTANCE_ID --query "Reservations[0].Instances[0].PublicIpAddress" --output text)

echo ""
echo "=== Deployed! http://$PUBLIC_IP:3000 ==="
