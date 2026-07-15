import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface ClientUserDataProps {
  /**
   * ubuntu 사용자 비밀번호 (DCV 콘솔/SSH 로그인용). 빈 값이면 설정 생략
   * Password for the ubuntu user (DCV console/SSH login). Skipped when empty.
   */
  ubuntuPassword?: string;
  /**
   * 워크샵 참가자(studentN) 계정 수 = 인스턴스당 동시 접속 인원. 기본 8
   * Number of workshop participant (studentN) accounts = concurrent users per instance. Default 8.
   */
  studentCount: number;
  /**
   * studentN 공통 DCV 로그인 비밀번호. 빈 값이면 부팅 시 랜덤 생성 후 로그에 기록
   * Common DCV login password for studentN. If empty, generated randomly at boot and recorded in the log.
   */
  studentPassword?: string;
}

/**
 * Isaac Sim 클라이언트 자동 설정 user-data.
 *
 * 목적: GPU 1대(마켓플레이스 AMI)에 여러 명이 DCV virtual 세션으로 동시 접속해
 *       디지털 트윈 씬을 각자 GPU 가속으로 보게 한다 (모니터링 비용 절감).
 *
 * ★ 실측으로 확인한 두 가지 필수 조건 (docs/스트리밍-실측노트.md / 검증 기록 참조):
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
 *
 * (English)
 * User-data that auto-configures the Isaac Sim client.
 *
 * Purpose: let multiple people attach to one GPU (Marketplace AMI) concurrently via DCV virtual
 *          sessions, each viewing the digital twin scene GPU-accelerated (cuts monitoring cost).
 *
 * Two prerequisites confirmed by field measurement (see docs/스트리밍-실측노트.md / verification notes):
 *   1. Install nice-xdcv — the X server (Xdcv) for virtual sessions. Missing from the Marketplace AMI;
 *      without it, sessions die right after creation ("Cannot launch Xdcv: not executable").
 *   2. The GPU Xorg must occupy DISPLAY=:0 — DCV-GL offloads GL calls to "the 3D X server on :0".
 *      If gdm's GPU Xorg gets pushed to :1, or :0 is the virtual session itself, it falls back to
 *      llvmpipe (software rendering) and cannot run Isaac Sim. Verified with dcvgldiag.
 *
 * Robustness design (same pattern as nucleus-userdata.ts):
 *  - Register the setup logic as a systemd oneshot (dcv-multiuser) → overcomes the one-shot/reboot
 *    limits of user-data. Runs on every boot but passes quickly when already healthy (idempotent).
 *    Sessions are created only when absent.
 *  - Restart=on-failure retries automatically on failure. All logs go to /var/log/dcv-multiuser.log.
 */
