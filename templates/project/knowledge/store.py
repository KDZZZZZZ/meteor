#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
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


SCHEMA_VERSION = 3
MAX_INTEGRATION_FAILURES = 3


def connect(knowledge_root, initializing=False):
    root = Path(knowledge_root)
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / "catalog.sqlite", timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    metadata = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").fetchone()
    version_row = db.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone() if metadata else None
    version = int(version_row["value"]) if version_row else 0
    if not initializing and version == 2:
        upgrade_schema(db)
        version = SCHEMA_VERSION
    if version > SCHEMA_VERSION or (not initializing and version != SCHEMA_VERSION):
        db.close()
        raise ValueError(f"Unsupported catalog schema {version}; current runtime requires {SCHEMA_VERSION}. Do not downgrade a catalog.")
    if metadata and version == SCHEMA_VERSION and db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integration_events'").fetchone():
        try:
            # DDL does not start a sqlite3 transaction implicitly. Lock before
            # checking columns so concurrent opens cannot race the same ALTER.
            db.execute("BEGIN IMMEDIATE")
            ensure_integration_retry_schema(db)
            db.commit()
        except Exception:
            db.rollback()
            db.close()
            raise
    return db


def target_key(target):
    if target is None:
        return ""
    import re
    if not isinstance(target, dict) or set(target) != {"workspace_id", "op_id", "dtype_id"}:
        raise ValueError("A complete workspace/op/dtype target is required")
    parts = [target[key] for key in ("workspace_id", "op_id", "dtype_id")]
    if not all(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", value) and '..' not in value for value in parts):
        raise ValueError("Invalid target identity")
    return "/".join(parts)


def safe_scope_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", value) or '..' in value:
        raise ValueError("Invalid knowledge scope identifier")
    return value


def normalize_knowledge_scope(claim):
    level = claim.get('scope_level') or ('hardware' if claim.get('applicability') == 'hardware' else 'dtype')
    if level not in ('hardware', 'op', 'dtype', 'shape'):
        raise ValueError('scope_level must be hardware, op, dtype or shape')
    if claim.get('scope_level') and claim.get('applicability') == 'hardware' and level != 'hardware':
        raise ValueError('hardware applicability conflicts with scope_level')
    shape_range = claim.get('shape_range')
    if isinstance(shape_range, str):
        shape_range = json.loads(shape_range)
    if level != 'shape':
        if shape_range is not None:
            raise ValueError('shape_range is only allowed for shape knowledge')
        return dict(scope_level=level)
    if not isinstance(shape_range, dict) or set(shape_range) != {'shape_id', 'dimensions'}:
        raise ValueError('shape knowledge requires shape_range with shape_id and explicit dimensions')
    shape_id = safe_scope_id(shape_range['shape_id'])
    dimensions = shape_range['dimensions']
    if not isinstance(dimensions, dict) or not dimensions:
        raise ValueError('shape_range.dimensions requires explicit min/max bounds')
    normalized = {}
    for dimension, bounds in dimensions.items():
        safe_scope_id(dimension)
        if (not isinstance(bounds, dict) or set(bounds) != {'min', 'max'}
                or any(type(bounds[key]) is not int or not 1 <= bounds[key] <= 9007199254740991 for key in ('min', 'max'))
                or bounds['min'] > bounds['max']):
            raise ValueError(f'shape_range.dimensions.{dimension} requires positive integer min <= max')
        normalized[dimension] = dict(min=bounds['min'], max=bounds['max'])
    return dict(scope_level=level, shape_range=dict(shape_id=shape_id, dimensions=normalized))


def normalize_knowledge_shape(shape):
    if not isinstance(shape, dict) or not shape:
        raise ValueError('shape must contain concrete positive integer dimensions')
    for dimension, size in shape.items():
        safe_scope_id(dimension)
        if type(size) is not int or not 1 <= size <= 9007199254740991:
            raise ValueError(f'shape.{dimension} must be a positive safe integer')
    return shape


def knowledge_scope_matches(claim, target, shape=None):
    scope = normalize_knowledge_scope(claim)
    origin = claim.get('target_key', '')
    if not origin or not target:
        return not origin and not target and scope['scope_level'] != 'shape'
    source_parts, target_parts = origin.split('/'), target.split('/')
    if len(source_parts) != 3 or len(target_parts) != 3 or source_parts[0] != target_parts[0]:
        return False
    if scope['scope_level'] == 'hardware':
        return True
    if source_parts[1] != target_parts[1]:
        return False
    if scope['scope_level'] == 'op':
        return True
    if source_parts[2] != target_parts[2]:
        return False
    if scope['scope_level'] == 'dtype':
        return True
    return bool(shape) and all(dimension in shape and bounds['min'] <= shape[dimension] <= bounds['max']
                               for dimension, bounds in scope['shape_range']['dimensions'].items())


def knowledge_document(envelope, claim):
    submission = envelope['submission']
    target = submission.get('target')
    scope = normalize_knowledge_scope(claim)
    parts = []
    if target and scope['scope_level'] != 'hardware':
        parts.append(safe_scope_id(target['op_id']))
        if scope['scope_level'] in ('dtype', 'shape'):
            parts.append(safe_scope_id(target['dtype_id']))
    if scope['scope_level'] == 'shape':
        if not target:
            raise ValueError('shape knowledge requires a workspace target')
        parts.append(scope['shape_range']['shape_id'])
    document = dict(schema_version=1, **scope, claim=claim,
                    source=dict(target=target, research_id=submission['research_id'],
                                submission_id=envelope['submission_id'], submission_hash=envelope['submission_hash'],
                                execution_backend=submission['execution_backend'], report_ref=envelope['report_ref']),
                    evidence_refs=claim['evidence_refs'], scope_validation='author_declared')
    digest = hashlib.sha256(canonical(document).encode('utf-8')).hexdigest()
    return '/'.join(parts + [f'claim_{digest}.json']), document


def write_knowledge_documents(knowledge_root, envelope):
    # Write before the catalog transaction commits. If it rolls back, retain
    # immutable unindexed files so retry can reuse them without replacing evidence.
    # Declaring a range does not prove every point inside it; receipts remain the evidence.
    import os
    import tempfile
    root = Path(knowledge_root).resolve()
    for claim in envelope['submission'].get('knowledge_updates', []):
        relative, document = knowledge_document(envelope, claim)
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        encoded = (canonical(document) + '\n').encode('utf-8')
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.knowledge-', delete=False) as staged:
                temporary = Path(staged.name)
                staged.write(encoded)
                staged.flush()
                os.fsync(staged.fileno())
            try:
                os.link(temporary, destination)
            except FileExistsError:
                if destination.read_bytes() != encoded:
                    raise ValueError('Immutable knowledge record has conflicting content')
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def bind_target(db, payload):
    target = payload.get("target")
    scope = target_key(target)
    workspace = db.execute("SELECT value FROM metadata WHERE key='workspace_id'").fetchone()
    if workspace and (not target or workspace["value"] != target["workspace_id"]):
        raise ValueError("Catalog belongs to a different workspace; legacy snapshots cannot write it")
    if target:
        db.execute("INSERT OR IGNORE INTO metadata(key,value) VALUES ('workspace_id',?)", (target["workspace_id"],))
        db.execute("INSERT OR IGNORE INTO targets VALUES (?,?,?,?)",
                   (scope, target["workspace_id"], target["op_id"], target["dtype_id"]))
    return scope


def upgrade_schema(db):
    # Check the version after acquiring the writer lock: several subagents may
    # open an empty shared workspace together. All DDL commits atomically.
    db.execute('PRAGMA journal_mode=WAL')
    try:
        db.execute('BEGIN IMMEDIATE')
        metadata = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").fetchone()
        row = db.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone() if metadata else None
        version = int(row['value']) if row else 0
        if version > SCHEMA_VERSION:
            raise ValueError(f'Unsupported catalog schema {version}; cannot downgrade')
        migrations = Path(__file__).parent / 'migrations'
        for revision in range(version + 1, SCHEMA_VERSION + 1):
            statement = ''
            for line in (migrations / f'{revision:04d}.sql').read_text(encoding='utf-8').splitlines(True):
                statement += line
                if sqlite3.complete_statement(statement):
                    normalized = statement.strip().upper()
                    if not normalized.startswith(('PRAGMA ', 'BEGIN ', 'COMMIT')):
                        db.execute(statement)
                    statement = ''
            db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES ('schema_version',?)", (str(revision),))
        ensure_integration_retry_schema(db)
        db.commit()
    except Exception:
        db.rollback()
        raise


def table_columns(db, table):
    return {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}


def ensure_integration_retry_schema(db):
    columns = table_columns(db, "integration_events")
    if "retryable" not in columns:
        db.execute("ALTER TABLE integration_events ADD COLUMN retryable INTEGER NOT NULL DEFAULT 1")
    if "failure_count" not in columns:
        db.execute("ALTER TABLE integration_events ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0")
    if "first_error" not in columns:
        db.execute("ALTER TABLE integration_events ADD COLUMN first_error TEXT")
    if "last_error" not in columns:
        db.execute("ALTER TABLE integration_events ADD COLUMN last_error TEXT")
    db.execute("""
        CREATE TABLE IF NOT EXISTS integration_attempts (
          target_key TEXT NOT NULL DEFAULT '',
          attempt_id TEXT,
          integration_event_id TEXT NOT NULL,
          attempt_no INTEGER NOT NULL,
          status TEXT NOT NULL,
          error_class TEXT,
          retryable INTEGER NOT NULL,
          error TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          PRIMARY KEY (target_key, integration_event_id, attempt_no),
          FOREIGN KEY (target_key) REFERENCES targets(target_key)
        )
    """)
    attempt_columns = table_columns(db, "integration_attempts")
    if "attempt_id" not in attempt_columns:
        db.execute("ALTER TABLE integration_attempts ADD COLUMN attempt_id TEXT")
    retry_version = db.execute("SELECT value FROM metadata WHERE key='integration_retry_schema'").fetchone()
    if not retry_version or retry_version["value"] != "2":
        # Legacy failures have no attempt history. Preserve their known error
        # without inventing a count or replaying a known permanent failure.
        for row in db.execute("SELECT * FROM integration_events WHERE status='FAILED'").fetchall():
            first_error = row["first_error"] or row["error"]
            last_error = row["last_error"] or row["error"]
            permanent = any(re.search(
                r"symbol_prefix|Duplicate module symbol prefix|Launcher mismatch|Frozen integration|"
                r"Immutable (record|text|input).*conflict|Immutable .* conflict|"
                r"Integration measurement identity|data hash is stale|source hash is stale",
                message or "", re.IGNORECASE,
            ) for message in (first_error, last_error))
            db.execute("""UPDATE integration_events SET first_error=?, last_error=?, retryable=?
                          WHERE target_key=? AND integration_event_id=?""",
                       (first_error, last_error, 0 if permanent else row["retryable"],
                        row["target_key"], row["integration_event_id"]))
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES ('integration_retry_schema','2')")


def init(args):
    payload = json.loads(sys_stdin() or "{}")
    db = connect(args.knowledge_root, initializing=True)
    upgrade_schema(db)
    with db:
        bind_target(db, payload)


def import_legacy(args):
    """Import a detached legacy catalog without replaying submissions or novelty."""
    import tempfile
    payload = json.loads(sys_stdin() or "{}")
    scope = target_key(payload.get("target"))
    if not scope:
        raise ValueError("Legacy import requires an explicit workspace/op/dtype target")
    source_root = Path(args.source_knowledge_root).resolve()
    root = Path(args.knowledge_root).resolve()
    if root == source_root:
        raise ValueError("Legacy import requires a separate destination; original evidence stays in place")
    source_path = source_root / "catalog.sqlite"
    if not source_path.is_file():
        raise ValueError("Legacy source catalog is missing")
    wal = Path(str(source_path) + '-wal')
    if wal.exists() and wal.stat().st_size:
        raise ValueError("Legacy catalog has an active WAL; quiesce and checkpoint it with its original runtime before importing")
    root.mkdir(parents=True, exist_ok=True)
    lock = root / ".legacy-import.lock"
    with lock.open("x", encoding="utf-8") as locked:
        locked.write(scope)
    try:
        source = sqlite3.connect(source_path.as_uri() + "?mode=ro&immutable=1", uri=True)
        source.row_factory = sqlite3.Row
        fingerprint = hashlib.sha256("\n".join(source.iterdump()).encode("utf-8")).hexdigest()
        provenance = dict(source_root=str(source_root), source_fingerprint=fingerprint, target=payload["target"])
        destination = connect(root, initializing=True)
        upgrade_schema(destination)
        prior = destination.execute("SELECT value FROM metadata WHERE key='legacy_import'").fetchone()
        if prior:
            previous = json.loads(prior["value"])
            if any(previous.get(key) != value for key, value in provenance.items()):
                raise ValueError("Destination already imported a different legacy source or target")
            print(json.dumps(dict(ok=True, imported=False, **previous)))
            return
        tables = [row["name"] for row in destination.execute("SELECT name FROM sqlite_master WHERE type='table'")
                  if row["name"] not in ("metadata", "targets")]
        if any(destination.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() for table in tables):
            raise ValueError("Legacy import refuses a nonempty destination catalog")
        existing_workspace = destination.execute("SELECT value FROM metadata WHERE key='workspace_id'").fetchone()
        if existing_workspace and existing_workspace["value"] != payload["target"]["workspace_id"]:
            raise ValueError("Destination belongs to another workspace")
        with tempfile.TemporaryDirectory(prefix="meteor-catalog-import-") as temp:
            staging = sqlite3.connect(Path(temp) / "catalog.sqlite")
            source.backup(staging)
            staging.row_factory = sqlite3.Row
            version = staging.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()
            if not version or int(version["value"]) not in (1, 2, SCHEMA_VERSION):
                raise ValueError("Unsupported legacy source schema")
            upgrade_schema(staging)
            if any(staging.execute(f"SELECT 1 FROM {table} WHERE target_key <> '' LIMIT 1").fetchone() for table in tables):
                raise ValueError("Legacy source already contains workspace targets")
            staging.execute("PRAGMA foreign_keys=ON")
            with staging:
                bind_target(staging, payload)
                for table in tables:
                    staging.execute(f"UPDATE {table} SET target_key = ? WHERE target_key = ''", (scope,))
                # Retain event states and leases. No historical event is newly enqueued.
                for table in ("integration_events", "integration_channels"):
                    staging.execute(f"UPDATE {table} SET channel = ? || '|' || channel WHERE target_key = ?", (scope, scope))
                provenance.update(imported_at=now_iso(), counts={table: staging.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables})
                staging.execute("INSERT INTO metadata(key,value) VALUES ('legacy_import',?)", (canonical(provenance),))
            staging.backup(destination)
            staging.close()
        destination.close()
        source.close()
        print(json.dumps(dict(ok=True, imported=True, **provenance)))
    finally:
        lock.unlink(missing_ok=True)


def import_submission(args):
    payload = json.loads(sys_stdin() or "{}")
    db = connect(args.knowledge_root)
    envelope = json.loads(Path(args.commit_json).read_text(encoding="utf-8"))
    validate_envelope(envelope)
    with db:
        scope = bind_target(db, payload)
        import_envelope(db, envelope, scope=scope, payload=payload)
        write_knowledge_documents(args.knowledge_root, envelope)


def commit_submission(args):
    payload = json.loads(sys_stdin())
    db = connect(args.knowledge_root)
    validate_envelope(payload["commit"])
    with db:
        scope = bind_target(db, payload)
        import_envelope(db, payload["commit"], payload["report"], payload["event"], scope, payload)
        write_knowledge_documents(args.knowledge_root, payload["commit"])
    print(json.dumps({"ok": True}))


def validate_envelope(envelope):
    require_path(envelope, "submission_id")
    require_path(envelope, "submission_hash")
    require_path(envelope, "committed_at")
    submission = require_path(envelope, "submission")
    require_path(submission, "research_id")
    require_path(submission, "agent_session_id")
    require_path(submission, "execution_backend")
    hypothesis = require_path(submission, "hypothesis")
    for key in ("hypothesis_id", "revision", "statement", "scope", "mechanism", "verdict"):
        require_path(hypothesis, key, "submission.hypothesis")
    for index, experiment in enumerate(require_list(submission, "experiments")):
        base = f"submission.experiments.{index}"
        for key in ("experiment_id", "hypothesis_revision", "question", "intervention", "analysis"):
            require_path(experiment, key, base)
    for index, kernel in enumerate(require_list(submission, "submitted_kernels")):
        base = f"submission.submitted_kernels.{index}"
        for key in (
            "kernel_id", "revision", "source_hash", "case_suite_revision", "environment_ref",
            "measurement_protocol_ref", "full_size_test_ref", "data_hash", "recommended_domain",
            "supported_domain",
        ):
            require_path(kernel, key, base)
    for index, claim in enumerate(require_list(submission, "knowledge_updates")):
        base = f"submission.knowledge_updates.{index}"
        for key in ("claim_id", "kind", "statement", "scope"):
            require_path(claim, key, base)
        require_list(claim, "evidence_refs", base)
        require_list(claim, "related_material_ids", base)
        normalize_knowledge_scope(claim)
    chief_report = require_path(submission, "chief_report")
    require_path(chief_report, "summary", "submission.chief_report")


def require_path(value, key, base=None):
    if not isinstance(value, dict) or key not in value:
        path = f"{base}.{key}" if base else key
        raise ValueError(f"Missing required submission field before knowledge import: {path}")
    return value[key]


def require_list(value, key, base=None):
    current = require_path(value, key, base)
    if not isinstance(current, list):
        path = f"{base}.{key}" if base else key
        raise ValueError(f"Required submission field must be a list before knowledge import: {path}")
    return current


def put(db, table, scope, values, ignore=False):
    columns = ["target_key"] + list(values)
    action = "IGNORE" if ignore else "REPLACE"
    db.execute(f"INSERT OR {action} INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
               [scope] + list(values.values()))


def related_material(db, scope, ref):
    """Resolve catalog references for progress without changing their evidence origin."""
    from urllib.parse import unquote
    origin, kind, local_id = scope, None, ref
    qualified = ref.startswith('sqlite://') or '#' in ref
    if ref.startswith('sqlite://'):
        parts = ref[len('sqlite://'):].split('/', 1)
        if len(parts) != 2:
            raise ValueError('Invalid related material sqlite ref')
        kind, local_id = unquote(parts[0]), unquote(parts[1])
    if '#' in local_id:
        origin, identity = local_id.split('#', 1)
        pieces = identity.split('/', 1)
        if len(pieces) != 2 or (kind and kind != pieces[0]):
            raise ValueError('Related material kind does not match its qualified identity')
        kind, local_id = pieces
    if origin != scope:
        current = db.execute('SELECT workspace_id FROM targets WHERE target_key=?', (scope,)).fetchone()
        target = db.execute('SELECT workspace_id FROM targets WHERE target_key=?', (origin,)).fetchone()
        if not current or not target or not current['workspace_id'] or current['workspace_id'] != target['workspace_id']:
            raise ValueError('Related progress must remain inside the same hardware workspace')
    if qualified:
        if kind == 'kernel':
            found = db.execute("SELECT 1 FROM kernel_submissions WHERE target_key=? AND kernel_id || '@' || revision=? LIMIT 1", (origin, local_id)).fetchone()
        else:
            found = db.execute('SELECT 1 FROM knowledge_claims WHERE target_key=? AND claim_id=? AND kind=?', (origin, local_id, kind)).fetchone()
        if not found:
            raise ValueError('Qualified related material does not exist in the shared catalog')
    return origin, local_id


def import_envelope(db, envelope, report=None, event=None, scope="", payload=None):
    payload = payload or {}
    submission = envelope["submission"]
    if target_key(submission.get("target")) != scope:
        raise ValueError("Submission target does not match the runtime-bound target")
    submission_id, committed_at = envelope["submission_id"], envelope["committed_at"]
    hypothesis = submission["hypothesis"]
    identity = payload.get("identity", {})
    put(db, "research_runs", scope, dict(
        research_id=submission["research_id"], agent_session_id=submission["agent_session_id"],
        backend=submission["execution_backend"],
        **{key: identity.get(key, first_kernel_field(submission, key)) for key in
           ("case_suite_revision", "environment_ref", "measurement_protocol_ref")},
        run_status="CLOSED", research_goal_met=int(bool(envelope.get("research_goal_met"))),
        created_at=committed_at, updated_at=committed_at))
    put(db, "hypotheses", scope, dict(hypothesis_id=hypothesis["hypothesis_id"],
        latest_revision=hypothesis["revision"], **{key: hypothesis[key] for key in ("statement", "scope", "mechanism")}))
    put(db, "hypothesis_revisions", scope, dict(
        **{key: hypothesis[key] for key in ("hypothesis_id", "revision", "statement", "scope", "mechanism", "verdict")},
        submission_id=submission_id, created_at=committed_at))
    for experiment in submission.get("experiments", []):
        put(db, "experiments", scope, dict(
            **{key: experiment[key] for key in ("experiment_id", "hypothesis_revision", "question", "intervention", "analysis")},
            research_id=submission["research_id"], submission_id=submission_id))
    for kernel in submission.get("submitted_kernels", []):
        put(db, "kernel_submissions", scope, dict(
            **{key: kernel[key] for key in ("kernel_id", "revision", "source_hash", "case_suite_revision",
               "environment_ref", "measurement_protocol_ref", "full_size_test_ref", "data_hash",
               "recommended_domain", "supported_domain")},
            research_id=submission["research_id"], submission_id=submission_id))
        receipt_path = Path(kernel["full_size_test_ref"])
        if not receipt_path.is_absolute():
            receipt_path = Path(payload.get("workspace_root", ".")) / receipt_path
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            if scope:
                raise ValueError("Submitted full-size receipt is unreadable; measurements cannot be omitted from the catalog")
            receipt = None
        if receipt:
            if target_key(receipt.get("target")) != scope:
                raise ValueError("Measurement target differs from submitted target")
            for row in receipt.get("rows", []):
                put(db, "case_measurements", scope, dict(submission_id=submission_id,
                    kernel_id=kernel["kernel_id"], revision=kernel["revision"], case_id=row["case_id"],
                    status=row["status"], median_us=row.get("median_us"), reason=row.get("reason")))

    def novelty(material, reason, identity, content, material_scope=None):
        # Novelty identity includes the target, while freshness timestamps remain observations.
        material_scope = scope if material_scope is None else material_scope
        content_hash = short_hash(content)
        # Imported event IDs remain untouched. Re-submitting their exact content
        # is still not progress, even though new event IDs include target scope.
        if db.execute('SELECT 1 FROM novelty_events WHERE target_key=? AND material_id=? AND reason=? AND content_hash=? LIMIT 1',
                      (material_scope, material, reason, content_hash)).fetchone():
            return
        put(db, "novelty_events", material_scope, dict(
            novelty_event_id="novelty_" + short_hash(dict(target_key=material_scope, **identity)),
            material_id=material, backend=submission["execution_backend"], reason=reason,
            content_hash=content_hash, created_at=committed_at, submission_id=submission_id), ignore=True)

    for claim in submission.get("knowledge_updates", []):
        knowledge_scope = normalize_knowledge_scope(claim)
        knowledge_ref, _ = knowledge_document(envelope, claim)
        put(db, "knowledge_claims", scope, dict(
            **{key: claim[key] for key in ("claim_id", "kind", "statement", "scope")},
            category=claim.get("category", "research"),
            applicability='hardware' if knowledge_scope['scope_level'] == 'hardware' else 'target',
            scope_level=knowledge_scope['scope_level'],
            shape_range=canonical(knowledge_scope['shape_range']) if 'shape_range' in knowledge_scope else None,
            knowledge_ref=knowledge_ref,
            submission_id=submission_id, created_at=committed_at))
        for evidence in claim.get("evidence_refs", []):
            put(db, "evidence_links", scope, dict(claim_id=claim["claim_id"], evidence_ref=evidence), ignore=True)
        content = dict(statement=claim["statement"], scope=claim["scope"], evidence_refs=sorted(claim.get("evidence_refs", [])))
        if 'scope_level' in claim or 'shape_range' in claim:
            content.update(knowledge_scope)
        novelty(claim["claim_id"], "knowledge_update", dict(kind=claim["kind"], **content), content)
        for related in claim.get("related_material_ids", []):
            origin, local_id = related_material(db, scope, related)
            novelty(local_id, "related_progress", dict(related_material_id=local_id, author_target_key=scope, content_hash=short_hash(content)), content, origin)
    if hypothesis["verdict"] in ("SUPPORTED", "REFUTED"):
        novelty(hypothesis["hypothesis_id"], "hypothesis_verdict",
                {key: hypothesis[key] for key in ("hypothesis_id", "revision", "verdict")},
                dict(statement=hypothesis["statement"], verdict=hypothesis["verdict"],
                     evidence=sorted(hypothesis.get("supporting_evidence", []) + hypothesis.get("counterevidence", []))))
    for kernel in submission.get("submitted_kernels", []):
        novelty(f"{kernel['kernel_id']}@{kernel['revision']}", "submitted_kernel",
                {key: kernel[key] for key in ("kernel_id", "revision", "source_hash", "data_hash")},
                dict(source_hash=kernel["source_hash"], data_hash=kernel["data_hash"],
                     recommended_case_ids=sorted(kernel.get("recommended_case_ids", []))))
    put(db, "research_commits", scope, dict(submission_id=submission_id, research_id=submission["research_id"],
        submission_hash=envelope["submission_hash"], report_ref=envelope["report_ref"], committed_at=committed_at))
    summary = report["report"]["summary"] if report else submission["chief_report"]["summary"]
    put(db, "research_reports", scope, dict(submission_id=submission_id, research_id=submission["research_id"],
        summary=summary, report_ref=envelope["report_ref"]))
    if event:
        if target_key(event.get("target")) != scope:
            raise ValueError("Integration event target differs from submitted target")
        channel = event.get("channel") or "default"
        put(db, "integration_events", scope, dict(integration_event_id=event["integration_event_id"],
            submission_id=event["submission_id"], channel=channel, status=event["status"],
            created_at=event["created_at"], updated_at=event["updated_at"]), ignore=True)
        put(db, "integration_channels", scope, dict(channel=channel, updated_at=event["created_at"]), ignore=True)


def list_events(args):
    payload = json.loads(sys_stdin() or "{}")
    db = connect(args.knowledge_root)
    scope = bind_target(db, payload)
    events = [
        integration_event_dict(row) for row in db.execute(
            """
            SELECT integration_event_id, submission_id, channel, status, created_at, updated_at,
                   result_ref, error, retryable, failure_count, first_error, last_error
            FROM integration_events WHERE target_key = ?
            ORDER BY created_at, integration_event_id
            """, (scope,)
        ).fetchall()
    ]
    print(json.dumps({"ok": True, "events": events}))


def claim_event(args):
    payload = json.loads(sys_stdin())
    event_id = payload["event_id"]
    token = payload["token"]
    lease_seconds = int(payload.get("lease_seconds", 300))
    db = connect(args.knowledge_root)
    try:
        # Serialize the eligibility checks with both event and channel writes.
        db.execute("BEGIN IMMEDIATE")
        scope = bind_target(db, payload)
        row = db.execute(
            "SELECT * FROM integration_events WHERE target_key = ? AND integration_event_id = ?",
            (scope, event_id),
        ).fetchone()
        if not row:
            db.rollback()
            print(json.dumps({"ok": True, "claimed": False}))
            return
        if payload.get("channel") is not None and row["channel"] != payload["channel"]:
            db.rollback()
            print(json.dumps({"ok": True, "claimed": False}))
            return
        now = now_iso()
        expired = row["lease_expires_at"] is not None and row["lease_expires_at"] < now
        exhausted = int(row["failure_count"] or 0) >= MAX_INTEGRATION_FAILURES
        if row["status"] == "FAILED" and (not bool(row["retryable"]) or exhausted):
            db.rollback()
            print(json.dumps({"ok": True, "claimed": False}))
            return
        if row["status"] not in ("QUEUED", "FAILED") and not expired:
            db.rollback()
            print(json.dumps({"ok": True, "claimed": False}))
            return
        channel = row["channel"]
        channel_row = db.execute("SELECT * FROM integration_channels WHERE target_key = ? AND channel = ?", (scope, channel)).fetchone()
        channel_expired = (not channel_row) or channel_row["lease_expires_at"] is None or channel_row["lease_expires_at"] < now
        if channel_row and channel_row["active_event_id"] and channel_row["active_event_id"] != event_id and not channel_expired:
            db.rollback()
            print(json.dumps({"ok": True, "claimed": False}))
            return
        updated_at = now_iso()
        lease_expires_at = (datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)).isoformat().replace("+00:00", "Z")
        db.execute(
            "UPDATE integration_events SET status = ?, claim_token = ?, lease_expires_at = ?, updated_at = ? WHERE target_key = ? AND integration_event_id = ?",
            ("SELECTING", token, lease_expires_at, updated_at, scope, event_id),
        )
        db.execute(
            """
            INSERT INTO integration_channels(target_key, channel, active_event_id, lease_token, lease_expires_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(target_key, channel) DO UPDATE SET
              active_event_id = excluded.active_event_id,
              lease_token = excluded.lease_token,
              lease_expires_at = excluded.lease_expires_at,
              updated_at = excluded.updated_at
            """,
            (scope, channel, event_id, token, lease_expires_at, updated_at),
        )
        event = integration_event_dict(db.execute("SELECT * FROM integration_events WHERE target_key = ? AND integration_event_id = ?", (scope, event_id)).fetchone())
        db.commit()
    except Exception:
        db.rollback()
        raise
    print(json.dumps({"ok": True, "claimed": True, "event": event}))


