# C단계 — 실시간 데이터 연동 트윈 (AWS IoT → Isaac Sim 모니터링)

가짜 로봇이 운영 데이터를 5초마다 AWS로 보내고, Isaac Sim 안에서 실시간 차트로 보는 PoC.

```
[robot_simulator.py]  ──MQTT──▶ [AWS IoT Core] ──IoT Rule──▶ [Kinesis: robot-telemetry]
   (로컬, 가짜 Nova Carter)                                          │
                                                                     ▼
                              [Isaac Sim 확장 robot.monitor] ◀── boto3 polling
                                  omni.ui.Plot 실시간 차트 + 상태/insight
```

검증 완료: 로컬→IoT→Kinesis 도달 + 소비기 시계열 수신 확인. (UI는 Isaac Sim GUI에서 확인)

---

## 1. AWS 인프라 (CLI로 생성됨 — 나중에 CDK 통합 예정)

| 리소스 | 값 |
|------|------|
| Kinesis Stream | `robot-telemetry` (1 shard) |
| IoT Thing | `nova_carter_01` |
| IoT 엔드포인트 | `aws iot describe-endpoint --endpoint-type iot:Data-ATS` 로 조회 (env `IOT_ENDPOINT` 로 주입) |
| MQTT 토픽 | `robots/<robot_id>/telemetry` |
| IoT Rule | `robot_telemetry_to_kinesis` (SELECT * FROM 'robots/+/telemetry' → Kinesis) |
| IoT→Kinesis IAM 역할 | `iot-to-kinesis-role` |
| 디바이스 인증서 | `~/digital_twin/iot/certs/` (device.cert.pem, device.private.key, AmazonRootCA1.pem) |

> ⚠️ `certs/` 의 private key 는 비밀. git 에 올리지 말 것(.gitignore 처리).

---

## 2. 데이터 생성기 실행 (발행기)

발행기는 `awsiotsdk`(awscrt+awsiot) 가 필요하고, IoT Core 인증에 `iot/certs/` 의 디바이스 인증서를
쓴다. 시스템 python 은 PEP668 로 pip 설치가 막혀 있어 **venv** 를 쓴다. 셋업 스크립트가 한 번에 처리:

```bash
cd ~/digital_twin/iot          # (워크샵 클라이언트에선 ~/nvidia-omniverse-digital-twin/iot)
bash setup_publisher.sh        # venv 생성 + awsiotsdk 설치 + IOT_ENDPOINT 조회/캐시 (멱등, 1회)
```
> `setup_publisher.sh` 없이 수동으로 하려면: `python3 -m venv ~/venv && ~/venv/bin/pip install -r requirements.txt`
> (venv 생성 실패 시 `sudo apt-get install -y python3-venv`). 발행기엔 `iot/certs/` 인증서가 있어야 한다.

실행 (venv 파이썬 사용):
```bash
IOT_ENDPOINT=$(cat ~/.iot_endpoint) ~/venv/bin/python -u robot_simulator.py --interval 5      # 1대, 5초 간격
IOT_ENDPOINT=$(cat ~/.iot_endpoint) ~/venv/bin/python -u robot_simulator.py --robots 3 --interval 5   # 3대
```
- 셋업이 `~/.bashrc` 에 `IOT_ENDPOINT` 를 넣으므로, 새 셸에선 `~/venv/bin/python -u robot_simulator.py ...` 만 해도 된다.
- `~/venv/bin/python` 을 써야 한다(시스템 `python3` 엔 awsiotsdk 없음). `-u` 는 출력 즉시 표시.
- 텔레메트리: `battery_pct, motor_temp_c, speed_mps, position(x,y), heading_deg, odometer_m, status, error_count`
- 상태 머신: moving(배터리↓·발열↑) → 20%↓ 면 charging → 95%↑ 면 moving.

생성기만으로 파이프라인 검증(Kinesis 도달 확인):
```bash
SHARD=$(aws kinesis get-shard-iterator --region ap-northeast-2 --stream-name robot-telemetry \
  --shard-id shardId-000000000000 --shard-iterator-type LATEST --query ShardIterator --output text)
aws kinesis get-records --region ap-northeast-2 --shard-iterator "$SHARD" --limit 5
```

---

## 3. Isaac Sim 모니터링 확장 (robot.monitor)

### 확장 구조
```
~/digital_twin/exts/robot.monitor/
├── config/extension.toml
└── robot/monitor/
    ├── __init__.py
    ├── extension.py         # UI + 발행/표시 + 보간 이동 + 클릭 인터랙션
    ├── kinesis_consumer.py  # 백그라운드 Kinesis 폴링 → TelemetryStore
    └── usd_bridge.py        # 텔레메트리 ↔ USD 프림(customData/transform)
```

### Isaac Sim 에 로드 (3가지 방법)

**A) 명령행 (가장 확실 — UI 입력 불필요):**
```bash
/opt/IsaacSim/isaac-sim.sh \
  --ext-folder /home/ubuntu/digital_twin/exts \
  --enable robot.monitor
```

**B) user.config.json 에 검색 경로 주입 (재시작 시 자동):**
```
~/.local/share/ov/data/Kit/Isaac-Sim Full/5.1/user.config.json
→ exts.folders 에 "/home/ubuntu/digital_twin/exts" 추가
```

**C) Extensions UI:** Window → Extensions → ⚙ → Search Paths 에 경로 추가 후 토글.
> DCV+한글 IME 환경에서 UI 입력이 막히는 경우가 있어 A/B 권장.

