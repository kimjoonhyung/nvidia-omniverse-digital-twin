#!/usr/bin/env python3
"""
공장 4종 로봇 가짜 데이터 생성기 (워크샵용).

대형 창고에 배치된 4종 로봇이 각자 타입에 맞는 운영 데이터를 5초마다
AWS IoT Core 로 MQTT publish. 토픽: robots/<robot_id>/telemetry → Kinesis.

로봇 타입별 텔레메트리:
  - AMR (Nova Carter, iw_hub): battery_pct, speed_mps, motor_temp_c,
      position(x,y), heading_deg, odometer_m, status(moving/charging)
  - ARM (Franka): joint_angle_deg, cycle_count, payload_kg, gripper(open/closed),
      motor_temp_c, status(working/idle), position(고정)
  - HUMANOID (Digit): gait_speed_mps, balance_pct, battery_pct, step_count,
      position(x,y), heading_deg, status(walking/standing)

공통: robot_id, robot_type, ts. 모든 로봇은 데모를 위해 position 이 갱신됨
(로봇팔은 작은 반경으로 진동, 나머지는 창고를 이동).

사용:
  export IOT_ENDPOINT=$(aws iot describe-endpoint --region ap-northeast-2 \
      --endpoint-type iot:Data-ATS --query endpointAddress --output text)
  python3 -u factory_simulator.py            # 기본 4종 전부
  python3 -u factory_simulator.py --interval 5

(English)
Fake data generator for 4 factory robot types (for the workshop).

Four robot types placed in a large warehouse each publish type-appropriate operational data
every 5 seconds to AWS IoT Core via MQTT. Topic: robots/<robot_id>/telemetry → Kinesis.

Telemetry per robot type:
  - AMR (Nova Carter, iw_hub): battery_pct, speed_mps, motor_temp_c,
      position(x,y), heading_deg, odometer_m, status(moving/charging)
  - ARM (Franka): joint_angle_deg, cycle_count, payload_kg, gripper(open/closed),
      motor_temp_c, status(working/idle), position (fixed)
  - HUMANOID (Digit): gait_speed_mps, balance_pct, battery_pct, step_count,
      position(x,y), heading_deg, status(walking/standing)

Common: robot_id, robot_type, ts. For the demo, every robot's position is updated
(the arm oscillates in a small radius; the others roam the warehouse).

Usage:
  export IOT_ENDPOINT=$(aws iot describe-endpoint --region ap-northeast-2 \
      --endpoint-type iot:Data-ATS --query endpointAddress --output text)
  python3 -u factory_simulator.py            # all 4 types by default
  python3 -u factory_simulator.py --interval 5
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
ENDPOINT = os.environ.get("IOT_ENDPOINT", "REPLACE-WITH-YOUR-ENDPOINT-ats.iot.ap-northeast-2.amazonaws.com")

# 워크샵 4종 로봇 정의 (robot_id, type, 창고 내 시작 위치)
# 좌표는 full_warehouse 내부 범위(X:-24~3, Y:-16~28)에 맞춤.
# Workshop definitions for the 4 robots (robot_id, type, starting position in the warehouse)
# Coordinates fit the full_warehouse interior range (X:-24~3, Y:-16~28).
ROBOTS = [
    {"id": "nova_carter_01", "type": "amr",      "x": -15.0, "y": 0.0},
    {"id": "iw_hub_01",      "type": "amr",      "x": -8.0,  "y": 10.0},
    {"id": "franka_01",      "type": "arm",      "x": -18.0, "y": 15.0},
    {"id": "digit_01",       "type": "humanoid", "x": -5.0,  "y": 20.0},
]

# 창고 내부 이동 한계 (벽 밖으로 안 나가게) / Movement bounds inside the warehouse (keeps robots within the walls)
WH_X_MIN, WH_X_MAX = -23.0, 2.0
WH_Y_MIN, WH_Y_MAX = -15.0, 27.0


class Robot:
    def __init__(self, spec):
        self.id = spec["id"]
        self.type = spec["type"]
        self.x = spec["x"]
        self.y = spec["y"]
        self.home = (spec["x"], spec["y"])
        self.heading = random.uniform(0, 360)
        self.battery = random.uniform(70, 100)
        self.motor_temp = random.uniform(28, 35)
        self.odometer = 0.0
        self.status = "moving" if self.type != "arm" else "working"
        # 타입별 상태 / per-type state
        self.joint = 0.0
        self.cycles = 0
        self.steps = 0
        self.t = 0.0  # 내부 시계(로봇팔 진동 등) / internal clock (arm oscillation etc.)

    def step(self, dt):
        self.t += dt
        if self.type == "amr":
            return self._amr(dt)
        if self.type == "arm":
            return self._arm(dt)
        return self._humanoid(dt)

    def _base(self, extra):
        rec = {"robot_id": self.id, "robot_type": self.type,
               "ts": int(time.time() * 1000),
               "position": {"x": round(self.x, 2), "y": round(self.y, 2)},
               "heading_deg": round(self.heading, 1),
               "status": self.status}
        rec.update(extra)
        return rec

    def _move(self, speed, dt, wander_deg):
        """heading 방향으로 전진. 벽에 닿으면 그 축의 방향성분을 반사(bounce)해
        모서리에 갇히지 않게 한다. 이동 거리(odometer 용)를 반환.

        Advance along the heading. On wall contact, reflect (bounce) that axis's direction
        component so robots don't get stuck in corners. Returns the distance moved (for the odometer).
        """
        self.heading = (self.heading + random.gauss(0, wander_deg)) % 360
        rad = math.radians(self.heading)
        nx = self.x + math.cos(rad) * speed * dt
        ny = self.y + math.sin(rad) * speed * dt
        # X 벽 충돌 → 수평성분 반사 (heading 을 세로축 기준으로 뒤집기)
        # X wall collision → reflect the horizontal component (mirror heading about the vertical axis)
        if nx <= WH_X_MIN or nx >= WH_X_MAX:
            self.heading = (180 - self.heading) % 360
        # Y 벽 충돌 → 수직성분 반사 / Y wall collision → reflect the vertical component
        if ny <= WH_Y_MIN or ny >= WH_Y_MAX:
            self.heading = (-self.heading) % 360
        self.x = min(WH_X_MAX, max(WH_X_MIN, nx))
        self.y = min(WH_Y_MAX, max(WH_Y_MIN, ny))
        return speed * dt

    # ---- AMR: 창고 이동, 배터리 소모/충전 ----
    # ---- AMR: roams the warehouse, battery drain/charge ----
    def _amr(self, dt):
        if self.status == "moving":
            speed = max(0.0, random.gauss(0.8, 0.2))
            self.battery -= dt * random.uniform(0.05, 0.12)
            self.motor_temp += dt * random.uniform(0.05, 0.2)
            self.odometer += self._move(speed, dt, wander_deg=15)
            if self.battery <= 20:
                self.status = "charging"
        else:  # charging
            speed = 0.0
            self.battery = min(100, self.battery + dt * 2.0)
            self.motor_temp = max(25, self.motor_temp - dt * 0.3)
            if self.battery >= 95:
                self.status = "moving"
        self.motor_temp = min(self.motor_temp, 85)
        return self._base({
            "battery_pct": round(self.battery, 1),
            "speed_mps": round(speed, 2),
            "motor_temp_c": round(self.motor_temp, 1),
            "odometer_m": round(self.odometer, 1),
        })

    # ---- ARM: 고정 위치, 관절 진동 + 사이클 ----
    # ---- ARM: fixed position, joint oscillation + cycles ----
    def _arm(self, dt):
        # 관절각 사인 진동(0~180), 픽앤플레이스 사이클
        # Sinusoidal joint-angle oscillation (0~180), pick-and-place cycles
        self.joint = 90 + 80 * math.sin(self.t * 0.6)
        self.motor_temp += dt * random.uniform(-0.05, 0.15)
        self.motor_temp = min(max(self.motor_temp, 30), 75)
        gripper = "closed" if math.sin(self.t * 0.6) > 0 else "open"
        if gripper == "closed" and random.random() < 0.3:
            self.cycles += 1
        self.status = "working" if random.random() > 0.1 else "idle"
        # 데모용 미세 위치 진동(제자리에서 살짝) / Tiny positional jitter for the demo (slightly, in place)
        self.x = self.home[0] + 0.1 * math.sin(self.t)
        self.y = self.home[1] + 0.1 * math.cos(self.t)
        self.heading = (self.joint) % 360
        return self._base({
            "joint_angle_deg": round(self.joint, 1),
            "cycle_count": self.cycles,
            "payload_kg": round(random.uniform(0, 3.5), 2),
            "gripper": gripper,
            "motor_temp_c": round(self.motor_temp, 1),
        })

    # ---- HUMANOID: 보행, 균형 ---- / ---- HUMANOID: walking, balance ----
    def _humanoid(self, dt):
        if self.status == "walking":
            gait = max(0.0, random.gauss(0.6, 0.15))
            self.battery -= dt * random.uniform(0.08, 0.15)
            self._move(gait, dt, wander_deg=10)
            self.steps += int(gait * dt * 2)
            if random.random() < 0.05:
                self.status = "standing"
        else:
            gait = 0.0
            if random.random() < 0.3:
                self.status = "walking"
        balance = max(70, min(100, random.gauss(92, 4)))
        return self._base({
            "gait_speed_mps": round(gait, 2),
            "balance_pct": round(balance, 1),
            "battery_pct": round(self.battery, 1),
            "step_count": self.steps,
        })


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=5.0)
    args = ap.parse_args()

    robots = [Robot(s) for s in ROBOTS]
    print(f"Connecting to {ENDPOINT} ...")
    conn = mqtt_connection_builder.mtls_from_path(
        endpoint=ENDPOINT,
        cert_filepath=str(CERT_DIR / "device.cert.pem"),
        pri_key_filepath=str(CERT_DIR / "device.private.key"),
        ca_filepath=str(CERT_DIR / "AmazonRootCA1.pem"),
        client_id="factory-simulator",
        clean_session=False, keep_alive_secs=30,
    )
    conn.connect().result()
    print(f"Connected. Publishing {len(robots)} robots every {args.interval}s. Ctrl+C to stop.\n")
    try:
        while True:
            for r in robots:
                payload = r.step(args.interval)
                conn.publish(topic=f"robots/{r.id}/telemetry",
                             payload=json.dumps(payload), qos=mqtt.QoS.AT_LEAST_ONCE)
                print(f"[{r.id:16}] type={r.type:8} status={payload['status']:9} "
                      f"pos=({payload['position']['x']},{payload['position']['y']})")
            print("-" * 64)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nStopping...")
        conn.disconnect().result()


if __name__ == "__main__":
    main()
