# 핸즈온 워크샵 — 공장 4종 로봇 실시간 데이터 트윈

> **목표**: 대형 창고에 로봇 4종을 배치하고, 가짜 운영 데이터가 AWS를 거쳐
> Isaac Sim 안에서 **실시간 차트 + 로봇 움직임**으로 살아나는 디지털 트윈을 만든다.
> **대상**: 입문자. 명령어는 그대로 복사·붙여넣기 하면 된다.
> **소요**: 약 40~60분 (Isaac Sim 첫 기동 시간 포함).

```
[factory_simulator.py]──MQTT──▶[IoT Core]──Rule──▶[Kinesis]
   로봇 4종 가짜데이터                                  │
                                                       ▼
                        [Isaac Sim + robot.monitor 확장]
                        실시간 차트 + 로봇 이동 + 클릭 대시보드
```

전제: AWS 계정/자격증명, NVIDIA Isaac Sim 5.1 설치, 인터넷.
리전은 예시로 `ap-northeast-2`(서울)를 쓴다.

---

## STEP 0. 준비 확인

```bash
aws sts get-caller-identity          # AWS 자격증명 OK?
ls /opt/IsaacSim/isaac-sim.sh        # Isaac Sim 설치 OK?
python3 -c "import boto3, awsiot"    # 라이브러리 OK? (없으면 아래)
```
라이브러리 없으면:
```bash
sudo apt-get install -y python3-pip
python3 -m pip install --break-system-packages awsiotsdk boto3
```

---

## STEP 1. AWS IoT 인프라 만들기 (1회)

> 이미 만들어 두었다면 STEP 2 로. 처음이면 아래를 순서대로.

### 1-1. Kinesis 스트림
```bash
RG=ap-northeast-2
aws kinesis create-stream --region $RG --stream-name robot-telemetry --shard-count 1
aws kinesis wait stream-exists --region $RG --stream-name robot-telemetry
```

### 1-2. IoT→Kinesis 권한(IAM 역할)
```bash
ACCT=$(aws sts get-caller-identity --query Account --output text)
cat > /tmp/iot-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"iot.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name iot-to-kinesis-role --assume-role-policy-document file:///tmp/iot-trust.json
cat > /tmp/kinesis-put.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"kinesis:PutRecord","Resource":"arn:aws:kinesis:$RG:$ACCT:stream/robot-telemetry"}]}
EOF
aws iam put-role-policy --role-name iot-to-kinesis-role --policy-name kinesis-put --policy-document file:///tmp/kinesis-put.json
```

### 1-3. IoT 디바이스(Thing) + 인증서
```bash
mkdir -p ~/digital_twin/iot/certs && cd ~/digital_twin/iot/certs
aws iot create-thing --region $RG --thing-name factory_robots
CERT_ARN=$(aws iot create-keys-and-certificate --region $RG --set-as-active \
  --certificate-pem-outfile device.cert.pem \
  --public-key-outfile device.public.key \
  --private-key-outfile device.private.key \
  --query certificateArn --output text)
curl -s https://www.amazontrust.com/repository/AmazonRootCA1.pem -o AmazonRootCA1.pem
cat > /tmp/iot-policy.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["iot:Connect","iot:Publish","iot:Subscribe","iot:Receive"],"Resource":"*"}]}
EOF
aws iot create-policy --region $RG --policy-name robot-telemetry-policy --policy-document file:///tmp/iot-policy.json
aws iot attach-policy --region $RG --policy-name robot-telemetry-policy --target "$CERT_ARN"
aws iot attach-thing-principal --region $RG --thing-name factory_robots --principal "$CERT_ARN"
```
> ⚠️ `certs/` 의 private key 는 비밀. 절대 git 등에 올리지 말 것.

### 1-4. IoT 규칙: MQTT → Kinesis
```bash
ROLE_ARN=$(aws iam get-role --role-name iot-to-kinesis-role --query Role.Arn --output text)
cat > /tmp/iot-rule.json <<EOF
{"sql":"SELECT * FROM 'robots/+/telemetry'","awsIotSqlVersion":"2016-03-23","ruleDisabled":false,
 "actions":[{"kinesis":{"streamName":"robot-telemetry","roleArn":"$ROLE_ARN","partitionKey":"\${topic(2)}"}}]}
EOF
aws iot create-topic-rule --region $RG --rule-name robot_telemetry_to_kinesis --topic-rule-payload file:///tmp/iot-rule.json
```

---

## STEP 2. 가짜 데이터 생성기 실행 (로봇 4종)

발행기는 venv + awsiotsdk + `iot/certs/` 인증서가 필요하다. 최초 1회 셋업 후 실행:
```bash
cd ~/digital_twin/iot          # (워크샵 클라이언트에선 ~/nvidia-omniverse-digital-twin/iot)
bash setup_publisher.sh        # venv + awsiotsdk + IOT_ENDPOINT 캐시 (멱등, 최초 1회)
IOT_ENDPOINT=$(cat ~/.iot_endpoint) ~/venv/bin/python -u factory_simulator.py --interval 3
```
> `~/venv/bin/python` 을 써야 한다(시스템 python 엔 awsiotsdk 없음). 상세는 `IOT_MONITORING.md` STEP 2.
> `factory_simulator.py` 가 4종을 발행한다. `robot_simulator.py` 는 nova_carter 만 발행하므로 데모엔 부적합.

4종 로봇이 데이터를 보낸다:
| 로봇 | 타입 | 주요 지표 |
|------|------|-----------|
| nova_carter_01 | AMR | battery, speed, motor_temp, 이동 |
| iw_hub_01 | AMR | battery, speed, motor_temp, 이동 |
| franka_01 | 로봇팔 | joint_angle, cycle_count, payload, gripper |
| digit_01 | 휴머노이드 | gait_speed, balance, battery, 보행 |

