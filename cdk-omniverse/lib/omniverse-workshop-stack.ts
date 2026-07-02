import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { buildNucleusUserData } from './nucleus-userdata';
import { buildClientUserData } from './client-userdata';

export interface OmniverseWorkshopStackProps extends cdk.StackProps {
  /** Isaac Sim 클라이언트 대수 (기본 3) */
  clientCount: number;
  /** 클라이언트 1대당 DCV virtual 세션(=동시 접속 참가자) 수 (기본 8) */
  studentCount: number;
  /** 클라이언트 인스턴스 타입 (GPU 필요, 기본 g6e.2xlarge) */
  clientInstanceType: string;
  /** Nucleus 서버 타입 (GPU 불필요, 기본 m7i.xlarge) */
  nucleusInstanceType: string;
  /** 기존 EC2 키페어 이름 (SSH/DCV 접속용) */
  keyName?: string;
  /** 관리 접근(DCV 8443·SSH 22) 허용 CIDR. 반드시 본인 IP/32 로 좁힐 것 */
  allowCidr: string;
  /**
   * 뷰어(WebRTC 스트리밍) 허용 CIDR — 시그널링 49100·미디어 UDP 47998-48010·브라우저 8210.
   * 참가자들이 접속하는 IP 대역. 미지정 시 allowCidr 로 폴백.
   */
  viewerCidr: string;
}

/** WebRTC 미디어 UDP 포트 범위 (Isaac Sim 5.1 minHostPort~maxHostPort 와 일치). */
export const WEBRTC_MEDIA_PORT_MIN = 47998;
export const WEBRTC_MEDIA_PORT_MAX = 48010;

export class OmniverseWorkshopStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OmniverseWorkshopStackProps) {
    super(scope, id, props);

    const { clientCount, studentCount, clientInstanceType, nucleusInstanceType, keyName, allowCidr, viewerCidr } = props;

    // ---------------------------------------------------------------
    // 0) NGC API 키 — 배포 시 CFN Parameter 로 입력받음 (NoEcho=평문 노출 방지)
    //    스택이 이 키로 Secrets Manager Secret 을 생성하고, destroy 시 함께 삭제.
    // ---------------------------------------------------------------
    const ngcApiKeyParam = new cdk.CfnParameter(this, 'NgcApiKey', {
      type: 'String',
      noEcho: true,
      minLength: 1,
      description: 'NGC API key (nvapi-...) for pulling Nucleus containers. 콘솔/로그에 노출되지 않음(NoEcho).',
    });
    // 입력받은 키를 Secrets Manager 에 저장 (스택 소유 → destroy 시 함께 삭제).
    // user-data 는 이 시크릿을 런타임에 읽어 NGC 로그인에 사용 → 평문키가 템플릿/로그에 안 남음.
    const ngcSecret = new secretsmanager.CfnSecret(this, 'NgcSecret', {
      name: `${this.stackName}-ngc-api-key`,
      secretString: ngcApiKeyParam.valueAsString,
    });
    const ngcSecretArn = ngcSecret.ref; // 완전한 ARN

    // ---------------------------------------------------------------
    // 0-2) ubuntu 사용자 DCV 로그인 비밀번호 — 배포 시 입력 (NoEcho).
    //      클라이언트(및 Nucleus) user-data 가 부팅 시 ubuntu 계정에 설정.
    //      DCV 콘솔 세션 로그인에 사용. 입력 안 하면(빈 값) 설정 생략.
    // ---------------------------------------------------------------
    const ubuntuPasswordParam = new cdk.CfnParameter(this, 'UbuntuPassword', {
      type: 'String',
      noEcho: true,
      default: '',
      description: 'ubuntu 사용자 비밀번호 (DCV 로그인용). 비우면 설정 생략. NoEcho 로 로그/콘솔 노출 안 됨.',
    });
    const ubuntuPassword = ubuntuPasswordParam.valueAsString;

    // ---------------------------------------------------------------
    // 0-3) 참가자(student1..N) 공통 DCV 로그인 비밀번호 — 배포 시 입력 (NoEcho).
    //      클라이언트 user-data 가 부팅 시 studentN 계정에 동일 적용.
    //      비우면 인스턴스에서 랜덤 생성 → /opt/dcv-multiuser/CREDENTIALS.txt 에 기록.
    // ---------------------------------------------------------------
    const studentPasswordParam = new cdk.CfnParameter(this, 'StudentPassword', {
      type: 'String',
      noEcho: true,
      default: '',
      description: 'student1..N 공통 DCV 로그인 비밀번호. 비우면 인스턴스가 랜덤 생성(로그 기록). NoEcho.',
    });
    const studentPassword = studentPasswordParam.valueAsString;

    // 기존 EC2 키페어를 이름으로 참조 (deprecated keyName 대신 keyPair 사용)
    const keyPair = keyName
      ? ec2.KeyPair.fromKeyPairName(this, 'KeyPair', keyName)
      : undefined;

