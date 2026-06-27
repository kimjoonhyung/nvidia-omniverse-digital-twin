# Omniverse 디지털 트윈 워크숍 — 전체 가이드 (마스터 문서)

NVIDIA Isaac Sim(Omniverse) 기반으로 **공장/창고 디지털 트윈을 만들고, 여러 명이
협업하는 워크숍**을 구축한 전 과정의 마스터 인덱스. 입문자 대상.

---

## 🚀 Quick Start — 클론 후 CDK 배포

워크숍 인프라(Isaac Sim 클라이언트 N대 + Nucleus 1대)를 한 번에 띄운다.

### 1) 클론 + 의존성
```bash
git clone https://github.com/kimjoonhyung/nvidia-omniverse-digital-twin.git
cd nvidia-omniverse-digital-twin/cdk-omniverse
npm install
```

### 2) 사전 준비 (최초 1회)
```bash
# (a) AWS 자격증명 확인
aws sts get-caller-identity

# (b) CDK 부트스트랩 (계정·리전당 1회)
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-2

# (c) Isaac Sim 마켓플레이스 AMI ID 조회 (마켓플레이스 구독 동의 필요)
aws ec2 describe-images --region ap-northeast-2 --owners 679593333241 \
  --filters "Name=name,Values=OV-Template-aws-ubuntu-isaac_sim-*" \
  --query 'reverse(sort_by(Images,&CreationDate))[0].Id' --output text

# (d) 내 공인 IP (DCV/SSH 접근 제한용)
curl -s https://checkip.amazonaws.com
```
그 외: **EC2 키페어**(예 `omni-seoul`), **NGC API 키**(`nvapi-...`) 준비.

### 3) 배포
```bash
npx cdk deploy \
  -c keyName=<키페어명> \
  -c isaacAmiId=<위 (c)의 AMI ID> \
  -c allowCidr=<위 (d)의 IP>/32 \
  -c clientCount=2 \
  --parameters NgcApiKey=nvapi-xxxxxxxx \
  --parameters UbuntuPassword=<DCV 로그인 비밀번호>
```
- `clientCount` 기본 3. `NgcApiKey`·`UbuntuPassword`는 NoEcho(로그 비노출).

### 4) 배포 후
- 출력(Outputs)의 **클라이언트 DCV URL**(`https://<IP>:8443`) → `ubuntu` / 지정한 비밀번호로 로그인.
- Isaac Sim에서 **Content → Add New Connection** → 출력의 **Nucleus 사설IP** 입력 →
  `omniverse` / Nucleus 서버 `/opt/nucleus/CREDENTIALS.txt` 의 MASTER_PASSWORD.
- Nucleus 자동설치는 5~10분 (`/opt/nucleus/READY` 생성 시 완료).

### 5) 삭제 (비용 정리)
```bash
npx cdk destroy
```

> 자세한 파라미터·문제해결·실배포로 잡은 버그 → **`cdk-omniverse/README.md`**.
> 수동 배포(학습용)나 씬 제작은 아래 문서들 참고.

---

## 0. 문서 구성

| 문서 | 내용 | 대상 |
|------|------|------|
| **README.md** (이 문서) | 전체 흐름·인프라·로드맵 | 모두 |
| **SETUP_GUIDE.md** | Isaac Sim 설치·실행, 씬 구축, 에셋 배치, 함정 상세 | 강사/엔지니어 |
| **WORKSHOP.md** | 입문자 핸즈온 실습 시트 (URL 복붙으로 따라하기) | 수강생 |
| **NUCLEUS_DEPLOY.md** | 협업용 Nucleus 서버 EC2 수동 배포 + 자급자족 패키지(Collect) | 강사/인프라 |
| **cdk-omniverse/README.md** | **CDK로 전체 인프라(N클라+1Nucleus) 자동 배포** (실배포 검증 완료) | 인프라 |

> 한국어로 작성. 코드·명령·경로는 원문 유지.

### 두 가지 배포 경로
- **수동** (`NUCLEUS_DEPLOY.md`) — 단계를 직접 이해하며 배포. 학습·디버깅용.
- **자동** (`cdk-omniverse/`) — `cdk deploy` 한 번으로 VPC+SG+IAM+EC2(N+1)+Nucleus 자동설치.
  워크숍 반복 배포용. **실제 배포로 검증 완료(2클라+1Nucleus, Live 협업 동작 확인).**