화면에 `[nova_carter_01] type=amr ...` 가 5초마다 4줄씩 나오면 성공.
**이 터미널은 켜둔 채로** 다음 단계 진행. (Ctrl+C 로 중지)

확인(선택) — Kinesis 도달:
```bash
SHARD=$(aws kinesis get-shard-iterator --region ap-northeast-2 --stream-name robot-telemetry \
  --shard-id shardId-000000000000 --shard-iterator-type LATEST --query ShardIterator --output text)
sleep 8; aws kinesis get-records --region ap-northeast-2 --shard-iterator "$SHARD" --limit 10
```

---

## STEP 3. Isaac Sim 실행 + 공장 씬 열기

새 터미널에서:
```bash
/opt/IsaacSim/isaac-sim.sh \
  --ext-folder /home/ubuntu/digital_twin/exts \
  --enable robot.monitor
```

> **다중 사용자(student) 환경**에서는 위처럼 직접 실행하지 말고 **`launch-isaac`** 을 쓴다.
> Isaac Sim 은 HTTP 서비스 포트(8011)를 인스턴스 전체에서 공유하므로, 여러 명이 동시에 기본
> 포트로 띄우면 `address already in use` 로 죽는다. `launch-isaac` 이 uid 로 포트를 자동 분리한다
> (student1→8001 … student8→8008). 확장까지 얹으려면 인자를 그대로 넘길 수 있다:
> ```bash
> launch-isaac --ext-folder ~/digital_twin/exts --enable robot.monitor
> ```
> (CDK 배포 클라이언트에 자동 설치됨. 수동 등가: `./isaac-sim.sh --/exts/omni.services.transport.server.http/port=$((8000+$(id -u)-1000))`)

- 첫 기동은 셰이더 컴파일로 4~8분. 검은 창이어도 정상. 우측 하단 진행바가 100% 되면 화면이 뜬다.
  (여러 명이 동시에 처음 열면 셰이더 컴파일 경합으로 더 느릴 수 있다.)
- 확장이 켜지면 스테이지가 비었을 때 PoC 씬을 자동으로 연다.
  4종 공장 씬을 쓰려면 Isaac Sim 에서 **File → Open**:
  ```
  /home/ubuntu/digital_twin/iot/factory_scene.usda
  ```
  (대형 창고 + 로봇 4종이 로드된다. 첫 로드 1~3분)

> ⚠️ DCV 환경에서 한글 입력기 때문에 경로 입력이 막히면, 키보드를 영문으로 두고 입력.

---

## STEP 4. 실시간 모니터링 확인

화면의 **"Robot Telemetry Monitor"** 창:
- **Publish** 체크 ON (기본): Kinesis 데이터를 읽어 로봇 USD 에 기록.
- **Move** 체크 ON (기본): 데이터의 position 으로 로봇을 부드럽게 이동.
- **Robot** 콤보박스에서 로봇 선택 → 그 로봇의 수치·차트 표시.
- **차트**: battery / motor_temp / speed 실시간 라인.

확인 포인트:
1. 뷰포트에서 **AMR·휴머노이드가 창고를 돌아다니고**, 로봇팔은 제자리에서 움직인다.
2. 차트가 5초마다 갱신된다.
3. **뷰포트에서 로봇을 클릭** → 콤보박스가 그 로봇으로 바뀌고 대시보드 전환.
4. AMR 배터리가 20%↓ → status=charging, 배터리 곡선 반등.

---

## STEP 5. (선택) 협업 — 모두가 같은 트윈 보기

여러 명이 같은 화면을 보려면 Nucleus Live 를 쓴다(별도 문서 `NUCLEUS_DEPLOY.md`).
- 한 명(강사)이 **Publish ON** 으로 데이터를 USD 에 기록.
- 나머지는 같은 Nucleus 씬을 Live 로 열기만 하면, 로봇 움직임·상태가 자동 전파된다.
  (이들은 Publish 를 꺼도 됨 — USD 에서 읽어 표시.)

---

## STEP 6. 정리 (비용)

워크샵이 끝나면 AWS 리소스를 지운다(과금 방지):
```bash
RG=ap-northeast-2
aws kinesis delete-stream --region $RG --stream-name robot-telemetry --enforce-consumer-deletion
aws iot delete-topic-rule --region $RG --rule-name robot_telemetry_to_kinesis
# Thing/인증서/정책은 detach 후 삭제 (순서 주의) — 자세히는 IOT_MONITORING.md
```

---

## 자주 막히는 곳

| 증상 | 해결 |
|------|------|
| 생성기 출력이 안 보임 | `python3 -u` (unbuffered) 로 실행 |
| `IOT_ENDPOINT` 안 잡힘 | STEP 2 의 describe-endpoint 명령으로 export 했는지 확인 |
| 차트/콤보 비어있음 | 씬에 로봇 프림 없음 → factory_scene.usda 를 File→Open 으로 열기 |
| 로봇이 안 움직임 | Move 체크 ON 확인. 로봇팔은 원래 제자리(미세 진동) |
| 연결 "unable to connect" | Nucleus 의 SERVER_IP 공란 문제 → `IOT_MONITORING.md` 트러블슈팅 |
| 인증서 에러 | `certs/` 에 device.cert.pem/private.key/AmazonRootCA1.pem 3개 있는지 |

상세 기술 배경은 `IOT_MONITORING.md`, 확장 구조는 `exts/robot.monitor/` 참고.
