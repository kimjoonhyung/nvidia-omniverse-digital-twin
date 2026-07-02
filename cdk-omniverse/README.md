# CDK — Omniverse 워크숍 인프라 (N Isaac Sim + 1 Nucleus)

수동으로 구축했던 협업 인프라(**N대 Isaac Sim 클라이언트 + 1대 Nucleus 서버**)를
AWS CDK(TypeScript)로 코드화한 것. 워크숍마다 반복 배포·삭제 가능.

## 무엇을 만드나

- **VPC** (단일 AZ, 퍼블릭 서브넷 — PoC용)
- **보안그룹 2개**: 클라이언트(DCV 8443 + SSH), Nucleus(서비스 포트 VPC내부 + SSH)
- **IAM 역할 2개**: SSM 접속 + (Nucleus) NGC 시크릿 읽기
- **Nucleus 서버 1대** (m7i.xlarge) — **user-data로 Docker+NGC+compose 자동 설치**
- **Isaac Sim 클라이언트 N대** (g6e.2xlarge, 기본 3) — 마켓플레이스 AMI

## 사전 준비

1. **CDK 부트스트랩** (계정·리전 최초 1회):
   ```bash
   npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-2
   ```
2. **EC2 키페어** 존재 (예: `omni-seoul`).
3. **Isaac Sim 마켓플레이스 AMI 구독** + 해당 리전의 AMI ID 확보:
   ```bash
   aws ec2 describe-images --region ap-northeast-2 --owners 679593333241 \
     --filters "Name=name,Values=OV-Template-aws-ubuntu-isaac_sim-*" \
     --query 'reverse(sort_by(Images,&CreationDate))[0].{Id:ImageId,Name:Name}'
   ```
4. **NGC API 키** — 미리 저장할 필요 없음. **배포 시 입력**한다(아래).
   스택이 NoEcho Parameter로 받아 Secrets Manager에 저장하고, destroy 시 함께 삭제한다.

## 배포

NGC 키는 `-c`(context)가 **아니라** CFN Parameter(`--parameters`)로 전달한다.
context는 템플릿/`cdk.out`에 평문으로 남지만, NoEcho Parameter는 콘솔·로그에 가려진다.

```bash
npm install

npx cdk deploy \
  -c keyName=omni-seoul \
  -c isaacAmiId=ami-xxxxxxxxxxxx \
  -c allowCidr=<내공인IP>/32 \
  -c clientCount=3 \
  --parameters NgcApiKey=nvapi-xxxxxxxx     # ← NGC 키 (NoEcho)
```

> 셸 히스토리에도 키를 남기기 싫으면, 입력 프롬프트로 받기:
> ```bash
> read -rs NGC && npx cdk deploy ... --parameters NgcApiKey=$NGC; unset NGC
> ```

### 파라미터
**context (`-c key=value`)** — 인프라 형태:
| 파라미터 | 기본값 | 설명 |
|----------|--------|------|
| `clientCount` | 3 | Isaac Sim 클라이언트 대수 |
| `clientInstanceType` | g6e.2xlarge | 클라이언트 타입 (GPU 필요) |
| `nucleusInstanceType` | m7i.xlarge | Nucleus 타입 (GPU 불필요) |
| `keyName` | (없음) | 기존 EC2 키페어 이름 |
| `allowCidr` | **(필수)** | 관리 접근(DCV 8443·SSH 22) 허용 IP — **`내공인IP/32` 필수**. 미지정·`0.0.0.0/0`이면 배포 차단 |
| `viewerCidr` | allowCidr 로 폴백 | 뷰어(WebRTC 스트리밍) 허용 대역 — 시그널 49100·미디어 UDP 47998-48010·브라우저 8210. 참가자 IP 대역(예 `15.0.0.0/8`). `0.0.0.0/0` 금지 |
| `isaacAmiId` | (없음) | Isaac Sim 마켓플레이스 AMI ID (리전별 상이) |

**CFN Parameter (`--parameters`)** — 비밀값:
| 파라미터 | 설명 |
|----------|------|
| `NgcApiKey` | NGC API 키(`nvapi-...`). NoEcho. 스택이 Secret 생성·삭제 관리 |
| `UbuntuPassword` | ubuntu 사용자 비밀번호(DCV 로그인용). NoEcho. 클라이언트+Nucleus 전부에 설정. 비우면 생략 |

