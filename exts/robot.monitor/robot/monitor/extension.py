"""
Robot Telemetry Monitor — Isaac Sim(omni.ui) 확장.

두 가지 모드:
  - Publish (발행): Kinesis 에서 받은 텔레메트리를 로봇 USD 프림 customData 에 기록.
    Nucleus Live 세션이면 모든 클라이언트에 자동 전파. (워크숍에서 강사 1명만 ON)
  - Display (표시): USD 프림 customData 에서 값을 읽어 차트/수치로 표시. (모두 ON)
    Publish 가 켜져 있으면 자기 데이터를, 아니면 Live 로 받은 남의 데이터를 표시.

클릭 인터랙션: 뷰포트에서 로봇 프림을 선택하면 해당 로봇 대시보드로 자동 전환.

UI/USD 접근은 omni.kit.app update 이벤트(메인 스레드)에서 → 스레드 안전.

(English)
Robot Telemetry Monitor — Isaac Sim (omni.ui) extension.

Two modes:
  - Publish: writes telemetry received from Kinesis into the robot USD prim's customData.
    In a Nucleus Live session this propagates automatically to all clients. (Only the instructor
    turns this ON in the workshop.)
  - Display: reads values from the USD prim customData and shows them as charts/numbers. (Everyone ON.)
    Shows your own data when Publish is on, otherwise data received from others via Live.

Click interaction: selecting a robot prim in the viewport switches to that robot's dashboard.

UI/USD access happens in the omni.kit.app update event (main thread) → thread safe.
"""
import omni.ext
import omni.ui as ui
import omni.kit.app
import omni.usd
import carb

from .kinesis_consumer import TelemetryStore, KinesisConsumer
from . import usd_bridge

BATTERY_WARN = 30.0
TEMP_WARN = 70.0
OK_COLOR = 0xFF44DD44
WARN_COLOR = 0xFF4444FF
NEUTRAL = 0xFFCCCCCC

SERIES_KEYS = ("battery_pct", "motor_temp_c", "speed_mps")

# 로봇 타입별 바닥 Z 오프셋. 원점 위치가 타입마다 다르다:
#  - AMR(바퀴)/로봇팔: 원점이 바닥 → 0.0
#  - 휴머노이드(Digit): 원점이 토르소 → 발이 바닥에 닿으려면 Z≈1.1341 (화면 측정)
# Floor Z offset per robot type. Origin position differs by type:
#  - AMR (wheeled) / robot arm: origin at the floor → 0.0
#  - Humanoid (Digit): origin at the torso → feet touch the floor at Z≈1.1341 (measured on screen)
FLOOR_Z_BY_TYPE = {"amr": 0.0, "arm": 0.0, "humanoid": 1.1341344687369161}
DEFAULT_FLOOR_Z = 0.0


def floor_z_for(rec):
    return FLOOR_Z_BY_TYPE.get(rec.get("robot_type"), DEFAULT_FLOOR_Z)


