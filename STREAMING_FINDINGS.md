# 스트리밍/다중 접속 실측 노트 (Isaac Sim 5.1, EC2 g6e)

> 워크샵에서 "여러 명이 같은 디지털 트윈을 본다"를 어떻게 구현할지 조사·실측한 기록.
> **결론 먼저**: WebRTC 스트리밍은 인스턴스당 1명. 다수 공유는 **Nucleus Live**, 비용 절감(1 GPU에 여러 명)은
> **DCV virtual 다중세션**이 후보다. 아래는 근거와 시행착오 전체.

환경:
- Isaac Sim **5.1.0** (마켓플레이스 AMI `OV-Template-aws-ubuntu-isaac_sim-*`, `/opt/IsaacSim`)
- 클라이언트 EC2 **g6e.2xlarge (L40S 46GB)**, 리전 `ap-northeast-2`
- 배포: CDK(`cdk-omniverse`) — 클라이언트 2대 + Nucleus 1대

---

## 1. WebRTC 라이브스트리밍 — 인스턴스당 1명 (one-to-one)

### 실측/근거
- 공식 문서: **"Only one client can access an Isaac Sim instance at a time."**
- 바이너리(`libNvStreamServer.so`)에 연결 거부 코드 `NVST_DISCONN_MAX_CONCURRENT_SESSION_LIMIT` 존재.
- 세션 수를 늘리는 kit 설정 키는 **없음**.
- 이 제한은 **네이티브 클라이언트·브라우저 웹 뷰어 둘 다** 적용(같은 WebRTC 전송).

### 5.1 설정 키 (중요 — 문서와 다름)
공식 문서 예시는 **6.0 네임스페이스**라 5.1에선 무시된다:
- ❌ (6.0) `--/exts/omni.kit.livestream.app/primaryStream/publicIp|signalPort|streamPort`
- ✅ (5.1) `/app/livestream/` 네임스페이스 (바이너리 `strings` 로 확정):
  | 키 | 용도 |
  |----|------|
  | `--/app/livestream/publicEndpointAddress=<공인IP>` | **NAT/공인망 접속 시 필수**. 없으면 서버가 사설IP만 ICE 광고 → **검은 화면** |
  | `--/app/livestream/minHostPort` / `maxHostPort` | 미디어 UDP 포트 범위 고정 (SG를 좁게 열 수 있음) |
  | `--/app/livestream/port` (기본 49100) | 시그널 포트 |
  | `--/app/livestream/publicEndpointPort` | 공인 시그널 포트 |

### 올바른 5.1 스트리밍 실행 (검증됨)
```bash
cd /opt/IsaacSim
HOST_IP=$(curl -s https://checkip.amazonaws.com)
./isaac-sim.streaming.sh \
  --ext-folder /home/ubuntu/digital_twin/exts --enable robot.monitor \
  --/app/livestream/publicEndpointAddress=$HOST_IP \
  --/app/livestream/minHostPort=47998 --/app/livestream/maxHostPort=48010
```
- `Streaming server started.` + `Isaac Sim Full Streaming App is loaded.` **둘 다** 뜬 뒤 접속(로드 전 접속 시 검은 화면).
- `robot.monitor` 확장 → `factory_scene.usda` 자동 오픈, "Robot Telemetry Monitor" 패널도 스트림에 보이고 조작됨(`hideUi=false`).

### 시행착오 (검은 화면 디버깅)
1. 6.0용 인자를 줬으나 5.1에서 무시 → publicEndpointAddress 누락 → 서버가 사설IP(10.x)만 광고 → **검은 화면**.
2. `ss -tulnp` 에 UDP 미디어 포트가 연결 전엔 안 뜸(정상, ICE 동적 할당). `minHostPort/maxHostPort`로 고정해야 SG로 통제 가능.
3. ufw inactive, NVENC(L40S) 정상, 노트북 IP도 SG 대역 안 → 결국 원인은 **설정 키(publicEndpointAddress)** 였음.
4. 수정 후 노트북 네이티브 클라이언트에서 원격 접속·조작 **성공**.

---

## 2. 다중 스트리밍 서버 (한 머신에 여러 개) — 네이티브 클라이언트론 불가

### 실측
- 한 EC2에서 스트리밍 서버 2개를 다른 포트로 동시 기동 성공:
  - A: `port=49100`, media `47998-48002` → LISTEN ✅
  - B: `port=49101`, media `48003-48007` → LISTEN ✅
  - GPU: L40S 46GB 중 **6.3GB / 18%** — 여유 충분(A 3.1GB, B 0.9GB).
- 즉 **머신당 제한이 아니라 인스턴스당 1명**. 서버를 늘리면 접속 슬롯은 늘어난다.

### 그러나 — 네이티브 클라이언트는 포트 지정 불가
- 네이티브 **Isaac Sim WebRTC Streaming Client**는 **IP만 입력**, 포트(49100) 고정.
  IP:port·설정파일·CLI 옵션 **없음**(공식 문서 확인 + 실사용 확인).
- → 2번째 서버(49101)에 **네이티브 클라이언트로는 접속 불가**.
- multi-instance/custom-port는 **브라우저 웹 뷰어 전용** 경로("The web viewer supports multi-instance deployment with... custom ports").