---

## 1. 무엇을 만들었나 (전체 흐름)

```
[Isaac Sim 실행] → [대형 창고 씬 열기] → [로봇·설비 배치]
   → [Nucleus 협업 서버 구축] → [자급자족 패키지화(Collect)]
   → [2대 Isaac Sim에서 Live 동시편집 협업]
   → [CDK 로 전체 인프라 코드화 + 실배포 + Live 협업 재검증] ✅ 여기까지 완료
   → [B: 로봇 동작 시뮬레이션] → [C: 실시간 데이터 연동]  (다음 단계)
```

---

## 2. 인프라 구성 (AWS, 예: ap-northeast-2)

| 역할 | 타입 | 비고 |
|------|------|------|
| **Isaac Sim 클라이언트** (N대) | g6e.2xlarge / 4xlarge (L40S GPU) | 작업·협업 클라이언트 |
| **Nucleus 서버** (1대) | m7i.xlarge (GPU 불필요) | 협업 DB/엔진 |

- 클라이언트와 Nucleus는 **같은 VPC/서브넷** → 사설IP로 상호 통신.
- DCV 접속(8443)·SSH(22): 작업자 공인 IP(`<내IP>/32`)만 허용.
- 키페어: EC2 키페어 1개 (개인키는 로컬에만 보관, **저장소에 두지 말 것**).
- 실제 IP는 배포할 때마다 달라지므로 여기 하드코딩하지 않음 (CDK Outputs 참고).
- 키페어: `omni-seoul` (개인키는 1호기 `~/.ssh/omni-seoul.pem`).

### 접속 정보 (형식 — 실제 IP/비밀번호는 환경마다 다름)
| 대상 | 주소 형식 | 계정 |
|------|------|------|
| Isaac Sim DCV | `https://<클라이언트-퍼블릭IP>:8443` | ubuntu / `<배포 시 지정한 비밀번호>` |
| Nucleus (Isaac Sim 연결) | `<Nucleus-사설IP>` | omniverse / `<MASTER_PASSWORD>` |
| Nucleus Navigator 웹 | `http://<Nucleus-IP>:8080` | (허용된 IP에서만) |

> 실제 IP·비밀번호는 저장소에 두지 말 것. Nucleus 비밀번호는 서버 `/opt/nucleus/CREDENTIALS.txt`,
> DCV 비밀번호는 CDK 배포 시 `--parameters UbuntuPassword=...` 로 지정.

> 🔐 **보안 — 워크숍 후 반드시 처리**:
> - NGC API 키 폐기(rotate)
> - Nucleus MASTER/SERVICE 비밀번호 교체 (`/opt/nucleus/CREDENTIALS.txt`)
> - DCV ubuntu 비밀번호는 강한 값으로 (배포 파라미터)
> - 운영 전환 시 no-SSL → SSL, 접근범위 축소
> - **이 저장소에 실제 IP·키·비밀번호를 커밋하지 말 것**

---

## 3. 핵심 산출물

| 산출물 | 위치 |
|------|------|
| 작업 씬 (대형창고+로봇3종) | `omniverse://<Nucleus-사설IP>/Projects/...` |
| **자급자족 패키지** (오프라인 가능) | `omniverse://<Nucleus-사설IP>/Projects/factory_workshop_collected_v2/` |
| 로컬 작업 파일 | `~/Documents/digitaltwin_factory.usd` 등 |
| 에셋 래퍼(소형창고용, 참고) | `~/digital_twin/assets/*.usda` |

### 확정된 워크숍 에셋
- **창고**: Full Warehouse (27.8 × 45m)
- **로봇 3종**: Nova Carter(AMR), Franka Panda(로봇팔), Digit(휴머노이드)
  - ※ iw_hub은 UDIM 텍스처 Collect 누락 문제로 **제외** (NUCLEUS_DEPLOY.md 7.5 참고)
- **설비**: 팔레트, KLT 박스, 컨베이어, 지게차
- 모든 에셋 출처: NVIDIA S3 (`Assets/Isaac/5.1/...`), URL은 WORKSHOP.md 카탈로그 참고