예:
```bash
npx cdk deploy -c keyName=omni-seoul -c isaacAmiId=ami-xxx -c allowCidr=<IP>/32 -c clientCount=2 \
  --parameters NgcApiKey=nvapi-xxxx \
  --parameters UbuntuPassword=원하는비밀번호
```

## 배포 후

- 출력(Outputs)에 **Nucleus IP, Navigator URL, 클라이언트별 DCV URL** 표시.
- 각 클라이언트 DCV: `https://<PublicIP>:8443` (ubuntu / DCV 비밀번호는 별도 설정 필요).
- Nucleus admin 비밀번호: 서버 `/opt/nucleus/CREDENTIALS.txt` (SSH로 확인).
- Isaac Sim에서 Nucleus 연결: **Nucleus 사설IP** 사용 (출력 `ConnectNucleusFromIsaac`).
- Nucleus 자동설치 진행/완료: 서버에 `/opt/nucleus/READY` 파일 생성됨.

## 삭제 (비용 정리)

```bash
npx cdk destroy
```

## 주의 / 한계

- **마켓플레이스 AMI**는 구독 동의가 선행돼야 하고 AMI ID가 리전·버전마다 다름 → `isaacAmiId` 필수.
- 마켓플레이스 AMI 스냅샷이 **>=512GB**를 요구 → 클라이언트 루트 볼륨 512GB로 고정.
- user-data Nucleus 설치는 **no-SSL PoC**. 운영은 SSL·SSO·시크릿 강화 필요(`../NUCLEUS_DEPLOY.md`).
- DCV 로그인용 ubuntu 비밀번호는 AMI 기본값/수동 설정 필요(보안상 CDK에 넣지 않음).
- PoC는 퍼블릭 서브넷. 운영은 private 서브넷 + NAT + 부하분산 고려.

## 구조

```
cdk-omniverse/
├── bin/cdk-omniverse.ts          # 앱 진입점, 파라미터 파싱
├── lib/
│   ├── omniverse-workshop-stack.ts  # VPC/SG/IAM/EC2(N+1) 정의
│   └── nucleus-userdata.ts          # Nucleus 자동설치 user-data (검증된 수동절차 자동화)
├── package.json
├── tsconfig.json
└── cdk.json
```

## 실제 배포로 잡은 버그 (검증 완료)

synth만으로는 못 잡고, **실제 `deploy` + 런타임 확인**으로 발견·수정한 것들:

1. **IAM 시크릿 권한** — `Secret.fromSecretAttributes(secretPartialArn)` + `grantRead` 조합이
   실제 ARN(6자리 접미사)에 매칭 안 돼 `AccessDenied`. → `addToPolicy`로 ARN 명시 부여.
2. **NGC 키 전달 방식** — `-c`(context)는 템플릿/cdk.out에 평문 잔존. → **NoEcho CfnParameter**로 변경,
   스택이 Secret 생성·삭제 관리.
3. **user-data 재부팅 취약성** — EC2 user-data는 1회성이라, 설치 중 재부팅되면 재실행 안 됨.
   → **systemd oneshot 서비스(nucleus-install)** 로 전환: 멱등(READY 있으면 skip) + `Restart=on-failure`.
4. **tar 압축 해제 누락** — NGC `download-version`이 받는 건
   `nucleus-compose-stack-..._v2023.2.8/` 폴더 안의 **`nucleus-stack-....tar.gz` 파일**.
   이걸 `tar xzf`로 풀어야 `nucleus-stack-2023.2.8*/base_stack`이 나온다.
   초기 스크립트가 압축 해제를 빠뜨려 `cd base_stack` 실패 → compose 미실행.
   → download 후 `tar xzf` 단계 추가.
5. **SERVER_IP_OR_HOST 가 비어버림 (IMDSv2)** — `curl .../meta-data/local-ipv4` 가
   IMDSv2(토큰 필수) AMI 에서 빈 값 반환 → `.env` 의 `SERVER_IP_OR_HOST=` 공란 →
   컨테이너는 12개 다 떠도 **Isaac Sim 연결 시 "unable to connect"** (discovery 가 빈 주소 안내).
   → IMDSv2 토큰 먼저 받고 IP 조회 + `hostname -I` fallback + 빈 값이면 재시도.
   증상이 "포트는 다 열렸는데 클라이언트 연결만 실패"면 이걸 의심.

> 최종 검증: 클라이언트 2대 배포, ubuntu 비번 자동설정 + DCV 로그인 성공,
> Nucleus 12개 컨테이너 Up + Navigator 200 + **Isaac Sim 연결 성공** 확인.
