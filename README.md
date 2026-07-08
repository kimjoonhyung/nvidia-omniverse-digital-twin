# Omniverse 디지털 트윈 워크숍

NVIDIA Isaac Sim(Omniverse)으로 **공장/창고 디지털 트윈**을 만들고, 여러 명이 협업하며,
실시간 데이터로 살아 움직이게 하는 워크숍입니다. 입문자 대상, 한국어.

---

## 🎓 수강생은 여기부터 — 순서대로 따라가세요

`workshop/` 폴더의 문서를 **번호 순서대로** 진행합니다. 각 단계는 앞 단계를 전제로 합니다.

| 단계 | 문서 | 무엇을 하나 | 소요 |
|:---:|------|------|:---:|
| **00** | [시작하기](workshop/00-시작하기.md) | 원격 데스크톱(DCV) 접속 + Isaac Sim 실행 | 10분 |
| **01** | [씬 만들기](workshop/01-씬-만들기.md) | 창고 열기 + 로봇·설비 배치 + 카메라·렌더링 | 30분 |
| **02** | [협업 — Nucleus Live](workshop/02-협업-Nucleus-Live.md) ★ | 여러 명이 같은 씬을 실시간 동시편집 | 20분 |
| **03** | [실시간 데이터](workshop/03-실시간-데이터.md) | 가짜 로봇 데이터 → AWS → 실시간 차트·이동 | 40~60분 |
| **04** | [스트리밍 뷰어](workshop/04-스트리밍-뷰어.md) *(선택)* | GPU 1대를 여러 명이 노트북 앱으로 관전·조작 | 20~30분 |

> **처음이라면** → [00. 시작하기](workshop/00-시작하기.md) 로 바로 이동하세요.
> 코딩·USD 문법 지식은 필요 없습니다.

---

## 🗺️ 전체 그림

```
        ┌─ 00 접속 ─┐
        │           ▼
        │      01 씬 만들기 ──▶ 02 협업(Nucleus Live) ──▶ 03 실시간 데이터
        │                                                      │
   [강사가 미리 배포한 인프라]                              04 스트리밍 뷰어(선택)
   Isaac Sim 클라이언트 N대 + Nucleus 1대
   (cdk-omniverse/ 로 자동 배포)
```

- **클라이언트(GPU)**: g6e (L40S). DCV virtual 다중세션으로 **1대를 여러 명이** 공유.
- **Nucleus(협업 서버)**: m7i.xlarge (GPU 불필요). Live 동시편집·자급자족 패키지 호스팅.
- 실제 IP·비밀번호는 배포 때마다 다르므로 저장소에 두지 않습니다(강사가 공지).

---

## 🛠️ 강사·엔지니어용 — 인프라 배포와 심화 자료

수강생은 볼 필요 없습니다. 워크숍 환경을 **직접 구축·운영**할 때 참고하세요.

### 인프라 배포
| 문서 | 내용 |
|------|------|
| **[cdk-omniverse/README.md](cdk-omniverse/README.md)** | **CDK 자동 배포** (클라이언트 N대 + Nucleus 1대 한 번에). 실배포 검증 완료 |
| [docs/nucleus-수동배포.md](docs/nucleus-수동배포.md) | Nucleus 서버 **수동** 배포 (EC2 + Docker + NGC). 원리 학습·디버깅용 |

### 심화 / 개발 노트
| 문서 | 내용 |
|------|------|
| [docs/isaac-sim-셋업.md](docs/isaac-sim-셋업.md) | Isaac Sim 설치·실행, 씬 구축 상세, 100배 스케일·텍스처 함정, 래퍼 USD 패턴 |
| [docs/iot-개발노트.md](docs/iot-개발노트.md) | IoT→Kinesis→Isaac Sim 파이프라인 상세, `robot.monitor` 확장 구조·동작 원리 |
| [docs/스트리밍-실측노트.md](docs/스트리밍-실측노트.md) | WebRTC 1:1 한계, 5.1 설정 키, Nucleus Live vs DCV 다중세션 비용 비교 (실측) |

### 코드
| 위치 | 내용 |
|------|------|
| `cdk-omniverse/` | 워크숍 인프라 IaC (TypeScript CDK) |
| `exts/robot.monitor/` | Isaac Sim 실시간 모니터링 확장 |
| `iot/` | 데이터 발행기(`factory_simulator.py` 등) + 셋업 스크립트 + 씬 |
| `assets/` | 래퍼 USD 예시 (소형 창고용, 참고) |

---

## 🔐 보안 (워크숍 후 반드시)

- **이 저장소에 실제 IP·키·비밀번호를 커밋하지 말 것.** (`.gitignore` 로 `*.pem`, `certs/`,
  `CREDENTIALS.txt` 등 차단됨)
- NGC API 키 폐기(rotate), Nucleus MASTER/SERVICE 비밀번호 교체(`/opt/nucleus/CREDENTIALS.txt`).
- DCV 비밀번호는 강한 값으로. 운영 전환 시 no-SSL → SSL, 접근 범위 축소.

---

## 진행 상태

- ✅ **A. 씬/레이아웃** — 창고 + 로봇·설비 배치
- ✅ **협업** — Nucleus + 자급자족 패키지 + Live 동시편집
- ✅ **IaC** — CDK 전체 인프라 코드화 + 실배포 검증
- ✅ **C. 실시간 데이터** — IoT→Kinesis→Isaac Sim, 실시간 차트 + 로봇 이동 + 클릭
- ✅ **다중 접속** — DCV virtual 다중세션(1 GPU 여러 명) + WebRTC 스트리밍 뷰어
- ⬜ **B. 동작 시뮬레이션** — PhysX 물리, 로봇/컨베이어 거동 (심화 과정으로 분리 권장)
