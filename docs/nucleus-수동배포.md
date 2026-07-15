> 🇰🇷 한국어 | 🇺🇸 [English](en/nucleus-manual-deploy.md)

# Nucleus 협업 서버 배포 가이드 (AWS EC2)

> Omniverse 협업(Live 동시 편집)을 위해 **Enterprise Nucleus Server**를 AWS EC2에
> 배포한 전 과정. NGC API 키(Omniverse Enterprise 라이선스 연동)가 필요하다.
> 이 문서는 실제 수행·검증된 절차를 그대로 기록한 것이다.

---

## 0. 배경 — 왜 이렇게 하나 (2025/2026 현재)

- **Omniverse Launcher가 2025.10.1 폐기** → 예전 무료 "Nucleus Workstation" 설치 방식 사라짐.
- 현재 Nucleus는 **Enterprise Nucleus Server (Docker Compose 컨테이너)** 형태로만 배포됨.
- 컨테이너·compose 아티팩트는 **NGC 카탈로그의 라이선스 게이트 뒤**에 있음
  → **NGC API 키**(Omniverse Enterprise 또는 평가판 라이선스 연동)가 있어야 다운로드 가능.

> ⚠️ **보안**: NGC API 키, Nucleus MASTER/SERVICE 비밀번호, EC2 키페어(.pem)는 자격증명이다.
> 문서·채팅·코드에 평문으로 남기지 말고, 노출되면 즉시 폐기(rotate)할 것.

---

## 1. 사전 준비물

| 항목 | 검증된 값 / 비고 |
|------|------|
| AWS 계정 + EC2 권한 | run-instances, security-group, terminate 등 |
| NGC API 키 | `nvapi-...` (Omniverse Enterprise 라이선스 연동) |
| EC2 키페어(.pem) | 새 서버 SSH 접속용 (예: `omni-seoul`) |
| 인스턴스 사양 | **m7i.xlarge** (4vCPU/16GB) — Nucleus는 **GPU 불필요** |
| OS | Ubuntu 22.04 (Nucleus 권장) |
| 디스크 | 200GB gp3 (에셋 저장 공간) |
| 네트워크 | Isaac Sim 클라이언트와 **같은 VPC** 권장 (사설IP로 통신) |

---

## 2. EC2 인스턴스 생성

```bash
RG=ap-northeast-2
VPC=vpc-XXXXXXXX               # Isaac Sim 머신과 동일 VPC
SUBNET=subnet-XXXXXXXX         # 동일 서브넷(같은 AZ) 권장
KEY=omni-seoul

# Ubuntu 22.04 최신 AMI 조회 (리전마다 ID 다름! 반드시 해당 리전에서 조회)
AMI=$(aws ec2 describe-images --region $RG --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
            "Name=state,Values=available" "Name=architecture,Values=x86_64" \
  --query 'reverse(sort_by(Images,&CreationDate))[0].ImageId' --output text)

# 보안그룹: VPC 내부(예 172.31.0.0/16)에서 SSH + Nucleus 포트만 허용
SG=$(aws ec2 create-security-group --region $RG \
  --group-name nucleus-server-sg --description "Nucleus VPC internal" \
  --vpc-id $VPC --query 'GroupId' --output text)
aws ec2 authorize-security-group-ingress --region $RG --group-id $SG --ip-permissions \
  "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=172.31.0.0/16}]" \
  "IpProtocol=tcp,FromPort=3006,ToPort=3030,IpRanges=[{CidrIp=172.31.0.0/16}]" \
  "IpProtocol=tcp,FromPort=3100,ToPort=3180,IpRanges=[{CidrIp=172.31.0.0/16}]" \
  "IpProtocol=tcp,FromPort=3333,ToPort=3400,IpRanges=[{CidrIp=172.31.0.0/16}]" \
  "IpProtocol=tcp,FromPort=8000,ToPort=8080,IpRanges=[{CidrIp=172.31.0.0/16}]" \
  "IpProtocol=tcp,FromPort=5555,ToPort=5555,IpRanges=[{CidrIp=172.31.0.0/16}]"

# 인스턴스 기동
IID=$(aws ec2 run-instances --region $RG --image-id $AMI --instance-type m7i.xlarge \
  --key-name $KEY --security-group-ids $SG --subnet-id $SUBNET \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=200,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=nucleus-server-new}]' \
  --query 'Instances[0].InstanceId' --output text)
aws ec2 wait instance-running --region $RG --instance-ids $IID
aws ec2 describe-instances --region $RG --instance-ids $IID \
  --query 'Reservations[0].Instances[0].{Priv:PrivateIpAddress,Pub:PublicIpAddress}' --output json
```

