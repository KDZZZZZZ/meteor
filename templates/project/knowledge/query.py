#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path


def connect(root):
    db = sqlite3.connect(Path(root) / "catalog.sqlite")
    db.row_factory = sqlite3.Row
    return db


def rows(cursor):
    return [dict(row) for row in cursor.fetchall()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("knowledge_root")
    parser.add_argument("entity", choices=["research", "kernels", "claims", "novelty", "measurements"])
    parser.add_argument("--id")
    args = parser.parse_args()
    db = connect(args.knowledge_root)
    if args.entity == "research":
        sql = "SELECT * FROM research_runs"
        params = ()
        if args.id:
            sql += " WHERE research_id = ?"
            params = (args.id,)
    elif args.entity == "kernels":
        sql = "SELECT * FROM kernel_submissions"
        params = ()
    elif args.entity == "claims":
        sql = "SELECT * FROM knowledge_claims"
        params = ()
    elif args.entity == "novelty":
        sql = "SELECT * FROM novelty_events ORDER BY created_at DESC"
        params = ()
    else:
        sql = "SELECT * FROM case_measurements"
        params = ()
    print(json.dumps(rows(db.execute(sql, params)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
