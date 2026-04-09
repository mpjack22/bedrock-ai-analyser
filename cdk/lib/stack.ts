import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class BedrockMonitorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cloudwatch:GetMetricStatistics',
        'cloudwatch:ListMetrics',
        'cloudwatch:GetMetricData',
        'service-quotas:ListServiceQuotas',
        'service-quotas:GetServiceQuota',
        'service-quotas:RequestServiceQuotaIncrease',
        'bedrock:ListFoundationModels',
        'bedrock:GetFoundationModel',
        'bedrock:InvokeModel',
      ],
      resources: ['*'],
    }));

    const sg = new ec2.SecurityGroup(this, 'SG', {
      vpc,
      description: 'Bedrock Capacity Monitor',
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3000), 'Dashboard');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -ex',
      'yum update -y',
      'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -',
      'yum install -y nodejs git',
      'mkdir -p /opt/bedrock-monitor',
      'cd /opt/bedrock-monitor',

      // Write the app source inline (package.json)
      'cat > package.json << \'PKGJSON\'',
    );

    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      securityGroup: sg,
      userData,
      associatePublicIpAddress: true,
    });

    new cdk.CfnOutput(this, 'DashboardURL', {
      value: `http://${instance.instancePublicIp}:3000`,
      description: 'Dashboard URL',
    });

    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID (use SSM to connect)',
    });
  }
}