> Isaac Sim 내장 python 에 boto3 포함(추가 설치 불필요).
> Kinesis 읽기 권한 필요(인스턴스 IAM Role 또는 `~/.aws/credentials`).

### 두 가지 모드 (UI 체크박스)
- **Publish (발행, 강사 1명만 ON)**: Kinesis 소비 → 로봇 USD 프림 customData 에 기록.
  Nucleus Live 세션이면 **모든 클라이언트에 자동 전파**(나머지는 폴링 불필요).
- **Move (이동)**: 텔레메트리 position/heading 으로 로봇 프림을 **부드럽게 이동**(보간).

### UI 구성
- **Mode/Publish, Move** 체크박스 (PoC 기본 둘 다 ON)
- **Stream**: 소비기 상태(running/error) 또는 display mode
- **Robot**: 로봇 선택 ComboBox — **뷰포트에서 로봇 클릭 시 자동 전환**
- **수치 패널**: status / battery% / motor temp / speed / position / odometer / errors
  - 배터리 ≤30% → 빨강, 모터온도 ≥70°C → 빨강 (insight 경고)
- **차트(omni.ui.Plot)**: 배터리(0-100) / 모터온도(20-90) / 속도(0-2) 실시간 라인

### 동작 원리 (핵심)
```
KinesisConsumer(백그라운드 스레드) → TelemetryStore(thread-safe)
        │ (Publish ON 시)
        ▼
usd_bridge.write_telemetry()  로봇 프림 customData["telemetry"] = JSON
        │ Nucleus Live 가 USD 변경을 모든 클라이언트로 전파
        ▼
각 클라이언트: usd_bridge.read_telemetry() 로 값 읽음
   - omni.ui.Plot 차트 갱신 (ts 바뀔 때만 시계열에 append → 차트 끊김/평탄화 방지)
   - _update_motion(): position/heading 목표로 매 프레임 lerp(a=0.08) → 부드러운 이동
   - 뷰포트 SELECTION_CHANGED 이벤트 → 클릭한 로봇으로 대시보드 전환
```

**공유 원리**: UI 패널은 Live 로 공유되지 않지만, **USD(customData/transform)는 공유**된다.
→ 발행자가 USD 에 쓰면 모든 클라이언트가 같은 데이터를 보고, 로봇도 같이 움직인다.

### 편의 기능
- 확장 시작 시 스테이지에 로봇 프림이 없으면 PoC 테스트 씬(`iot/test_scene.usda`) 자동 오픈.
- `test_scene.usda`: Nova Carter reference + `customData.robot_id="nova_carter_01"` (매칭 보장).

---

## 4. 데모 시나리오

1. 터미널에서 `robot_simulator.py` 실행 (데이터 흐르기 시작).
2. Isaac Sim 을 명령행(3-A)으로 실행 → 테스트 씬 자동 오픈 + 확장 활성화.
3. **차트가 5초마다 갱신**되고, **로봇이 창고를 부드럽게 돌아다님**.
4. 배터리 20%↓ → status=charging, 배터리 곡선 반등 → "살아있는 트윈".
5. **뷰포트에서 로봇 클릭 → 그 로봇 대시보드로 전환** (다중 로봇 시).
6. 다른 클라이언트도 같은 Nucleus 씬을 Live 로 열면 → 동일한 움직임/데이터 공유.

---

## 5. 정리 / 다음 단계

- **정리(비용)**: PoC 후 리소스 삭제
  ```bash
  aws kinesis delete-stream --region ap-northeast-2 --stream-name robot-telemetry --enforce-consumer-deletion
  aws iot delete-topic-rule --region ap-northeast-2 --rule-name robot_telemetry_to_kinesis
  # IoT Thing/인증서/정책은 detach 후 삭제 (순서 주의)
  ```
- **CDK 통합 (예정)**: IoT/Kinesis/IAM 을 `cdk-omniverse` 스택에 추가해 한 번에 배포.
- **확장 아이디어**:
  - 로봇 3D 위에 배터리/상태 텍스트 오버레이
  - 임계 초과 시 로봇을 빨갛게 하이라이트
  - 다중 로봇(`--robots N`) + 헤드리스 발행자로 전환
  - 상세 이력·집계는 Grafana(Amazon Managed Grafana) + Timestream

---

## 6. 트러블슈팅 (실제 겪은 함정)

| 증상 | 원인 / 해결 |
|------|------|
| 생성기 출력이 안 보임 | Python 버퍼링 → `python3 -u` (unbuffered) 사용 |
| Extensions UI 검색경로 입력 안 됨 | DCV+IME 충돌 → 명령행 `--ext-folder` 또는 user.config.json 주입 |
| 차트·콤보 안 나옴 (`prim_by_rid={}`) | 씬에 로봇 프림 없음 → 테스트 씬 열기(자동 오픈 기능 추가됨) |
| 위치인자로 준 USD 가 안 열림 | Isaac Sim은 kit 위치인자 무시 → 확장이 `open_stage()` 로 자동 오픈 |
| 차트가 그려지나 갱신 안 됨/평탄 | `_on_update` 가 매 프레임 같은 값 누적 → ts 변경 시에만 append |
| 로봇 이동이 뚝뚝 끊김 | 5초 간격 스냅 → 매 프레임 lerp 보간(`a=0.08`) |
| robot_id ↔ 프림 매칭 실패 | customData.robot_id 우선, 없으면 이름/경로 부분일치(베이스명) |
| `apply_motion` 가 False | usd_bridge 가 omni import 실패 시 pxr 까지 None → omni/pxr import 분리 |
