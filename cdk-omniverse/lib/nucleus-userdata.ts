import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface NucleusUserDataProps {
  region: string;
  /** NGC API 키가 담긴 Secrets Manager 시크릿 ARN. 평문키는 절대 넣지 말 것 */
  ngcSecretArn?: string;
  /** ubuntu 사용자 비밀번호 (SSH/콘솔 로그인용). 빈 값이면 설정 생략 */
  ubuntuPassword?: string;
}

/**
 * Nucleus 서버 자동 설치 user-data.
 *
 * 견고성 설계 (이전 배포에서 download 직후 재부팅되어 compose 단계 누락된 문제 해결):
 *  - 설치 로직을 systemd oneshot 서비스(nucleus-install)로 등록 → user-data 1회성·재부팅 한계 극복.
 *    부팅 때마다 실행되지만 /opt/nucleus/READY 있으면 즉시 종료(멱등).
 *  - Restart=on-failure 로 실패 시 자동 재시도.
 *  - set -e 미사용: 단계별로 진행하고 실패해도 다음 부팅에 재시도.
 *  - 모든 로그는 /var/log/nucleus-install.log + journald 에 남김.
 */
export function buildNucleusUserData(props: NucleusUserDataProps): ec2.UserData {
  const { region, ngcSecretArn } = props;
  const ud = ec2.UserData.forLinux();

  // 설치 스크립트 (멱등 + 견고). systemd 서비스가 실행.
  const installScript = [
    '#!/bin/bash',
    'exec >> /var/log/nucleus-install.log 2>&1',
    'echo "=== nucleus-install start: $(date) ==="',
    'set -x',
    '',
    '# 이미 완료됐으면 종료 (멱등)',
    'if [ -f /opt/nucleus/READY ]; then echo "already done"; exit 0; fi',
    ngcSecretArn
      ? `NGC_SECRET_ARN="${ngcSecretArn}"`
      : 'echo "no ngcSecretArn — manual install required"; exit 0',
    'REGION="' + region + '"',
    '',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -y || true',
    'apt-get install -y curl unzip jq awscli || true',
    '',
    '# --- Docker (멱등) ---',
    'if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi',
    'systemctl enable --now docker',
    'usermod -aG docker ubuntu || true',
    '',
    '# --- NGC 키 조회 (실패 시 비종료, 다음 부팅 재시도) ---',
    'NGC_KEY=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$NGC_SECRET_ARN" --query SecretString --output text)',
    'if [ -z "$NGC_KEY" ]; then echo "NGC key fetch failed; will retry next boot"; exit 1; fi',
    '',
    '# --- NGC CLI ---',
    'mkdir -p /opt/nucleus && cd /opt/nucleus',
    'if [ ! -x /opt/nucleus/ngc-cli/ngc ]; then',
    '  curl -L "https://api.ngc.nvidia.com/v2/resources/nvidia/ngc-apps/ngc_cli/versions/3.64.2/files/ngccli_linux.zip" -o ngccli.zip',
    '  unzip -oq ngccli.zip',
    'fi',
    'export NGC_CLI_API_KEY="$NGC_KEY" NGC_CLI_ORG=nvidia',
    '',
    '# --- nvcr.io 로그인 ---',
    'echo "$NGC_KEY" | docker login nvcr.io --username \'$oauthtoken\' --password-stdin || { echo "docker login failed; retry"; exit 1; }',
    '',
    '# --- compose stack 다운로드 (멱등) ---',
    '# NGC 가 받는 것은 nucleus-compose-stack-..._v2023.2.8/ 폴더 안의 .tar.gz 파일.',
    '# 그 tar.gz 를 풀어야 nucleus-stack-2023.2.8*/base_stack 이 나온다.',
    'if ! find /opt/nucleus -type d -name "nucleus-stack-2023.2.8*" | grep -q .; then',
    '  /opt/nucleus/ngc-cli/ngc registry resource download-version "nvidia/omniverse/nucleus-compose-stack-pb25h1:2023.2.8" || { echo "download failed; retry"; exit 1; }',
    '  TGZ=$(find /opt/nucleus -name "nucleus-stack-2023.2.8*.tar.gz" | head -1)',
    '  if [ -z "$TGZ" ]; then echo "tar.gz not found after download; retry"; exit 1; fi',
    '  tar xzf "$TGZ" -C "$(dirname "$TGZ")" || { echo "tar extract failed; retry"; exit 1; }',
    'fi',
    'STACK=$(find /opt/nucleus -type d -name "nucleus-stack-2023.2.8*" -not -name "*.tar.gz" | head -1)',
    'if [ -z "$STACK" ] || [ ! -d "$STACK/base_stack" ]; then echo "stack/base_stack missing; retry"; exit 1; fi',
    'cd "$STACK/base_stack"',
    '',
    '# --- .env 설정 (최초 1회만; 비밀번호 보존) ---',
    'if [ ! -f /opt/nucleus/CREDENTIALS.txt ]; then',
    '  # IMDSv2(토큰 필수) 대응: 토큰 먼저 받고 사설IP 조회. (구버전 IMDSv1 도 fallback)',
    '  TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")',
    '  PRIV_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)',
    '  [ -z "$PRIV_IP" ] && PRIV_IP=$(curl -s http://169.254.169.254/latest/meta-data/local-ipv4)',
    '  [ -z "$PRIV_IP" ] && PRIV_IP=$(hostname -I | awk "{print \\$1}")',
    '  if [ -z "$PRIV_IP" ]; then echo "FATAL: cannot determine private IP; retry"; exit 1; fi',
    '  MASTER_PW=$(openssl rand -base64 18 | tr -d "/+=" | head -c 20)',
    '  SERVICE_PW=$(openssl rand -base64 18 | tr -d "/+=" | head -c 20)',
    '  sed -i "s/^ACCEPT_EULA=.*/ACCEPT_EULA=1/" nucleus-stack.env',
    '  sed -i "s/^SECURITY_REVIEWED=.*/SECURITY_REVIEWED=1/" nucleus-stack.env',
    '  sed -i "s/^SERVER_IP_OR_HOST=.*/SERVER_IP_OR_HOST=${PRIV_IP}/" nucleus-stack.env',
    '  sed -i "s/^INSTANCE_NAME=.*/INSTANCE_NAME=workshop_nucleus/" nucleus-stack.env',
    '  sed -i "s|^MASTER_PASSWORD=.*|MASTER_PASSWORD=${MASTER_PW}|" nucleus-stack.env',
    '  sed -i "s|^SERVICE_PASSWORD=.*|SERVICE_PASSWORD=${SERVICE_PW}|" nucleus-stack.env',
    '  ./generate-sample-insecure-secrets.sh',
    '  printf "Nucleus: %s\\nadmin: omniverse\\nMASTER_PASSWORD: %s\\nSERVICE_PASSWORD: %s\\n" "$PRIV_IP" "$MASTER_PW" "$SERVICE_PW" > /opt/nucleus/CREDENTIALS.txt',
    '  chmod 600 /opt/nucleus/CREDENTIALS.txt',
    'fi',
    '',
    '# --- 기동 (no-SSL PoC) ---',
    'docker compose -f nucleus-stack-no-ssl.yml --env-file nucleus-stack.env up -d || { echo "compose up failed; retry"; exit 1; }',
    '',
    '# --- 컨테이너가 실제로 떴는지 확인 후에만 READY ---',
    'sleep 20',
    'UP=$(docker compose -f nucleus-stack-no-ssl.yml --env-file nucleus-stack.env ps --status running -q | wc -l)',
    'if [ "$UP" -ge 10 ]; then',
    '  echo "Nucleus up ($UP containers): $(date)" > /opt/nucleus/READY',
    'else',
    '  echo "only $UP containers up; retry next boot"; exit 1',
    'fi',
    'echo "=== nucleus-install done: $(date) ==="',
  ].join('\n');

  // systemd 서비스 + 설치 스크립트 설치, 즉시 1회 실행
  ud.addCommands(
    'set -x',
    // ubuntu 비밀번호 설정 (입력값 있을 때만)
    `UBUNTU_PW='${props.ubuntuPassword ?? ''}'`,
    'if [ -n "$UBUNTU_PW" ]; then echo "ubuntu:$UBUNTU_PW" | chpasswd; echo "ubuntu password set"; fi',
    'mkdir -p /opt/nucleus',
    'cat > /opt/nucleus/install.sh <<\'INSTALL_EOF\'',
    installScript,
    'INSTALL_EOF',
    'chmod +x /opt/nucleus/install.sh',
    '',
    'cat > /etc/systemd/system/nucleus-install.service <<\'UNIT_EOF\'',
    '[Unit]',
    'Description=Install and start Omniverse Nucleus',
    'After=network-online.target docker.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'ExecStart=/opt/nucleus/install.sh',
    'RemainAfterExit=true',
    'Restart=on-failure',
    'RestartSec=30',
    'TimeoutStartSec=1800',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'UNIT_EOF',
    '',
    'systemctl daemon-reload',
    'systemctl enable nucleus-install.service',
    'systemctl start --no-block nucleus-install.service',
  );

  return ud;
}
