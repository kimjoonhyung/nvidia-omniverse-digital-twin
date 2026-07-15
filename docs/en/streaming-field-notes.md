> 🇰🇷 [한국어](../스트리밍-실측노트.md) | 🇺🇸 English

# Streaming / Multi-User Access Field Notes (Isaac Sim 5.1, EC2 g6e)

> A record of researching and empirically testing how to let "multiple people view the same digital twin" for the workshop.
> **Conclusion first**: WebRTC streaming is one person per instance. Multi-user sharing is solved with **Nucleus Live**,
> and cost reduction (multiple people on 1 GPU) with **DCV virtual multi-sessions** (automation complete — section 4).
> Everything below is the evidence and trial-and-error.

Environment:
- Isaac Sim **5.1.0** (marketplace AMI `OV-Template-aws-ubuntu-isaac_sim-*`, `/opt/IsaacSim`)
- Client EC2 **g6e.2xlarge (L40S 46GB)**, region `ap-northeast-2`
- Deployment: CDK (`cdk-omniverse`) — 2 clients + 1 Nucleus

---

## 1. WebRTC Livestreaming — One Person per Instance (one-to-one)

### Measurements / evidence
- Official docs: **"Only one client can access an Isaac Sim instance at a time."**
- The binary (`libNvStreamServer.so`) contains the connection-refusal code `NVST_DISCONN_MAX_CONCURRENT_SESSION_LIMIT`.
- There is **no** kit setting key that raises the session count.
- The limit applies to **both the native client and the browser web viewer** (same WebRTC transport).

### 5.1 setting keys (important — differs from the docs)
The official docs' examples use the **6.0 namespace**, which 5.1 ignores:
- ❌ (6.0) `--/exts/omni.kit.livestream.app/primaryStream/publicIp|signalPort|streamPort`
- ✅ (5.1) the `/app/livestream/` namespace (confirmed via `strings` on the binary):
  | Key | Purpose |
  |----|------|
  | `--/app/livestream/publicEndpointAddress=<public IP>` | **Required for NAT/public-network access**. Without it the server advertises only the private IP over ICE → **black screen** |
  | `--/app/livestream/minHostPort` / `maxHostPort` | Pins the media UDP port range (lets you keep the SG narrow) |
  | `--/app/livestream/port` (default 49100) | Signaling port |
  | `--/app/livestream/publicEndpointPort` | Public signaling port |

### Correct 5.1 streaming launch (verified)
```bash
cd /opt/IsaacSim
HOST_IP=$(curl -s https://checkip.amazonaws.com)
./isaac-sim.streaming.sh \
  --ext-folder /home/ubuntu/digital_twin/exts --enable robot.monitor \
  --/app/livestream/publicEndpointAddress=$HOST_IP \
  --/app/livestream/minHostPort=47998 --/app/livestream/maxHostPort=48010
```
- Connect only after **both** `Streaming server started.` and `Isaac Sim Full Streaming App is loaded.` appear (connecting before load → black screen).
- The `robot.monitor` extension → `factory_scene.usda` auto-opens, and the "Robot Telemetry Monitor" panel is visible and operable in the stream (`hideUi=false`).

### Trial and error (black-screen debugging)
1. Passed 6.0-style args, which 5.1 ignored → publicEndpointAddress missing → server advertised only the private IP (10.x) → **black screen**.
2. UDP media ports don't show in `ss -tulnp` before a connection (normal, ICE allocates dynamically). Pin them with `minHostPort/maxHostPort` to control via SG.
3. ufw inactive, NVENC (L40S) fine, laptop IP within the SG range → the root cause was ultimately the **setting key (publicEndpointAddress)**.
4. After the fix, remote connection and control from the laptop's native client **succeeded**.

---

## 2. Multiple Streaming Servers (Several on One Machine) — Not Possible with the Native Client

### Measurements
- Successfully ran two streaming servers on one EC2 on different ports:
  - A: `port=49100`, media `47998-48002` → LISTEN ✅
  - B: `port=49101`, media `48003-48007` → LISTEN ✅
  - GPU: **6.3 GB / 18%** of the L40S's 46 GB — plenty of headroom (A 3.1 GB, B 0.9 GB).
- So the limit is **per instance, not per machine**. Adding servers adds connection slots.

### However — the native client cannot specify a port
- The native **Isaac Sim WebRTC Streaming Client** accepts **an IP only**; the port (49100) is fixed.
  There is **no** IP:port form, config file, or CLI option (confirmed in the official docs and in practice).
- → The second server (49101) is **unreachable from the native client**.
- Multi-instance/custom-port is a **browser web viewer only** path ("The web viewer supports multi-instance deployment with... custom ports").

### Conclusion
- Multiple streaming servers means **independent scenes anyway**, so it isn't "sharing the same twin", and the native client can't connect either → **unsuitable for the workshop**.

---

## 3. Many People Viewing the Same Twin → Nucleus Live (The Answer)

- WebRTC is pixel streaming (1:1). **Nucleus Live synchronizes scene state (USD)**, so multiple people share the same scene.
- **Already built and verified** in this project: [`../../workshop/en/02-collaboration-nucleus-live.md`](../../workshop/en/02-collaboration-nucleus-live.md), and the Live sharing principle in [`iot-dev-notes.md`](iot-dev-notes.md).
- Integration with the IoT twin: one instructor turns **Publish ON** → Kinesis data is written to the robots' USD `customData`/`transform` →
  **Nucleus Live propagates it to all clients automatically** → everyone sees the same robot motion and data.
