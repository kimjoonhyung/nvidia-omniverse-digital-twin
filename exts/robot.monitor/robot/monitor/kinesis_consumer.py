"""
Kinesis 텔레메트리 소비기 (백그라운드 스레드).

Isaac Sim UI 를 막지 않도록 별도 스레드에서 Kinesis 를 폴링하고,
로봇별 최신값 + 시계열 버퍼(deque)를 thread-safe 하게 보관한다.

Isaac Sim 의존성 없음 → 단독 테스트 가능(아래 __main__).
"""
import base64
import json
import threading
import time
from collections import defaultdict, deque

try:
    import boto3
except ImportError:
    boto3 = None

MAX_POINTS = 120  # 로봇별 시계열 보관 길이 (5초 간격이면 10분)


class TelemetryStore:
    """로봇별 최신값 + 시계열. 모든 접근은 lock 으로 보호."""

    def __init__(self, max_points: int = MAX_POINTS):
        self._lock = threading.Lock()
        self._latest: dict = {}
        self._series: dict = defaultdict(lambda: {
            "battery_pct": deque(maxlen=max_points),
            "motor_temp_c": deque(maxlen=max_points),
            "speed_mps": deque(maxlen=max_points),
        })

    def update(self, rec: dict):
        rid = rec.get("robot_id", "unknown")
        with self._lock:
            self._latest[rid] = rec
            s = self._series[rid]
            for k in ("battery_pct", "motor_temp_c", "speed_mps"):
                if k in rec:
                    s[k].append(float(rec[k]))

    def robot_ids(self):
        with self._lock:
            return sorted(self._latest.keys())

    def latest(self, rid: str) -> dict:
        with self._lock:
            return dict(self._latest.get(rid, {}))

    def series(self, rid: str, key: str):
        with self._lock:
            return list(self._series[rid][key])


class KinesisConsumer:
    """Kinesis 스트림을 폴링해 TelemetryStore 를 채우는 백그라운드 스레드."""

    def __init__(self, store: TelemetryStore, stream_name="robot-telemetry",
                 region="ap-northeast-2", poll_interval=2.0):
        self.store = store
        self.stream_name = stream_name
        self.region = region
        self.poll_interval = poll_interval
        self._thread = None
        self._stop = threading.Event()
        self.status = "stopped"
        self.last_error = ""

    def start(self):
        if boto3 is None:
            self.status = "error"
            self.last_error = "boto3 not installed"
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        try:
            client = boto3.client("kinesis", region_name=self.region)
            # 시작 시점부터 최신만 — LATEST (이미 쌓인 과거는 생략)
            shards = client.list_shards(StreamName=self.stream_name)["Shards"]
            iters = {}
            for sh in shards:
                it = client.get_shard_iterator(
                    StreamName=self.stream_name,
                    ShardId=sh["ShardId"],
                    ShardIteratorType="LATEST",
                )["ShardIterator"]
                iters[sh["ShardId"]] = it
            self.status = "running"
            while not self._stop.is_set():
                for sid, it in list(iters.items()):
                    if not it:
                        continue
                    resp = client.get_records(ShardIterator=it, Limit=100)
                    iters[sid] = resp.get("NextShardIterator")
                    for r in resp.get("Records", []):
                        try:
                            data = r["Data"]
                            if isinstance(data, (bytes, bytearray)):
                                rec = json.loads(data)
                            else:
                                rec = json.loads(base64.b64decode(data))
                            self.store.update(rec)
                        except Exception as e:
                            self.last_error = f"parse: {e}"
                self._stop.wait(self.poll_interval)
        except Exception as e:
            self.status = "error"
            self.last_error = str(e)


if __name__ == "__main__":
    # 단독 테스트: Isaac Sim 없이 Kinesis 소비가 되는지 확인
    store = TelemetryStore()
    c = KinesisConsumer(store)
    c.start()
    print("consuming 15s... (run robot_simulator.py in parallel)")
    for _ in range(15):
        time.sleep(1)
        for rid in store.robot_ids():
            lt = store.latest(rid)
            print(f"  {rid}: batt={lt.get('battery_pct')} temp={lt.get('motor_temp_c')} "
                  f"status={lt.get('status')} | points={len(store.series(rid,'battery_pct'))}")
    c.stop()
    print("status:", c.status, "err:", c.last_error)
