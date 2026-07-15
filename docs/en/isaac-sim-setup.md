> 🇰🇷 [한국어](../isaac-sim-셋업.md) | 🇺🇸 English

# Factory/Warehouse Digital Twin Build Guide (NVIDIA Isaac Sim)

> A walkthrough of connecting remotely (via DCV) to an Ubuntu + NVIDIA GPU server and
> opening a digital twin scene in NVIDIA Isaac Sim.
> Written so that anyone can reach the same point using this document alone, without Claude.

---

## 0. Environment This Guide Was Verified On

| Item | Value |
|------|-----|
| OS | Ubuntu (Linux, GNOME, X11 session) |
| GPU | NVIDIA L40S |
| Driver | 580.126.09 (requirement: `>= 550.54.15`) |
| Isaac Sim | 5.1.0, installed at `/opt/IsaacSim` |
| Remote access | NICE DCV (virtual display `DISPLAY=:1`) |
| Local PC | macOS (DCV native client) |

> ⚠️ Isaac Sim requires an RTX-capable NVIDIA GPU.

---

## 1. Environment Checks (Optional but Recommended)

### 1-1. Verify GPU / driver
```bash
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader
```
You're good if it shows an RTX-class GPU and driver `>= 550`.

### 1-2. Verify display / session
```bash
echo "DISPLAY=$DISPLAY  SESSION=$XDG_SESSION_TYPE"
```
On a DCV desktop this is usually `DISPLAY=:1`, `SESSION=x11`.

### 1-3. Verify Isaac Sim install location
```bash
ls /opt/IsaacSim/isaac-sim.sh
cat /opt/IsaacSim/VERSION
```

---

## 2. (Reference) Korean Input — When Hangul Jamo Come Apart in DCV

If Korean input over macOS → DCV splits into separate jamo like `ㅇㅏㄴ`, make sure **only one side composes** the characters.

- **Recommended**: keep the local Mac input source on **English (ABC)** and let **the server's ibus do the composition**
  ```bash
  ibus engine hangul          # switch the server to Hangul composition mode
  ibus engine xkb:us::eng     # switch back to English
  ibus engine                 # check the current engine
  ```
- Server Korean/English toggle shortcut: `Super (Windows key) + Space`

---

## 3. Isaac Sim Launch Scripts Overview

Key launchers inside `/opt/IsaacSim/`:

| Script | Purpose |
|----------|------|
| `isaac-sim.sh` | **GUI mode** — runs as a window on the desktop (DCV) |
| `isaac-sim.selector.sh` | Pick an app/GPU, then launch |
| `isaac-sim.streaming.sh` | **Streaming mode** — sends GPU rendering over WebRTC (for server operation) |
| `isaac-sim.compatibility_check.sh` | Checks GPU/driver/Vulkan compatibility |

---

## 4. (Optional) Compatibility Check

```bash
cd /opt/IsaacSim
./isaac-sim.compatibility_check.sh
```
- A GUI window opens and runs the checks. You're good if the log shows **Driver / Graphics API: Vulkan / GPU** recognized correctly.
- The first run may be slow due to shader compilation. Close the window when done.

---

## 5. Launching the Isaac Sim GUI

With the DCV desktop up:

### 5-1. Simple foreground launch
```bash
cd /opt/IsaacSim
DISPLAY=:1 ./isaac-sim.sh
```

### 5-2. Background launch + log tailing (when you want to keep using the terminal)
```bash
cd /opt/IsaacSim
DISPLAY=:1 nohup ./isaac-sim.sh > /tmp/isaacsim_launch.log 2>&1 &
```

Checking startup progress:
```bash
# Extension loading progress logs (extension.toml warnings are safe to ignore)
tail -f /tmp/isaacsim_launch.log | grep -v "extension.toml.*doesn't exist"

# Startup is complete once "app ready" appears
grep "app ready" /tmp/isaacsim_launch.log

# Check process/memory
ps aux | grep 'kit/kit.*isaacsim.exp.full' | grep -v grep
```

> ⏱️ **The first launch takes 4–8 minutes due to shader compilation** (about 267 seconds in the verified environment).
> A black window is normal; it's ready once `app ready` appears in the log.

### 5-3. Shutting down
```bash
pkill -f 'isaacsim.exp.full'
```

---

## 6. Digital Twin Sample Assets (Official NVIDIA, Free)

Isaac Sim 5.1 assets live on an NVIDIA S3 server.
Asset root:
```
https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1
```

