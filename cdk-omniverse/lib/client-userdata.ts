import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface ClientUserDataProps {
  /** ubuntu 사용자 비밀번호 (DCV 콘솔/SSH 로그인용). 빈 값이면 설정 생략 */
  ubuntuPassword?: string;
  /** 워크샵 참가자(studentN) 계정 수 = 인스턴스당 동시 접속 인원. 기본 8 */
  studentCount: number;
  /** studentN 공통 DCV 로그인 비밀번호. 빈 값이면 부팅 시 랜덤 생성 후 로그에 기록 */
  studentPassword?: string;
}

/**
 * Isaac Sim 클라이언트 자동 설정 user-data.
 *
 * 목적: GPU 1대(마켓플레이스 AMI)에 여러 명이 DCV virtual 세션으로 동시 접속해
 *       디지털 트윈 씬을 각자 GPU 가속으로 보게 한다 (모니터링 비용 절감).
 *
 * ★ 실측으로 확인한 두 가지 필수 조건 (STREAMING_FINDINGS.md / 검증 기록 참조):
 *   1. nice-xdcv 설치 — virtual 세션의 X 서버(Xdcv). 마켓플레이스 AMI 에는 없어서
 *      설치 안 하면 세션이 생성 즉시 죽는다("Cannot launch Xdcv: not executable").
 *   2. GPU Xorg 가 DISPLAY=:0 을 점유 — DCV-GL 은 GL 호출을 ":0 의 3D X 서버"로
 *      오프로드한다. gdm 의 GPU Xorg 가 :1 로 밀리거나 :0 이 virtual 세션 자신이면
 *      llvmpipe(SW 렌더)로 폴백돼 Isaac Sim 을 못 돌린다. dcvgldiag 로 검증한다.
 *
 * 견고성 설계 (nucleus-userdata.ts 와 동일 패턴):
 *  - 설정 로직을 systemd oneshot(dcv-multiuser)로 등록 → user-data 1회성·재부팅 한계 극복.
 *    부팅마다 실행되지만 이미 정상이면 빠르게 통과(멱등). 세션도 없을 때만 생성.
 *  - Restart=on-failure 로 실패 시 자동 재시도. 모든 로그는 /var/log/dcv-multiuser.log.
 */