> ⚠️ **함정**: 셸에 `AWS_REGION`/`AWS_DEFAULT_REGION` 환경변수가 다른 리전으로 설정돼 있으면
> AMI 조회·인스턴스 생성이 엉뚱한 리전으로 가서 `InvalidAMIID.NotFound` 등이 난다.
> 의심되면 `unset AWS_REGION AWS_DEFAULT_REGION` 후 `--region`을 항상 명시.

Nucleus가 사용하는 포트(참고): API 3009/3019, LFT 3030, Discovery 3333, Auth 3100/3180,
Web(Navigator) 8080, Search 3400, Tagging 3020, Metrics 3010, Service 3006/3106, AuthAPI 8000.

---

## 3. 서버 준비 (SSH 접속 + Docker 설치)

```bash
chmod 600 ~/.ssh/omni-seoul.pem
ssh -i ~/.ssh/omni-seoul.pem ubuntu@<PRIVATE_IP>

# 서버 안에서 Docker 설치
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
sudo docker compose version    # v2+ 내장 확인
```

---

## 4. Nucleus 스택 다운로드 (NGC)

```bash
# NGC CLI 설치
cd /tmp
curl -L "https://api.ngc.nvidia.com/v2/resources/nvidia/ngc-apps/ngc_cli/versions/3.64.2/files/ngccli_linux.zip" -o ngccli.zip
unzip -oq ngccli.zip -d /tmp/ngc

# 인증 (키는 env로만)
export NGC_CLI_API_KEY='nvapi-...'
export NGC_CLI_ORG=nvidia
NGC=/tmp/ngc/ngc-cli/ngc

# nucleus compose stack 검색 → 다운로드
$NGC registry resource list "nvidia/omniverse*" --format_type csv | grep -i nucleus
#  => nvidia/omniverse/nucleus-compose-stack-pb25h1 (예: 2023.2.8)
mkdir -p /tmp/nucleus && cd /tmp/nucleus
$NGC registry resource download-version "nvidia/omniverse/nucleus-compose-stack-pb25h1:2023.2.8"

# 압축 해제 → base_stack/ 에 compose·env 파일들이 있음
cd nucleus-compose-stack-pb25h1_v2023.2.8 && tar xzf nucleus-stack-*.tar.gz
```

> 참고: 단일 `nucleus-stack` 도커 이미지를 찾으면 안 보인다. Nucleus는 **마이크로서비스**
> (nucleus-api, nucleus-auth, nucleus-discovery, nucleus-lft, navigator, search ...)로 분리됐고,
> 위 compose stack이 이들을 묶어 기동한다.

---

## 5. 설정 + 시크릿 + 기동

```bash
# nvcr.io 레지스트리 로그인 (이미지 pull용)
echo "$NGC_CLI_API_KEY" | sudo docker login nvcr.io --username '$oauthtoken' --password-stdin

cd <stack>/base_stack

# nucleus-stack.env 핵심 항목 설정
sed -i 's/^ACCEPT_EULA=.*/ACCEPT_EULA=1/' nucleus-stack.env
sed -i 's/^SECURITY_REVIEWED=.*/SECURITY_REVIEWED=1/' nucleus-stack.env
sed -i 's/^SERVER_IP_OR_HOST=.*/SERVER_IP_OR_HOST=<PRIVATE_IP>/' nucleus-stack.env   # 클라이언트가 붙을 주소!
sed -i 's/^INSTANCE_NAME=.*/INSTANCE_NAME=workshop_nucleus/' nucleus-stack.env
sed -i 's|^MASTER_PASSWORD=.*|MASTER_PASSWORD=<강한비밀번호>|' nucleus-stack.env
sed -i 's|^SERVICE_PASSWORD=.*|SERVICE_PASSWORD=<강한비밀번호>|' nucleus-stack.env

# 인증 시크릿 생성 (PoC용 insecure 샘플)
chmod +x generate-sample-insecure-secrets.sh && ./generate-sample-insecure-secrets.sh

# 기동 (PoC = no-SSL). 운영은 nucleus-stack-ssl.yml 사용 권장
sudo docker compose -f nucleus-stack-no-ssl.yml --env-file nucleus-stack.env up -d
```