### CDK 프로젝트 (`~/digital_twin/cdk-omniverse/`)
워크숍 인프라(Isaac Sim 클라이언트 N대 + Nucleus 1대)를 TypeScript CDK로 코드화.
한 번에 배포·삭제 가능. 배포 예:
```bash
cd ~/digital_twin/cdk-omniverse && npm install
npx cdk deploy -c keyName=omni-seoul -c isaacAmiId=ami-xxx -c allowCidr=<IP>/32 -c clientCount=2 \
  --parameters NgcApiKey=nvapi-xxxx --parameters UbuntuPassword=원하는비번
```
- `clientCount`로 클라이언트 수 조절(기본 3, 테스트는 2).
- NGC 키·ubuntu 비번은 **NoEcho CfnParameter**(로그/콘솔 노출 방지).
- Nucleus는 user-data(systemd 멱등 서비스)로 Docker+NGC+compose 자동 설치.
- 자세한 내용·검증 결과·실배포로 잡은 버그 5건 → `cdk-omniverse/README.md`.

---

## 4. 우리가 겪고 해결한 주요 함정 (요약)

| 함정 | 해결 | 상세 |
|------|------|------|
| 한글 자모 분리 입력 (Mac+DCV) | Mac 입력기 영문 고정, 서버 ibus 조합 | SETUP_GUIDE 2장 |
| 설비가 100배 커짐 | 부모(Lab) scale=100 상속 → 0.01 상쇄, 또는 정상스케일 창고 사용 | SETUP_GUIDE 8.5 |
| 속성값 입력 안 됨 | lock 해제 + IME 영문 | SETUP_GUIDE 8.5 |
| 회색(텍스처 없음) | 부분수집/미연결 구분, 로봇은 원래 어두움 | SETUP_GUIDE 8.5 |
| 창고가 너무 작음 | small→full_warehouse(대형, 정상 스케일)로 교체 | SETUP_GUIDE 6장 |
| URL 중복 붙여넣기 "찾을 수 없음" | 입력란 비우고 한 번만 | SETUP_GUIDE 6장 |
| Launcher 폐기로 Nucleus 못 받음 | NGC 키로 Enterprise nucleus-compose-stack 다운로드 | NUCLEUS_DEPLOY |
| AWS `InvalidAMIID` | 셸 리전 환경변수 충돌, unset 후 --region 명시 | NUCLEUS_DEPLOY |
| Navigator 웹 무한로딩 | SG가 VPC내부만 허용 → DCV 안에서 접속 | NUCLEUS_DEPLOY |
| UDIM 텍스처 Collect 누락 | UDIM 쓰는 로봇 제외 후 재Collect | NUCLEUS_DEPLOY 7.5 |

### CDK 실배포로 잡은 버그 (synth만으론 못 잡음)
| 버그 | 해결 |
|------|------|
| IAM 시크릿 권한(partial ARN 매칭 실패) | addToPolicy로 ARN 명시 부여 |
| NGC 키가 context에 평문 잔존 | NoEcho CfnParameter + 스택이 Secret 관리 |
| user-data 재부팅 시 재실행 안 됨 | systemd 멱등 서비스(READY skip + Restart=on-failure) |
| compose stack tar.gz 미압축해제 | download 후 `tar xzf` 추가 |
| **SERVER_IP 공란(IMDSv2)** → 클라 연결 실패 | IMDSv2 토큰 조회 + hostname -I fallback |
> 상세: `cdk-omniverse/README.md` "실제 배포로 잡은 버그".

---

## 5. 다음 단계 (로드맵)

- ✅ **A. 시각화/레이아웃** — 창고+로봇 배치 완료
- ✅ **협업 인프라** — Nucleus + 자급자족 패키지 + 2대 Live 동시편집 완료
- ✅ **IaC** — CDK로 전체 인프라 코드화 + 실배포 검증 + Live 협업 재확인 완료
- ⬜ **B. 동작 시뮬레이션** — PhysX 물리, 로봇/컨베이어 거동 (워크숍 "와!" 포인트)
- ⬜ **C. 실시간 데이터 연동** — 센서/PLC/IoT 실데이터 → 살아있는 트윈

상세 실습은 각 문서를 참고. B/C 단계는 심화 과정으로 분리 권장.
