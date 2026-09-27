"""Strict-size comparison of NPU output against the isolated case oracle."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import numpy as np


def read_exact(path, dtype, count):
    data = Path(path).read_bytes()
    expected = np.dtype(dtype).itemsize * count
    if len(data) != expected:
        raise ValueError(f"incorrect size for {path}: {len(data)} bytes, expected {expected}")
    return np.frombuffer(data, dtype=dtype)


def verify_case(directory):
    directory = Path(directory)
    metadata = json.loads((directory / "case.json").read_text(encoding="utf-8"))
    m, n = metadata["m"], metadata["n"]
    if metadata.get("format_version") != 1 or not isinstance(m, int) or not isinstance(n, int) or min(m, n) <= 0:
        raise ValueError("unsupported or invalid case metadata")
    expected_files = {"input/x1.bin", "input/x2.bin", "input/x1Scale.bin", "input/x2Scale.bin", "golden/y.bin", "golden/yScale.bin"}
    if set(metadata["files"]) != expected_files:
        raise ValueError("missing or unexpected case file path")
    for name, record in metadata["files"].items():
        data = (directory / name).read_bytes()
        if len(data) != record["bytes"] or sha256(data).hexdigest() != record["sha256"]:
            raise ValueError(f"case input/golden changed: {name}")
    expected_y = read_exact(directory / "golden/y.bin", np.int8, m * n)
    expected_scale = read_exact(directory / "golden/yScale.bin", "<f4", m)
    actual_y = read_exact(directory / "output/y.bin", np.int8, m * n)
    actual_scale = read_exact(directory / "output/yScale.bin", "<f4", m)
    y_mismatch = actual_y != expected_y
    y_errors = int(np.count_nonzero(y_mismatch))
    finite = np.isfinite(actual_scale)
    if not np.all(np.isfinite(expected_scale)):
        raise ValueError("golden scale is nonfinite")
    # Fixed statement tolerances; metadata cannot silently loosen these checks.
    scale_close = finite & np.isclose(actual_scale, expected_scale, rtol=1e-4, atol=1e-4, equal_nan=False)
    scale_errors = int(np.count_nonzero(~scale_close))
    difference = np.abs(actual_scale[finite].astype(np.float64) - expected_scale[finite].astype(np.float64))
    denominator = np.maximum(np.abs(expected_scale[finite].astype(np.float64)), np.finfo(np.float32).tiny)
    first = np.flatnonzero(y_mismatch)[:8]
    first_scale = np.flatnonzero(~scale_close)[:8]
    result = {
        "passed": y_errors == 0 and scale_errors / m <= 1e-4,
        "shape": {"m": m, "n": n, "k": metadata["k"]}, "seed": metadata["seed"], "mode": metadata["mode"],
        "y": {"elements": m * n, "mismatches": y_errors,
              "max_abs_error": int(np.max(np.abs(actual_y.astype(np.int16) - expected_y.astype(np.int16)))),
              "first_mismatches": [{"row": int(i // n), "col": int(i % n), "actual": int(actual_y[i]), "expected": int(expected_y[i])} for i in first]},
        "yScale": {"elements": m, "mismatches": scale_errors, "error_fraction": scale_errors / m,
                   "nonfinite_outputs": int(np.count_nonzero(~finite)),
                   "first_mismatches": [{"row": int(i),
                                         "actual": float(actual_scale[i]) if finite[i] else str(actual_scale[i]),
                                         "expected": float(expected_scale[i])} for i in first_scale],
                   "max_abs_error_finite": float(difference.max()) if difference.size else None,
                   "max_relative_error_finite": float((difference / denominator).max()) if difference.size else None,
                   "rtol": 1e-4, "atol": 1e-4, "max_error_fraction": 1e-4},
        "scope": "Independent generated-case accuracy only, not official hidden-case correctness or performance.",
    }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case_directory", type=Path)
    parser.add_argument("--report", type=Path, help="Optional JSON result file")
    args = parser.parse_args()
    try:
        result = verify_case(args.case_directory)
    except (ValueError, OSError, KeyError, TypeError) as error:
        result = {"passed": False, "error": str(error)}
    text = json.dumps(result, indent=2, allow_nan=False) + "\n"
    if args.report:
        args.report.write_text(text, encoding="utf-8")
    print(text, end="")
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
