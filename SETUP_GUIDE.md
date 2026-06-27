# 공장/창고 디지털 트윈 구축 가이드 (NVIDIA Isaac Sim)

> Ubuntu + NVIDIA GPU 서버에 원격(DCV)으로 접속해, NVIDIA Isaac Sim으로
> 디지털 트윈 씬을 여는 전 과정을 정리한 문서입니다.
> Claude 없이도 이 문서만으로 동일한 지점까지 도달할 수 있도록 작성했습니다.

---

## 0. 이 가이드가 검증된 환경

| 항목 | 값 |
|------|-----|
| OS | Ubuntu (Linux, GNOME, X11 세션) |
| GPU | NVIDIA L40S |
| 드라이버 | 580.126.09 (요건: `>= 550.54.15`) |
| Isaac Sim | 5.1.0, 설치 위치 `/opt/IsaacSim` |
| 원격 접속 | NICE DCV (가상 디스플레이 `DISPLAY=:1`) |
| 로컬 PC | macOS (DCV 네이티브 클라이언트) |

> ⚠️ Isaac Sim은 RTX 지원 NVIDIA GPU가 필수입니다.

---

## 1. 환경 점검 (선택이지만 권장)

### 1-1. GPU / 드라이버 확인
```bash
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader
```
RTX 계열 GPU와 드라이버 `>= 550`이 나오면 OK.

### 1-2. 디스플레이 / 세션 확인
```bash
echo "DISPLAY=$DISPLAY  SESSION=$XDG_SESSION_TYPE"
```
DCV 데스크톱에서는 보통 `DISPLAY=:1`, `SESSION=x11`.

### 1-3. Isaac Sim 설치 위치 확인
```bash
ls /opt/IsaacSim/isaac-sim.sh
cat /opt/IsaacSim/VERSION
```

---

## 2. (참고) 한글 입력 — DCV에서 자모가 분리될 때

macOS → DCV 환경에서 한글이 `ㅇㅏㄴ`처럼 분리 입력되면, **조합을 한 쪽에서만** 하도록 맞춥니다.

- **권장**: 로컬 Mac 입력기를 **영문(ABC)** 으로 두고, **서버 ibus가 조합**하게 함
  ```bash
  ibus engine hangul          # 서버를 한글 조합 모드로
  ibus engine xkb:us::eng     # 다시 영문으로
  ibus engine                 # 현재 엔진 확인
  ```
- 서버 한/영 전환 단축키: `Super(윈도우키) + Space`

---

## 3. Isaac Sim 실행 스크립트 개요

`/opt/IsaacSim/` 안의 주요 런처:

| 스크립트 | 용도 |
|----------|------|
| `isaac-sim.sh` | **GUI 모드** — 데스크톱(DCV)에 창으로 실행 |
| `isaac-sim.selector.sh` | 앱/GPU 선택 후 실행 |
| `isaac-sim.streaming.sh` | **스트리밍 모드** — GPU 렌더링을 WebRTC로 전송 (서버 운영용) |
| `isaac-sim.compatibility_check.sh` | GPU/드라이버/Vulkan 호환성 점검 |

---

## 4. (선택) 호환성 체크

```bash
cd /opt/IsaacSim
./isaac-sim.compatibility_check.sh
```
- GUI 창이 뜨며 점검합니다. 로그에 **Driver / Graphics API: Vulkan / GPU** 가 정상 인식되면 OK.
- 첫 실행은 셰이더 컴파일로 느릴 수 있습니다. 확인 후 창을 닫으면 됩니다.

---

## 5. Isaac Sim GUI 실행

DCV 데스크톱이 떠 있는 상태에서:

### 5-1. 포그라운드로 간단히 실행
```bash
cd /opt/IsaacSim
DISPLAY=:1 ./isaac-sim.sh
```

### 5-2. 백그라운드로 실행 + 로그 추적 (터미널을 계속 쓰고 싶을 때)
```bash
cd /opt/IsaacSim
DISPLAY=:1 nohup ./isaac-sim.sh > /tmp/isaacsim_launch.log 2>&1 &
```

기동 상황 확인:
```bash
# 익스텐션 로딩 진행 로그 (extension.toml 경고는 무시해도 됨)
tail -f /tmp/isaacsim_launch.log | grep -v "extension.toml.*doesn't exist"

# "app ready" 가 보이면 기동 완료
grep "app ready" /tmp/isaacsim_launch.log

# 프로세스/메모리 확인
ps aux | grep 'kit/kit.*isaacsim.exp.full' | grep -v grep
```

