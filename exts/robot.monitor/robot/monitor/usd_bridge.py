"""
USD 브리지 — 텔레메트리를 로봇 USD 프림의 customData 에 쓰고/읽는다.

핵심 아이디어:
  - 발행 모드: Kinesis 에서 받은 값을 로봇 프림 customData["telemetry"] 에 기록.
    → Nucleus Live 세션이면 모든 클라이언트에 자동 전파(폴링 불필요).
  - 표시 모드: 모든 클라이언트가 프림 customData 에서 값을 읽어 표현.

robot_id → 프림 매핑:
  씬마다 로봇 프림 경로가 다르므로, 프림 이름/경로에 robot_id 가 포함되거나
  customData["robot_id"] 가 일치하는 프림을 찾는다. 못 찾으면 None.

(English)
USD bridge — writes/reads telemetry to/from the robot USD prim's customData.

Core idea:
  - Publish mode: record values received from Kinesis into the robot prim's customData["telemetry"].
    → In a Nucleus Live session this propagates automatically to all clients (no polling needed).
  - Display mode: every client reads values from the prim customData and renders them.

robot_id → prim mapping:
  Robot prim paths differ per scene, so find a prim whose name/path contains the robot_id
  or whose customData["robot_id"] matches. Returns None when not found.
"""
import json

# pxr 와 omni.usd 를 분리 import — 테스트 환경(omni 없음)에서도 pxr 함수는 동작.
# Import pxr and omni.usd separately — pxr functions still work in test environments (no omni).
try:
    from pxr import Usd, Sdf, UsdGeom, Gf
except ImportError:
    Usd = Sdf = UsdGeom = Gf = None
try:
    import omni.usd
except ImportError:
    omni = None

TELEMETRY_KEY = "telemetry"
ROBOT_ID_KEY = "robot_id"


def get_stage():
    if omni is None:
        return None
    return omni.usd.get_context().get_stage()


def _norm(s: str) -> str:
    return s.lower().replace("_", "").replace("-", "")


def find_robot_prim_path(stage, robot_id: str):
    """robot_id 에 해당하는 로봇 프림 경로를 찾는다.

    우선순위: customData.robot_id 정확 일치 > 프림 경로에 id 포함(정규화).

    Find the robot prim path corresponding to robot_id.

    Priority: exact customData.robot_id match > id contained in the prim path (normalized).
    """
    if stage is None:
        return None
    target = _norm(robot_id)
    base = target.rstrip("0123456789")  # nova_carter_01 → novacarter
    exact = None       # 프림 경로에 robot_id 전체 포함 (가장 정확) / prim path contains the full robot_id (most precise)
    loose = None       # 베이스명만 일치 (번호 없는 공유 프림 등) / only the base name matches (e.g. shared prims without a number)
    try:
        prims = stage.Traverse()
    except Exception:
        # 씬 로딩 중이거나 stage 타입이 호환 안 되면(usdrt 등) 조용히 패스
        # Silently pass while the scene is loading or the stage type is incompatible (usdrt etc.)
        return None
    for prim in prims:
        cd = prim.GetCustomData()
        if cd.get(ROBOT_ID_KEY) == robot_id:
            return str(prim.GetPath())
        if str(prim.GetTypeName()) not in ("Xform", "Scope", ""):
            continue
        pnorm = _norm(str(prim.GetPath()))
        nnorm = _norm(prim.GetName())
        if exact is None and target and target in pnorm:
            exact = str(prim.GetPath())
        elif loose is None and base and nnorm and (nnorm == base or base in pnorm):
            loose = str(prim.GetPath())
    return exact or loose


def write_telemetry(stage, prim_path: str, rec: dict) -> bool:
    """프림 customData 에 telemetry(JSON 문자열) + robot_id 기록.

    Write telemetry (JSON string) + robot_id into the prim's customData.
    """
    if stage is None or not prim_path:
        return False
    prim = stage.GetPrimAtPath(prim_path)
    if not prim or not prim.IsValid():
        return False
    # customData 는 dict. telemetry 는 JSON 문자열로 저장(중첩 dict 안전).
    # customData is a dict. telemetry is stored as a JSON string (safe for nested dicts).
    prim.SetCustomDataByKey(TELEMETRY_KEY, json.dumps(rec))
    if ROBOT_ID_KEY in rec:
        prim.SetCustomDataByKey(ROBOT_ID_KEY, rec[ROBOT_ID_KEY])
    return True


