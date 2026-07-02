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
// allowCidr: DCV(8443)/SSH(22)/WebRTC(49100·47998)/브라우저뷰어(8210) 허용 IP.
// 보안상 반드시 '내 공인 IP/32' 로 좁힌다. 미지정이거나 0.0.0.0/0(전체 개방)이면 배포를 막는다.
//   예:  -c allowCidr=$(curl -s https://checkip.amazonaws.com)/32
const allowCidr = app.node.tryGetContext('allowCidr');
if (!allowCidr || allowCidr === '0.0.0.0/0') {
  throw new Error(
    "context 'allowCidr' 가 필요합니다 (전체 개방 금지). 본인 공인 IP 로 좁혀 지정하세요: " +
    '-c allowCidr=$(curl -s https://checkip.amazonaws.com)/32',
  );
}
// viewerCidr: 뷰어(WebRTC 스트리밍 접속) 허용 대역 — 시그널 49100·미디어 UDP 47998-48010·브라우저 8210.
// 참가자들이 접속하는 IP 대역을 여기에 지정한다(예: 사내망 15.0.0.0/8, 또는 각자 /32).
// 미지정 시 allowCidr 로 폴백(강사 혼자 테스트하는 경우). 전체 개방(0.0.0.0/0)은 금지.
//   예:  -c viewerCidr=15.0.0.0/8
const viewerCidr = app.node.tryGetContext('viewerCidr') ?? allowCidr;
if (viewerCidr === '0.0.0.0/0') {
  throw new Error("context 'viewerCidr' 는 전체 개방(0.0.0.0/0) 금지. 뷰어 IP 대역으로 좁혀 지정하세요.");
}
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
  viewerCidr,
  description: 'Omniverse workshop: N Isaac Sim clients + 1 Nucleus server',
});

app.synth();
