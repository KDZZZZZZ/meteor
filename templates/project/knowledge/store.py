#!/usr/bin/env python3
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from datetime import timedelta


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def short_hash(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()[:24]


def connect(knowledge_root):
    root = Path(knowledge_root)
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / "catalog.sqlite")
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


def init(args):
    root = Path(args.knowledge_root)
    db = connect(root)
    migration = Path(__file__).parent / "migrations" / "0001.sql"
    db.executescript(migration.read_text(encoding="utf-8"))
    db.execute(
        "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
        ("schema_version", "1"),
    )
    db.commit()


def import_submission(args):
    db = connect(args.knowledge_root)
    envelope = json.loads(Path(args.commit_json).read_text(encoding="utf-8"))
    event = None
    report = None
    import_envelope(db, envelope, report, event)
    db.commit()


def commit_submission(args):
    payload = json.loads(sys_stdin())
    db = connect(args.knowledge_root)
    with db:
        import_envelope(db, payload["commit"], payload["report"], payload["event"])
    print(json.dumps({"ok": True}))


def import_envelope(db, envelope, report=None, event=None):
    submission = envelope["submission"]
    submission_id = envelope["submission_id"]
    committed_at = envelope["committed_at"]
    hypothesis = submission["hypothesis"]
    db.execute(
        """
        INSERT OR REPLACE INTO research_runs(
          research_id, agent_session_id, backend, case_suite_revision, environment_ref,
          measurement_protocol_ref, run_status, research_goal_met, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            submission["research_id"],
            submission["agent_session_id"],
            submission["execution_backend"],
            first_kernel_field(submission, "case_suite_revision"),
            first_kernel_field(submission, "environment_ref"),
            first_kernel_field(submission, "measurement_protocol_ref"),
            "CLOSED",
            1 if envelope.get("research_goal_met") else 0,
            committed_at,
            committed_at,
        ),
    )
    db.execute(
        "INSERT OR REPLACE INTO hypotheses(hypothesis_id, latest_revision, statement, scope, mechanism) VALUES (?, ?, ?, ?, ?)",
        (
            hypothesis["hypothesis_id"],
            hypothesis["revision"],
            hypothesis["statement"],
            hypothesis["scope"],
            hypothesis["mechanism"],
        ),
    )
    db.execute(
        """
        INSERT OR REPLACE INTO hypothesis_revisions(
          hypothesis_id, revision, statement, scope, mechanism, verdict, submission_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            hypothesis["hypothesis_id"],
            hypothesis["revision"],
            hypothesis["statement"],
            hypothesis["scope"],
            hypothesis["mechanism"],
            hypothesis["verdict"],
            submission_id,
            committed_at,
        ),
    )
    for experiment in submission.get("experiments", []):
        db.execute(
            """
            INSERT OR REPLACE INTO experiments(
              experiment_id, research_id, hypothesis_revision, question, intervention, analysis, submission_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                experiment["experiment_id"],
                submission["research_id"],
                experiment["hypothesis_revision"],
                experiment["question"],
                experiment["intervention"],
                experiment["analysis"],
                submission_id,
            ),
        )
    for kernel in submission.get("submitted_kernels", []):
        db.execute(
            """
            INSERT OR REPLACE INTO kernel_submissions(
              kernel_id, revision, research_id, submission_id, source_hash, case_suite_revision,
              environment_ref, measurement_protocol_ref, full_size_test_ref, data_hash,
              recommended_domain, supported_domain
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                kernel["kernel_id"],
                kernel["revision"],
                submission["research_id"],
                submission_id,
                kernel["source_hash"],
                kernel["case_suite_revision"],
                kernel["environment_ref"],
                kernel["measurement_protocol_ref"],
                kernel["full_size_test_ref"],
                kernel["data_hash"],
                kernel["recommended_domain"],
                kernel["supported_domain"],
            ),
        )
        try:
            receipt = json.loads(Path(kernel["full_size_test_ref"]).read_text(encoding="utf-8"))
        except Exception:
            receipt = None
        if receipt:
            for row in receipt.get("rows", []):
                db.execute(
                    """
                    INSERT OR REPLACE INTO case_measurements(
                      submission_id, kernel_id, revision, case_id, status, median_us, reason
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        submission_id,
                        kernel["kernel_id"],
                        kernel["revision"],
                        row["case_id"],
                        row["status"],
                        row.get("median_us"),
                        row.get("reason"),
                    ),
                )
    for claim in submission.get("knowledge_updates", []):
        db.execute(
            "INSERT OR REPLACE INTO knowledge_claims(claim_id, kind, statement, scope, submission_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                claim["claim_id"],
                claim["kind"],
                claim["statement"],
                claim["scope"],
                submission_id,
                committed_at,
            ),
        )
        for ref in claim.get("evidence_refs", []):
            db.execute(
                "INSERT OR IGNORE INTO evidence_links(claim_id, evidence_ref) VALUES (?, ?)",
                (claim["claim_id"], ref),
            )
        novelty_id = "novelty_" + short_hash(
            {"kind": claim["kind"], "statement": claim["statement"], "scope": claim["scope"], "evidence_refs": sorted(claim.get("evidence_refs", []))}
        )
        content_hash = short_hash({"statement": claim["statement"], "scope": claim["scope"], "evidence_refs": sorted(claim.get("evidence_refs", []))})
        db.execute(
            "INSERT OR IGNORE INTO novelty_events(novelty_event_id, material_id, backend, reason, content_hash, created_at, submission_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                novelty_id,
                claim["claim_id"],
                submission["execution_backend"],
                "knowledge_update",
                content_hash,
                committed_at,
                submission_id,
            ),
        )
        for related_id in claim.get("related_material_ids", []):
            related_novelty_id = "novelty_" + short_hash(
                {"related_material_id": related_id, "content_hash": content_hash}
            )
            db.execute(
                "INSERT OR IGNORE INTO novelty_events(novelty_event_id, material_id, backend, reason, content_hash, created_at, submission_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    related_novelty_id,
                    related_id,
                    submission["execution_backend"],
                    "related_progress",
                    content_hash,
                    committed_at,
                    submission_id,
                ),
            )
    if hypothesis["verdict"] in ("SUPPORTED", "REFUTED"):
        novelty_id = "novelty_" + short_hash(
            {"hypothesis_id": hypothesis["hypothesis_id"], "revision": hypothesis["revision"], "verdict": hypothesis["verdict"]}
        )
        content_hash = short_hash({"statement": hypothesis["statement"], "verdict": hypothesis["verdict"], "evidence": sorted(hypothesis.get("supporting_evidence", []) + hypothesis.get("counterevidence", []))})
        db.execute(
            "INSERT OR IGNORE INTO novelty_events(novelty_event_id, material_id, backend, reason, content_hash, created_at, submission_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                novelty_id,
                hypothesis["hypothesis_id"],
                submission["execution_backend"],
                "hypothesis_verdict",
                content_hash,
                committed_at,
                submission_id,
            ),
        )
    for kernel in submission.get("submitted_kernels", []):
        novelty_id = "novelty_" + short_hash(
            {"kernel_id": kernel["kernel_id"], "revision": kernel["revision"], "source_hash": kernel["source_hash"], "data_hash": kernel["data_hash"]}
        )
        content_hash = short_hash({"source_hash": kernel["source_hash"], "data_hash": kernel["data_hash"], "recommended_case_ids": sorted(kernel.get("recommended_case_ids", []))})
        db.execute(
            "INSERT OR IGNORE INTO novelty_events(novelty_event_id, material_id, backend, reason, content_hash, created_at, submission_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                novelty_id,
                f"{kernel['kernel_id']}@{kernel['revision']}",
                submission["execution_backend"],
                "submitted_kernel",
                content_hash,
                committed_at,
                submission_id,
            ),
        )
    db.execute(
        "INSERT OR REPLACE INTO research_commits(submission_id, research_id, submission_hash, report_ref, committed_at) VALUES (?, ?, ?, ?, ?)",
        (submission_id, submission["research_id"], envelope["submission_hash"], envelope["report_ref"], committed_at),
    )
    report_summary = report["report"]["summary"] if report else submission["chief_report"]["summary"]
    db.execute(
        "INSERT OR REPLACE INTO research_reports(submission_id, research_id, summary, report_ref) VALUES (?, ?, ?, ?)",
        (submission_id, submission["research_id"], report_summary, envelope["report_ref"]),
    )
    if event:
        channel = event.get("channel") or "default"
        db.execute(
            "INSERT OR IGNORE INTO integration_events(integration_event_id, submission_id, channel, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                event["integration_event_id"],
                event["submission_id"],
                channel,
                event["status"],
                event["created_at"],
                event["updated_at"],
            ),
        )
        db.execute(
            "INSERT OR IGNORE INTO integration_channels(channel, updated_at) VALUES (?, ?)",
            (channel, event["created_at"]),
        )


def list_events(args):
    payload = json.loads(sys_stdin() or "{}")
    db = connect(args.knowledge_root)
    events = [
        dict(row) for row in db.execute(
            """
            SELECT integration_event_id, submission_id, channel, status, created_at, updated_at, result_ref, error
            FROM integration_events
            ORDER BY created_at, integration_event_id
            """
        ).fetchall()
    ]
    print(json.dumps({"ok": True, "events": events}))


def claim_event(args):
    payload = json.loads(sys_stdin())
    event_id = payload["event_id"]
    token = payload["token"]
    lease_seconds = int(payload.get("lease_seconds", 300))
    db = connect(args.knowledge_root)
    with db:
        # Serialize the eligibility checks with both event and channel writes.
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT * FROM integration_events WHERE integration_event_id = ?",
            (event_id,),
        ).fetchone()
        if not row:
            print(json.dumps({"ok": True, "claimed": False}))
            return
        if payload.get("channel") is not None and row["channel"] != payload["channel"]:
            print(json.dumps({"ok": True, "claimed": False}))
            return
        now = now_iso()
        expired = row["lease_expires_at"] is not None and row["lease_expires_at"] < now
        if row["status"] not in ("QUEUED", "FAILED") and not expired:
            print(json.dumps({"ok": True, "claimed": False}))
            return
        channel = row["channel"]
        channel_row = db.execute("SELECT * FROM integration_channels WHERE channel = ?", (channel,)).fetchone()
        channel_expired = (not channel_row) or channel_row["lease_expires_at"] is None or channel_row["lease_expires_at"] < now
        if channel_row and channel_row["active_event_id"] and channel_row["active_event_id"] != event_id and not channel_expired:
            print(json.dumps({"ok": True, "claimed": False}))
            return
        updated_at = now_iso()
        lease_expires_at = (datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)).isoformat().replace("+00:00", "Z")
        db.execute(
            "UPDATE integration_events SET status = ?, claim_token = ?, lease_expires_at = ?, updated_at = ?, error = NULL WHERE integration_event_id = ?",
            ("SELECTING", token, lease_expires_at, updated_at, event_id),
        )
        db.execute(
            """
            INSERT INTO integration_channels(channel, active_event_id, lease_token, lease_expires_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(channel) DO UPDATE SET
              active_event_id = excluded.active_event_id,
              lease_token = excluded.lease_token,
              lease_expires_at = excluded.lease_expires_at,
              updated_at = excluded.updated_at
            """,
            (channel, event_id, token, lease_expires_at, updated_at),
        )
        event = dict(db.execute("SELECT * FROM integration_events WHERE integration_event_id = ?", (event_id,)).fetchone())
    print(json.dumps({"ok": True, "claimed": True, "event": event}))


def finish_event(args):
    payload = json.loads(sys_stdin())
    db = connect(args.knowledge_root)
    with db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM integration_events WHERE integration_event_id = ?", (payload["event_id"],)).fetchone()
        if not row or row["claim_token"] != payload.get("token"):
            print(json.dumps({"ok": False, "error": "lease token mismatch"}))
            return
        event_update = db.execute(
            "UPDATE integration_events SET status = ?, result_ref = ?, error = ?, updated_at = ?, lease_expires_at = NULL WHERE integration_event_id = ? AND claim_token = ?",
            (
                payload["status"],
                payload.get("result_ref"),
                payload.get("error"),
                now_iso(),
                payload["event_id"],
                payload.get("token"),
            ),
        )
        if payload["status"] in ("ASSEMBLED", "SKIPPED", "NO_CHANGE"):
            channel_update = db.execute(
                "UPDATE integration_channels SET active_event_id = NULL, lease_token = NULL, lease_expires_at = NULL, current_version_ref = COALESCE(?, current_version_ref), generation = generation + 1, updated_at = ? WHERE channel = ? AND lease_token = ? AND active_event_id = ?",
                (payload.get("result_ref"), now_iso(), row["channel"], payload.get("token"), payload["event_id"]),
            )
        else:
            channel_update = db.execute(
                "UPDATE integration_channels SET active_event_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE channel = ? AND lease_token = ? AND active_event_id = ?",
                (now_iso(), row["channel"], payload.get("token"), payload["event_id"]),
            )
        if event_update.rowcount != 1 or channel_update.rowcount != 1:
            db.rollback()
            print(json.dumps({"ok": False, "error": "lease token mismatch"}))
            return
    print(json.dumps({"ok": True}))


def list_materials(args):
    payload = json.loads(sys_stdin() or "{}")
    backend = payload.get("backend")
    db = connect(args.knowledge_root)
    claim_rows = db.execute(
        """
        SELECT claim_id AS material_id, kind, statement, scope, submission_id
        FROM knowledge_claims
        """
    ).fetchall()
    kernel_rows = db.execute(
        """
        SELECT kernel_id || '@' || revision AS material_id, 'kernel' AS kind,
               source_hash || ' ' || recommended_domain AS statement,
               supported_domain AS scope, submission_id
        FROM kernel_submissions
        """
    ).fetchall()
    novelty_rows = db.execute(
        """
        SELECT material_id, MAX(created_at) AS last_novelty_event_at
        FROM novelty_events
        WHERE (? IS NULL OR backend = ?)
        GROUP BY material_id
        """,
        (backend, backend),
    ).fetchall()
    novelty = {row["material_id"]: row["last_novelty_event_at"] for row in novelty_rows}
    materials = []
    for row in list(claim_rows) + list(kernel_rows):
        material_id = row["material_id"]
        materials.append({
            "material_id": material_id,
            "kind": row["kind"],
            "statement": row["statement"],
            "scope": row["scope"],
            "submission_id": row["submission_id"],
            "last_novelty_event_at": novelty.get(material_id, "1970-01-01T00:00:00Z"),
        })
    print(json.dumps({"ok": True, "materials": materials}))


def first_kernel_field(submission, key):
    kernels = submission.get("submitted_kernels", [])
    if kernels:
        return kernels[0].get(key, "")
    return ""


def sys_stdin():
    import sys
    return sys.stdin.read()


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(required=True)
    init_parser = sub.add_parser("init")
    init_parser.add_argument("knowledge_root")
    init_parser.set_defaults(func=init)
    import_parser = sub.add_parser("import-submission")
    import_parser.add_argument("knowledge_root")
    import_parser.add_argument("commit_json")
    import_parser.set_defaults(func=import_submission)
    commit_parser = sub.add_parser("commit-submission")
    commit_parser.add_argument("knowledge_root")
    commit_parser.set_defaults(func=commit_submission)
    events_parser = sub.add_parser("list-events")
    events_parser.add_argument("knowledge_root")
    events_parser.set_defaults(func=list_events)
    claim_parser = sub.add_parser("claim-event")
    claim_parser.add_argument("knowledge_root")
    claim_parser.set_defaults(func=claim_event)
    finish_parser = sub.add_parser("finish-event")
    finish_parser.add_argument("knowledge_root")
    finish_parser.set_defaults(func=finish_event)
    materials_parser = sub.add_parser("list-materials")
    materials_parser.add_argument("knowledge_root")
    materials_parser.set_defaults(func=list_materials)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