### 6-1. Listing the available warehouse/factory environments
```bash
BASE="https://omniverse-content-production.s3-us-west-2.amazonaws.com"
curl -s "$BASE/?list-type=2&prefix=Assets/Isaac/5.1/Isaac/Environments/&delimiter=/" \
  | grep -oE '<Prefix>[^<]+</Prefix>' | sed 's/<[^>]*>//g'
```

### 6-2. Recommended environment assets

| Asset URL | Measured size | Description |
|------|------|------|
| `Environments/Digital_Twin_Warehouse/small_warehouse_digital_twin.usd` | Small | Purpose-built for digital twins but **too small** |
| `Environments/Simple_Warehouse/full_warehouse.usd` | **27.8 × 45 m** | ⭐ Large warehouse packed with shelves and boxes (recommended) |
| `Environments/Simple_Warehouse/warehouse_with_forklifts.usd` | - | Includes forklifts |
| `NVIDIA/Assets/ArchVis/Industrial/Stages/IsaacWarehouse.usd` | **46.6 × 73 m** | Largest industrial stage (rather empty, units = cm) |

> **Size comparison matters**: actual dimensions vary wildly between environments. You can measure before opening with the command below.
> ```bash
> EXT=/opt/IsaacSim/extscache/omni.usd.libs-1.0.1+69cbf6ad.lx64.r.cp311
> PY=/opt/IsaacSim/kit/python/bin/python3
> curl -s "<environment USD URL>" -o /tmp/env.usd
> LD_LIBRARY_PATH="$EXT/bin:/opt/IsaacSim/kit/python/lib" PYTHONPATH="$EXT" "$PY" -c "
> from pxr import Usd, UsdGeom
> s=Usd.Stage.Open('/tmp/env.usd', Usd.Stage.LoadAll); dp=s.GetDefaultPrim()
> mpu=UsdGeom.GetStageMetersPerUnit(s)
> bb=UsdGeom.BBoxCache(Usd.TimeCode.Default(),[UsdGeom.Tokens.default_])
> sz=bb.ComputeWorldBound(dp).ComputeAlignedRange().GetSize()
> print('Size (m): %.1f x %.1f x %.1f | units:%.3f'%(sz[0]*mpu,sz[1]*mpu,sz[2]*mpu,mpu))"
> ```
> (Note: files with many https sub-references may report broken values — check in the GUI in that case.)

The large warehouse URL this guide ultimately used:
```
https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1/Isaac/Environments/Simple_Warehouse/full_warehouse.usd
```

> 💡 This USD references materials, textures, and boxes (3,138 of them!) on the same server **via relative paths**.
> Downloading only the main file locally breaks every reference (gray, empty scene), so **always open it directly by URL**.

> ⚠️ **Watch out for duplicate URL pasting in File→Open**: if leftover text remains in the input field and the URL gets
> concatenated two or three times (`...full_warehouse.usdhttps:/...`), you get a "not found" error.
> Before typing, **clear the field completely with `Ctrl+A` → `Delete` and paste the URL exactly once**.

---

## 7. Opening the Scene (Inside the Isaac Sim GUI)

### Method A) Open the URL directly via File → Open (recommended)
1. Top menu **`File` → `Open`**
2. Paste the full URL from 6-2 into the **path input field** of the file dialog
3. **`Open`** → loading plus shader compilation takes 1–3 minutes (gray at first, textures fill in gradually)

### Method B) Built-in asset browser
- In the **`Environments`** or **`Isaac Sim Assets`** panel,
  navigate to `Environments → Digital_Twin_Warehouse` and double-click/drag

---

## 8. Viewport Navigation & Rendering Basics

### Camera controls
| Action | Input |
|------|------|
| Orbit | `Alt + left-click drag` (or right-click drag) |
| Pan | `Middle-button drag` |
| Zoom | `Mouse wheel` / `Alt + right-click drag` |
| Focus on selected object | Select object, then `F` |

### Render modes (visual quality)
- Renderer menu at the top of the viewport:
  - **`RTX - Real-Time`**: real-time (default)
  - **`RTX - Interactive (Path Tracing)`**: high quality, noise converges over time

### Stage panel
- Inspect the scene structure (walls/floor/shelves/lights) in the **Stage** tree on the right.

---

## 8.5 Placing Equipment (Props) — Hands-On + Pitfalls (Core of Stage A)

The process of adding pallets, boxes, conveyors, forklifts, etc. to the warehouse scene. Problems actually
encountered and their fixes are recorded in order, so this is **reproducible as-is without AI**.

### (1) Placeable equipment assets (official NVIDIA, free)

