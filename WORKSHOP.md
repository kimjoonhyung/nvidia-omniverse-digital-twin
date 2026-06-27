# Omniverse 디지털 트윈 워크숍 — 입문자 핸즈온

> 처음 NVIDIA Isaac Sim(Omniverse)을 다루는 분을 위한 따라하기 자료.
> **코딩·USD 문법 필요 없음.** 마우스와 URL 복사·붙여넣기만으로 진행합니다.
> 목표: 창고를 열고 → 로봇·설비를 직접 배치하고 → 자유롭게 조작해 본다.

---

## 준비 — 강사가 미리 해두는 것

- Isaac Sim 5.1 실행 (DCV 데스크톱에 창이 떠 있는 상태). 실행법은 `SETUP_GUIDE.md` 5장 참고.
- 아래 URL 목록을 수강생에게 배포 (복사·붙여넣기용).

---

## 에셋 URL 카탈로그 (복사해서 사용)

모든 URL의 공통 앞부분:
```
https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1/Isaac
```

### 창고 (씬의 바탕)
| 이름 | 크기 | URL |
|------|------|-----|
| Full Warehouse | 27.8 × 45m | `.../Environments/Simple_Warehouse/full_warehouse.usd` |

### 로봇 (3종)
| 이름 | 종류 | 크기 | URL |
|------|------|------|-----|
| Nova Carter | 창고 AMR(바퀴) | ~0.7m | `.../Robots/NVIDIA/NovaCarter/nova_carter.usd` |
| Franka Panda | 로봇팔(7축) | ~0.9m | `.../Robots/FrankaRobotics/FrankaPanda/franka.usd` |
| Digit | 휴머노이드 | 1.68m | `.../Robots/Agility/Digit/digit_v4.usd` |

> ⚠️ **iw_hub 제외 이유**: iw_hub는 UDIM 텍스처(`STL_Robot_*.<UDIM>.png`)를 쓰는데,
> Collect 도구가 UDIM 토큰을 못 풀어 텍스처가 누락된다(자급자족 패키지에서 회색+에러).
> 오프라인 자급자족 워크숍에서는 제외했다. UDIM 상세는 `NUCLEUS_DEPLOY.md` Collect 절 참고.

### 설비/소품 (4종)
| 이름 | 크기 | URL |
|------|------|-----|
| 팔레트 | 1.2 × 0.8m | `.../Props/Pallet/pallet.usd` |
| KLT 박스 | 소형 | `.../Props/KLT_Bin/small_KLT.usd` |
| 컨베이어 벨트 | ~2m | `.../Props/Conveyors/ConveyorBelt_A01.usd` |
| 지게차 | 1.2 × 2.3m | `.../Props/Forklift/forklift.usd` |

> 전체 URL 예시(Nova Carter):
> `https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1/Isaac/Robots/NVIDIA/NovaCarter/nova_carter.usd`
> 모든 URL은 검증됨(HTTP 200). 이 창고는 미터 단위·정상 스케일이라 **그냥 넣으면 정상 크기**로 들어온다.

---

## 실습

### Step 1. 창고 열기
1. 상단 메뉴 **`File` → `Open`**
2. 경로 입력란을 **`Ctrl+A` → `Delete`로 완전히 비운다** (중요!)
3. Full Warehouse URL을 **한 번만** 붙여넣고 `Open`
4. 1~3분 로딩 (박스가 3000개 넘어 시간이 걸림). 회색이다가 점차 채워진다.

> ⚠️ URL이 두세 번 이어붙으면(`...usd https:/...usd`) "찾을 수 없음" 에러. 반드시 입력란을 먼저 비울 것.

### Step 2. 화면 둘러보기 (카메라)
| 동작 | 입력 |
|------|------|
| 회전 | `Alt + 좌클릭 드래그` |
| 이동(팬) | `중간 버튼 드래그` |
| 줌 | `마우스 휠` |
| 선택한 것에 포커스 | 객체 선택 후 `F` |
| WASD 비행 | 우클릭 누른 채 `WASD`. **느리게 하려면 그 상태로 마우스 휠 아래로** |

### Step 3. 로봇 넣기
1. **`File` → `Add Reference`**
2. 입력란 비우고 → 로봇 URL(예: Nova Carter) 붙여넣기 → `Open`
3. 로봇이 원점(바닥 0,0,0)에 나타난다. 안 보이면 Stage 패널에서 선택 후 `F`.
4. 4종을 다 넣으면 한 자리에 겹치므로, 아래 Step 4로 떨어뜨린다.