export function buildClientUserData(props: ClientUserDataProps): ec2.UserData {
  const { ubuntuPassword = '', studentCount, studentPassword = '' } = props;
  const ud = ec2.UserData.forLinux();

  // 공식 DCV 배포 tgz (nice-xdcv 포함). AMI 의 DCV 버전과 맞춘다.
  const DCV_PKG = 'nice-dcv-2025.0-20103-ubuntu2404-x86_64';
  const DCV_URL = `https://d1uj6qtbmh3dt5.cloudfront.net/2025.0/Servers/${DCV_PKG}.tgz`;

  const setupScript = [
    '#!/bin/bash',
    'exec >> /var/log/dcv-multiuser.log 2>&1',
    'echo "=== dcv-multiuser start: $(date) ==="',
    'set -x',
    '',
    `STUDENT_COUNT=${studentCount}`,
    `STUDENT_PW='${studentPassword}'`,
    `DCV_PKG="${DCV_PKG}"`,
    `DCV_URL="${DCV_URL}"`,
    '',
    '# 이미 정상 설정 완료됐으면(세션까지) 빠르게 통과. 단 세션 유실 시 아래서 재생성.',
    'DONE_MARK=/opt/dcv-multiuser/READY',
    '',
    'export DEBIAN_FRONTEND=noninteractive',
    '',
    '# --- 1. nice-xdcv 설치 (virtual 세션 필수). 없을 때만. ---',
    'if [ ! -x /usr/bin/Xdcv ]; then',
    '  echo "installing nice-xdcv..."',
    '  cd /tmp',
    '  curl -fsSL "$DCV_URL" -o dcv.tgz || { echo "dcv tgz download failed; retry next boot"; exit 1; }',
    '  tar xzf dcv.tgz',
    '  apt-get install -y "./${DCV_PKG}/nice-xdcv_"*.deb || { echo "nice-xdcv install failed; retry"; exit 1; }',
    'fi',
    'if [ ! -x /usr/bin/Xdcv ]; then echo "Xdcv still missing; retry"; exit 1; fi',
    '# dcv-gl 활성 보장 (AMI 에 설치돼 있음; 멱등)',
    'dcvgladmin enable >/dev/null 2>&1 || true',
    '',
    '# --- 2. console 자동생성 끄기 (console 과 virtual 은 동시 불가) ---',
    'if grep -q "^create-session = true" /etc/dcv/dcv.conf; then',
    '  cp -n /etc/dcv/dcv.conf /etc/dcv/dcv.conf.orig',
    '  sed -i "s/^create-session = true/create-session = false/" /etc/dcv/dcv.conf',
    '  dcv close-session console 2>/dev/null || true',
    '  systemctl restart dcvserver && sleep 3',
    'fi',
    '',
    '# --- 3. GPU Xorg 가 :0 을 점유하도록 정렬 ---',
    '# 이미 정상(dcvgldiag "No problem found")이면 건드리지 않는다(멱등, 세션 유지).',
    'if dcvgldiag 2>&1 | grep -q "No problem found"; then',
    '  echo "GPU 3D X server on :0 already OK"',
    'else',
    '  echo "realigning GPU Xorg to :0"',
    '  systemctl stop gdm 2>/dev/null; sleep 2',
    '  pkill -9 Xorg 2>/dev/null; sleep 2',
    '  # stale X 소켓/락이 :0 을 막으면 gdm 의 GPU Xorg 가 :1 로 밀린다 → 제거.',
    '  rm -f /tmp/.X11-unix/X* /tmp/.X*-lock',
    '  systemctl restart dcvserver && sleep 2',
    '  systemctl start gdm && sleep 15',
    '  if ! dcvgldiag 2>&1 | grep -q "No problem found"; then',
    '    echo "dcvgldiag still failing after realign; retry next boot"; exit 1',
    '  fi',
    'fi',
    '',
    '# --- 4. studentN 계정 + 공통 비밀번호 (최초 1회 생성) ---',
    'mkdir -p /opt/dcv-multiuser',
    'if [ -z "$STUDENT_PW" ] && [ ! -f /opt/dcv-multiuser/CREDENTIALS.txt ]; then',
    '  STUDENT_PW=$(openssl rand -base64 18 | tr -d "/+=" | head -c 16)',
    'fi',
    'if [ -f /opt/dcv-multiuser/STUDENT_PW ]; then STUDENT_PW=$(cat /opt/dcv-multiuser/STUDENT_PW); fi',
    'echo -n "$STUDENT_PW" > /opt/dcv-multiuser/STUDENT_PW && chmod 600 /opt/dcv-multiuser/STUDENT_PW',
    'for i in $(seq 1 "$STUDENT_COUNT"); do',
    '  u="student$i"',
    '  if ! id "$u" >/dev/null 2>&1; then',
    '    useradd -m -s /bin/bash "$u"',
    '    echo "$u:$STUDENT_PW" | chpasswd',
    '  fi',
    'done',
    '# 접속 정보 기록 (공통 비밀번호이므로 1회).',
    'if [ ! -f /opt/dcv-multiuser/CREDENTIALS.txt ]; then',
    '  printf "DCV users: student1..student%s\\ncommon password: %s\\n" "$STUDENT_COUNT" "$STUDENT_PW" \\',
    '    > /opt/dcv-multiuser/CREDENTIALS.txt',
    '  chmod 600 /opt/dcv-multiuser/CREDENTIALS.txt',
    'fi',
    '',
    '# --- 5. 각 studentN virtual 세션 생성 (세션 없을 때만; 부팅 후 재생성) ---',
    'for i in $(seq 1 "$STUDENT_COUNT"); do',
    '  u="student$i"',
    '  if ! dcv list-sessions 2>/dev/null | grep -q "${u}-session"; then',
    '    dcv create-session --type virtual --owner "$u" "${u}-session" || echo "create-session $u failed (continue)"',
    '    sleep 2',
    '  fi',
    'done',
    'dcv list-sessions',
    '',
    '# --- 6. 완료 표시 (세션이 최소 1개라도 떠야 READY) ---',
    'SESS=$(dcv list-sessions 2>/dev/null | grep -c "student")',
    'if [ "$SESS" -ge 1 ]; then',
    '  echo "dcv-multiuser ready ($SESS student sessions): $(date)" > "$DONE_MARK"',
    'else',
    '  echo "no student sessions up; retry next boot"; exit 1',
    'fi',
    'echo "=== dcv-multiuser done: $(date) ==="',
  ].join('\n');

  ud.addCommands(
    'set -x',
    // ubuntu 비밀번호 설정 (입력값 있을 때만) — 기존 동작 유지.
    `UBUNTU_PW='${ubuntuPassword}'`,
    'if [ -n "$UBUNTU_PW" ]; then echo "ubuntu:$UBUNTU_PW" | chpasswd; echo "ubuntu password set"; fi',
    'mkdir -p /opt/dcv-multiuser',
    "cat > /opt/dcv-multiuser/setup.sh <<'SETUP_EOF'",
    setupScript,
    'SETUP_EOF',
    'chmod +x /opt/dcv-multiuser/setup.sh',
    '',
    "cat > /etc/systemd/system/dcv-multiuser.service <<'UNIT_EOF'",
    '[Unit]',
    'Description=Configure DCV virtual multi-session (student1..N) with GPU acceleration',
    // gdm(GPU Xorg :0)과 dcvserver 가 준비된 뒤 실행.
    'After=network-online.target dcvserver.service gdm.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'ExecStart=/opt/dcv-multiuser/setup.sh',
    'RemainAfterExit=true',
    'Restart=on-failure',
    'RestartSec=30',
    'TimeoutStartSec=1200',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'UNIT_EOF',
    '',
    'systemctl daemon-reload',
    'systemctl enable dcv-multiuser.service',
    'systemctl start --no-block dcv-multiuser.service',
  );

  return ud;
}
