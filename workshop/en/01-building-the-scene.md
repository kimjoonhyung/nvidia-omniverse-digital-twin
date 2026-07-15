> 🇰🇷 [한국어](../01-씬-만들기.md) | 🇺🇸 English

# 01. Building the Scene — Open the Warehouse + Place Robots and Equipment

> **← Previous:** [00. Getting Started](00-getting-started.md) &nbsp;|&nbsp; **Next →** [02. Collaboration](02-collaboration-nucleus-live.md)
>
> Open the warehouse → place robots and equipment yourself → move things around freely.
> **No coding or USD knowledge required.** Everything is done with the mouse and copy-pasted URLs.

**Prerequisite:** You have completed [00. Getting Started](00-getting-started.md) and the Isaac Sim window is open.
Work through this by copy-pasting the URLs listed below.

---

## Asset URL Catalog (Copy and Paste)

Common prefix for every URL:
```
https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1/Isaac
```

### Warehouse (the base of the scene)
| Name | Size | URL |
|------|------|-----|
| Full Warehouse | 27.8 × 45m | `.../Environments/Simple_Warehouse/full_warehouse.usd` |

### Robots (3 types)
| Name | Type | Size | URL |
|------|------|------|-----|
| Nova Carter | Warehouse AMR (wheeled) | ~0.7m | `.../Robots/NVIDIA/NovaCarter/nova_carter.usd` |
| Franka Panda | Robot arm (7-axis) | ~0.9m | `.../Robots/FrankaRobotics/FrankaPanda/franka.usd` |
| Digit | Humanoid | 1.68m | `.../Robots/Agility/Digit/digit_v4.usd` |

> ⚠️ **Why iw_hub is excluded**: iw_hub uses UDIM textures (`STL_Robot_*.<UDIM>.png`),
> and the Collect tool cannot resolve the UDIM token, so the textures go missing (gray + errors in the self-contained package).
> It was excluded from this offline, self-contained workshop. For UDIM details, see the Collect section of [`../../docs/en/nucleus-manual-deploy.md`](../../docs/en/nucleus-manual-deploy.md).

### Equipment/Props (4 types)
| Name | Size | URL |
|------|------|-----|
| Pallet | 1.2 × 0.8m | `.../Props/Pallet/pallet.usd` |
| KLT bin | Small | `.../Props/KLT_Bin/small_KLT.usd` |
| Conveyor belt | ~2m | `.../Props/Conveyors/ConveyorBelt_A01.usd` |
| Forklift | 1.2 × 2.3m | `.../Props/Forklift/forklift.usd` |

> Example of a full URL (Nova Carter):
> `https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1/Isaac/Robots/NVIDIA/NovaCarter/nova_carter.usd`
> All URLs are verified (HTTP 200). This warehouse uses meter units and normal scale, so **assets come in at the correct size** with no adjustments.

---

## Hands-on

### Step 1. Open the Warehouse
1. Top menu **`File` → `Open`**
2. **Clear the path field completely with `Ctrl+A` → `Delete`** (important!)
3. Paste the Full Warehouse URL **once** and click `Open`
4. Loading takes 1–3 minutes (there are over 3,000 boxes). The scene starts gray and gradually fills in.

> ⚠️ If the URL gets pasted two or three times back to back (`...usd https:/...usd`), you get a "not found" error. Always clear the field first.

### Step 2. Look Around (Camera)
| Action | Input |
|------|------|
| Orbit | `Alt + left-click drag` |
| Pan | `Middle-button drag` |
| Zoom | `Mouse wheel` |
| Focus on selection | Select an object, then press `F` |
| WASD fly | Hold right-click and use `WASD`. **To slow down, scroll the mouse wheel down while holding** |

### Step 3. Add a Robot
1. **`File` → `Add Reference`**
2. Clear the field → paste a robot URL (e.g. Nova Carter) → `Open`
3. The robot appears at the origin (floor, 0,0,0). If you can't see it, select it in the Stage panel and press `F`.
4. If you add all four they will overlap in one spot — spread them out in Step 4 below.

### Step 4. Move and Rotate (Gizmos)
- With an object selected:
  - **`W`** = translate
  - **`E`** = rotate
  - **`R`** = scale  ← usually no need to touch this
- Drag the on-screen arrows (gizmo) to move things. Easier than typing numbers.

### Step 5. Place Equipment and Dress the Scene
- Use `Add Reference` the same way as Step 3 for the pallet, bin, conveyor, and forklift.
- Build **your own logistics layout** — for example, place a pallet next to a robot.

### Step 6. Try Different Rendering Quality
- Renderer menu at the top of the viewport:
  - **`RTX - Real-Time`**: real-time (default)
  - **`RTX - Interactive (Path Tracing)`**: high quality. Noise gradually fades and the image becomes photorealistic.

At this point you have **your own warehouse scene**. Next, let's edit the same scene together with others.
→ **[02. Collaboration — Nucleus Live](02-collaboration-nucleus-live.md)**

---

## FAQ

| Symptom | Answer |
|------|-----|
| The robot looks flat black/gray | **Normal.** Nova Carter and others are dark by design. If you can see detail on the wheels and sensors, you're fine |
| Can't type numbers | (1) **Unlock the padlock** next to the property, (2) **set the keyboard input method to English (ABC)** — Korean mode blocks input |
| Added a robot but can't see it | It's overlapping something at the same spot. Select it in the Stage panel, press `F` to focus, then `W` to move it |
| Camera is too fast | While flying with right-click held, **scroll the mouse wheel down** to reduce speed |
| URL "not found" | The URL got duplicated in the field. Clear it with `Ctrl+A` → `Delete` and paste once |
| Screen frozen gray | Textures/shaders are loading. Wait 30 seconds to 1 minute |

---

## Notes

- This workshop **does not need a wrapper USD.** Since full_warehouse uses meter units at scale 1.0,
  adding the original URL via `Add Reference` brings it in at the correct size.
  (The small warehouse `small_warehouse_digital_twin` has a 100x parent-scale trap — don't use it for the workshop.)
- For the technical background and pitfall details (100x scale, unlinked textures, wrapper USD pattern), see
  [`../../docs/en/isaac-sim-setup.md`](../../docs/en/isaac-sim-setup.md).

---

**Next →** [02. Collaboration — Nucleus Live](02-collaboration-nucleus-live.md)
