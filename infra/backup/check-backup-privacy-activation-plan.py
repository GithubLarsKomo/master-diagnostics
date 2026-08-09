#!/usr/bin/env python3
"""Verify a signed byte-reversible backup-privacy activation plan."""
from __future__ import annotations
import argparse,base64,hashlib,hmac,json,re,stat,sys
from pathlib import Path
from typing import Any
PLAN_VERSION=2
SIGNING_DOMAIN=b"masters:backup-privacy-activation-plan:v2\n"
ACTIVATION_FILE=re.compile(r"^activation-[0-9a-f]{32}\.json$")
ACTIVATION_ID=re.compile(r"^activation-[0-9a-f]{32}$")
ATTESTATION_ID=re.compile(r"^attestation-[0-9a-f]{32}$")
SHA256=re.compile(r"^sha256:[0-9a-f]{64}$")
HMAC_SHA256=re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
TARGET_ORDER=("PRIVACY_BACKUP_STATE","PRIVACY_BACKUP_POLICY_VERSION","PRIVACY_BACKUP_ENCRYPTED_AT_REST","PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED","PRIVACY_BACKUP_RESTORE_RECONCILIATION")
TARGET={"PRIVACY_BACKUP_STATE":"ENABLED","PRIVACY_BACKUP_POLICY_VERSION":"1.0.0","PRIVACY_BACKUP_ENCRYPTED_AT_REST":"true","PRIVACY_BACKUP_BOUNDED_RETENTION_CONFIGURED":"true","PRIVACY_BACKUP_RESTORE_RECONCILIATION":"true"}
def fail(code:str,message:str)->"NoReturn": raise ValueError(f"{code}: {message}")
def canonical_json(value:Any)->str: return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"))
def read_key(path:Path)->bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file(): fail("ACTIVATION_PLAN_KEY_UNSAFE","key must be absolute regular non-symlink")
    try: key=base64.b64decode(path.read_text().strip(),validate=True)
    except Exception as exc: raise ValueError("ACTIVATION_PLAN_KEY_INVALID: invalid Base64") from exc
    if len(key)!=32: fail("ACTIVATION_PLAN_KEY_INVALID","key must decode to 32 bytes")
    return key
def read_envelope(path:Path)->dict[str,Any]:
    if not path.is_absolute() or not ACTIVATION_FILE.fullmatch(path.name): fail("ACTIVATION_PLAN_PATH_INVALID","invalid path or filename")
    if path.is_symlink() or not path.is_file(): fail("ACTIVATION_PLAN_FILE_UNSAFE","plan must be regular non-symlink")
    if stat.S_IMODE(path.stat().st_mode)&0o077: fail("ACTIVATION_PLAN_PERMISSIONS_UNSAFE","plan must be private")
    raw=json.loads(path.read_text());
    if not isinstance(raw,dict): fail("ACTIVATION_PLAN_INVALID","envelope must be object")
    return raw
def verify_rollback_descriptor(record:dict[str,Any])->None:
    rd=record.get("rollbackDescriptor")
    if not isinstance(rd,dict) or rd.get("strategy")!="REVERSE_ONLY_BOUND_BACKUP_PRIVACY_LINES_V1": fail("ROLLBACK_DESCRIPTOR_INVALID","strategy invalid")
    if rd.get("appendLineEnding") not in ("LF","CRLF") or not isinstance(rd.get("originalHadTrailingLineEnding"),bool): fail("ROLLBACK_DESCRIPTOR_INVALID","line ending metadata invalid")
    patches=rd.get("patches")
    if not isinstance(patches,list) or len(patches)!=5 or [p.get("key") for p in patches if isinstance(p,dict)]!=list(TARGET_ORDER): fail("ROLLBACK_DESCRIPTOR_INVALID","patch order invalid")
    indexes=[]
    for p in patches:
        key=p["key"]
        if p.get("targetValue")!=TARGET[key] or not isinstance(p.get("originalPresent"),bool): fail("ROLLBACK_DESCRIPTOR_INVALID",f"patch {key} invalid")
        if p["originalPresent"]:
            if not isinstance(p.get("originalLineIndex"),int) or p["originalLineIndex"]<0 or not isinstance(p.get("originalValue"),str) or p.get("originalLineEnding") not in ("LF","CRLF","NONE"): fail("ROLLBACK_DESCRIPTOR_INVALID",f"present patch {key} invalid")
            indexes.append(p["originalLineIndex"])
        else:
            if p.get("originalLineIndex") is not None or p.get("originalValue") is not None or p.get("originalLineEnding") is not None or not isinstance(p.get("targetAppendedLineIndex"),int): fail("ROLLBACK_DESCRIPTOR_INVALID",f"absent patch {key} invalid")
    if len(indexes)!=len(set(indexes)): fail("ROLLBACK_DESCRIPTOR_INVALID","original line indexes must be unique")