Listing:
```bash
BASE="https://omniverse-content-production.s3-us-west-2.amazonaws.com"
# Props category
curl -s "$BASE/?list-type=2&prefix=Assets/Isaac/5.1/Isaac/Props/&delimiter=/" \
  | grep -oE '<Prefix>[^<]+</Prefix>' | sed 's/<[^>]*>//g'
# .usd files in a specific category (e.g. Pallet)
curl -s "$BASE/?list-type=2&prefix=Assets/Isaac/5.1/Isaac/Props/Pallet/&delimiter=/" \
  | grep -oE '<Key>[^<]+</Key>' | sed 's/<[^>]*>//g'
```

Commonly used equipment (paths under `.../Isaac/5.1/Isaac/Props/`):

| Asset | Path |
|------|------|
| Pallet | `Pallet/pallet.usd` |
| KLT bin (box) | `KLT_Bin/small_KLT.usd` |
| Conveyor belt | `Conveyors/ConveyorBelt_A01.usd` |
| Forklift | `Forklift/forklift.usd` |

### (2) Adding equipment — Add Reference

- Top menu **`File` → `Add Reference`** → paste the asset URL into the path field → `Open`
- Adding as a **Reference** keeps things lightweight since it references rather than copies the original, and upstream updates are picked up automatically.

### (3) ⚠️ Pitfall 1 — Equipment blows up 100x (most important)

**Symptom:** you add a pallet and it's huge enough to cover the entire warehouse.

**Cause:** this warehouse's top-level prim `Lab` (the defaultPrim) was authored with an internal
**scale = (100,100,100)** (the original was built in cm and multiplied by 100 to match meters). But `Add Reference`
places the asset **as a child of the currently selected prim**, so equipment placed under `Lab` inherits that 100x.
→ A 1.2 m pallet becomes 120 m.

**How to check the parent scale** (command line, optional):
```bash
# Download the warehouse USD and inspect the Lab prim's xformOps
curl -s "<warehouse USD URL>" -o /tmp/wh.usd
EXT=/opt/IsaacSim/extscache/omni.usd.libs-1.0.1+69cbf6ad.lx64.r.cp311
PY=/opt/IsaacSim/kit/python/bin/python3
LD_LIBRARY_PATH="$EXT/bin:/opt/IsaacSim/kit/python/lib" PYTHONPATH="$EXT" "$PY" -c "
from pxr import Usd, UsdGeom
s=Usd.Stage.Open('/tmp/wh.usd'); dp=s.GetDefaultPrim()
for op in UsdGeom.Xformable(dp).GetOrderedXformOps(): print(op.GetOpName(), op.Get())"
# -> if it prints xformOp:scale (100, 100, 100), child equipment will balloon 100x
```

**Fix (either one):**
- **(Recommended) Cancel out the parent's 100x:** set the equipment Xform's **Scale to `0.01, 0.01, 0.01`** → 100 × 0.01 = 1x (normal).
- **(Alternative) Place outside Lab:** move the equipment out as a sibling of `Lab` (`/<equipment-name>`) with Scale `1,1,1`. However, Stage
  drag-and-drop can be unreliable over DCV, and the pseudo-root `/` is not shown as a row in the Stage panel.

### (4) ⚠️ Pitfall 2 — Can't type property values (lock / IME)

**Symptom:** you can't type numbers into the Scale field; only mouse dragging works. Unlocking sometimes helps.

**Cause A — Lock:** if the **padlock icon** next to a property is locked, it can't be edited → **unlock** it.

**Cause B — Korean IME conflict (the key issue in this environment):** on Mac → DCV, if the input source is in Hangul
composition mode, keystrokes get swallowed by the IME and never reach the Kit input field. "Sometimes it works" reflects
whether English/Korean mode was active at the time.
→ **Lock the Mac input source to English (ABC) before typing** (`Caps Lock` or `Ctrl+Space`).

**How to enter values:** **double-click** the number field → edit mode (blue highlight) → type the number → `Enter`. X/Y/Z separately.

### (5) ⚠️ Pitfall 3 — Equipment shows up gray (no textures)

**Symptom:** the pallet is flat gray, and stays that way after loading finishes.

**Cause:** some Isaac prop assets ship only an OmniPBR material with **no textures connected**
(the texture files exist on the server, but the USD has `diffuse_texture = None`).