> ⏱️ **첫 실행은 셰이더 컴파일로 4~8분** 걸립니다(검증 환경에서 약 267초).
> 창이 검게 보여도 정상이며, 로그에 `app ready`가 뜨면 준비된 것입니다.

### 5-3. 종료
```bash
pkill -f 'isaacsim.exp.full'
```

---

## 6. 디지털 트윈 샘플 에셋 (NVIDIA 공식, 무료)

Isaac Sim 5.1 에셋은 NVIDIA S3 서버에 있습니다.
에셋 루트:
```
https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1
```

### 6-1. 사용 가능한 창고/공장 환경 목록 확인
```bash
BASE="https://omniverse-content-production.s3-us-west-2.amazonaws.com"
curl -s "$BASE/?list-type=2&prefix=Assets/Isaac/5.1/Isaac/Environments/&delimiter=/" \
  | grep -oE '<Prefix>[^<]+</Prefix>' | sed 's/<[^>]*>//g'
```

### 6-2. 추천 환경 에셋

| 에셋 URL | 실측 크기 | 설명 |
|------|------|------|
| `Environments/Digital_Twin_Warehouse/small_warehouse_digital_twin.usd` | 소형 | 디지털 트윈 전용이나 **너무 작음** |
| `Environments/Simple_Warehouse/full_warehouse.usd` | **27.8 × 45m** | ⭐ 선반·박스 가득한 대형 창고 (권장) |
| `Environments/Simple_Warehouse/warehouse_with_forklifts.usd` | - | 지게차 포함 |
| `NVIDIA/Assets/ArchVis/Industrial/Stages/IsaacWarehouse.usd` | **46.6 × 73m** | 가장 큰 산업용 스테이지(비어있는 편, 단위=cm) |

> **크기 비교가 중요**: 환경마다 실제 크기가 천차만별. 아래 명령으로 열기 전에 실측할 수 있다.
> ```bash
> EXT=/opt/IsaacSim/extscache/omni.usd.libs-1.0.1+69cbf6ad.lx64.r.cp311
> PY=/opt/IsaacSim/kit/python/bin/python3
> curl -s "<환경 USD URL>" -o /tmp/env.usd
> LD_LIBRARY_PATH="$EXT/bin:/opt/IsaacSim/kit/python/lib" PYTHONPATH="$EXT" "$PY" -c "
> from pxr import Usd, UsdGeom
> s=Usd.Stage.Open('/tmp/env.usd', Usd.Stage.LoadAll); dp=s.GetDefaultPrim()
> mpu=UsdGeom.GetStageMetersPerUnit(s)
> bb=UsdGeom.BBoxCache(Usd.TimeCode.Default(),[UsdGeom.Tokens.default_])
> sz=bb.ComputeWorldBound(dp).ComputeAlignedRange().GetSize()
> print('크기(m): %.1f x %.1f x %.1f | 단위:%.3f'%(sz[0]*mpu,sz[1]*mpu,sz[2]*mpu,mpu))"
> ```
> (단, https 하위참조가 많은 파일은 깨진 값이 나올 수 있음 — 그땐 GUI에서 확인)

이 가이드에서 최종 사용한 대형 창고 URL:
```
https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1/Isaac/Environments/Simple_Warehouse/full_warehouse.usd
```

> 💡 이 USD는 머티리얼·텍스처·박스(3138개!)를 같은 서버에서 **상대 경로로 참조**합니다.
> 메인 파일만 로컬에 내려받으면 참조가 전부 깨지므로(회색·빈 씬), **반드시 URL로 직접 여는 방식을 사용**한다.

> ⚠️ **File→Open 시 URL 중복 붙여넣기 주의**: 입력란에 기존 텍스트가 남아 URL이 두세 번
> 이어붙으면(`...full_warehouse.usdhttps:/...`) "찾을 수 없음" 에러가 난다.
> 입력 전 **`Ctrl+A` → `Delete`로 입력란을 완전히 비우고 URL을 한 번만** 붙여넣을 것.

---

## 7. 씬 열기 (Isaac Sim GUI 안에서)

### 방법 A) File → Open 으로 URL 직접 열기 (권장)
1. 상단 메뉴 **`File` → `Open`**
2. 파일 대화상자의 **경로 입력란**에 6-2의 전체 URL을 붙여넣기
3. **`Open`** → 로딩 + 셰이더 컴파일로 1~3분 (처음엔 회색, 점차 텍스처가 채워짐)

