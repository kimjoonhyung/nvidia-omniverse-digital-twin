> 🇰🇷 [한국어](../iot-개발노트.md) | 🇺🇸 English

# Stage C — Live Data Twin (AWS IoT → Isaac Sim Monitoring)

A PoC where fake robots send operational data to AWS every 5 seconds, viewed as live charts inside Isaac Sim.

```
[factory_simulator.py]──MQTT──▶ [AWS IoT Core] ──IoT Rule──▶ [Kinesis: robot-telemetry]
   (publishes 4 robot types; robot_simulator.py for single tests)        │
                                                                     ▼
                              [Isaac Sim extension robot.monitor] ◀── boto3 polling
                                  omni.ui.Plot live charts + status/insight
```

Verified: local → IoT → Kinesis delivery + consumer receiving the time series. (UI verified in the Isaac Sim GUI.)

---

## 1. AWS Infrastructure (created via CLI — CDK integration planned)

| Resource | Value |
|------|------|
| Kinesis Stream | `robot-telemetry` (1 shard) |
| IoT Thing | `nova_carter_01` |
| IoT endpoint | Look up with `aws iot describe-endpoint --endpoint-type iot:Data-ATS` (injected via env `IOT_ENDPOINT`) |
| MQTT topic | `robots/<robot_id>/telemetry` |
| IoT Rule | `robot_telemetry_to_kinesis` (SELECT * FROM 'robots/+/telemetry' → Kinesis) |
| IoT→Kinesis IAM role | `iot-to-kinesis-role` |
| Device certificates | `~/digital_twin/iot/certs/` (device.cert.pem, device.private.key, AmazonRootCA1.pem) |

> ⚠️ The private key in `certs/` is a secret. Do not commit it to git (handled via .gitignore).

---

## 2. Running the Data Generator (Publisher)

**Two publishers — pick the one that fits:**
| Script | Robots published | Purpose |
|----------|-----------|------|
| `robot_simulator.py` | `nova_carter_01..N` (1 type, count via `--robots N`) | Pipeline / single-robot testing |
| **`factory_simulator.py`** | **4 types**: `nova_carter_01` (amr), `iw_hub_01` (amr), `franka_01` (arm), `digit_01` (humanoid) | **Workshop factory scene (factory_scene) demo** |

> If all 4 robots need to appear on screen in the workshop, use **`factory_simulator.py`**.
> `robot_simulator.py` publishes nova_carter only, so the list will show only nova_carter_0N.

The publisher needs `awsiotsdk` (awscrt+awsiot) and authenticates to IoT Core with the device
certificates in `iot/certs/`. The system Python blocks pip installs via PEP 668, so use a **venv**.
The setup script handles everything at once:

```bash
cd ~/digital_twin/iot          # (on workshop clients: ~/nvidia-omniverse-digital-twin/iot)
bash setup_publisher.sh        # create venv + install awsiotsdk + look up/cache IOT_ENDPOINT (idempotent, run once)
```
> To do it manually without `setup_publisher.sh`: `python3 -m venv ~/venv && ~/venv/bin/pip install -r requirements.txt`
> (if venv creation fails, `sudo apt-get install -y python3-venv`). The publisher requires the `iot/certs/` certificates.

Running (use the venv Python):
```bash
# Workshop 4-robot set (recommended) — nova_carter/iw_hub/franka/digit
IOT_ENDPOINT=$(cat ~/.iot_endpoint) ~/venv/bin/python -u factory_simulator.py --interval 3

# Or single-robot testing (nova_carter only)
IOT_ENDPOINT=$(cat ~/.iot_endpoint) ~/venv/bin/python -u robot_simulator.py --interval 5      # 1 robot
IOT_ENDPOINT=$(cat ~/.iot_endpoint) ~/venv/bin/python -u robot_simulator.py --robots 3 --interval 5   # 3 robots
```
- The setup adds `IOT_ENDPOINT` to `~/.bashrc`, so in a new shell `~/venv/bin/python -u factory_simulator.py ...` alone is enough.
- You must use `~/venv/bin/python` (the system `python3` has no awsiotsdk). `-u` makes output appear immediately.
- Telemetry: `battery_pct, motor_temp_c, speed_mps, position(x,y), heading_deg, odometer_m, status, error_count`
- State machine: moving (battery↓, heat↑) → charging when below 20% → moving again above 95%.

Verifying the pipeline with the generator alone (confirming delivery to Kinesis):
```bash
SHARD=$(aws kinesis get-shard-iterator --region ap-northeast-2 --stream-name robot-telemetry \
  --shard-id shardId-000000000000 --shard-iterator-type LATEST --query ShardIterator --output text)
aws kinesis get-records --region ap-northeast-2 --shard-iterator "$SHARD" --limit 5
```

---

## 3. Isaac Sim Monitoring Extension (robot.monitor)

### Extension layout
```
~/digital_twin/exts/robot.monitor/
├── config/extension.toml
└── robot/monitor/
    ├── __init__.py
    ├── extension.py         # UI + publish/display + interpolated motion + click interaction
    ├── kinesis_consumer.py  # background Kinesis polling → TelemetryStore
    └── usd_bridge.py        # telemetry ↔ USD prims (customData/transform)
```