**How to check:**
```bash
EXT=/opt/IsaacSim/extscache/omni.usd.libs-1.0.1+69cbf6ad.lx64.r.cp311
PY=/opt/IsaacSim/kit/python/bin/python3
curl -s "<pallet USD URL>" -o /tmp/pallet.usd
LD_LIBRARY_PATH="$EXT/bin:/opt/IsaacSim/kit/python/lib" PYTHONPATH="$EXT" "$PY" -c "
from pxr import Usd, UsdShade
s=Usd.Stage.Open('/tmp/pallet.usd')
for p in s.Traverse():
  if p.GetTypeName()=='Shader':
    sh=UsdShade.Shader(p)
    print('diffuse:', sh.GetInput('diffuse_texture').Get())  # None means not connected"
# List the texture files on the server
curl -s "https://omniverse-content-production.s3-us-west-2.amazonaws.com/?list-type=2&prefix=Assets/Isaac/5.1/Isaac/Props/Pallet/Materials/Textures/&delimiter=/" \
  | grep -oE '<Key>[^<]+</Key>' | sed 's/<[^>]*>//g'
```

**Fix (either one):**
- **(Simple) Color only, in the GUI:** select the `/Root/Looks/OmniPBR` material → in Property, set the Albedo Color to a wood tone.
- **(Recommended) Wrapper USD that fixes textures + scale in one shot:** see (6) below.

### (6) ✅ Wrapper USD pattern — solve size and textures at the file level in one go

The most reliable approach when GUI input is flaky. Create a small `.usda` file that references the original with
**scale 0.01 + texture connections** baked in, and add that to the scene instead.

`~/digital_twin/assets/pallet_textured.usda`:
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
    # Apply 0.01 so it comes out normal-sized even under Lab (100x). (Use 1.0 if placed outside Lab.)
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
> Replace the `...` in the texture URLs with the asset root (`https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1/Isaac/Props`).

Verification (texture connection only — https references get their final check in the GUI):
```bash
EXT=/opt/IsaacSim/extscache/omni.usd.libs-1.0.1+69cbf6ad.lx64.r.cp311
PY=/opt/IsaacSim/kit/python/bin/python3
LD_LIBRARY_PATH="$EXT/bin:/opt/IsaacSim/kit/python/lib" PYTHONPATH="$EXT" "$PY" -c "
from pxr import Usd, UsdShade
s=Usd.Stage.Open('/home/ubuntu/digital_twin/assets/pallet_textured.usda')
sh=UsdShade.Shader(s.GetPrimAtPath('/Pallet_Textured/Looks/OmniPBR/Shader'))
print('diffuse:', sh.GetInput('diffuse_texture').Get())"
```
> Note: command-line pxr cannot resolve `https://` references, so the bbox comes out broken. That's expected;
> do the final size/texture check in the Isaac Sim GUI (Isaac handles https via the omni client).

Usage: delete the existing gray pallet, then use **`File → Add Reference`** to add
`/home/ubuntu/digital_twin/assets/pallet_textured.usda` — it appears at normal size with the wood texture.

---

## 9. Roadmap for Next Steps (A → B → C)

- **A. Visualization/layout** (current stage)
  - Open the warehouse scene → place equipment (pallets/shelves/forklifts/robots) → lighting, materials, RTX rendering
- **B. Behavior simulation**
  - Apply PhysX physics, robot/conveyor behavior, sensors — all within Isaac Sim
- **C. Live data integration**
  - Connect real sensor/PLC/IoT data (extensions/connectors/OpenUSD live sessions) → a living twin

---

## Appendix. Common Issues

| Symptom | Cause/Fix |
|------|-----------|
| Many `extension.toml doesn't exist` warnings in the log | **Normal**. Safe to ignore |
| Window is black and seems frozen | First-time shader compilation. Wait while checking with `grep "app ready"` |
| `Could not import system rclpy` | Uses the bundled rclpy when ROS2 isn't installed. No impact on twin work |
| `PCIe link width ... don't match` warning | Performance warning. No functional impact |
| Everything shows gray without textures | (1) USD downloaded as a single local file breaks references → open by URL, (2) the asset itself has no textures connected → 8.5 (5)(6), or (3) **the robot is dark by design** (below) |
| Robot looks flat gray/black | **May be normal.** Many robots such as Nova Carter have matte black / dark gray bodies by design. If wheels/sensors show detail (black rubber/metal), textures are fine. Don't expect flashy textures |
| Added equipment is 100x too big | Inherited scale=100 from the parent prim (Lab). Set equipment Scale to 0.01 → 8.5 (3) |
| Can't type property values (Scale etc.) | Unlock the padlock + lock the Mac input source to English (IME conflict) → 8.5 (4) |
| Can't move equipment out of Lab / can't see `/` | The pseudo-root isn't shown in Stage. The 0.01 cancel-out is easier → 8.5 (3) |
| Korean input splits into jamo | See section 2 (Mac locked to English + server-side ibus composition) |
