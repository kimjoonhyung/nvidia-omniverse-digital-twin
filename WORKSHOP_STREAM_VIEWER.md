# 핸즈온 워크샵 — 뷰어 전용(View-Only) WebRTC 디지털 트윈

> **목표**: 워크샵에서 배포한 Isaac Sim 클라이언트 3대 중 **1대를 "스트리밍 호스트"**로 만들고,
> 나머지 참가자는 **자기 화면에서 그 트윈을 실시간으로 "보기만"** 한다(조작·GPU 불필요).
> 강사(또는 발표자) 1명이 씬을 돌리고, 여러 명이 WebRTC 로 같은 화면을 본다.
> **대상**: 입문자. 명령은 그대로 복붙.
> **소요**: 약 20~30분 (인프라가 이미 떠 있다는 전제).

```
[클라이언트 #3 = 스트리밍 호스트]         [뷰어들 (노트북/브라우저)]
 isaac-sim.streaming.sh  ──WebRTC──▶  네이티브 클라이언트  또는  Chromium 브라우저
   (GPU 렌더링)          49100/TCP 시그널
                         47998/UDP 미디어
```

전제:
- `cdk-omniverse` 로 **클라이언트 3대 + Nucleus 1대**가 이미 배포됨 (README Quick Start).
- 이 문서의 CDK 는 클라이언트 보안그룹에 **WebRTC 포트(49100/TCP, 47998/UDP)** 를 이미 열어둔 버전이다.
  (예전에 배포했다면 아래 **STEP 0** 으로 포트를 다시 반영할 것.)
- 리전 예시 `ap-northeast-2`(서울).

> ⚠️ **GPU 주의**: WebRTC 라이브스트림은 NVENC 인코더가 필요하다. 워크샵 기본 `g6e`(L40S)는 지원.
> A100 계열은 라이브스트림 미지원이니 인스턴스 타입을 바꾸지 말 것.

---

## STEP 0. WebRTC 포트 열기 (배포/갱신)

`cdk-omniverse/lib/omniverse-workshop-stack.ts` 의 클라이언트 보안그룹에 이미 반영돼 있다.
포트가 없던 예전 스택이라면 재배포로 반영:

```bash
cd ~/digital_twin/cdk-omniverse   # (repo 경로에 맞게)
npx cdk deploy \
  -c keyName=<키페어명> \
  -c isaacAmiId=<Isaac Sim AMI> \
  -c allowCidr=$(curl -s https://checkip.amazonaws.com)/32 \
  -c clientCount=3 \
  --parameters NgcApiKey=nvapi-xxxx \
  --parameters UbuntuPassword=<DCV 비밀번호>
```

열리는 포트(클라이언트 SG, `allowCidr` 한정):
| 포트 | 프로토콜 | 용도 |
|------|----------|------|
| 8443 | TCP | DCV 원격데스크톱 (기존) |
| 22 | TCP | SSH (기존) |
| **49100** | **TCP** | **WebRTC 시그널링** |
| **47998** | **UDP** | **WebRTC 미디어** — TCP만 열면 영상이 안 나온다 |
| 8210 | TCP | (선택) 브라우저 웹 뷰어 — 옵션 B(Docker)에서만 사용 |