def finish_event(args):
    payload = json.loads(sys_stdin())
    db = connect(args.knowledge_root)
    try:
        db.execute("BEGIN IMMEDIATE")
        scope = bind_target(db, payload)
        row = db.execute("SELECT * FROM integration_events WHERE target_key = ? AND integration_event_id = ?", (scope, payload["event_id"])).fetchone()
        if not row or row["claim_token"] != payload.get("token"):
            db.rollback()
            print(json.dumps({"ok": False, "error": "lease token mismatch"}))
            return
        finished_at = now_iso()
        if payload["status"] == "FAILED":
            current_error = sanitize_error(payload.get("error"))
            next_failure_count = int(row["failure_count"] or 0) + 1
            next_attempt_no = 1 + (db.execute(
                "SELECT COALESCE(MAX(attempt_no), 0) FROM integration_attempts WHERE target_key = ? AND integration_event_id = ?",
                (scope, payload["event_id"]),
            ).fetchone()[0] or 0)
            retryable = bool(payload.get("retryable", True)) and next_failure_count < MAX_INTEGRATION_FAILURES
            first_error = row["first_error"] or row["error"] or current_error
            attempt_id = "attempt_" + short_hash(dict(
                integration_event_id=payload["event_id"],
                claim_token=payload.get("token"),
                attempt_started_at=row["updated_at"],
            ))
            db.execute(
                """
                INSERT INTO integration_attempts(
                  target_key, attempt_id, integration_event_id, attempt_no, status, error_class, retryable, error, started_at, finished_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    scope,
                    attempt_id,
                    payload["event_id"],
                    next_attempt_no,
                    "FAILED",
                    payload.get("error_class"),
                    int(retryable),
                    current_error,
                    row["updated_at"],
                    finished_at,
                ),
            )
            event_update = db.execute(
                """
                UPDATE integration_events
                SET status = ?, result_ref = ?, error = ?, first_error = ?, last_error = ?,
                    retryable = ?, failure_count = ?, updated_at = ?, lease_expires_at = NULL, claim_token = NULL
                WHERE target_key = ? AND integration_event_id = ? AND claim_token = ?
                """,
                (
                    "FAILED",
                    payload.get("result_ref"),
                    first_error,
                    first_error,
                    current_error,
                    int(retryable),
                    next_failure_count,
                    finished_at,
                    scope,
                    payload["event_id"],
                    payload.get("token"),
                ),
            )
        else:
            event_update = db.execute(
                """
                UPDATE integration_events
                SET status = ?, result_ref = ?, error = NULL, first_error = NULL, last_error = NULL,
                    retryable = 0, updated_at = ?, lease_expires_at = NULL, claim_token = NULL
                WHERE target_key = ? AND integration_event_id = ? AND claim_token = ?
                """,
                (
                    payload["status"],
                    payload.get("result_ref"),
                    finished_at,
                    scope,
                    payload["event_id"],
                    payload.get("token"),
                ),
            )
        if payload["status"] in ("ASSEMBLED", "SKIPPED", "NO_CHANGE"):
            channel_update = db.execute(
                "UPDATE integration_channels SET active_event_id = NULL, lease_token = NULL, lease_expires_at = NULL, current_version_ref = COALESCE(?, current_version_ref), generation = generation + 1, updated_at = ? WHERE target_key = ? AND channel = ? AND lease_token = ? AND active_event_id = ?",
                (payload.get("result_ref"), finished_at, scope, row["channel"], payload.get("token"), payload["event_id"]),
            )
        else:
            channel_update = db.execute(
                "UPDATE integration_channels SET active_event_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE target_key = ? AND channel = ? AND lease_token = ? AND active_event_id = ?",
                (finished_at, scope, row["channel"], payload.get("token"), payload["event_id"]),
            )
        if event_update.rowcount != 1 or channel_update.rowcount != 1:
            db.rollback()
            print(json.dumps({"ok": False, "error": "lease token mismatch"}))
            return
        db.commit()
    except Exception:
        db.rollback()
        raise
    print(json.dumps({"ok": True}))


def integration_event_dict(row):
    value = dict(row)
    if "retryable" in value:
        value["retryable"] = bool(value["retryable"])
    return value


def sanitize_error(value):
    if value is None:
        return None
    text = str(value)
    return text.replace("\r", " ").replace("\n", " ")[:4000]


def list_materials(args):
    payload = json.loads(sys_stdin() or "{}")
    backend = payload.get("backend")
    db = connect(args.knowledge_root)
    scope = bind_target(db, payload)
    all_targets = bool(payload.get('all_targets')) and bool(scope)
    claims = db.execute("""
        SELECT target_key, claim_id AS material_id, kind, statement, scope, submission_id, category, applicability,
               scope_level, shape_range, knowledge_ref
        FROM knowledge_claims WHERE (? OR target_key = ?)
    """, (all_targets, scope)).fetchall()
    kernels = db.execute("""
        SELECT target_key, kernel_id || '@' || revision AS material_id, 'kernel' AS kind,
               source_hash || ' ' || recommended_domain AS statement,
               supported_domain AS scope, submission_id, 'research' AS category, 'target' AS applicability,
               'dtype' AS scope_level, NULL AS shape_range, NULL AS knowledge_ref
        FROM kernel_submissions WHERE (? OR target_key = ?)
    """, (all_targets, scope)).fetchall()
    novelty_rows = db.execute("""
        SELECT target_key, material_id, MAX(created_at) AS last_novelty_event_at
        FROM novelty_events WHERE (? OR target_key = ?) AND (? IS NULL OR backend = ?)
        GROUP BY target_key, material_id
    """, (all_targets, scope, backend, backend)).fetchall()
    novelty = {(row['target_key'], row['material_id']): row['last_novelty_event_at'] for row in novelty_rows}
    targets = {row['target_key']: {key: row[key] for key in ('workspace_id', 'op_id', 'dtype_id')}
               for row in db.execute('SELECT * FROM targets')}
    materials = [dict(dict(row), **normalize_knowledge_scope(dict(row)),
                      material_key=(row['target_key'] + '#' if row['target_key'] else '') + row['kind'] + '/' + row['material_id'],
                      last_novelty_event_at=novelty.get((row['target_key'], row['material_id']), '1970-01-01T00:00:00Z'),
                      **({'target': targets[row['target_key']]} if row['target_key'] else {})) for row in list(claims) + list(kernels)]
    for material in materials:
        if material.get('shape_range') is None:
            material.pop('shape_range', None)
    print(json.dumps({"ok": True, "materials": materials}))


def first_kernel_field(submission, key):
    kernels = submission.get("submitted_kernels", [])
    if kernels:
        return kernels[0].get(key, "")
    return ""


def sys_stdin():
    import sys
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    return sys.stdin.read()


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(required=True)
    init_parser = sub.add_parser("init")
    init_parser.add_argument("knowledge_root")
    init_parser.set_defaults(func=init)
    legacy_parser = sub.add_parser("import-legacy")
    legacy_parser.add_argument("knowledge_root")
    legacy_parser.add_argument("source_knowledge_root")
    legacy_parser.set_defaults(func=import_legacy)
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