### 방법 B) 내장 에셋 브라우저
- **`Environments`** 또는 **`Isaac Sim Assets`** 패널에서
  `Environments → Digital_Twin_Warehouse` 탐색 후 더블클릭/드래그

---

## 8. 뷰포트 조작 & 렌더링 기본기

### 카메라 조작
| 동작 | 입력 |
|------|------|
| 회전 | `Alt + 좌클릭 드래그` (또는 우클릭 드래그) |
| 이동(팬) | `중간 버튼 드래그` |
| 줌 | `마우스 휠` / `Alt + 우클릭 드래그` |
| 선택 객체에 포커스 | 객체 선택 후 `F` |

### 렌더 모드 (시각화 품질)
- 뷰포트 상단 렌더러 메뉴:
  - **`RTX - Real-Time`** : 실시간 (기본)
  - **`RTX - Interactive (Path Tracing)`** : 고품질, 노이즈가 점차 수렴

### Stage 패널
- 우측 **Stage** 트리에서 씬 구성(벽/바닥/선반/조명) 확인.

---

## 8.5 설비(소품) 배치 — 실전 + 함정 (A단계 핵심)

창고 씬에 팔레트·박스·컨베이어·지게차 등을 추가하는 과정. **AI 없이 그대로 재현 가능**하도록
실제 겪은 문제와 해결을 순서대로 기록한다.

### (1) 배치 가능한 설비 에셋 (NVIDIA 공식, 무료)

목록 조회:
```bash
BASE="https://omniverse-content-production.s3-us-west-2.amazonaws.com"
# 소품(Props) 카테고리
curl -s "$BASE/?list-type=2&prefix=Assets/Isaac/5.1/Isaac/Props/&delimiter=/" \
  | grep -oE '<Prefix>[^<]+</Prefix>' | sed 's/<[^>]*>//g'
# 특정 카테고리의 .usd 파일 (예: Pallet)
curl -s "$BASE/?list-type=2&prefix=Assets/Isaac/5.1/Isaac/Props/Pallet/&delimiter=/" \
  | grep -oE '<Key>[^<]+</Key>' | sed 's/<[^>]*>//g'
```

자주 쓰는 설비 (경로는 `.../Isaac/5.1/Isaac/Props/` 하위):

| 에셋 | 경로 |
|------|------|
| 팔레트 | `Pallet/pallet.usd` |
| KLT 빈(박스) | `KLT_Bin/small_KLT.usd` |
| 컨베이어 벨트 | `Conveyors/ConveyorBelt_A01.usd` |
| 지게차 | `Forklift/forklift.usd` |

### (2) 설비 추가 — Add Reference

- 상단 메뉴 **`File` → `Add Reference`** → 경로 입력란에 에셋 URL 붙여넣기 → `Open`
- **Reference**로 넣으면 원본을 복사하지 않고 참조만 하므로 가볍고, 원본 업데이트가 자동 반영됨.

### (3) ⚠️ 함정 1 — 설비가 100배 커진다 (가장 중요)

**증상:** 팔레트를 넣었더니 창고를 통째로 덮을 만큼 거대함.

**원인:** 이 창고의 최상위 프림 `Lab`(defaultPrim)이 내부적으로 **scale = (100,100,100)** 으로
제작돼 있다(원본이 cm로 만들어져 100을 곱해 m로 맞춘 구조). 그런데 `Add Reference`는
**현재 선택된 프림의 자식으로** 에셋을 넣기 때문에, `Lab` 아래에 들어간 설비가 이 100배를 상속받는다.
→ 1.2m 팔레트가 120m가 됨.

**부모 스케일 확인 방법** (명령줄, 선택):
```bash
# 창고 USD를 받아서 Lab 프림의 xformOp 확인
curl -s "<창고 USD URL>" -o /tmp/wh.usd
EXT=/opt/IsaacSim/extscache/omni.usd.libs-1.0.1+69cbf6ad.lx64.r.cp311
PY=/opt/IsaacSim/kit/python/bin/python3
LD_LIBRARY_PATH="$EXT/bin:/opt/IsaacSim/kit/python/lib" PYTHONPATH="$EXT" "$PY" -c "
from pxr import Usd, UsdGeom
s=Usd.Stage.Open('/tmp/wh.usd'); dp=s.GetDefaultPrim()
for op in UsdGeom.Xformable(dp).GetOrderedXformOps(): print(op.GetOpName(), op.Get())"
# -> xformOp:scale (100, 100, 100) 이면 자식 설비는 100배 부풀어오름
```

