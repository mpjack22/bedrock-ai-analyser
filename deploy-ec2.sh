#!/bin/bash
# Deploy Bedrock Capacity Monitor to EC2
# Usage: bash deploy-ec2.sh
set -e

REGION="us-east-1"
INSTANCE_TYPE="t3.small"
STACK_NAME="bedrock-monitor-ec2"
KEY_NAME=""  # Leave empty for SSM-only access (no SSH key needed)

echo "=== Deploying Bedrock Capacity Monitor to EC2 in $REGION ==="

# Get default VPC
VPC_ID=$(aws ec2 describe-vpcs --region $REGION --filters "Name=isDefault,Values=true" --query "Vpcs[0].VpcId" --output text)
echo "Using VPC: $VPC_ID"

# Get a public subnet (avoid us-east-1e which doesn't support t3)
SUBNET_ID=$(aws ec2 describe-subnets --region $REGION --filters "Name=vpc-id,Values=$VPC_ID" "Name=map-public-ip-on-launch,Values=true" --query "Subnets[?AvailabilityZone!='us-east-1e'] | [0].SubnetId" --output text)
echo "Using Subnet: $SUBNET_ID"

# Get latest Amazon Linux 2023 AMI
AMI_ID=$(aws ec2 describe-images --region $REGION --owners amazon --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" --query "sort_by(Images, &CreationDate)[-1].ImageId" --output text)
echo "Using AMI: $AMI_ID"

# Create IAM role
echo "Creating IAM role..."
aws iam create-role \
  --role-name bedrock-monitor-ec2-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  2>/dev/null || echo "Role already exists"

aws iam put-role-policy \
  --role-name bedrock-monitor-ec2-role \
  --policy-name bedrock-monitor-policy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricStatistics","cloudwatch:ListMetrics","cloudwatch:GetMetricData",
        "service-quotas:ListServiceQuotas","service-quotas:GetServiceQuota","service-quotas:RequestServiceQuotaIncrease",
        "bedrock:ListFoundationModels","bedrock:GetFoundationModel","bedrock:InvokeModel"
      ],
      "Resource": "*"
    }]
  }'

aws iam attach-role-policy \
  --role-name bedrock-monitor-ec2-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore \
  2>/dev/null || true

# Create instance profile
aws iam create-instance-profile \
  --instance-profile-name bedrock-monitor-ec2-profile \
  2>/dev/null || echo "Instance profile already exists"

aws iam add-role-to-instance-profile \
  --instance-profile-name bedrock-monitor-ec2-profile \
  --role-name bedrock-monitor-ec2-role \
  2>/dev/null || true

echo "Waiting for instance profile to propagate..."
sleep 10

# Create security group
SG_ID=$(aws ec2 describe-security-groups --region $REGION --filters "Name=group-name,Values=bedrock-monitor-sg" "Name=vpc-id,Values=$VPC_ID" --query "SecurityGroups[0].GroupId" --output text 2>/dev/null)
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID=$(aws ec2 create-security-group --region $REGION --group-name bedrock-monitor-sg --description "Bedrock Monitor" --vpc-id $VPC_ID --query "GroupId" --output text)
  aws ec2 authorize-security-group-ingress --region $REGION --group-id $SG_ID --protocol tcp --port 3000 --cidr 0.0.0.0/0
  echo "Created security group: $SG_ID"
else
  echo "Using existing security group: $SG_ID"
fi

# User data script
USER_DATA=$(cat << 'USERDATA'
#!/bin/bash
set -ex
dnf update -y
dnf install -y nodejs npm git

# Create app directory
mkdir -p /opt/bedrock-monitor
cd /opt/bedrock-monitor

# Create .env
cat > .env << 'ENV'
AWS_REGION=us-east-1
PORT=3000
LOGIN_USERNAME=admin
LOGIN_PASSWORD=changeme
ENV

# Clone or copy app (we'll use SCP/SSM later, for now install from scratch)
# The user data just sets up the environment. Upload code via SSM or SCP.

# Create a systemd service
cat > /etc/systemd/system/bedrock-monitor.service << 'SERVICE'
[Unit]
Description=Bedrock Capacity Monitor
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/bedrock-monitor
ExecStart=/usr/bin/npx tsx src/web/server.ts
Restart=always
RestartSec=5
EnvironmentFile=/opt/bedrock-monitor/.env

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
echo "EC2 instance ready. Upload app code to /opt/bedrock-monitor/"
USERDATA
)

# Launch instance
echo "Launching EC2 instance..."
INSTANCE_ID=$(aws ec2 run-instances \
  --region $REGION \
  --image-id $AMI_ID \
  --instance-type $INSTANCE_TYPE \
  --subnet-id $SUBNET_ID \
  --security-group-ids $SG_ID \
  --iam-instance-profile Name=bedrock-monitor-ec2-profile \
  --associate-public-ip-address \
  --user-data "$USER_DATA" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=bedrock-monitor}]" \
  --query "Instances[0].InstanceId" \
  --output text)

echo "Instance launched: $INSTANCE_ID"
echo "Waiting for instance to be running..."
aws ec2 wait instance-running --region $REGION --instance-ids $INSTANCE_ID

PUBLIC_IP=$(aws ec2 describe-instances --region $REGION --instance-ids $INSTANCE_ID --query "Reservations[0].Instances[0].PublicIpAddress" --output text)

echo ""
echo "============================================"
echo "  EC2 Instance Ready!"
echo "============================================"
echo "  Instance ID: $INSTANCE_ID"
echo "  Public IP:   $PUBLIC_IP"
echo ""
echo "  Next steps:"
echo "  1. Wait ~2 minutes for user data to finish"
echo "  2. Upload your code:"
echo "     aws ssm start-session --target $INSTANCE_ID --region $REGION"
echo ""
echo "  Or use the upload script:"
echo "     bash upload-code.sh $INSTANCE_ID"
echo ""
echo "  Dashboard will be at: http://$PUBLIC_IP:3000"
echo "============================================"
