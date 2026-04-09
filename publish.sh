#!/bin/bash
# Package and publish Bedrock AI Analyser for customer deployment
# Creates an S3 bucket with the source code and a CloudFormation template
# Usage: bash publish.sh <s3-bucket-name>
set -e

BUCKET=${1:?"Usage: bash publish.sh <s3-bucket-name>"}
REGION="us-east-1"

echo "=== Publishing Bedrock AI Analyser ==="

# Create bucket if it doesn't exist
aws s3 mb s3://$BUCKET --region $REGION 2>/dev/null || true

# Make bucket publicly readable for CloudFormation access
aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false" --region $REGION
aws s3api put-bucket-policy --bucket $BUCKET --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"PublicRead\",
    \"Effect\": \"Allow\",
    \"Principal\": \"*\",
    \"Action\": \"s3:GetObject\",
    \"Resource\": \"arn:aws:s3:::$BUCKET/*\"
  }]
}" --region $REGION

# Package source code
echo "Packaging source..."
tar czf /tmp/bedrock-ai-analyser.tar.gz \
  --exclude=node_modules --exclude=dist --exclude=cdk --exclude=.git \
  --exclude=users.json --exclude=.env --exclude='*.log' --exclude=cdk.out \
  --exclude=cloudformation --exclude=deploy-ec2.sh --exclude=upload-code.sh \
  --exclude=publish.sh \
  -C "$(pwd)" .

# Upload source
echo "Uploading source to S3..."
aws s3 cp /tmp/bedrock-ai-analyser.tar.gz s3://$BUCKET/bedrock-ai-analyser.tar.gz --region $REGION

# Upload CloudFormation template
echo "Uploading template..."
aws s3 cp cloudformation/bedrock-ai-analyser.yaml s3://$BUCKET/bedrock-ai-analyser.yaml --region $REGION

rm /tmp/bedrock-ai-analyser.tar.gz

TEMPLATE_URL="https://$BUCKET.s3.amazonaws.com/bedrock-ai-analyser.yaml"
LAUNCH_URL="https://console.aws.amazon.com/cloudformation/home#/stacks/new?stackName=BedrockAIAnalyser&templateURL=$TEMPLATE_URL"

echo ""
echo "============================================"
echo "  Published!"
echo "============================================"
echo ""
echo "  Template URL:"
echo "  $TEMPLATE_URL"
echo ""
echo "  One-click launch URL (share this with customers):"
echo "  $LAUNCH_URL"
echo ""
echo "  Source bundle:"
echo "  https://$BUCKET.s3.amazonaws.com/bedrock-ai-analyser.tar.gz"
echo "============================================"