**해결 (둘 중 하나):**
- **(권장) 부모 100배 상쇄:** 설비 Xform의 **Scale을 `0.01, 0.01, 0.01`** 로 설정 → 100 × 0.01 = 1배(정상).
- **(대안) Lab 바깥에 배치:** 설비를 `Lab`의 형제(`/설비명`)로 빼고 Scale은 `1,1,1`. 단, DCV에서
  Stage 드래그가 잘 안 될 수 있고, pseudo-root `/`는 Stage 패널에 행으로 표시되지 않는다.

### (4) ⚠️ 함정 2 — 속성값 입력이 안 된다 (lock / IME)

**증상:** Scale 칸에 숫자 입력이 안 되고 마우스 드래그만 됨. unlock하면 가끔 됨.

**원인 A — Lock:** 각 속성 옆 **자물쇠 아이콘**이 잠겨 있으면 편집 불가 → **unlock**.

**원인 B — 한글 IME 충돌 (이 환경의 핵심):** Mac→DCV에서 입력기가 한글 조합 모드면
키스트로크가 IME에 먹혀 Kit 입력 필드에 도달하지 못함. "가끔 된다"는 그때의 영문/한글 상태 차이.
→ **입력 전 Mac 입력기를 영문(ABC)으로 고정** (`Caps Lock` 또는 `Ctrl+Space`).

**입력 방법:** 숫자 칸을 **더블클릭** → 편집 모드(파란 하이라이트) → 숫자 → `Enter`. X/Y/Z는 각각 따로.

### (5) ⚠️ 함정 3 — 설비가 회색(텍스처 없음)으로 보인다

**증상:** 팔레트가 단색 회색. 로딩이 끝나도 그대로.

**원인:** 일부 Isaac prop 에셋은 OmniPBR 머티리얼만 있고 **텍스처가 연결돼 있지 않다**
(서버에 텍스처 파일은 존재하지만 USD에서 `diffuse_texture = None`).

**확인 방법:**
```bash
EXT=/opt/IsaacSim/extscache/omni.usd.libs-1.0.1+69cbf6ad.lx64.r.cp311
PY=/opt/IsaacSim/kit/python/bin/python3
curl -s "<팔레트 USD URL>" -o /tmp/pallet.usd
LD_LIBRARY_PATH="$EXT/bin:/opt/IsaacSim/kit/python/lib" PYTHONPATH="$EXT" "$PY" -c "
from pxr import Usd, UsdShade
s=Usd.Stage.Open('/tmp/pallet.usd')
for p in s.Traverse():
  if p.GetTypeName()=='Shader':
    sh=UsdShade.Shader(p)
    print('diffuse:', sh.GetInput('diffuse_texture').Get())  # None 이면 미연결"
# 서버의 텍스처 파일 목록
curl -s "https://omniverse-content-production.s3-us-west-2.amazonaws.com/?list-type=2&prefix=Assets/Isaac/5.1/Isaac/Props/Pallet/Materials/Textures/&delimiter=/" \
  | grep -oE '<Key>[^<]+</Key>' | sed 's/<[^>]*>//g'
```

**해결 (둘 중 하나):**
- **(간단) GUI에서 색만:** `/Root/Looks/OmniPBR` 머티리얼 선택 → Property에서 Albedo Color를 나무색으로.
- **(권장) 래퍼 USD로 텍스처 연결 + 크기 보정 한 번에:** 아래 (6) 참고.

### (6) ✅ 래퍼 USD 패턴 — 크기·텍스처를 파일 레벨에서 한 번에 해결

GUI 입력이 불안정할 때 가장 확실한 방법. 원본을 reference하고, **scale 0.01 + 텍스처 연결**을
미리 박은 작은 `.usda` 파일을 만들어 그걸 씬에 넣는다.

