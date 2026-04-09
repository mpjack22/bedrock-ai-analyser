#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BedrockMonitorStack } from '../lib/stack';

const app = new cdk.App();

new BedrockMonitorStack(app, 'BedrockCapacityMonitor', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
});