def verify_record(record:dict[str,Any])->None:
    if record.get("activationPlanVersion")!=PLAN_VERSION: fail("ACTIVATION_PLAN_VERSION_INVALID","activationPlanVersion must be 2")
    if not isinstance(record.get("activationId"),str) or not ACTIVATION_ID.fullmatch(record["activationId"]): fail("ACTIVATION_ID_INVALID","activation ID invalid")
    if not isinstance(record.get("attestationId"),str) or not ATTESTATION_ID.fullmatch(record["attestationId"]): fail("ATTESTATION_ID_INVALID","attestation ID invalid")
    for field in ("attestationFingerprint","attestationFileSha256","currentEnvFingerprint","targetEnvFingerprint","planFingerprint"):
        if not isinstance(record.get(field),str) or not SHA256.fullmatch(record[field]): fail("ACTIVATION_PLAN_FINGERPRINT_INVALID",f"{field} invalid")
    if not isinstance(record.get("envFilePath"),str) or not record["envFilePath"].startswith("/"): fail("ACTIVATION_PLAN_ENV_PATH_INVALID","env path must be absolute")
    if record.get("activationTarget")!=TARGET or record.get("expectedPreState")!="DISABLED" or record.get("expectedPostState")!="ENABLED": fail("ACTIVATION_PLAN_STATE_INVALID","target/state invalid")
    for field in ("atomicReplaceRequired","postWriteRuntimeAttestationRequired","rollbackOnValidationFailureRequired","exactRollbackReconstructionRequired","nonTargetEnvBytesMustRemainUnchanged"):
        if record.get(field) is not True: fail("ACTIVATION_PLAN_POLICY_INVALID",f"{field} must be true")
    if record.get("runtimeConfigurationChanged") is not False or record.get("activationExecuted") is not False: fail("ACTIVATION_PLAN_BOUNDARY_INVALID","plan must be pre-mutation")
    verify_rollback_descriptor(record)
    body=dict(record); fp=body.pop("planFingerprint")
    expected="sha256:"+hashlib.sha256(canonical_json(body).encode()).hexdigest()
    if not hmac.compare_digest(fp,expected): fail("ACTIVATION_PLAN_FINGERPRINT_MISMATCH","fingerprint mismatch")
def verify_signature(envelope:dict[str,Any],key:bytes)->dict[str,Any]:
    if envelope.get("envelopeVersion")!=1: fail("ACTIVATION_PLAN_ENVELOPE_VERSION_INVALID","envelopeVersion must be 1")
    record=envelope.get("record"); signature=envelope.get("signature")
    if not isinstance(record,dict): fail("ACTIVATION_PLAN_INVALID","record missing")
    verify_record(record)
    if not isinstance(signature,str) or not HMAC_SHA256.fullmatch(signature): fail("ACTIVATION_PLAN_SIGNATURE_INVALID","signature invalid")
    expected="hmac-sha256:"+hmac.new(key,SIGNING_DOMAIN+canonical_json({"envelopeVersion":1,"record":record}).encode(),hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature,expected): fail("ACTIVATION_PLAN_SIGNATURE_MISMATCH","HMAC mismatch")
    return record
def main()->int:
    p=argparse.ArgumentParser();p.add_argument("--plan",required=True,type=Path);p.add_argument("--key-file",required=True,type=Path);a=p.parse_args()
    try:
        r=verify_signature(read_envelope(a.plan),read_key(a.key_file));print(json.dumps({"mode":"BACKUP_PRIVACY_ACTIVATION_PLAN_VERIFICATION","status":"ACTIVATION_PLAN_VERIFIED","activationPlanVersion":PLAN_VERSION,"activationId":r["activationId"],"planFingerprint":r["planFingerprint"],"currentEnvFingerprint":r["currentEnvFingerprint"],"targetEnvFingerprint":r["targetEnvFingerprint"],"envFilePath":r["envFilePath"],"activationTarget":r["activationTarget"],"rollbackStrategy":r["rollbackDescriptor"]["strategy"],"activationExecutionAllowed":True,"runtimeConfigurationChanged":False,"activationExecuted":False},separators=(",",":")));return 0
    except (OSError,ValueError,json.JSONDecodeError) as exc:
        print(json.dumps({"mode":"BACKUP_PRIVACY_ACTIVATION_PLAN_VERIFICATION","status":"BLOCKED","blocker":str(exc).split(":",1)[0],"activationExecutionAllowed":False,"runtimeConfigurationChanged":False,"activationExecuted":False},separators=(",",":")));return 1
if __name__=="__main__": raise SystemExit(main())
