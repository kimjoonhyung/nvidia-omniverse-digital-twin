#!/usr/bin/env python3
"""
가짜 로봇 운영 데이터 생성기 (Nova Carter PoC).

5초마다 로봇별 텔레메트리를 생성해 AWS IoT Core 로 MQTT publish.
토픽: robots/<robot_id>/telemetry  → IoT Rule → Kinesis(robot-telemetry).

상태 머신(idle→moving→charging)으로 현실적인 값 변화를 흉내:
  - moving 이면 배터리 소모↑, 모터 온도↑, 속도>0, 위치 이동
  - 배터리 20% 이하면 charging 으로 전환, 충전되며 온도↓
  - charging 완료(95%↑)면 다시 moving

사용:
  python3 robot_simulator.py                 # 기본 1대(nova_carter_01)
  python3 robot_simulator.py --robots 3      # nova_carter_01..03
  python3 robot_simulator.py --interval 5

(English)
Fake robot operational data generator (Nova Carter PoC).

Every 5 seconds, generates per-robot telemetry and publishes to AWS IoT Core via MQTT.
Topic: robots/<robot_id>/telemetry → IoT Rule → Kinesis (robot-telemetry).

A state machine (idle→moving→charging) mimics realistic value changes:
  - While moving: battery drains, motor temperature rises, speed>0, position moves
  - Battery at or below 20% switches to charging; temperature drops while charging
  - When charging completes (95%+), back to moving

Usage:
  python3 robot_simulator.py                 # 1 robot by default (nova_carter_01)
  python3 robot_simulator.py --robots 3      # nova_carter_01..03
  python3 robot_simulator.py --interval 5
"""
import argparse
import json
import math
import os
import random
import time
from pathlib import Path

from awscrt import mqtt
from awsiot import mqtt_connection_builder

CERT_DIR = Path(__file__).parent / "certs"
# IoT 엔드포인트는 환경변수 IOT_ENDPOINT 로 지정 (계정별로 다름).
#   aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text
# The IoT endpoint is set via the IOT_ENDPOINT environment variable (differs per account).
#   aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text
ENDPOINT = os.environ.get("IOT_ENDPOINT", "REPLACE-WITH-YOUR-ENDPOINT-ats.iot.ap-northeast-2.amazonaws.com")


class RobotState:
    """로봇 한 대의 시뮬레이션 상태.

    Simulation state for a single robot.
    """

    def __init__(self, robot_id: str):
        self.id = robot_id
        self.battery = random.uniform(60, 100)   # %
        self.motor_temp = random.uniform(28, 35)  # °C
        self.speed = 0.0                            # m/s
        self.x = random.uniform(0, 40)              # m (창고 좌표) / m (warehouse coordinates)
        self.y = random.uniform(0, 25)
        self.heading = random.uniform(0, 360)       # deg
        self.status = "moving"
        self.odometer = 0.0                         # m 누적 주행 / cumulative travel in meters
        self.errors = 0

    def step(self, dt: float) -> dict:
        """dt초 경과 후 상태 갱신 + 텔레메트리 dict 반환.

        Update state after dt seconds elapse + return a telemetry dict.
        """
        if self.status == "moving":
            self.speed = max(0.0, random.gauss(0.8, 0.25))   # ~0.8 m/s
            self.battery -= dt * random.uniform(0.05, 0.12)   # 소모 / drain
            self.motor_temp += dt * random.uniform(0.05, 0.2) # 발열 / heating
            # 위치 이동 / position movement
            self.heading = (self.heading + random.gauss(0, 15)) % 360
            rad = math.radians(self.heading)
            self.x = min(40, max(0, self.x + math.cos(rad) * self.speed * dt))
            self.y = min(25, max(0, self.y + math.sin(rad) * self.speed * dt))
            self.odometer += self.speed * dt
            if random.random() < 0.02:      # 가끔 에러 이벤트 / occasional error event
                self.errors += 1
            if self.battery <= 20:
                self.status = "charging"
        elif self.status == "charging":
            self.speed = 0.0
            self.battery = min(100, self.battery + dt * random.uniform(1.5, 2.5))
            self.motor_temp = max(25, self.motor_temp - dt * random.uniform(0.2, 0.4))
            if self.battery >= 95:
                self.status = "moving"
        else:  # idle
            self.speed = 0.0
            self.motor_temp = max(25, self.motor_temp - dt * 0.1)

        # 모터 온도 자연 냉각(이동 중에도 상한 근처서 균형)
        # Natural motor cooling (balances near the upper limit even while moving)
        self.motor_temp = min(self.motor_temp, 85)

        return {
            "robot_id": self.id,
            "ts": int(time.time() * 1000),
            "battery_pct": round(self.battery, 1),
            "speed_mps": round(self.speed, 2),
            "motor_temp_c": round(self.motor_temp, 1),
            "position": {"x": round(self.x, 2), "y": round(self.y, 2)},
            "heading_deg": round(self.heading, 1),
            "odometer_m": round(self.odometer, 1),
            "status": self.status,
            "error_count": self.errors,
        }


def build_connection(client_id: str):
    return mqtt_connection_builder.mtls_from_path(
        endpoint=ENDPOINT,
        cert_filepath=str(CERT_DIR / "device.cert.pem"),
        pri_key_filepath=str(CERT_DIR / "device.private.key"),
        ca_filepath=str(CERT_DIR / "AmazonRootCA1.pem"),
        client_id=client_id,
        clean_session=False,
        keep_alive_secs=30,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--robots", type=int, default=1, help="로봇 대수")  # number of robots
    ap.add_argument("--interval", type=float, default=5.0, help="publish 간격(초)")  # publish interval (seconds)
    args = ap.parse_args()

    robots = [RobotState(f"nova_carter_{i:02d}") for i in range(1, args.robots + 1)]

    print(f"Connecting to {ENDPOINT} ...")
    conn = build_connection("robot-simulator")
    conn.connect().result()
    print(f"Connected. Publishing {len(robots)} robot(s) every {args.interval}s. Ctrl+C to stop.\n")

    try:
        while True:
            for r in robots:
                payload = r.step(args.interval)
                topic = f"robots/{r.id}/telemetry"
                conn.publish(
                    topic=topic,
                    payload=json.dumps(payload),
                    qos=mqtt.QoS.AT_LEAST_ONCE,
                )
                print(f"[{topic}] batt={payload['battery_pct']}% "
                      f"spd={payload['speed_mps']}m/s temp={payload['motor_temp_c']}C "
                      f"status={payload['status']}")
            print("-" * 60)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nStopping...")
        conn.disconnect().result()
        print("Disconnected.")


if __name__ == "__main__":
    main()