    // ---------------------------------------------------------------
    // 1) VPC — 단일 AZ, 퍼블릭 서브넷 (워크숍 PoC용. 운영은 private+NAT 권장)
    // ---------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'WorkshopVpc', {
      maxAzs: 1,
      natGateways: 0,
      ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });
    const vpcCidr = vpc.vpcCidrBlock;

    // ---------------------------------------------------------------
    // 2) 보안 그룹
    //    - 클라이언트(Isaac Sim): DCV 8443 + SSH 22 (allowCidr 에서만)
    //    - Nucleus: VPC 내부에서 서비스 포트, SSH 는 allowCidr
    //    - VPC 내부 상호 통신 허용 (클라이언트 <-> Nucleus)
    // ---------------------------------------------------------------
    const clientSg = new ec2.SecurityGroup(this, 'ClientSg', {
      vpc, description: 'Isaac Sim client - DCV + SSH', allowAllOutbound: true,
    });
    // 관리 접근(DCV·SSH): allowCidr 에서만.
    clientSg.addIngressRule(ec2.Peer.ipv4(allowCidr), ec2.Port.tcp(8443), 'DCV');
    clientSg.addIngressRule(ec2.Peer.ipv4(allowCidr), ec2.Port.tcp(22), 'SSH');
    // Isaac Sim WebRTC 라이브스트림 (WORKSHOP_STREAM_VIEWER.md): 뷰어(viewerCidr)에서 접속.
    //  - TCP 49100      : 시그널링
    //  - UDP 47998-48010: 미디어(둘 다 필수. TCP만 열면 영상 안 나옴).
    //                     Isaac Sim 5.1 은 minHostPort~maxHostPort 로 이 범위에 미디어 포트를 고정한다.
    //  - TCP 8210       : (부록) Docker Compose 브라우저 웹 뷰어. 네이티브 방식엔 불필요.
    // 3대 모두 열어두고, 워크샵에서 1대를 스트리밍 호스트로 지정해 쓴다.
    clientSg.addIngressRule(ec2.Peer.ipv4(viewerCidr), ec2.Port.tcp(49100), 'Isaac WebRTC signaling');
    clientSg.addIngressRule(
      ec2.Peer.ipv4(viewerCidr),
      ec2.Port.udpRange(WEBRTC_MEDIA_PORT_MIN, WEBRTC_MEDIA_PORT_MAX),
      'Isaac WebRTC media',
    );
    clientSg.addIngressRule(ec2.Peer.ipv4(viewerCidr), ec2.Port.tcp(8210), 'Isaac WebRTC browser viewer (Docker Compose, appendix)');

    const nucleusSg = new ec2.SecurityGroup(this, 'NucleusSg', {
      vpc, description: 'Nucleus server', allowAllOutbound: true,
    });
    nucleusSg.addIngressRule(ec2.Peer.ipv4(allowCidr), ec2.Port.tcp(22), 'SSH admin');
    // Nucleus 서비스 포트 (VPC 내부 클라이언트가 접속)
    const nucleusPorts: Array<[number, number, string]> = [
      [3006, 3030, 'nucleus core/api/lft/tagging/metrics'],
      [3100, 3180, 'auth'],
      [3333, 3400, 'discovery/search'],
      [8000, 8080, 'authapi/web navigator'],
      [5555, 5555, 'meta dump'],
    ];
    for (const [from, to, desc] of nucleusPorts) {
      nucleusSg.addIngressRule(ec2.Peer.ipv4(vpcCidr), ec2.Port.tcpRange(from, to), desc);
    }
    // (선택) Navigator 웹을 본인 IP에서 직접 보고 싶으면 8080 을 allowCidr 에도 개방
    nucleusSg.addIngressRule(ec2.Peer.ipv4(allowCidr), ec2.Port.tcp(8080), 'Navigator web (admin)');

    // ---------------------------------------------------------------
    // 3) IAM 역할 — SSM 접속 + (Nucleus는) NGC 시크릿 읽기
    // ---------------------------------------------------------------
    const baseRole = (id2: string) => {
      const r = new iam.Role(this, id2, {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        ],
      });
      return r;
    };
    const clientRole = baseRole('ClientRole');
    const nucleusRole = baseRole('NucleusRole');
    // Nucleus 역할에 NGC 시크릿 읽기 권한 부여.
    // CfnSecret 의 ref 는 완전한 ARN(접미사 포함)이므로 그대로 사용.
    nucleusRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [ngcSecret.ref],
    }));

    // ---------------------------------------------------------------
    // 4) AMI
    //    - 클라이언트: NVIDIA Isaac Sim 마켓플레이스 AMI (리전별 ID 다름 → context로 주입)
    //    - Nucleus:   Ubuntu 22.04 (자동 최신 조회)
    // ---------------------------------------------------------------
    const isaacAmiId = this.node.tryGetContext('isaacAmiId');
    if (!isaacAmiId) {
      // 합성은 되게 하되, 배포 전 반드시 지정하도록 경고
      cdk.Annotations.of(this).addWarning(
        "context 'isaacAmiId' 미지정 — Isaac Sim 마켓플레이스 AMI ID를 -c isaacAmiId=ami-xxxx 로 전달하세요 " +
        '(리전·버전마다 다르며 마켓플레이스 구독 동의 필요).',
      );
    }
    const clientAmi = ec2.MachineImage.genericLinux({
      [this.region]: isaacAmiId ?? 'ami-00000000000000000',
    });
    const nucleusAmi = ec2.MachineImage.fromSsmParameter(
      '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id',
      { os: ec2.OperatingSystemType.LINUX },
    );

    // ---------------------------------------------------------------
    // 5) Nucleus 서버 (user-data 로 Docker+NGC+compose 자동 설치)
    // ---------------------------------------------------------------
    const nucleus = new ec2.Instance(this, 'NucleusServer', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(nucleusInstanceType),
      machineImage: nucleusAmi,
      securityGroup: nucleusSg,
      role: nucleusRole,
      keyPair,
      blockDevices: [{
        deviceName: '/dev/sda1',
        volume: ec2.BlockDeviceVolume.ebs(200, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
      }],
      // Nucleus admin(omniverse) 비번을 StudentPassword 와 동일하게 → 참가자가 외우기 쉽게.
      //   (빈 값이면 nucleus-userdata 가 랜덤 생성 후 CREDENTIALS.txt 에 기록)
      userData: buildNucleusUserData({ region: this.region, ngcSecretArn, ubuntuPassword, masterPassword: studentPassword }),
    });
    cdk.Tags.of(nucleus).add('Name', 'omniverse-nucleus');
    cdk.Tags.of(nucleus).add('Role', 'nucleus');

    // ---------------------------------------------------------------
    // 6) Isaac Sim 클라이언트 N대 (개수 파라미터화)
    // ---------------------------------------------------------------
    // 클라이언트 user-data: ubuntu 비밀번호 설정 + DCV virtual 다중세션 자동 구성.
    //   - nice-xdcv 설치 + GPU Xorg :0 정렬 + student1..N 계정/세션 생성 (client-userdata.ts).
    //   - GPU 1대에 studentCount 명이 동시에 DCV 로 붙어 디지털 트윈 씬을 GPU 가속으로 본다.
    // NoEcho 파라미터라 콘솔/이벤트엔 가려지나, user-data 자체는 평문 저장 → PoC 한정.
    const clientUserData = buildClientUserData({ ubuntuPassword, studentCount, studentPassword });

    const clients: ec2.Instance[] = [];
    for (let i = 1; i <= clientCount; i++) {
      const c = new ec2.Instance(this, `IsaacClient${i}`, {
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        instanceType: new ec2.InstanceType(clientInstanceType),
        machineImage: clientAmi,
        securityGroup: clientSg,
        role: clientRole,
        keyPair,
        userData: clientUserData,
        blockDevices: [{
          deviceName: '/dev/sda1',
          // Isaac Sim 마켓플레이스 AMI 스냅샷은 >=512GB 요구
          volume: ec2.BlockDeviceVolume.ebs(512, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
        }],
      });
      cdk.Tags.of(c).add('Name', `isaac-sim-client-${i}`);
      cdk.Tags.of(c).add('Role', 'isaac-client');
      clients.push(c);
    }

    // ---------------------------------------------------------------
    // 7) 출력
    // ---------------------------------------------------------------
    new cdk.CfnOutput(this, 'NucleusPrivateIp', { value: nucleus.instancePrivateIp });
    new cdk.CfnOutput(this, 'NucleusPublicIp', { value: nucleus.instancePublicIp });
    new cdk.CfnOutput(this, 'NucleusNavigator', { value: `http://${nucleus.instancePublicIp}:8080` });
    clients.forEach((c, idx) => {
      new cdk.CfnOutput(this, `Client${idx + 1}Dcv`, { value: `https://${c.instancePublicIp}:8443` });
    });
    new cdk.CfnOutput(this, 'ConnectNucleusFromIsaac', {
      value: `Add Nucleus connection in Isaac Sim to: ${nucleus.instancePrivateIp}`,
    });
    // 뷰어 전용 시나리오: 마지막 클라이언트를 스트리밍 호스트로 쓰는 예시 (WORKSHOP_STREAM_VIEWER.md).
    if (clients.length > 0) {
      const host = clients[clients.length - 1];
      new cdk.CfnOutput(this, 'StreamHostPublicIp', {
        value: host.instancePublicIp,
        description: 'WebRTC viewer host: run isaac-sim.streaming.sh here, connect clients to this IP:49100',
      });
    }
  }
}