- However, **UI panels (omni.ui) are not shared over Live** — only USD (positions/data). Everyone gets their own panel.
- Trade-off: **each participant needs a GPU client** (everyone renders locally). Cost goes up.

---

## 4. Maximizing GPU Instance Utilization (Cost Reduction) — Option Comparison

| Method | GPUs | Concurrent users | Shared twin | Setup effort |
|------|:---:|:---:|:---:|:---:|
| WebRTC streaming | 1 server per person | ❌ 1 per instance | ❌ | Low |
| **DCV virtual multi-session** | **Many on 1 machine** | ✅ | ❌ independent each | High |
| Nucleus Live | 1 GPU per person | ✅ | ✅ | Medium (already built) |
| DCV virtual + Nucleus Live | Many on 1 machine | ✅ | ✅ | High |

### DCV session types (measured)
- **Console session**: **only 1** per server. Direct GPU access. Marketplace AMI default (auto-created at boot).
- **Virtual session**: **multiple allowed** (Linux only). GPU acceleration requires the **`dcv-gl` package**, though.
- **Console and virtual cannot coexist.**
- Multiple virtual sessions under the same OS user are a no-go (home dir/D-Bus conflicts) → **a separate OS account per participant** is required.

### Deployed client (marketplace AMI) initial state — measured
- `nice-dcv-server` 2025.0 installed, configured with **1 console session** (`automatic-console-session`).
- **`dcv-gl` not installed** (not in the apt repos either; manual install from NICE), and no `Xdcv` visible.
- → Virtual multi-sessions + GPU acceleration need extra installation/configuration → **solved by the automation below (done)**.

### Automated DCV virtual multi-session setup (✅ done — CDK user-data)

The systemd oneshot service `dcv-multiuser` in `cdk-omniverse/lib/client-userdata.ts` performs the
following idempotently at boot. **Proven: 8 students on 1 L40S with GPU-accelerated Isaac Sim connected concurrently.**

1. **Install `nice-xdcv` + `nice-dcv-gl`** — the virtual-session X server (Xdcv; without it sessions die instantly) and
   the GPU offload runtime (dcvgladmin/dcvgldiag). Missing from the marketplace AMI, so installed from the official tgz.
2. **Disable console auto-creation** — `create-session = false` + close the existing console session.
   (Console and virtual cannot coexist.)
3. **Align the GPU Xorg to `DISPLAY=:0`** — DCV-GL offloads GL calls to "the 3D X server on :0".
   If gdm's GPU Xorg gets pushed to `:1`, or :0 is the virtual session itself, it **falls back to llvmpipe (software rendering)**
   and Isaac Sim won't run. Remove stale X sockets/locks, then poll and verify until `dcvgldiag` reports **"No problem found"**.
4. **Create student1..N accounts + one virtual session per account** — multiple sessions under one OS user cause home/D-Bus
   conflicts → **separate the accounts**. The shared password is `StudentPassword` (if empty, a random one is generated and logged).
5. **Install a deb browser (epiphany) + place the `launch-isaac` launcher** — the AMI's snap firefox/chromium can't run in
   virtual sessions due to mount-namespace conflicts. Navigator opens via `epiphany`.
   `launch-isaac` separates the Isaac Sim HTTP port by uid (student1→8001 … 8→8008) to prevent
   `address already in use` during concurrent launches.
6. (Optional) Each session joins **Nucleus Live** → multiple people on 1 GPU sharing **the same twin**.

> For detailed parameters and deploy commands, see the "multi-user access" section of [`../../cdk-omniverse/README.en.md`](../../cdk-omniverse/README.en.md).

---

## 5. Real Deployment Reference Values (2026-07, ap-northeast-2)

> Actual IPs and passwords differ per deployment, so they are not kept in the repo. Only the format is recorded.

| Item | Value (format) |
|------|-----|
| Client 1 DCV | `https://<client1-public-IP>:8443` |
| Client 2 (streaming host) DCV | `https://<client2-public-IP>:8443` |
| Nucleus Navigator | `http://<Nucleus-IP>:8080` |
| Nucleus private IP (Isaac connection) | `<Nucleus-private-IP>` (see CDK Outputs) |
| DCV login | `ubuntu` / (set at deploy time) |
| Client SG | Admin (DCV/SSH)=allowCidr, viewer (WebRTC 49100, media 47998-48010, 8210)=viewerCidr |

### CDK security (commit a1c4504)
- `allowCidr` is **required** (deploys with it unset or 0.0.0.0/0 are blocked) — admin access (DCV/SSH).
- `viewerCidr` — viewer (WebRTC) access range. Falls back to allowCidr if unset; 0.0.0.0/0 forbidden.
- Media UDP is opened narrowly to the range **47998-48010** (matching 5.1's min/maxHostPort).

### Deployment issues encountered (resolved)
- CDK deploy hung on a Node SDK socket on this EC2 (during the asset publish step). The aws CLI (Python) worked fine.
  → Worked around by feeding the synthesized template directly to the aws CLI with `create-stack` — succeeded.
- Region pitfall: the shell's `AWS_REGION=us-east-1` overrode CDK's default (ap-northeast-2), causing AMI not found.
  → Set `AWS_REGION=ap-northeast-2` explicitly when deploying.

---

> ⚠️ Security: the NGC API key and DCV password have appeared in plaintext on command lines during deployment → rotate the key and change the password after the workshop.
