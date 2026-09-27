"""Generate an isolated INT8 test case and an exact-integer/FP32 oracle."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import numpy as np


_ORACLE_BLOCK_ROWS = 128
_ORACLE_RHS_BYTES = 64 * 1024 * 1024


def _accumulator_dtype(k):
    # Project-derived exactness bound, not a NumPy accuracy guarantee: INT8
    # products are integers with absolute value <= 16384. Every partial sum of
    # at most K products therefore lies in [-K*16384, K*16384]. Binary64 exactly
    # represents every integer in [-2**53, 2**53], including those products and
    # partial sums, regardless of their reduction order (also for fused MACs).
    # NumPy matmul uses optimized BLAS when possible:
    # https://numpy.org/doc/2.3/reference/generated/numpy.matmul.html
    return np.float64 if k * 16384 <= 2**53 else np.int64


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

    accumulator_dtype = _accumulator_dtype(k)
    # Bound temporary storage independently of M*N. Cache a modest converted
    # right operand once; larger operands are converted one N slice at a time.
    # Only the returned INT8 result occupies M*N elements across all row blocks.
    column_block = min(n, max(1, _ORACLE_RHS_BYTES // (k * 8)))
    right = x2.astype(accumulator_dtype) if column_block == n else None
    y = np.empty((m, n), dtype=np.int8)
    scale = np.ones(m, dtype=np.float32)
    bounds = np.iinfo(np.int32)
    low, high = bounds.max, bounds.min
    for row_start in range(0, m, _ORACLE_BLOCK_ROWS):
        rows = slice(row_start, min(m, row_start + _ORACLE_BLOCK_ROWS))
        left = x1[rows].astype(accumulator_dtype)
        activation = np.empty((left.shape[0], n), dtype=np.float32)
        for column_start in range(0, n, column_block):
            columns = slice(column_start, min(n, column_start + column_block))
            rhs = right if right is not None else x2[columns].astype(accumulator_dtype)
            accumulator = np.matmul(left, rhs.T)
            block_low, block_high = int(accumulator.min()), int(accumulator.max())
            if block_low < bounds.min or block_high > bounds.max:
                raise ValueError(f"integer accumulator outside INT32: [{block_low}, {block_high}]")
            low, high = min(low, block_low), max(high, block_high)
            # Materialize each FP32 stage separately; do not fuse scale products.
            value = accumulator.astype(np.int32).astype(np.float32)
            np.multiply(value, x1_scale[rows, None], out=value, dtype=np.float32)
            np.multiply(value, x2_scale[None, columns], out=value, dtype=np.float32)
            np.maximum(value, np.float32(0.0), out=activation[:, columns])
        row_max = activation.max(axis=1)
        row_scale = scale[rows]
        positive = row_max > np.float32(0.0)
        row_scale[positive] = np.divide(row_max[positive], np.float32(127.0), dtype=np.float32)
        if not np.all(np.isfinite(activation)) or not np.all(np.isfinite(row_scale)) or not np.all(row_scale > 0):
            raise ValueError("FP32 overflow or scale underflow outside this generated test domain")
        np.divide(activation, row_scale[:, None], out=activation, dtype=np.float32)
        np.rint(activation, out=activation)
        np.clip(activation, np.float32(-128.0), np.float32(127.0), out=activation)
        y[rows] = activation.astype(np.int8)
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
        "oracle": "Exact integer matmul (FP64 when K*16384<=2**53, otherwise INT64), row-blocked; assert INT32 range; FP32 cast, multiply token then channel, ReLU, max/127, RNE, clip",
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
