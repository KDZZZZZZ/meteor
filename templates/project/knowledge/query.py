#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path
from store import knowledge_scope_matches, normalize_knowledge_scope, normalize_knowledge_shape, target_key


def connect(root):
    db = sqlite3.connect((Path(root).resolve() / "catalog.sqlite").as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    version = db.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()
    if not version or int(version["value"]) not in (2, 3):
        raise ValueError("Query runtime requires catalog schema 2 or 3; use the original runtime for legacy catalogs")
    return db


def rows(cursor):
    return [dict(row) for row in cursor.fetchall()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("knowledge_root")
    parser.add_argument("entity", choices=["research", "kernels", "claims", "novelty", "measurements", "prediction-rules", "ir-techniques", "hardware"])
    parser.add_argument("--id")
    parser.add_argument("--target", help="workspace_id/op_id/dtype_id; knowledge inherits HW, op and dtype scopes")
    parser.add_argument("--level", choices=['hardware', 'op', 'dtype', 'shape'], help="Filter knowledge by its declared scope level")
    parser.add_argument("--shape", help='Concrete shape JSON for interval matching, for example {"m":1,"n":16,"k":32}')
    args = parser.parse_args()
    knowledge = args.entity in ('claims', 'prediction-rules', 'ir-techniques', 'hardware')
    if (args.level or args.shape) and not knowledge:
        parser.error('--level and --shape are only supported for knowledge entities')
    shape = normalize_knowledge_shape(json.loads(args.shape)) if args.shape else None
    if shape and not args.target:
        parser.error('--shape requires --target')
    if args.target is not None:
        parts = args.target.split('/')
        if len(parts) != 3:
            parser.error('--target requires workspace_id/op_id/dtype_id')
        target_key(dict(zip(('workspace_id', 'op_id', 'dtype_id'), parts)))
    db = connect(args.knowledge_root)
    table, identity = {"research": ("research_runs", "research_id"), "kernels": ("kernel_submissions", "kernel_id"),
                       "claims": ("knowledge_claims", "claim_id"), "novelty": ("novelty_events", "material_id"),
                       "measurements": ("case_measurements", "case_id"), "prediction-rules": ("prediction_rules", "claim_id"),
                       "ir-techniques": ("ir_techniques", "claim_id"), "hardware": ("hardware_knowledge", "claim_id")}[args.entity]
    conditions, params = [], []
    if args.target is not None and not knowledge:
        conditions.append("target_key = ?")
        params.append(args.target)
    if args.id:
        conditions.append(identity + " = ?")
        params.append(args.id)
    sql = "SELECT * FROM " + table + (" WHERE " + " AND ".join(conditions) if conditions else "")
    if args.entity == "novelty":
        sql += " ORDER BY created_at DESC"
    result = rows(db.execute(sql, params))
    if knowledge:
        result = [dict(row, **normalize_knowledge_scope(row)) for row in result]
        if args.level:
            result = [row for row in result if row['scope_level'] == args.level]
        if args.target:
            result = [row for row in result if knowledge_scope_matches(row, args.target, shape)]
        for row in result:
            row['scope_validation'] = 'author_declared'
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