### Loading into Isaac Sim (3 ways)

**A) Command line (most reliable — no UI typing needed):**
```bash
/opt/IsaacSim/isaac-sim.sh \
  --ext-folder /home/ubuntu/digital_twin/exts \
  --enable robot.monitor
```

**B) Inject the search path into user.config.json (automatic on restart):**
```
~/.local/share/ov/data/Kit/Isaac-Sim Full/5.1/user.config.json
→ add "/home/ubuntu/digital_twin/exts" to exts.folders
```

**C) Extensions UI:** Window → Extensions → ⚙ → add the path under Search Paths, then toggle it on.
> UI typing can be blocked in the DCV + Korean IME environment, so A/B are recommended.

> Isaac Sim's bundled Python includes boto3 (no extra install).
> Kinesis read permission is required (instance IAM role or `~/.aws/credentials`).

### Two modes (UI checkboxes)
- **Publish (only ONE instructor turns this ON)**: consume Kinesis → write into the robot USD prims' customData.
  In a Nucleus Live session this **propagates to all clients automatically** (no polling needed by the others).
- **Move**: **smoothly moves** the robot prims (interpolated) using the telemetry position/heading.

### UI layout
- **Mode/Publish, Move** checkboxes (both ON by default in the PoC)
- **Stream**: consumer state (running/error) or display mode
- **Robot**: robot-selection ComboBox — **auto-switches when you click a robot in the viewport**
- **Metrics panel**: status / battery% / motor temp / speed / position / odometer / errors
  - Battery ≤30% → red, motor temp ≥70°C → red (insight warnings)
- **Charts (omni.ui.Plot)**: live lines for battery (0-100) / motor temp (20-90) / speed (0-2)

### How it works (the essentials)
```
KinesisConsumer (background thread) → TelemetryStore (thread-safe)
        │ (when Publish is ON)
        ▼
usd_bridge.write_telemetry()  robot prim customData["telemetry"] = JSON
        │ Nucleus Live propagates the USD change to every client
        ▼
Each client reads the values via usd_bridge.read_telemetry()
   - Update omni.ui.Plot charts (append to the series only when ts changes → avoids chart gaps/flattening)
   - _update_motion(): lerp toward the position/heading target every frame (a=0.08) → smooth motion
   - Viewport SELECTION_CHANGED event → switch the dashboard to the clicked robot
```

**Sharing principle**: UI panels are not shared over Live, but **USD (customData/transform) is**.
→ When the publisher writes to USD, every client sees the same data, and the robots move in sync.

### Conveniences
- If the stage has no robot prims when the extension starts, the PoC test scene (`iot/test_scene.usda`) opens automatically.
- `test_scene.usda`: Nova Carter reference + `customData.robot_id="nova_carter_01"` (guarantees matching).

---

## 4. Demo Scenario

1. Run `robot_simulator.py` in a terminal (data starts flowing).
2. Launch Isaac Sim from the command line (3-A) → test scene auto-opens + extension activates.
3. **Charts refresh every 5 seconds**, and **the robot glides smoothly around the warehouse**.
4. Battery drops below 20% → status=charging, battery curve rebounds → "a living twin".
5. **Click a robot in the viewport → the dashboard switches to that robot** (with multiple robots).
6. When another client opens the same Nucleus scene in Live mode → identical movement/data shared.

---

## 5. Cleanup / Next Steps

- **Cleanup (cost)**: delete the resources after the PoC
  ```bash
  aws kinesis delete-stream --region ap-northeast-2 --stream-name robot-telemetry --enforce-consumer-deletion
  aws iot delete-topic-rule --region ap-northeast-2 --rule-name robot_telemetry_to_kinesis
  # For the IoT Thing/certificates/policies: detach first, then delete (order matters)
  ```
- **CDK integration (planned)**: add IoT/Kinesis/IAM to the `cdk-omniverse` stack for one-shot deployment.
- **Extension ideas**:
  - Battery/status text overlay above the robots in 3D
  - Highlight a robot in red when thresholds are exceeded
  - Multiple robots (`--robots N`) + switch to a headless publisher
  - Detailed history/aggregation via Grafana (Amazon Managed Grafana) + Timestream

---

## 6. Troubleshooting (Pitfalls Actually Encountered)

| Symptom | Cause / Fix |
|------|------|
| Generator output not showing | Python buffering → use `python3 -u` (unbuffered) |
| Can't type search paths in the Extensions UI | DCV + IME conflict → use command-line `--ext-folder` or the user.config.json injection |
| No charts/combo box (`prim_by_rid={}`) | No robot prims in the scene → open the test scene (auto-open feature was added) |
| USD passed as a positional arg doesn't open | Isaac Sim ignores kit positional args → the extension auto-opens via `open_stage()` |
| Chart draws but never updates / flat line | `_on_update` accumulated the same value every frame → append only when ts changes |
| Robot motion is jerky | 5-second snap intervals → per-frame lerp interpolation (`a=0.08`) |
| robot_id ↔ prim matching fails | customData.robot_id takes priority; else partial match on name/path (basename) |
| `apply_motion` is False | usd_bridge nulled pxr too when the omni import failed → split the omni/pxr imports |
