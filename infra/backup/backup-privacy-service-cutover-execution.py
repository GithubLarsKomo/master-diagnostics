#!/usr/bin/env python3
"""Persist/verify signed CUTOVER_STARTED evidence before backup-privacy service mutation."""
from __future__ import annotations

import argparse, base64, hashlib, hmac, json, os, re, stat, subprocess, sys
from datetime import datetime
from pathlib import Path
from typing import Any

DOMAIN=b"masters:backup-privacy-service-cutover-execution:v1\n"
START_FILE="service-cutover-started.json"
SHA256=re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_RE=re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
CUTOVER_ID=re.compile(r"^cutover-[0-9a-f]{32}$")
BASELINE_ID=re.compile(r"^baseline-[0-9a-f]{32}$")
EXECUTION_ID=re.compile(r"^cutover-execution-[0-9a-f]{32}$")
UTC_RE=re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def fail(code:str,msg:str)->"NoReturn": raise ValueError(f"{code}: {msg}")
def canonical(v:Any)->str: return json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(",",":"))
def sha(data:bytes)->str: return "sha256:"+hashlib.sha256(data).hexdigest()


def read_private(path:Path,code:str)->bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file(): fail(f"{code}_UNSAFE","file must be absolute regular non-symlink")
    if stat.S_IMODE(path.stat().st_mode)&0o077: fail(f"{code}_PERMISSIONS_UNSAFE","file must be private")
    return path.read_bytes()


def read_key(path:Path)->bytes:
    try: key=base64.b64decode(read_private(path,"CUTOVER_EXECUTION_KEY").decode().strip(),validate=True)
    except Exception as exc: raise ValueError("CUTOVER_EXECUTION_KEY_INVALID: invalid Base64") from exc
    if len(key)!=32: fail("CUTOVER_EXECUTION_KEY_INVALID","key must decode to 32 bytes")
    return key


def timestamp(value:str)->None:
    if not UTC_RE.fullmatch(value): fail("CUTOVER_EXECUTION_TIMESTAMP_INVALID","recordedAt must be canonical UTC")
    try: datetime.fromisoformat(value.replace("Z","+00:00"))
    except ValueError as exc: raise ValueError("CUTOVER_EXECUTION_TIMESTAMP_INVALID: recordedAt invalid") from exc


def run_json(cmd:list[str])->tuple[int,dict[str,Any]]:
    p=subprocess.run(cmd,check=False,capture_output=True,text=True)
    try: r=json.loads(p.stdout)
    except json.JSONDecodeError as exc: raise ValueError("CUTOVER_EXECUTION_DEPENDENCY_OUTPUT_INVALID: dependency did not return JSON") from exc
    if not isinstance(r,dict): fail("CUTOVER_EXECUTION_DEPENDENCY_OUTPUT_INVALID","dependency output must be object")
    return p.returncode,r


def baseline_cmd(a:argparse.Namespace)->list[str]:
    cmd=[sys.executable,str(a.baseline_tool),"check",
         "--cutover-plan-checker",str(a.cutover_plan_checker),
         "--handoff-checker",str(a.handoff_checker)]
    if a.target_config_checker is not None: cmd += ["--target-config-checker",str(a.target_config_checker)]
    cmd += ["--activation-plan",str(a.activation_plan),"--pending",str(a.pending),"--handoff",str(a.handoff),
            "--key-file",str(a.key_file),"--env-file",str(a.env_file),"--compose-file",str(a.compose_file),
            "--cutover-plan",str(a.cutover_plan),"--app-inspect",str(a.app_inspect),"--export-inspect",str(a.export_inspect),
            "--retention-inspect",str(a.retention_inspect),"--libsql-inspect",str(a.libsql_inspect),"--caddy-inspect",str(a.caddy_inspect),
            "--baseline",str(a.baseline)]
    return cmd


def verify_baseline(a:argparse.Namespace)->tuple[dict[str,Any],dict[str,Any],str]:
    for p,c in ((a.baseline_tool,"LIVE_BASELINE_TOOL"),(a.baseline,"LIVE_BASELINE")):
        if not p.is_absolute() or p.is_symlink() or not p.is_file(): fail(f"{c}_UNSAFE","baseline dependency is unsafe")
    code,result=run_json(baseline_cmd(a))
    if code!=0 or result.get("status")!="SERVICE_LIVE_BASELINE_VERIFIED" or result.get("serviceCutoverMutationAllowed") is not True or result.get("serviceCutoverExecuted") is not False or result.get("liveRuntimeAttested") is not False or result.get("activationExecuted") is not False:
        fail("LIVE_BASELINE_NOT_VERIFIED",f"live baseline verification failed: {result.get('blocker')}")
    raw=read_private(a.baseline,"LIVE_BASELINE")
    env=json.loads(raw)
    if not isinstance(env,dict) or env.get("envelopeVersion")!=1 or not isinstance(env.get("record"),dict): fail("LIVE_BASELINE_INVALID","baseline envelope invalid")
    sig=env.get("signature")
    if not isinstance(sig,str) or not HMAC_RE.fullmatch(sig): fail("LIVE_BASELINE_SIGNATURE_INVALID","baseline signature invalid")
    rec=env["record"]
    for field in ("baselineId","cutoverId","activationId","baselineFingerprint","liveFingerprint","cutoverPlanFingerprint"):
        if field in result and rec.get(field)!=result.get(field): fail("LIVE_BASELINE_BINDING_MISMATCH",f"baseline differs from verifier for {field}")
    return result,rec,sha(raw)