class RobotMonitorExtension(omni.ext.IExt):
    def on_startup(self, ext_id):
        self._store = TelemetryStore()          # 발행 모드일 때 Kinesis 시계열 / Kinesis time series in publish mode
        self._consumer = KinesisConsumer(self._store)
        self._publish = True                     # 발행 모드 토글 (PoC: 기본 ON) / publish mode toggle (PoC: ON by default)
        self._consumer.start()                   # 시작 시 바로 소비 / start consuming immediately on startup
        self._last_ts = {}                        # robot_id → 마지막 처리한 ts (중복 방지) / last processed ts (dedup)
        self._move_robots = True                  # 텔레메트리 position 으로 로봇 이동 / move robots from telemetry position
        self._motion = {}                         # robot_id → {cur:[x,y,h], tgt:[x,y,h]} 보간 상태 / interpolation state
        self._display_series = {}                # 표시 모드 시계열(USD에서 읽은 값 누적) / display-mode series (values read from USD)

        self._current_rid = None
        self._prim_by_rid = {}                   # robot_id → prim path
        self._combo_ids = []
        self._updating_combo = False             # 콤보 재구성 중 _on_robot_changed 콜백 무시용 / ignore _on_robot_changed while rebuilding combo
        self._labels = {}
        self._plots = {}
        self._frame_count = 0
        self._scene_open_attempted = False        # 자동 오픈 1회만 시도 / attempt auto-open only once

        self._window = ui.Window("Robot Telemetry Monitor", width=440, height=600)
        self._build_ui()

        # 자동 오픈은 기동 직후가 아니라 update 루프에서 지연 실행(아래 _on_update).
        # (startup 즉시 열면 omni client/네트워크 준비 전이라 S3 reference 로딩 실패)
        # Auto-open runs deferred in the update loop (_on_update below), not right at startup.
        # (Opening immediately at startup fails to load S3 references because the omni client/network is not ready yet.)

        self._sub = (
            omni.kit.app.get_app().get_update_event_stream()
            .create_subscription_to_pop(self._on_update, name="robot_monitor_update")
        )
        # 뷰포트 선택(클릭) 이벤트 구독 → 로봇 클릭 시 대시보드 전환
        # Subscribe to viewport selection (click) events → switch dashboard when a robot is clicked
        self._sel_sub = (
            omni.usd.get_context().get_stage_event_stream()
            .create_subscription_to_pop(self._on_stage_event, name="robot_monitor_sel")
        )

    def on_shutdown(self):
        if self._consumer:
            self._consumer.stop()
        self._sub = None
        self._sel_sub = None
        self._window = None

    # ----------------------------------------------------------------
    def _build_ui(self):
        with self._window.frame:
            with ui.VStack(spacing=6, height=0):
                with ui.HStack(height=24):
                    ui.Label("Mode:", width=50)
                    self._pub_cb = ui.CheckBox(width=20)
                    self._pub_cb.model.set_value(True)  # ON by default for PoC
                    self._pub_cb.model.add_value_changed_fn(self._on_publish_toggle)
                    ui.Label("Publish (Kinesis->USD, instructor)", style={"color": NEUTRAL})
                with ui.HStack(height=24):
                    ui.Label("Move:", width=50)
                    self._move_cb = ui.CheckBox(width=20)
                    self._move_cb.model.set_value(True)
                    self._move_cb.model.add_value_changed_fn(
                        lambda m: setattr(self, "_move_robots", m.get_value_as_bool()))
                    ui.Label("Move robots from data (position->transform)", style={"color": NEUTRAL})
                with ui.HStack(height=22):
                    ui.Label("Stream:", width=60)
                    self._status_label = ui.Label("display mode", style={"color": NEUTRAL})
                with ui.HStack(height=24):
                    ui.Label("Robot:", width=60)
                    self._robot_combo = ui.ComboBox(0)
                    self._robot_combo.model.add_item_changed_fn(self._on_robot_changed)

                ui.Separator(height=4)
                self._labels["status"] = self._kv_row("Status", "-")
                self._labels["battery_pct"] = self._kv_row("Battery %", "-")
                self._labels["motor_temp_c"] = self._kv_row("Motor Temp °C", "-")
                self._labels["speed_mps"] = self._kv_row("Speed m/s", "-")
                self._labels["position"] = self._kv_row("Position", "-")
                self._labels["odometer_m"] = self._kv_row("Odometer m", "-")
                self._labels["error_count"] = self._kv_row("Errors", "-")

                ui.Separator(height=4)
                ui.Label("Battery % (0-100)", height=16)
                self._plots["battery_pct"] = ui.Plot(ui.Type.LINE, 0.0, 100.0, height=80,
                    style={"color": OK_COLOR, "background_color": 0xFF202020})
                ui.Label("Motor Temp °C (20-90)", height=16)
                self._plots["motor_temp_c"] = ui.Plot(ui.Type.LINE, 20.0, 90.0, height=80,
                    style={"color": 0xFF55AAFF, "background_color": 0xFF202020})
                ui.Label("Speed m/s (0-2)", height=16)
                self._plots["speed_mps"] = ui.Plot(ui.Type.LINE, 0.0, 2.0, height=80,
                    style={"color": 0xFFFFAA55, "background_color": 0xFF202020})

    def _kv_row(self, key, val):
        with ui.HStack(height=22):
            ui.Label(key, width=130)
            lbl = ui.Label(val, style={"color": NEUTRAL})
        return lbl

    # ----------------------------------------------------------------
    def _on_publish_toggle(self, model):
        self._publish = model.get_value_as_bool()
        if self._publish:
            self._consumer.start()
        else:
            self._consumer.stop()

    def _on_robot_changed(self, model, item):
        # 콤보를 코드로 재구성하는 중엔 사용자 선택이 아니므로 무시(선택 튐 방지).
        # While the combo is being rebuilt programmatically this is not a user selection, so ignore it (prevents selection jumps).
        if self._updating_combo:
            return
        ids = self._combo_ids
        idx = model.get_item_value_model().as_int
        if 0 <= idx < len(ids):
            self._current_rid = ids[idx]

    def _on_stage_event(self, e):
        # 선택 변경 이벤트 → 선택된 프림이 로봇이면 대시보드 전환
        # Selection-changed event → if the selected prim is a robot, switch the dashboard
        if e.type != int(omni.usd.StageEventType.SELECTION_CHANGED):
            return
        ctx = omni.usd.get_context()
        sel = ctx.get_selection().get_selected_prim_paths()
        if not sel:
            return
        sel_path = sel[0]
        # 선택 경로가 어떤 로봇 프림(또는 그 하위)인지 매칭
        # Match the selected path against each robot prim (or its descendants)
        for rid, ppath in self._prim_by_rid.items():
            if sel_path == ppath or sel_path.startswith(ppath + "/"):
                self._current_rid = rid
                self._sync_combo_selection(rid)
                break

    def _sync_combo_selection(self, rid):
        if rid in self._combo_ids:
            idx = self._combo_ids.index(rid)
            self._robot_combo.model.get_item_value_model().set_value(idx)

    # ----------------------------------------------------------------
    def _on_update(self, e):
        stage = usd_bridge.get_stage()
        if stage is None:
            return

        # 기동 후 ~약 3초(180프레임) 뒤 1회만 씬 자동 오픈 (네트워크/클라이언트 준비 후)
        # Auto-open the scene once ~3s (180 frames) after startup (once network/client are ready)
        self._frame_count += 1
        if not self._scene_open_attempted and self._frame_count > 180:
            self._scene_open_attempted = True
            self._maybe_open_test_scene()

        # 1) 발행 모드: Kinesis 시계열 최신값을 USD 프림에 기록
        # 1) Publish mode: write the latest Kinesis time-series values into the USD prims
        if self._publish:
            st = self._consumer.status
            self._status_label.text = st if not self._consumer.last_error else f"{st}: {self._consumer.last_error}"
            self._status_label.style = {"color": OK_COLOR if st == "running" else WARN_COLOR}
            for rid in self._store.robot_ids():
                lt = self._store.latest(rid)
                if not lt:
                    continue
                ppath = self._resolve_prim(stage, rid)
                if ppath:
                    usd_bridge.write_telemetry(stage, ppath, lt)
        else:
            self._status_label.text = "display mode (reading USD)"
            self._status_label.style = {"color": NEUTRAL}

        # 1-b) 부드러운 이동: 모든 로봇에 대해 새 목표(position/heading)가 오면
        #      이전→목표 보간을 매 프레임 적용. (발행/표시 모두 USD 의 값을 목표로 사용)
        # 1-b) Smooth movement: whenever a new target (position/heading) arrives for any robot,
        #      apply previous→target interpolation every frame. (Both publish and display use USD values as targets.)
        if self._move_robots:
            self._update_motion(stage)

        # 2) 표시: USD 에서 telemetry 있는 프림 수집 → 로봇 목록/시계열 갱신
        #    (UI 부하 줄이려 몇 프레임마다 전체 스캔)
        # 2) Display: collect prims with telemetry from USD → refresh robot list/series
        #    (full scan only every few frames to reduce UI load)
        if self._frame_count % 30 == 0 or not self._prim_by_rid:
            mapping = usd_bridge.list_telemetry_prims(stage)  # path → rid
            self._prim_by_rid = {rid: path for path, rid in mapping.items()}

        ids = sorted(self._prim_by_rid.keys())
        if not ids:
            return
        self._refresh_robot_list(ids)
        if self._current_rid not in ids:
            self._current_rid = ids[0]
        rid = self._current_rid
        lt = usd_bridge.read_telemetry(stage, self._prim_by_rid.get(rid, ""))
        if not lt:
            return

        # 표시 모드 시계열 누적 — 값이 실제로 바뀐 샘플(ts)만 추가.
        # _on_update 는 매 프레임(초당 ~60회) 호출되므로, 새 텔레메트리(ts 변경)일 때만 append.
        # Accumulate display-mode series — only add samples whose value (ts) actually changed.
        # _on_update runs every frame (~60/s), so append only for new telemetry (ts changed).
        ser = self._display_series.setdefault(rid, {k: [] for k in SERIES_KEYS})
        last_ts = self._last_ts.get(rid)
        cur_ts = lt.get("ts")
        if cur_ts != last_ts:
            self._last_ts[rid] = cur_ts
            for k in SERIES_KEYS:
                if k in lt:
                    ser[k].append(float(lt[k]))
                    if len(ser[k]) > 120:
                        ser[k] = ser[k][-120:]

        self._labels["status"].text = str(lt.get("status", "-"))
        batt, temp = lt.get("battery_pct"), lt.get("motor_temp_c")
        self._set_val("battery_pct", f"{batt}", WARN_COLOR if (batt is not None and batt <= BATTERY_WARN) else OK_COLOR)
        self._set_val("motor_temp_c", f"{temp}", WARN_COLOR if (temp is not None and temp >= TEMP_WARN) else OK_COLOR)
        self._labels["speed_mps"].text = f"{lt.get('speed_mps','-')}"
        pos = lt.get("position", {})
        self._labels["position"].text = f"({pos.get('x','-')}, {pos.get('y','-')})"
        self._labels["odometer_m"].text = f"{lt.get('odometer_m','-')}"
        errs = lt.get("error_count", 0)
        self._set_val("error_count", f"{errs}", WARN_COLOR if errs else NEUTRAL)

        for k in SERIES_KEYS:
            if ser[k]:
                self._plots[k].set_data(*ser[k])

    def _update_motion(self, stage):
        """로봇별로 USD 의 목표 위치/방향을 향해 매 프레임 부드럽게 보간 이동.

        텔레메트리는 5초 간격(끊김)이지만, 매 프레임 lerp 로 채워 부드럽게 보인다.
        _motion[rid] = {cur:(x,y,h), tgt:(x,y,h)} 를 유지.

        Smoothly interpolate each robot toward the USD target position/heading every frame.

        Telemetry arrives at 5s intervals (choppy), but per-frame lerp fills the gaps so it looks smooth.
        Maintains _motion[rid] = {cur:(x,y,h), tgt:(x,y,h)}.
        """
        for rid, ppath in list(self._prim_by_rid.items()):
            rec = usd_bridge.read_telemetry(stage, ppath)
            pos = rec.get("position") or {}
            if pos.get("x") is None:
                continue
            tx, ty = float(pos["x"]), float(pos["y"])
            th = float(rec.get("heading_deg", 0.0))
            fz = floor_z_for(rec)   # 로봇 타입별 바닥 Z / floor Z per robot type
            m = self._motion.get(rid)
            if m is None:
                # 최초: 목표=현재 (점프 없이 시작) / First time: target = current (start without a jump)
                self._motion[rid] = {"cur": [tx, ty, th], "tgt": [tx, ty, th]}
                usd_bridge.apply_motion_xyh(stage, ppath, tx, ty, th, fz)
                continue
            m["tgt"] = [tx, ty, th]
            cx, cy, ch = m["cur"]
            # 보간 계수: 5초 간격을 ~부드럽게 따라잡도록 프레임당 일정 비율
            # Interpolation factor: a fixed per-frame ratio that smoothly catches up over the 5s interval
            a = 0.08
            cx += (tx - cx) * a
            cy += (ty - cy) * a
            # 각도는 최단경로로 보간(-180~180 wrap) / interpolate angle along the shortest path (-180~180 wrap)
            dh = ((th - ch + 180) % 360) - 180
            ch += dh * a
            m["cur"] = [cx, cy, ch]
            usd_bridge.apply_motion_xyh(stage, ppath, cx, cy, ch, fz)

    def _maybe_open_test_scene(self):
        """스테이지에 로봇 프림이 없으면 워크샵 씬을 자동으로 연다.
        우선순위: 4종 공장 씬(factory_scene) > 단일 PoC 씬(test_scene).

        Automatically open the workshop scene when the stage has no robot prims.
        Priority: 4-robot factory scene (factory_scene) > single-robot PoC scene (test_scene).
        """
        import os
        candidates = [
            "/home/ubuntu/digital_twin/iot/factory_scene.usda",
            "/home/ubuntu/digital_twin/iot/test_scene.usda",
        ]
        try:
            stage = usd_bridge.get_stage()
            has_robot = False
            if stage is not None:
                has_robot = usd_bridge.find_robot_prim_path(stage, "nova_carter_01") is not None
            if has_robot:
                return
            for scene in candidates:
                if os.path.exists(scene):
                    carb.log_warn(f"[robot.monitor] opening scene: {scene}")
                    omni.usd.get_context().open_stage(scene)
                    return
        except Exception as ex:
            carb.log_warn(f"[robot.monitor] open scene failed: {ex}")

    def _resolve_prim(self, stage, rid):
        if rid in self._prim_by_rid:
            return self._prim_by_rid[rid]
        path = usd_bridge.find_robot_prim_path(stage, rid)
        if path:
            self._prim_by_rid[rid] = path
        return path

    def _refresh_robot_list(self, ids):
        if ids == self._combo_ids:
            return
        # 재구성 전 현재 선택을 기억했다가, 재구성 후 복원한다.
        # (remove/append 는 선택을 0 으로 리셋하고 _on_robot_changed 를 발화시켜
        #  _current_rid 가 첫 로봇으로 튀는 버그 방지.)
        # Remember the current selection before rebuilding and restore it afterwards.
        # (remove/append resets the selection to 0 and fires _on_robot_changed,
        #  which would bounce _current_rid to the first robot — this prevents that bug.)
        prev = self._current_rid
        self._combo_ids = list(ids)
        self._updating_combo = True
        try:
            model = self._robot_combo.model
            for child in list(model.get_item_children()):
                model.remove_item(child)
            for rid in ids:
                model.append_child_item(None, ui.SimpleStringModel(rid))
            # 이전 선택이 여전히 목록에 있으면 그 인덱스로, 아니면 첫 항목 유지.
            # If the previous selection is still in the list use its index, otherwise keep the first item.
            if prev in self._combo_ids:
                self._current_rid = prev
                model.get_item_value_model().set_value(self._combo_ids.index(prev))
            elif self._combo_ids:
                self._current_rid = self._combo_ids[0]
        finally:
            self._updating_combo = False

    def _set_val(self, key, text, color):
        self._labels[key].text = text
        self._labels[key].style = {"color": color}