### 결론
- 다중 스트리밍 서버는 **각자 독립 씬**이라 "같은 트윈 공유"도 아니고, 네이티브론 접속도 안 됨 → **워크샵 부적합**.

---

## 3. 다수가 같은 트윈 보기 → Nucleus Live (정답)

- WebRTC는 픽셀 스트리밍(1:1). **Nucleus Live는 씬 상태(USD) 동기화**라 여러 명이 같은 씬 공유.
- 이 프로젝트에 **이미 구축·검증됨**: `WORKSHOP.md` Step 7, `IOT_MONITORING.md` Live 공유 원리.
- IoT 트윈과 통합: 강사 1명 **Publish ON** → Kinesis 데이터를 로봇 USD `customData`/`transform`에 기록 →
  **Nucleus Live가 모든 클라이언트로 자동 전파** → 각자 같은 로봇 움직임·데이터를 봄.
- 단 **UI 패널(omni.ui)은 Live 공유 안 됨** — USD(위치/데이터)만 공유. 각자 자기 패널.
- 트레이드오프: **참가자마다 GPU 클라이언트 필요**(각자 렌더). 비용↑.

---

## 4. GPU 인스턴스 활용 극대화 (비용 절감) — 옵션 비교

| 방법 | GPU 대수 | 동시 인원 | 같은 트윈 공유 | 세팅 부담 |
|------|:---:|:---:|:---:|:---:|
| WebRTC 스트리밍 | 1인당 서버1 | ❌ 인스턴스당 1명 | ❌ | 낮음 |
| **DCV virtual 다중세션** | **1대에 여러 명** | ✅ | ❌ 각자 독립 | 높음 |
| Nucleus Live | 1인당 1 GPU | ✅ | ✅ | 중간(구축됨) |
| DCV virtual + Nucleus Live | 1대에 여러 명 | ✅ | ✅ | 높음 |

### DCV 세션 타입 (실측)
- **Console 세션**: 서버당 **1개만**. GPU 직접 접근. 마켓플레이스 AMI 기본(부팅 시 자동 생성).
- **Virtual 세션**: **여러 개 가능**(Linux 전용). 단 GPU 가속엔 **`dcv-gl` 패키지 필요**.
- **console과 virtual은 동시 불가.**
- 같은 OS 유저로 다중 virtual 세션 금지(홈폴더/D-Bus 충돌) → **참가자마다 별도 OS 계정** 필요.

### 배포 클라이언트(마켓플레이스 AMI) 현황 — 실측
- `nice-dcv-server` 2025.0 설치됨, **console 세션 1개**로 구성(`automatic-console-session`).
- **`dcv-gl` 미설치**(apt 저장소에도 없음, NICE에서 수동 설치), `Xdcv`도 안 보임.
- → **virtual 다중세션 + GPU 가속을 쓰려면 추가 설치·설정 필요** (다음 작업 대상).

### DCV virtual 다중세션 세팅에 필요한 작업 (예정)
1. `dcv-gl` 설치 + `dcv-gl.conf` 로 가상 X서버를 GPU에 연결.
2. console 자동생성 끄기(동시 불가).
3. 참가자별 OS 계정 생성.
4. 계정별 virtual 세션 생성 + Isaac Sim 실행.
5. (선택) 각 세션이 Nucleus Live 참여 → 1 GPU에 여러 명 + 같은 트윈.

---

## 5. 실배포 참고값 (2026-07, ap-northeast-2)

| 항목 | 값 |
|------|-----|
| 클라이언트1 DCV | https://<클라이언트1-공인IP>:8443 |
| 클라이언트2(스트리밍 호스트) DCV | https://<클라이언트2-공인IP>:8443 |
| Nucleus Navigator | http://<Nucleus-공인IP>:8080 |
| Nucleus 사설 IP (Isaac 연결) | <Nucleus-사설IP> |
| DCV 로그인 | `ubuntu` / (배포 시 지정) |
| 클라이언트 SG | 관리(DCV/SSH)=allowCidr, 뷰어(WebRTC 49100·미디어 47998-48010·8210)=viewerCidr |

### CDK 보안 (커밋 a1c4504)
- `allowCidr` **필수**(미지정·0.0.0.0/0 배포 차단) — 관리 접근(DCV/SSH).
- `viewerCidr` — 뷰어(WebRTC) 접속 대역. 미지정 시 allowCidr 폴백, 0.0.0.0/0 금지.
- 미디어 UDP는 범위 **47998-48010**(5.1 min/maxHostPort와 일치)로 좁게 개방.

### 겪은 배포 이슈 (해결됨)
- CDK deploy 가 이 EC2에서 Node SDK 소켓 hang(asset publish 단계). aws CLI(Python)는 정상.
  → **합성 템플릿을 aws CLI 로 직접 `create-stack`** 해서 우회 성공.
- 리전 함정: 셸 `AWS_REGION=us-east-1` 가 CDK 기본(ap-northeast-2)을 덮어써 AMI not found.
  → 배포 시 `AWS_REGION=ap-northeast-2` 명시.

---

> ⚠️ 보안: 배포 시 NGC API 키·DCV 비밀번호가 명령행에 평문 노출된 이력 있음 → 워크샵 후 키 폐기·비번 변경 권장.
