"""Generate an isolated INT8 test case and an exact-integer/FP32 oracle."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import numpy as np


def oracle(x1, x2, x1_scale, x2_scale):
    if x1.dtype != np.int8 or x2.dtype != np.int8 or x1.ndim != 2 or x2.ndim != 2:
        raise ValueError("x1/x2 must be INT8 matrices")
    m, k = x1.shape
    n, k2 = x2.shape
    if min(m, n, k) <= 0 or k != k2 or k * 16384 > np.iinfo(np.int64).max:
        raise ValueError("invalid shape or INT64 accumulator bound")
    if x1_scale.shape != (m,) or x2_scale.shape != (n,):
        raise ValueError("scale shape mismatch")
    if x1_scale.dtype != np.float32 or x2_scale.dtype != np.float32:
        raise ValueError("scales must be FP32")
    if not (np.all(np.isfinite(x1_scale)) and np.all(x1_scale > 0)
            and np.all(np.isfinite(x2_scale)) and np.all(x2_scale > 0)):
        raise ValueError("this harness requires positive finite scales")

    accumulator = x1.astype(np.int64) @ x2.astype(np.int64).T
    bounds = np.iinfo(np.int32)
    low, high = int(accumulator.min()), int(accumulator.max())
    if low < bounds.min or high > bounds.max:
        raise ValueError(f"integer accumulator outside INT32: [{low}, {high}]")
    # Materialize each FP32 stage separately; do not fuse the two scale products.
    value = accumulator.astype(np.int32).astype(np.float32)
    value = np.multiply(value, x1_scale[:, None], dtype=np.float32)
    value = np.multiply(value, x2_scale[None, :], dtype=np.float32)
    activation = np.maximum(value, np.float32(0.0))
    row_max = activation.max(axis=1)
    scale = np.ones(m, dtype=np.float32)
    positive = row_max > np.float32(0.0)
    scale[positive] = np.divide(row_max[positive], np.float32(127.0), dtype=np.float32)
    if not np.all(np.isfinite(activation)) or not np.all(np.isfinite(scale)) or not np.all(scale > 0):
        raise ValueError("FP32 overflow or scale underflow outside this generated test domain")
    quotient = np.divide(activation, scale[:, None], dtype=np.float32)
    y = np.clip(np.rint(quotient), np.float32(-128.0), np.float32(127.0)).astype(np.int8)
    return y, scale, {"accumulator_min": low, "accumulator_max": high}


def generate_case(directory, m, n, k, seed, mode="random"):
    if not all(1 <= x <= np.iinfo(np.uint32).max for x in (m, n, k)):
        raise ValueError("M/N/K must be positive uint32 values")
    if not 0 <= seed <= np.iinfo(np.uint64).max:
        raise ValueError("seed must be a uint64 value")
    if mode not in ("random", "zero-row", "all-zero"):
        raise ValueError("unknown mode")
    directory = Path(directory)
    if directory.exists() and any(directory.iterdir()):
        raise FileExistsError(f"case directory must be new or empty: {directory}")
    rng = np.random.default_rng(seed)
    x1 = rng.integers(-128, 128, size=(m, k), dtype=np.int16).astype(np.int8)
    x2 = rng.integers(-128, 128, size=(n, k), dtype=np.int16).astype(np.int8)
    for array in (x1, x2):
        forced = np.array([-128, 127, 0, -1], dtype=np.int8)
        count = min(array.size, forced.size)
        array.flat[:count] = forced[:count]
    if mode == "zero-row":
        x1[0, :] = 0
    elif mode == "all-zero":
        x1[:] = 0
    x1_scale = rng.uniform(0.001, 0.1, size=m).astype(np.float32)
    x2_scale = rng.uniform(0.001, 0.1, size=n).astype(np.float32)
    y, y_scale, accumulator_range = oracle(x1, x2, x1_scale, x2_scale)
    arrays = {
        "input/x1.bin": x1, "input/x2.bin": x2,
        "input/x1Scale.bin": x1_scale.astype("<f4"),
        "input/x2Scale.bin": x2_scale.astype("<f4"),
        "golden/y.bin": y, "golden/yScale.bin": y_scale.astype("<f4"),
    }
    for child in ("input", "golden", "output"):
        (directory / child).mkdir(parents=True, exist_ok=True)
    files = {}
    for name, array in arrays.items():
        data = array.tobytes(order="C")
        (directory / name).write_bytes(data)
        files[name] = {"bytes": len(data), "sha256": sha256(data).hexdigest()}
    metadata = {
        "format_version": 1, "m": m, "n": n, "k": k, "seed": seed, "mode": mode,
        "numpy_version": np.__version__, "rng": "numpy.default_rng / PCG64",
        "int8_range_inclusive": [-128, 127], "scale_uniform_range": [0.001, 0.1],
        "oracle": "INT64 matmul; assert INT32 range; FP32 cast, multiply token then channel, ReLU, max/127, RNE, clip",
        "scale_tolerance": {"rtol": 0.0001, "atol": 0.0001, "max_error_fraction": 0.0001},
        "integer_output_tolerance": 0, **accumulator_range, "files": files,
    }
    (directory / "case.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--m", type=int, required=True)
    parser.add_argument("--n", type=int, required=True)
    parser.add_argument("--k", type=int, required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--mode", choices=("random", "zero-row", "all-zero"), default="random")
    parser.add_argument("--output", type=Path, required=True, help="New or empty case directory")
    args = parser.parse_args()
    try:
        result = generate_case(args.output, args.m, args.n, args.k, args.seed, args.mode)
    except (ValueError, OSError, MemoryError) as error:
        parser.exit(1, f"GENERATION_FAILED: {error}\n")
    print(json.dumps({"case_directory": str(args.output.resolve()), **result}, indent=2))


if __name__ == "__main__":
    main()