### Step 4. 위치·회전 옮기기 (기즈모)
- 객체 선택 후:
  - **`W`** = 이동(translate)
  - **`E`** = 회전(rotate)
  - **`R`** = 크기(scale)  ← 보통은 건드릴 필요 없음
- 화면의 화살표(기즈모)를 드래그해 옮긴다. 숫자 입력보다 쉽다.

### Step 5. 설비 배치 & 장면 꾸미기
- Step 3과 같은 방식으로 팔레트·박스·컨베이어·지게차도 `Add Reference`.
- 로봇 옆에 팔레트를 놓는 등 **나만의 물류 레이아웃**을 구성해 본다.

### Step 6. 렌더링 품질 바꿔보기
- 뷰포트 상단 렌더러 메뉴:
  - **`RTX - Real-Time`** : 실시간(기본)
  - **`RTX - Interactive (Path Tracing)`** : 고품질. 노이즈가 점점 사라지며 사실적으로 변한다.

---

## Step 7. 협업 (Nucleus 연결 + Live 동시편집) ★ 워크숍 하이라이트

여러 명이 **같은 씬을 실시간으로 함께 편집**하는 체험. 강사가 Nucleus 서버를 미리 띄워둔다.

### 7-1. Nucleus 서버 연결
1. Isaac Sim **Content** 패널 → **Add New Connection** (또는 `+`)
2. 서버 주소 입력: 강사가 알려준 Nucleus IP (예: `<Nucleus-사설IP>`)
3. 로그인: `omniverse` / (강사가 배포한 비밀번호)
4. 연결되면 Content 패널에 서버가 나타난다.

### 7-2. 공유 씬 열기
- Content에서 강사가 안내한 경로로 이동, 메인 USD를 연다. 예:
  ```
  omniverse://<Nucleus-IP>/Projects/factory_workshop_collected_v2/<메인USD>
  ```
- 이 패키지는 **자급자족(self-contained)** — 인터넷 없이도 모든 에셋·텍스처가 열린다.

### 7-3. Live 모드 켜기 ⚡
- 상단 툴바의 **번개(⚡) 아이콘** 또는 **"Live"** 토글 클릭 → Live 세션 진입.
- **모든 참가자가 같은 씬에서 Live를 켜면** 편집이 실시간 동기화된다.

### 7-4. 동시편집 확인
- 한 사람이 로봇/설비를 `W`로 옮기면 → **다른 사람 화면에서도 즉시 움직인다.** 🎉
- 여러 명이 각자 다른 설비를 동시에 배치하며 하나의 디지털 트윈을 함께 완성.

> 검증됨: Isaac Sim 2대(1호기·2호기)에서 같은 패키지를 Live로 열어 동시편집 동작 확인.

---

## 자주 묻는 질문 (수강생용)

| 증상 | 답 |
|------|-----|
| 로봇이 검정/회색으로 밋밋해요 | **정상.** Nova Carter 등은 원래 어두운 색. 바퀴·센서에 디테일 있으면 OK |
| 숫자 입력이 안 돼요 | (1) 속성 옆 **자물쇠 unlock**, (2) **키보드 입력기를 영문(ABC)으로** — 한글 모드면 입력이 막힘 |
| 넣은 로봇이 안 보여요 | 다른 것과 같은 자리에 겹쳐 있음. Stage에서 선택 후 `F`로 포커스, `W`로 이동 |
| 카메라가 너무 빨라요 | 우클릭 비행 중 **마우스 휠 아래로** 굴려 속도↓ |
| URL "찾을 수 없음" | 입력란에 URL이 중복됨. `Ctrl+A`→`Delete`로 비우고 한 번만 |
| 화면이 회색으로 멈춤 | 텍스처/셰이더 로딩 중. 30초~1분 대기 |

---

## 강사 메모

- 이 워크숍은 **별도 래퍼 USD가 필요 없다.** full_warehouse가 미터 단위·scale 1.0이라
  원본 URL을 `Add Reference`로 넣으면 정상 크기로 들어온다.
  (소형 창고 `small_warehouse_digital_twin`은 부모 스케일 100배 함정이 있으니 워크숍엔 쓰지 말 것.)
- 기술적 배경·함정 상세는 `SETUP_GUIDE.md` 참고.
- 다음 단계(B: 로봇을 실제로 움직이는 시뮬레이션, C: 실시간 데이터 연동)는 심화 과정으로 분리 권장.
