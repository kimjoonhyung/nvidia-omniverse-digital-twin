#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OmniverseWorkshopStack } from '../lib/omniverse-workshop-stack';

const app = new cdk.App();

// ---- 파라미터 (cdk.json context 또는 -c 로 오버라이드) ----
// 예: cdk deploy -c clientCount=5 -c clientInstanceType=g6e.4xlarge
const clientCount = Number(app.node.tryGetContext('clientCount') ?? 3);
const clientInstanceType = app.node.tryGetContext('clientInstanceType') ?? 'g6e.2xlarge';
const nucleusInstanceType = app.node.tryGetContext('nucleusInstanceType') ?? 'm7i.xlarge';
const keyName = app.node.tryGetContext('keyName'); // 필수: 기존 EC2 키페어 이름
const allowCidr = app.node.tryGetContext('allowCidr') ?? '0.0.0.0/0'; // DCV/SSH 허용 IP (반드시 좁힐 것)
// NGC API 키는 -c 가 아니라 배포 시 CFN Parameter 로 입력:
//   cdk deploy --parameters NgcApiKey=nvapi-...

new OmniverseWorkshopStack(app, 'OmniverseWorkshopStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-2',
  },
  clientCount,
  clientInstanceType,
  nucleusInstanceType,
  keyName,
  allowCidr,
  description: 'Omniverse workshop: N Isaac Sim clients + 1 Nucleus server',
});

app.synth();