def apply_motion(stage, prim_path: str, rec: dict, z: float = 0.0) -> bool:
    """텔레메트리의 position(x,y) + heading_deg 로 로봇 프림을 이동/회전.

    데이터가 로봇을 실제로 움직이게 함 → Live 세션이면 모든 클라이언트에 전파.
    xformOp:translate / xformOp:orient(또는 rotateZ) 를 직접 설정.

    Move/rotate the robot prim using the telemetry's position (x,y) + heading_deg.

    The data actually drives the robot → in a Live session this propagates to all clients.
    Sets xformOp:translate / xformOp:orient (or rotateZ) directly.
    """
    if stage is None or not prim_path or UsdGeom is None:
        return False
    prim = stage.GetPrimAtPath(prim_path)
    if not prim or not prim.IsValid():
        return False
    pos = rec.get("position") or {}
    x = pos.get("x")
    y = pos.get("y")
    if x is None or y is None:
        return False
    heading = float(rec.get("heading_deg", 0.0))
    return apply_motion_xyh(stage, prim_path, float(x), float(y), heading, z)


def apply_motion_xyh(stage, prim_path: str, x: float, y: float, heading: float, z: float = 0.0) -> bool:
    """좌표/방향을 직접 받아 프림 transform 설정 (보간 루프에서 매 프레임 호출).

    Set the prim transform from raw coordinates/heading (called every frame by the interpolation loop).
    """
    if stage is None or not prim_path or UsdGeom is None:
        return False
    prim = stage.GetPrimAtPath(prim_path)
    if not prim or not prim.IsValid():
        return False
    xform = UsdGeom.Xformable(prim)
    ops = {op.GetOpName(): op for op in xform.GetOrderedXformOps()}
    # 기존 translate/rotateZ 가 있으면 재사용, 없으면 1회만 추가한다.
    # (매 프레임 Add* 를 부르면 op 가 중복 추가돼 "too many rotation ops" /
    #  순서가 꼬여 "translation applied before rotation" 경고가 난다.)
    # Reuse existing translate/rotateZ ops if present, otherwise add them only once.
    # (Calling Add* every frame adds duplicate ops, causing "too many rotation ops" /
    #  scrambled order and "translation applied before rotation" warnings.)
    t_op = ops.get("xformOp:translate")
    if t_op is None:
        t_op = xform.AddTranslateOp()
    r_op = ops.get("xformOp:rotateZ")
    if r_op is None:
        r_op = xform.AddRotateZOp()
    t_op.Set(Gf.Vec3d(float(x), float(y), float(z)))
    r_op.Set(float(heading))
    # 우리가 쓰는 두 op 의 순서를 translate→rotateZ 로 고정.
    # 기존에 orient/transform 등 다른 회전 op 가 섞여 순서 경고가 나던 것을 방지.
    # Pin the order of our two ops to translate→rotateZ.
    # Prevents the order warnings that occurred when other rotation ops (orient/transform etc.) were mixed in.
    desired = ["xformOp:translate", "xformOp:rotateZ"]
    current = [op.GetOpName() for op in xform.GetOrderedXformOps()]
    if current != desired:
        xform.SetXformOpOrder([t_op, r_op])
    return True


def read_telemetry(stage, prim_path: str) -> dict:
    """프림 customData 에서 telemetry 를 읽어 dict 반환. 없으면 {}.

    Read telemetry from the prim's customData and return it as a dict. Returns {} when absent.
    """
    if stage is None or not prim_path:
        return {}
    prim = stage.GetPrimAtPath(prim_path)
    if not prim or not prim.IsValid():
        return {}
    raw = prim.GetCustomDataByKey(TELEMETRY_KEY)
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def list_telemetry_prims(stage):
    """telemetry customData 가 있는 모든 프림 경로 → robot_id 매핑.

    Mapping of every prim path that has telemetry customData → robot_id.
    """
    result = {}
    if stage is None:
        return result
    try:
        prims = stage.Traverse()
    except Exception:
        return result
    for prim in prims:
        cd = prim.GetCustomData()
        if TELEMETRY_KEY in cd:
            rid = cd.get(ROBOT_ID_KEY) or prim.GetName()
            result[str(prim.GetPath())] = rid
    return result