export function buildClientUserData(props: ClientUserDataProps): ec2.UserData {
  const { ubuntuPassword = '', studentCount, studentPassword = '' } = props;
  const ud = ec2.UserData.forLinux();

  // 공식 DCV 배포 tgz (nice-xdcv 포함). AMI 의 DCV 버전과 맞춘다.
  // Official DCV distribution tgz (includes nice-xdcv). Matched to the AMI's DCV version.
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
    '# If setup (including sessions) is already complete, pass through quickly. Lost sessions are recreated below.',
    'DONE_MARK=/opt/dcv-multiuser/READY',
    '',
    'export DEBIAN_FRONTEND=noninteractive',
    '',
    '# --- 1. nice-xdcv + nice-dcv-gl 설치 ---',
    '# --- 1. Install nice-xdcv + nice-dcv-gl ---',
    '# 마켓플레이스 AMI 에는 nice-dcv-server/web-viewer/xdcv 만 있고,',
    '#   - nice-xdcv    : virtual 세션 X 서버(Xdcv). (AMI 에 있을 수도) 없으면 세션 즉시 죽음.',
    '#   - nice-dcv-gl  : GPU 오프로드 런타임 + dcvgladmin/dcvgldiag. AMI 에 없어서 반드시 설치.',
    '# The Marketplace AMI only ships nice-dcv-server/web-viewer/xdcv, where:',
    '#   - nice-xdcv    : X server (Xdcv) for virtual sessions. (May exist on the AMI.) Without it sessions die instantly.',
    '#   - nice-dcv-gl  : GPU offload runtime + dcvgladmin/dcvgldiag. Absent from the AMI, so it must be installed.',
    'if [ ! -x /usr/bin/Xdcv ] || ! dpkg -l nice-dcv-gl >/dev/null 2>&1; then',
    '  echo "installing nice-xdcv + nice-dcv-gl..."',
    '  cd /tmp',
    '  curl -fsSL "$DCV_URL" -o dcv.tgz || { echo "dcv tgz download failed; retry next boot"; exit 1; }',
    '  tar xzf dcv.tgz',
    '  apt-get install -y "./${DCV_PKG}/nice-xdcv_"*.deb "./${DCV_PKG}/nice-dcv-gl_"*.deb \\',
    '    || { echo "nice-xdcv/nice-dcv-gl install failed; retry"; exit 1; }',
    'fi',
    'if [ ! -x /usr/bin/Xdcv ]; then echo "Xdcv still missing; retry"; exit 1; fi',
    'if ! command -v dcvgldiag >/dev/null 2>&1; then echo "dcvgldiag missing (nice-dcv-gl); retry"; exit 1; fi',
    '# dcv-gl 활성 (GLVND). 멱등. / Enable dcv-gl (GLVND). Idempotent.',
    'dcvgladmin enable >/dev/null 2>&1 || true',
    '',
    '# --- 1-2. deb 네이티브 브라우저 설치 (Nucleus Navigator 웹 UI 열람용) ---',
    '# --- 1-2. Install a deb-native browser (for viewing the Nucleus Navigator web UI) ---',
    '# AMI 의 firefox/chromium 은 snap 패키지라 DCV virtual 세션(student 계정)에서 mount',
    '# namespace 충돌로 실행 불가. epiphany(GNOME Web)+dbus-x11 은 deb 라서 정상 동작.',
    "# The AMI's firefox/chromium are snap packages and fail to run in DCV virtual sessions (student",
    '# accounts) due to mount namespace conflicts. epiphany (GNOME Web)+dbus-x11 are debs and work fine.',
    'if ! command -v epiphany >/dev/null 2>&1; then',
    '  apt-get install -y epiphany-browser dbus-x11 || echo "browser install failed (continue)"',
    'fi',
    '',
    '# --- 2. console 자동생성 끄기 (console 과 virtual 은 동시 불가) ---',
    '# --- 2. Disable console auto-creation (console and virtual sessions cannot coexist) ---',
    'if grep -q "^create-session = true" /etc/dcv/dcv.conf; then',
    '  cp -n /etc/dcv/dcv.conf /etc/dcv/dcv.conf.orig',
    '  sed -i "s/^create-session = true/create-session = false/" /etc/dcv/dcv.conf',
    '  dcv close-session console 2>/dev/null || true',
    '  systemctl restart dcvserver && sleep 3',
    'fi',
    '',
    '# --- 3. GPU Xorg 가 :0 을 점유하도록 정렬 ---',
    '# --- 3. Align things so the GPU Xorg occupies :0 ---',
    '# 이미 정상(dcvgldiag "No problem found")이면 건드리지 않는다(멱등, 세션 유지).',
    '# If already healthy (dcvgldiag "No problem found"), leave it alone (idempotent, sessions preserved).',
    'if dcvgldiag 2>&1 | grep -q "No problem found"; then',
    '  echo "GPU 3D X server on :0 already OK"',
    'else',
    '  echo "realigning GPU Xorg to :0"',
    '  systemctl stop gdm 2>/dev/null; sleep 2',
    '  pkill -9 Xorg 2>/dev/null; sleep 2',
    '  # stale X 소켓/락이 :0 을 막으면 gdm 의 GPU Xorg 가 :1 로 밀린다 → 제거.',
    "  # Stale X sockets/locks blocking :0 push gdm's GPU Xorg to :1 → remove them.",
    '  rm -f /tmp/.X11-unix/X* /tmp/.X*-lock',
    '  systemctl restart dcvserver && sleep 2',
    '  systemctl start gdm',
    '  # gdm 의 GPU Xorg 가 :0 을 잡을 때까지 폴링 (갓 부팅한 인스턴스는 15초로 부족).',
    "  # Poll until gdm's GPU Xorg grabs :0 (15s is not enough on a freshly booted instance).",
    '  for t in $(seq 1 24); do',
    '    sleep 5',
    '    [ -S /tmp/.X11-unix/X0 ] && dcvgldiag 2>&1 | grep -q "No problem found" && break',
    '  done',
    '  if ! dcvgldiag 2>&1 | grep -q "No problem found"; then',
    '    echo "dcvgldiag still failing after realign (waited ~120s); retry next boot"; exit 1',
    '  fi',
    'fi',
    '',
    '# --- 4. studentN 계정 + 공통 비밀번호 (최초 1회 생성) ---',
    '# --- 4. studentN accounts + common password (created once on first run) ---',
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
    '# 접속 정보 기록 (공통 비밀번호이므로 1회). / Record access info (once, since the password is shared).',
    'if [ ! -f /opt/dcv-multiuser/CREDENTIALS.txt ]; then',
    '  printf "DCV users: student1..student%s\\ncommon password: %s\\n" "$STUDENT_COUNT" "$STUDENT_PW" \\',
    '    > /opt/dcv-multiuser/CREDENTIALS.txt',
    '  chmod 600 /opt/dcv-multiuser/CREDENTIALS.txt',
    'fi',
    '',
    '# --- 4-2. Isaac Sim 런처 스크립트 배치 (다중 사용자 포트 충돌 방지) ---',
    '# --- 4-2. Deploy the Isaac Sim launcher script (avoids multi-user port collisions) ---',
    '# Isaac Sim(kit)은 0.0.0.0:8011(HTTP 서비스)을 쓰는데 인스턴스 전체 공유라,',
    '# 여러 student 가 동시에 띄우면 "address already in use" 로 죽는다.',
    '# 런처가 uid 로 포트를 자동 계산(student1->8001 ... student8->8008)해 충돌을 없앤다.',
    '# Isaac Sim (kit) uses 0.0.0.0:8011 (HTTP service), shared instance-wide, so when several',
    '# students launch it concurrently it dies with "address already in use".',
    '# The launcher derives the port from the uid (student1->8001 ... student8->8008), removing collisions.',
    "cat > /usr/local/bin/launch-isaac <<'LAUNCH_EOF'",
    '#!/bin/bash',
    '# 각 student 가 그냥 "launch-isaac" 만 실행하면 됨. uid 로 포트 자동 분리.',
    '# Each student just runs "launch-isaac". Ports are separated automatically by uid.',
    'PORT=$((8000 + $(id -u) - 1000))',
    'echo "Isaac Sim starting (HTTP port $PORT for $(whoami))..."',
    'cd /opt/IsaacSim && exec ./isaac-sim.sh --/exts/omni.services.transport.server.http/port=$PORT "$@"',
    'LAUNCH_EOF',
    'chmod +x /usr/local/bin/launch-isaac',
    '',
    '# --- 5. 각 studentN virtual 세션 생성 (세션 없을 때만; 부팅 후 재생성) ---',
    '# --- 5. Create each studentN virtual session (only when absent; recreated after boot) ---',
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
    '# --- 6. Mark completion (READY only when at least one session is up) ---',
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
    // Set the ubuntu password (only when a value is provided) — preserves existing behavior.
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
    // Runs after gdm (GPU Xorg :0) and dcvserver are ready.
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