def make_id(b:dict[str,Any],baseline_sha:str)->str:
    ident={k:b.get(k) for k in ("cutoverId","baselineId","baselineFingerprint","liveFingerprint","cutoverPlanFingerprint")}; ident["baselineFileSha256"]=baseline_sha
    return "cutover-execution-"+hashlib.sha256(canonical(ident).encode()).hexdigest()[:32]


def build_record(b:dict[str,Any],baseline_sha:str,recorded_at:str)->dict[str,Any]:
    timestamp(recorded_at)
    if not isinstance(b.get("cutoverId"),str) or not CUTOVER_ID.fullmatch(b["cutoverId"]): fail("CUTOVER_EXECUTION_CUTOVER_ID_INVALID","cutover ID invalid")
    if not isinstance(b.get("baselineId"),str) or not BASELINE_ID.fullmatch(b["baselineId"]): fail("CUTOVER_EXECUTION_BASELINE_ID_INVALID","baseline ID invalid")
    r={"cutoverExecutionVersion":1,"phase":"CUTOVER_STARTED","recordedAt":recorded_at,"cutoverExecutionId":make_id(b,baseline_sha),
       "cutoverId":b["cutoverId"],"activationId":b.get("activationId"),"baselineId":b["baselineId"],"baselineFingerprint":b.get("baselineFingerprint"),
       "liveFingerprint":b.get("liveFingerprint"),"baselineFileSha256":baseline_sha,"cutoverPlanFingerprint":b.get("cutoverPlanFingerprint"),
       "targetHandoffFingerprint":b.get("targetHandoffFingerprint"),"targetEnvFingerprint":b.get("targetEnvFingerprint"),
       "liveBaselineMustRemainVerifiedBeforeMutation":True,"preserveIdentityRequired":True,"rollbackRequiredOnCutoverFailure":True,
       "cutoverExecutionStarted":True,"productionMutationApplied":False,"serviceCutoverExecuted":False,"liveRuntimeAttested":False,"activationExecuted":False}
    for f in ("baselineFingerprint","liveFingerprint","baselineFileSha256","cutoverPlanFingerprint","targetHandoffFingerprint","targetEnvFingerprint"):
        if not isinstance(r.get(f),str) or not SHA256.fullmatch(r[f]): fail("CUTOVER_EXECUTION_BINDING_INVALID",f"{f} invalid")
    if not EXECUTION_ID.fullmatch(r["cutoverExecutionId"]): fail("CUTOVER_EXECUTION_ID_INVALID","execution ID invalid")
    r["cutoverExecutionFingerprint"]=sha(canonical(r).encode())
    return r


def signature(record:dict[str,Any],key:bytes)->str:
    return "hmac-sha256:"+hmac.new(key,DOMAIN+canonical({"envelopeVersion":1,"record":record}).encode(),hashlib.sha256).hexdigest()


def validate_record(r:dict[str,Any],b:dict[str,Any],baseline_sha:str)->None:
    if r.get("cutoverExecutionVersion")!=1 or r.get("phase")!="CUTOVER_STARTED": fail("CUTOVER_EXECUTION_VERSION_INVALID","version/phase invalid")
    expected=build_record(b,baseline_sha,str(r.get("recordedAt","")))
    if r!=expected: fail("CUTOVER_EXECUTION_BINDING_MISMATCH","execution evidence no longer matches live baseline")


def safe_dir(root:Path,cutover_id:str)->Path:
    if not root.is_absolute(): fail("CUTOVER_EXECUTION_OUTPUT_NOT_ABSOLUTE","output root must be absolute")
    root.mkdir(parents=True,exist_ok=True,mode=0o700); os.chmod(root,0o700)
    if root.is_symlink() or not root.is_dir(): fail("CUTOVER_EXECUTION_OUTPUT_UNSAFE","output root unsafe")
    d=root/cutover_id; d.mkdir(exist_ok=True,mode=0o700); os.chmod(d,0o700)
    if d.is_symlink() or not d.is_dir(): fail("CUTOVER_EXECUTION_OUTPUT_UNSAFE","execution dir unsafe")
    return d


def persist(path:Path,env:dict[str,Any])->bool:
    if path.exists(): return False
    data=(json.dumps(env,ensure_ascii=False,indent=2)+"\n").encode(); fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,"wb") as h: h.write(data); h.flush(); os.fsync(h.fileno())
        fd=-1; os.chmod(path,0o600); pfd=os.open(path.parent,os.O_RDONLY|getattr(os,"O_DIRECTORY",0))
        try: os.fsync(pfd)
        finally: os.close(pfd)
        return True
    finally:
        if fd>=0: os.close(fd)


