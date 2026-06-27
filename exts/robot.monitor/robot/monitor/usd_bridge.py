"""
USD 브리지 — 텔레메트리를 로봇 USD 프림의 customData 에 쓰고/읽는다.

핵심 아이디어:
  - 발행 모드: Kinesis 에서 받은 값을 로봇 프림 customData["telemetry"] 에 기록.
    → Nucleus Live 세션이면 모든 클라이언트에 자동 전파(폴링 불필요).
  - 표시 모드: 모든 클라이언트가 프림 customData 에서 값을 읽어 표현.

robot_id → 프림 매핑:
  씬마다 로봇 프림 경로가 다르므로, 프림 이름/경로에 robot_id 가 포함되거나
  customData["robot_id"] 가 일치하는 프림을 찾는다. 못 찾으면 None.
"""
import json

# pxr 와 omni.usd 를 분리 import — 테스트 환경(omni 없음)에서도 pxr 함수는 동작.
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
    """
    if stage is None:
        return None
    target = _norm(robot_id)
    base = target.rstrip("0123456789")  # nova_carter_01 → novacarter
    exact = None       # 프림 경로에 robot_id 전체 포함 (가장 정확)
    loose = None       # 베이스명만 일치 (번호 없는 공유 프림 등)
    for prim in stage.Traverse():
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
    """프림 customData 에 telemetry(JSON 문자열) + robot_id 기록."""
    if stage is None or not prim_path:
        return False
    prim = stage.GetPrimAtPath(prim_path)
    if not prim or not prim.IsValid():
        return False
    # customData 는 dict. telemetry 는 JSON 문자열로 저장(중첩 dict 안전).
    prim.SetCustomDataByKey(TELEMETRY_KEY, json.dumps(rec))
    if ROBOT_ID_KEY in rec:
        prim.SetCustomDataByKey(ROBOT_ID_KEY, rec[ROBOT_ID_KEY])
    return True


def apply_motion(stage, prim_path: str, rec: dict, z: float = 0.0) -> bool:
    """텔레메트리의 position(x,y) + heading_deg 로 로봇 프림을 이동/회전.

    데이터가 로봇을 실제로 움직이게 함 → Live 세션이면 모든 클라이언트에 전파.
    xformOp:translate / xformOp:orient(또는 rotateZ) 를 직접 설정.
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
    """좌표/방향을 직접 받아 프림 transform 설정 (보간 루프에서 매 프레임 호출)."""
    if stage is None or not prim_path or UsdGeom is None:
        return False
    prim = stage.GetPrimAtPath(prim_path)
    if not prim or not prim.IsValid():
        return False
    xform = UsdGeom.Xformable(prim)
    ops = {op.GetOpName(): op for op in xform.GetOrderedXformOps()}
    t_op = ops.get("xformOp:translate") or xform.AddTranslateOp()
    t_op.Set(Gf.Vec3d(float(x), float(y), float(z)))
    r_op = ops.get("xformOp:rotateZ") or xform.AddRotateZOp()
    r_op.Set(float(heading))
    return True


def read_telemetry(stage, prim_path: str) -> dict:
    """프림 customData 에서 telemetry 를 읽어 dict 반환. 없으면 {}."""
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
    """telemetry customData 가 있는 모든 프림 경로 → robot_id 매핑."""
    result = {}
    if stage is None:
        return result
    for prim in stage.Traverse():
        cd = prim.GetCustomData()
        if TELEMETRY_KEY in cd:
            rid = cd.get(ROBOT_ID_KEY) or prim.GetName()
            result[str(prim.GetPath())] = rid
    return result