`~/digital_twin/assets/pallet_textured.usda` :
```usda
#usda 1.0
(
    defaultPrim = "Pallet_Textured"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "Pallet_Textured" (
    prepend references = @https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1/Isaac/Props/Pallet/pallet.usd@
)
{
    # Lab(100x) 아래에 넣어도 정상 크기가 되도록 0.01 적용. (Lab 바깥이면 1.0 으로)
    float3 xformOp:scale = (0.01, 0.01, 0.01)
    uniform token[] xformOpOrder = ["xformOp:scale"]

    over "Looks" {
        over "OmniPBR" {
            over "Shader" {
                asset inputs:diffuse_texture = @.../Pallet/Materials/Textures/T_PalletWooden_A_Albedo.png@
                asset inputs:normalmap_texture = @.../Pallet/Materials/Textures/T_PalletWooden_A_Normal.png@
            }
        }
    }
}
```
> 텍스처 URL의 `...` 는 에셋 루트(`https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1/Isaac/Props`)로 치환.

검증 (텍스처 연결 여부만 — https reference는 GUI에서 최종 확인):
```bash
EXT=/opt/IsaacSim/extscache/omni.usd.libs-1.0.1+69cbf6ad.lx64.r.cp311
PY=/opt/IsaacSim/kit/python/bin/python3
LD_LIBRARY_PATH="$EXT/bin:/opt/IsaacSim/kit/python/lib" PYTHONPATH="$EXT" "$PY" -c "
from pxr import Usd, UsdShade
s=Usd.Stage.Open('/home/ubuntu/digital_twin/assets/pallet_textured.usda')
sh=UsdShade.Shader(s.GetPrimAtPath('/Pallet_Textured/Looks/OmniPBR/Shader'))
print('diffuse:', sh.GetInput('diffuse_texture').Get())"
```
> 참고: 명령줄 pxr는 `https://` reference를 해석하지 못해 bbox가 깨진 값으로 나온다. 이는 정상이며,
> 크기/텍스처의 최종 확인은 Isaac Sim GUI에서 한다(Isaac은 omni 클라이언트로 https를 처리).

사용: 기존 회색 팔레트를 삭제하고, **`File → Add Reference`** 로
`/home/ubuntu/digital_twin/assets/pallet_textured.usda` 를 넣으면 정상 크기 + 나무 텍스처로 표시됨.

---

## 9. 다음 단계 로드맵 (A → B → C)

- **A. 시각화/레이아웃** (현재 단계)
  - 창고 씬 열기 → 설비(팔레트/선반/지게차/로봇) 추가 배치 → 조명·머티리얼·RTX 렌더링
- **B. 동작 시뮬레이션**
  - PhysX 물리 적용, 로봇/컨베이어 거동, 센서 — Isaac Sim 내에서 진행
- **C. 실시간 데이터 연동**
  - 센서/PLC/IoT 실데이터 연결(확장/커넥터/OpenUSD 라이브 세션) → 살아있는 트윈

---

## 부록. 자주 겪는 문제

| 증상 | 원인/해결 |
|------|-----------|
| 로그에 `extension.toml doesn't exist` 경고 다수 | **정상**. 무시해도 됨 |
| 창이 검게 떠서 멈춘 듯 | 첫 셰이더 컴파일 중. `grep "app ready"`로 확인하며 대기 |
| `Could not import system rclpy` | ROS2 미설치 시 내부 rclpy 사용. 트윈 작업에 영향 없음 |
| `PCIe link width ... don't match` 경고 | 성능 경고. 기능엔 문제 없음 |
| 텍스처 없이 회색으로만 보임 | (1) USD를 로컬 단일 파일로 받아 참조가 깨짐 → URL로 열 것, (2) 에셋 자체가 텍스처 미연결 → 8.5 (5)(6), 또는 (3) **로봇이 원래 어두운 색**(아래) |
| 로봇이 회색/검정으로 밋밋함 | **정상일 수 있음.** Nova Carter 등 다수 로봇은 원래 무광 검정·짙은 회색 본체다. 바퀴·센서에 디테일(검은 고무/금속)이 보이면 텍스처는 정상. 화려한 텍스처를 기대하지 말 것 |
| 추가한 설비가 100배 커짐 | 부모 프림(Lab) scale=100 상속. 설비 Scale을 0.01로 → 8.5 (3) |
| 속성값(Scale 등) 숫자 입력 안 됨 | 자물쇠 unlock + Mac 입력기 영문 고정(IME 충돌) → 8.5 (4) |
| 설비를 Lab 밖으로 못 뺌 / `/`가 안 보임 | pseudo-root는 Stage에 표시 안 됨. 0.01 상쇄가 더 쉬움 → 8.5 (3) |
| 한글이 자모로 분리 입력 | 2장 참고 (Mac 영문 고정 + 서버 ibus 조합) |