def read_execution(path:Path,key:bytes,b:dict[str,Any],baseline_sha:str)->dict[str,Any]:
    raw=read_private(path,"CUTOVER_EXECUTION"); env=json.loads(raw)
    if not isinstance(env,dict) or env.get("envelopeVersion")!=1 or not isinstance(env.get("record"),dict): fail("CUTOVER_EXECUTION_INVALID","envelope invalid")
    validate_record(env["record"],b,baseline_sha)
    sig=env.get("signature")
    if not isinstance(sig,str) or not HMAC_RE.fullmatch(sig) or not hmac.compare_digest(sig,signature(env["record"],key)): fail("CUTOVER_EXECUTION_SIGNATURE_MISMATCH","HMAC mismatch")
    return env


def add_common(p:argparse.ArgumentParser)->None:
    root=Path(__file__).resolve().parents[2]
    p.add_argument("--baseline-tool",type=Path,default=root/"infra/backup/backup-privacy-service-live-baseline.py")
    p.add_argument("--cutover-plan-checker",type=Path,default=root/"infra/backup/check-backup-privacy-service-cutover-plan-v2.py")
    p.add_argument("--handoff-checker",type=Path,default=root/"infra/backup/check-backup-privacy-target-handoff.py")
    p.add_argument("--target-config-checker",type=Path)
    for name in ("activation-plan","pending","handoff","key-file","env-file","compose-file","cutover-plan","app-inspect","export-inspect","retention-inspect","libsql-inspect","caddy-inspect","baseline"):
        p.add_argument("--"+name,required=True,type=Path)


def prepare(a:argparse.Namespace)->dict[str,Any]:
    key=read_key(a.key_file); _,b,bsha=verify_baseline(a); r=build_record(b,bsha,a.recorded_at); d=safe_dir(a.output_root,r["cutoverId"]); path=d/START_FILE
    if path.exists(): env=read_execution(path,key,b,bsha); r=env["record"]; created=False
    else:
        env={"envelopeVersion":1,"record":r,"signature":signature(r,key)}; created=persist(path,env)
        if not created: r=read_execution(path,key,b,bsha)["record"]
    return {"mode":"BACKUP_PRIVACY_SERVICE_CUTOVER_EXECUTION","status":"CUTOVER_STARTED","cutoverExecutionId":r["cutoverExecutionId"],"cutoverId":r["cutoverId"],"cutoverExecutionFingerprint":r["cutoverExecutionFingerprint"],"executionPath":str(path),"executionCreated":created,"executionReused":not created,"serviceCutoverMutationAllowed":True,"productionMutationApplied":False,"serviceCutoverExecuted":False,"liveRuntimeAttested":False,"activationExecuted":False}


def check(a:argparse.Namespace)->dict[str,Any]:
    key=read_key(a.key_file); _,b,bsha=verify_baseline(a); env=read_execution(a.execution,key,b,bsha); r=env["record"]
    if a.execution.name!=START_FILE or a.execution.parent.name!=r["cutoverId"]: fail("CUTOVER_EXECUTION_PATH_BINDING_MISMATCH","execution path noncanonical")
    return {"mode":"BACKUP_PRIVACY_SERVICE_CUTOVER_EXECUTION_CHECK","status":"CUTOVER_START_VERIFIED","cutoverExecutionId":r["cutoverExecutionId"],"cutoverId":r["cutoverId"],"cutoverExecutionFingerprint":r["cutoverExecutionFingerprint"],"executionFileSha256":sha(read_private(a.execution,"CUTOVER_EXECUTION")),"serviceCutoverMutationAllowed":True,"liveBaselineReverified":True,"productionMutationApplied":False,"serviceCutoverExecuted":False,"liveRuntimeAttested":False,"activationExecuted":False}


def main()->int:
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest="command",required=True)
    pp=sub.add_parser("prepare"); add_common(pp); pp.add_argument("--output-root",required=True,type=Path); pp.add_argument("--recorded-at",required=True)
    pc=sub.add_parser("check"); add_common(pc); pc.add_argument("--execution",required=True,type=Path)
    a=ap.parse_args()
    try: result=prepare(a) if a.command=="prepare" else check(a); print(json.dumps(result,separators=(",",":"))); return 0
    except (OSError,ValueError,json.JSONDecodeError) as exc:
        print(json.dumps({"mode":"BACKUP_PRIVACY_SERVICE_CUTOVER_EXECUTION","status":"BLOCKED","blocker":str(exc).split(":",1)[0],"serviceCutoverMutationAllowed":False,"productionMutationApplied":False,"serviceCutoverExecuted":False,"liveRuntimeAttested":False,"activationExecuted":False},separators=(",",":"))); return 1

if __name__=="__main__": raise SystemExit(main())
