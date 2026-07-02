#!/bin/bash
# IoT 발행기(robot_simulator.py) 실행 환경 셋업 — 어느 계정에서든 1회 실행하면 됨. 멱등.
#
# 하는 일:
#   1) ~/venv 파이썬 가상환경 생성 (없으면). 시스템 python 은 PEP668(externally-managed)
#      이라 pip 직접 설치가 막혀서 venv 를 쓴다. python3-venv 패키지가 필요.
#   2) awsiotsdk(awscrt+awsiot) 설치.
#   3) IOT_ENDPOINT 를 조회해 ~/.iot_endpoint 에 캐시 + ~/.bashrc 에 export 추가.
#
# 실행:  bash ~/nvidia-omniverse-digital-twin/iot/setup_publisher.sh
# 이후:  cd ~/nvidia-omniverse-digital-twin/iot
#        ~/venv/bin/python -u robot_simulator.py --interval 5
set -uo pipefail
REGION="${AWS_REGION:-ap-northeast-2}"
VENV="$HOME/venv"

echo "[1/3] venv 준비 ($VENV)"
if [ ! -x "$VENV/bin/python" ]; then
  if ! python3 -m venv "$VENV" 2>/dev/null; then
    echo "  python3-venv 가 없어 생성 실패. 관리자(sudo)로 설치 필요:"
    echo "    sudo apt-get install -y python3-venv"
    exit 1
  fi
fi

echo "[2/3] awsiotsdk 설치"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$(dirname "$0")/requirements.txt"
"$VENV/bin/python" -c "import awscrt, awsiot; print('  awscrt', awscrt.__version__)"

echo "[3/3] IOT_ENDPOINT 조회 + 저장"
EP=$(aws iot describe-endpoint --region "$REGION" --endpoint-type iot:Data-ATS \
  --query endpointAddress --output text 2>/dev/null)
if [ -n "$EP" ] && [ "$EP" != "None" ]; then
  echo "$EP" > "$HOME/.iot_endpoint"
  grep -q "^export IOT_ENDPOINT=" "$HOME/.bashrc" 2>/dev/null \
    || echo "export IOT_ENDPOINT=$EP" >> "$HOME/.bashrc"
  echo "  IOT_ENDPOINT=$EP  (~/.bashrc 에 추가됨)"
else
  echo "  ⚠ 엔드포인트 조회 실패(자격증명/권한 확인). 수동 지정 필요:"
  echo "    export IOT_ENDPOINT=\$(aws iot describe-endpoint --region $REGION --endpoint-type iot:Data-ATS --query endpointAddress --output text)"
fi

echo ""
echo "완료. 실행:"
echo "  cd $(dirname "$0")"
echo "  IOT_ENDPOINT=\$(cat ~/.iot_endpoint) ~/venv/bin/python -u robot_simulator.py --interval 5"