핵심 .env 항목:
- `ACCEPT_EULA=1`, `SECURITY_REVIEWED=1` (둘 다 1이어야 기동)
- `SERVER_IP_OR_HOST` = **클라이언트(Isaac Sim)가 접속할 IP** — 같은 VPC면 사설IP, 외부면 퍼블릭IP/도메인
- `MASTER_PASSWORD` = admin(`omniverse`) 로그인 비번
- `DATA_ROOT=/var/lib/omni/nucleus-data` (에셋 저장 위치)

---

## 6. 검증

```bash
# 컨테이너 12개 전부 Up 인지
sudo docker compose -f nucleus-stack-no-ssl.yml --env-file nucleus-stack.env ps

# 클라이언트(같은 VPC)에서 포트/웹 응답
for p in 3009 3030 3333 3100 8080 3400; do
  timeout 4 bash -c "echo > /dev/tcp/<PRIVATE_IP>/$p" && echo "$p OK"; done
curl -s -o /dev/null -w "%{http_code}\n" http://<PRIVATE_IP>:8080   # 200 = Navigator OK
# 3333(discovery)은 426(WebSocket upgrade required)이 정상 신호
```

정상 시: 컨테이너 12개 Up, 8080 → HTTP 200, 핵심 포트 모두 열림.

---

## 7. Isaac Sim에서 연결 (협업)

1. Isaac Sim **Content** 패널 → **Add New Connection** → 서버 `<PRIVATE_IP>` 입력
2. 로그인: `omniverse` / MASTER_PASSWORD
3. 씬을 **`File → Save As`** 로 Nucleus 경로(`omniverse://<IP>/Projects/...`)에 저장
4. 참가자들이 같은 USD를 열고 **Live 모드(번개 아이콘)** → 실시간 동시 편집

---

## 7.5 자급자족 패키지 만들기 (Collect) — 오프라인 워크숍용

기본 저장은 메인 USD만 Nucleus에 올리고 **에셋은 여전히 S3(인터넷)를 참조**한다.
**인터넷 없는 환경**에서 열려면 모든 에셋·텍스처를 Nucleus로 모으는 **Collect**가 필요하다.

### 절차 (Isaac Sim GUI)
1. 씬을 먼저 Nucleus에 저장(`File → Save As`).
2. **`Utilities → Collect`** (또는 Content 패널에서 씬 우클릭 → Collect Asset).
3. Destination: `omniverse://<IP>/Projects/<name>_collected/`
4. 옵션 권장값:
   - **USD only** ❌ / **Material only** ❌  (둘 다 부분수집 모드 → 끄기. 켜면 텍스처 누락=회색)
   - **Flat collection** ⭕ → 텍스처 그룹핑은 **Group by USD** (에셋별 폴더 분리, 이름충돌 방지)
     - `Flat`(한 폴더에 전부)은 동일 파일명 충돌 위험 → 비권장
   - **Default prim only** ❌  (켜면 일부 로봇 누락 위험)
   - **Convert USDA to USDC** ⭕  (로딩 빠름·용량↓)
5. Collect 시작. 창고 박스 3138개 + 로봇 + USDC 변환이라 **수 분~십수 분** 소요.
   진행바가 멈춘 듯해도 보통 동작 중. 서버에서 `du -sh /var/lib/omni/nucleus-data/data`가
   증가하면 정상.