배포 후 `Outputs` 의 **`StreamHostPublicIp`** 가 스트리밍 호스트로 쓸 클라이언트(#3)의 공인 IP다.

---

## STEP 1. 스트리밍 호스트 준비 (클라이언트 #3)

호스트로 쓸 클라이언트에 **DCV(`https://<IP>:8443`)** 또는 SSH 로 접속한다.
씬을 미리 띄워두고 싶으면 먼저 일반 모드로 씬을 확인해도 되지만,
스트리밍은 **`--no-window`(헤드리스)** 로 도는 별도 실행이므로 여기서는 스트리밍 전용으로 바로 띄운다.

호스트의 **공인 IP** 를 확인:
```bash
HOST_IP=$(curl -s https://checkip.amazonaws.com); echo "HOST_IP=$HOST_IP"
```

---

## STEP 2. 스트리밍 서버 실행 (호스트에서)

Isaac Sim 설치 경로는 마켓플레이스 AMI 기준 `/opt/IsaacSim`.

```bash
cd /opt/IsaacSim
./isaac-sim.streaming.sh \
  --/exts/omni.kit.livestream.app/primaryStream/publicIp=$HOST_IP \
  --/exts/omni.kit.livestream.app/primaryStream/signalPort=49100 \
  --/exts/omni.kit.livestream.app/primaryStream/streamPort=47998
```
- 첫 기동은 셰이더 컴파일로 수 분. 로그에 **`Isaac Sim Full Streaming App is loaded.`** 와
  **`Streaming server started.`** 가 뜨면 준비 완료.
- 이 창(SSH/터미널)은 **켜둔 채로** 둔다. Ctrl+C 로 중지.
- `publicIp` 는 **원격(인터넷)에서 볼 때만** 필요. 같은 VPC 내부에서만 볼 거면 생략 가능.

> **우리 워크샵의 트윈 씬을 스트리밍하려면**: 위 스트리밍 앱에도 `robot.monitor` 확장과
> 공장 씬을 붙이면 된다(라이브 데이터 트윈까지 함께 스트리밍):
> ```bash
> ./isaac-sim.streaming.sh \
>   --ext-folder /home/ubuntu/digital_twin/exts --enable robot.monitor \
>   --/exts/omni.kit.livestream.app/primaryStream/publicIp=$HOST_IP \
>   --/exts/omni.kit.livestream.app/primaryStream/signalPort=49100 \
>   --/exts/omni.kit.livestream.app/primaryStream/streamPort=47998
> ```
> (확장이 `factory_scene.usda` 를 자동 오픈 → 뷰어들이 로봇 움직임·차트를 함께 본다.)

---

## STEP 3. 뷰어로 접속하기 — 두 가지 방법

### 옵션 A. 네이티브 WebRTC 클라이언트 (권장, 설치 필요·안정적)

각 참가자 **노트북**에 **Isaac Sim WebRTC Streaming Client** 를 설치한다(Windows/macOS/Linux).
NVIDIA 다운로드 페이지에서 받아 압축 해제 후 실행.

1. 앱 실행 → **Server** 입력란에 스트리밍 호스트 공인 IP 입력:
   ```
   <StreamHostPublicIp>          # 예: 3.35.x.x
   ```
   (포트 기본 49100 그대로. 로컬 테스트면 127.0.0.1)
2. **Connect** → 잠시 후 트윈 화면이 뜬다.
3. 뷰어는 화면을 **볼 수만** 있다(카메라 조작 정도). 씬 편집은 호스트에서.

추가 포트 불필요 — 49100/TCP + 47998/UDP 만 열려 있으면 된다.

### 옵션 B. 브라우저 웹 뷰어 (설치 불필요, 단 Docker Compose 필요)

브라우저(Chromium 계열)로 `http://<IP>:8210` 에 접속하는 방식.
단, **이 웹 뷰어는 Docker Compose 배포 경로에서만 제공**된다.
마켓플레이스 AMI 의 네이티브 설치(`/opt/IsaacSim`)에는 웹 페이지가 포함돼 있지 않으므로,
호스트에서 **스트리밍용 컨테이너**를 따로 받아 `--network=host` 로 띄워야 한다.

개요(호스트에서):
```bash
# 1) NGC 에서 Isaac Sim 컨테이너 pull (NGC 로그인 필요)
docker login nvcr.io      # Username: $oauthtoken / Password: NGC API 키
docker pull nvcr.io/nvidia/isaac-sim:5.1.0

# 2) 웹 뷰어 포함 Docker Compose 스택으로 기동 (반드시 --network=host)
#    compose 파일은 NGC/Isaac Sim 문서의 "WebRTC Streaming Client (Docker Compose)" 참고.
#    기동 후 로그의 web-viewer URL 확인:
docker compose logs web-viewer | grep -i http
```
그 뒤 브라우저에서 `http://<StreamHostPublicIp>:8210` 접속.

> 워크샵에서는 **옵션 A(네이티브)** 를 권장한다. 브라우저 방식은 컨테이너를 별도로 받아야 해
> 준비 시간이 길고 GPU 컨테이너 런타임 설정이 추가로 필요하다.

---

## STEP 4. 확인 포인트

1. 호스트 로그에 `Streaming server started.` + `... Streaming App is loaded.`
2. 뷰어 클라이언트가 **Connect** 후 트윈 화면 표시.
3. (트윈 씬을 붙였다면) 로봇 4종이 움직이고 차트가 갱신되는 게 뷰어에도 그대로 보인다.
4. 여러 명이 **동시에** 같은 호스트에 붙어도 각자 화면이 뜬다.

---

## STEP 5. 정리

- 호스트: 스트리밍 터미널에서 **Ctrl+C**.
- 인프라 전체 삭제(과금 방지): `npx cdk destroy`.
- 임시로 포트만 닫고 싶으면, SG 에서 49100/47998 인그레스만 제거 후 재배포.

---

## 자주 막히는 곳

| 증상 | 해결 |
|------|------|
| 뷰어 Connect 됐는데 **검은 화면** | UDP **47998** 이 막힘. SG·회사방화벽에서 UDP 허용 확인(TCP만으론 영상 안 옴). |
| `Connect` 자체가 안 됨 | TCP **49100** + `allowCidr` 에 내 IP 포함됐는지. `publicIp=` 를 호스트 공인 IP로 줬는지. |
| 영상은 뜨는데 **인코딩 에러/크래시** | GPU 가 NVENC 지원하는지(=`g6e` OK, A100 ✗). 인스턴스 타입 확인. |
| 씬이 비어있음 | 트윈을 보려면 STEP 2 의 `--ext-folder ... --enable robot.monitor` 붙여 실행. |
| 브라우저 8210 접속 안 됨 | 옵션 B 는 Docker Compose 전용. 네이티브 설치엔 웹페이지 없음 → 옵션 A 사용. |
| 여러 명 붙으니 끊김 | 호스트 GPU/네트워크 대역 한계. 뷰어 수를 줄이거나 호스트 인스턴스 상향. |

상세 인프라·포트는 `cdk-omniverse/README.md`, 트윈 씬·확장은 `WORKSHOP_LIVE_DATA.md` 참고.