### 검증 (에러 0 확인)
Collect 후 Isaac Sim 로그(`/tmp/isaacsim_launch.log`)에서 **그 시점 이후** 타임스탬프의
`can not be found` 에러가 없어야 한다.
```bash
# 예: 09:50 이후 텍스처 누락 에러 개수 (0이어야 성공)
awk '/2026-06-27T09:5[0-9]|2026-06-27T1[0-9]:/ && /can not be found/' /tmp/isaacsim_launch.log | wc -l
```

### ⚠️ 함정 — UDIM 텍스처는 Collect에서 누락된다 (실제 겪음)
- 증상: `References an asset that can not be found: './textures/.../STL_Robot_albedo.<UDIM>.png'`
- 원인: **iw_hub 로봇**이 UDIM 텍스처(타일 1001~1004로 분할: albedo/normal/orm/emissive)를 쓰는데,
  Collect가 `<UDIM>` 토큰을 실제 타일 번호로 펼치지 못해 16개 텍스처를 누락 → 패키지가 깨짐.
- S3 원본 위치(참고): `.../Robots/Idealworks/iwhub/HighResProps/Textures/STL_Robot_<type>.<1001-1004>.png`
- **해결(채택)**: 오프라인 자급자족이 목표라 **UDIM 쓰는 로봇(iw_hub)을 씬에서 제거**하고 재Collect →
  에러 0. 워크숍 로봇은 3종(Nova Carter/Franka/Digit)으로 확정.
- 대안: UDIM 텍스처 16개를 수동으로 collected `./textures/` 위치에 업로드(손이 많이 감).

> 교훈: 오프라인 패키지를 만들 에셋은 **UDIM 사용 여부를 미리 확인**하라. UDIM 쓰는 에셋은
> Collect 후 반드시 텍스처 누락 검증을 거칠 것.

---

## 8. 정리 / 운영 메모

- **기존 인스턴스 정리(이번 사례)**: 예전 `nucleus-workstation`(t3.xlarge)을 새 서버 검증 후 종료.
  ```bash
  # 반드시 새 서버가 정상임을 검증한 뒤 실행 (되돌릴 수 없음)
  aws ec2 terminate-instances --region ap-northeast-2 --instance-ids <OLD_IID>
  ```
  > 순서 원칙: **새 서버 배포·검증 완료 → 그다음 기존 삭제.** 작동 중인 걸 먼저 지우지 말 것.
- **PoC → 운영 전환 시**: no-SSL → SSL(`nucleus-stack-ssl.yml` + 인증서), 접근범위 축소, SSO 연동,
  비밀번호 교체, insecure 시크릿을 정식 시크릿으로 교체.
- **워크숍 외부 참가자**가 로컬 PC에서 직접 붙어야 하면, 보안그룹에 그들의 공인 IP를 추가하거나
  퍼블릭 접근 + SSL을 구성해야 한다 (VPC 내부 전용이면 DCV 데스크톱 안에서만 접속됨).

---

## 부록. 자주 겪는 문제

| 증상 | 원인/해결 |
|------|-----------|
| `InvalidAMIID.NotFound` | 셸 환경변수 리전 충돌. `unset AWS_REGION AWS_DEFAULT_REGION` 후 `--region` 명시 |
| Navigator 웹이 무한 로딩 | 보안그룹이 VPC 내부만 허용 → **외부(로컬 PC)에서 접속 불가**. DCV 데스크톱 안 브라우저에서 사설IP로 접속, 또는 SG에 IP 추가 |
| 컨테이너가 안 뜸 | `ACCEPT_EULA`/`SECURITY_REVIEWED`가 1인지, 시크릿 생성했는지 확인 |
| 클라이언트가 서버 못 찾음 | `SERVER_IP_OR_HOST`가 클라이언트에서 도달 가능한 주소인지 확인 (사설/퍼블릭 혼동 주의) |
| NGC pull 실패(denied) | `docker login nvcr.io` (user=`$oauthtoken`) 했는지, 키에 Omniverse 라이선스 연동됐는지 |
