import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const python = process.env.PYTHON ?? 'python';
const generator = fileURLToPath(new URL('../templates/project/tools/meteor/runners/remote/gen_case.py', import.meta.url));

// Keep the old, independent INT64 reference here. Comparisons are exact for both
// INT8 output and FP32 scale bits, not the runtime's permitted scale tolerance.
const reference = `
import importlib.util
import sys
import tempfile
from unittest.mock import patch
import numpy as np

spec = importlib.util.spec_from_file_location("gen_case", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def old_reference(x1, x2, x1_scale, x2_scale):
    accumulator = x1.astype(np.int64) @ x2.astype(np.int64).T
    low, high = int(accumulator.min()), int(accumulator.max())
    if low < -2147483648 or high > 2147483647:
        raise ValueError("integer accumulator outside INT32")
    value = accumulator.astype(np.int32).astype(np.float32)
    value = np.multiply(value, x1_scale[:, None], dtype=np.float32)
    value = np.multiply(value, x2_scale[None, :], dtype=np.float32)
    activation = np.maximum(value, np.float32(0.0))
    row_max = activation.max(axis=1)
    scale = np.ones(x1.shape[0], dtype=np.float32)
    positive = row_max > np.float32(0.0)
    scale[positive] = np.divide(row_max[positive], np.float32(127.0), dtype=np.float32)
    if not np.all(np.isfinite(activation)) or not np.all(np.isfinite(scale)) or not np.all(scale > 0):
        raise ValueError("FP32 overflow or scale underflow")
    quotient = np.divide(activation, scale[:, None], dtype=np.float32)
    y = np.clip(np.rint(quotient), np.float32(-128.0), np.float32(127.0)).astype(np.int8)
    return y, scale, {"accumulator_min": low, "accumulator_max": high}

def same(actual, expected):
    assert actual[0].dtype == np.int8
    assert actual[1].dtype == np.float32
    np.testing.assert_array_equal(actual[0], expected[0])
    np.testing.assert_array_equal(actual[1].view(np.uint32), expected[1].view(np.uint32))
    assert actual[2] == expected[2], (actual[2], expected[2])

def random_inputs(m, n, k, seed=73):
    rng = np.random.default_rng(seed)
    return (rng.integers(-128, 128, (m, k), dtype=np.int16).astype(np.int8),
            rng.integers(-128, 128, (n, k), dtype=np.int16).astype(np.int8),
            rng.uniform(0.001, 0.1, m).astype(np.float32),
            rng.uniform(0.001, 0.1, n).astype(np.float32))
`;

function runPython(source: string) {
  const result = spawnSync(python, ['-B', '-c', reference + source, generator], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, OPENBLAS_NUM_THREADS: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('FP64 oracle matches independent INT64 reference for random tails, extremes, and zero rows', () => {
  runPython(`
for i, shape in enumerate([(1, 1, 1), (3, 5, 7), (7, 33, 17), (129, 65, 127)]):
    inputs = random_inputs(*shape, seed=90 + i)
    same(module.oracle(*inputs), old_reference(*inputs))

left = np.stack([np.full(257, -128, dtype=np.int8), np.full(257, 127, dtype=np.int8),
                 np.resize(np.array([-128, 127, -1, 0], dtype=np.int8), 257)])
right = np.stack([left[1], left[0], left[2], np.zeros(257, dtype=np.int8)])
inputs = (left, right, np.array([0.003, 0.007, 0.09], dtype=np.float32),
          np.array([0.04, 0.006, 0.08, 0.02], dtype=np.float32))
same(module.oracle(*inputs), old_reference(*inputs))

inputs = random_inputs(131, 9, 33)
inputs[0][::2] = 0
same(module.oracle(*inputs), old_reference(*inputs))
inputs[0][:] = 0
actual = module.oracle(*inputs)
same(actual, old_reference(*inputs))
assert np.all(actual[0] == 0) and np.all(actual[1] == np.float32(1))
`);
});

test('oracle preserves nearest-even ties and separate FP32 multiplication stages', () => {
  runPython(`
half = np.float32(0.5)
left = np.array([[1], [0], [-1]], dtype=np.int8)
right = np.ones((9, 1), dtype=np.int8)
channel_scale = np.array([np.nextafter(half, np.float32(0)), half,
                         np.nextafter(half, np.float32(1)), 1.5, 2.5, 3.5,
                         126.5, 127, 0.25], dtype=np.float32)
inputs = (left, right, np.ones(3, dtype=np.float32), channel_scale)
with patch.object(module, "_ORACLE_BLOCK_ROWS", 1), patch.object(module, "_ORACLE_RHS_BYTES", 16):
    actual = module.oracle(*inputs)
same(actual, old_reference(*inputs))
np.testing.assert_array_equal(actual[0][0], [0, 0, 1, 2, 2, 4, 126, 127, 0])
np.testing.assert_array_equal(actual[0][1:], np.zeros((2, 9), dtype=np.int8))

inputs = random_inputs(33, 49, 67)
expected = old_reference(*inputs)
same(module.oracle(*inputs), expected)
# This data distinguishes the required intermediate FP32 rounding from folding
# both scale products into one FP64 expression and converting only at the end.
acc = inputs[0].astype(np.int64) @ inputs[1].astype(np.int64).T
fused = (acc.astype(np.float32).astype(np.float64) * inputs[2][:, None] * inputs[3][None, :]).astype(np.float32)
staged = np.multiply(acc.astype(np.float32), inputs[2][:, None], dtype=np.float32)
staged = np.multiply(staged, inputs[3][None, :], dtype=np.float32)
assert np.any(fused.view(np.uint32) != staged.view(np.uint32))
`);
});

test('oracle checks INT32 bounds before conversion and preserves FP32 domain rejection', () => {
  runPython(`
for k, left_value, right_value in [(131072, -128, -128), (132105, -128, 127)]:
    inputs = (np.full((1, k), left_value, dtype=np.int8),
              np.full((1, k), right_value, dtype=np.int8),
              np.ones(1, dtype=np.float32), np.ones(1, dtype=np.float32))
    for oracle in (module.oracle, old_reference):
        try:
            oracle(*inputs)
        except ValueError as error:
            assert "outside INT32" in str(error), error
        else:
            raise AssertionError("INT32 overflow was accepted")

inputs = (np.full((1, 131071), -128, dtype=np.int8), np.full((1, 131071), -128, dtype=np.int8),
          np.ones(1, dtype=np.float32), np.ones(1, dtype=np.float32))
same(module.oracle(*inputs), old_reference(*inputs))

for scales in [(np.finfo(np.float32).max, 2), (np.nextafter(np.float32(0), np.float32(1)), 1)]:
    inputs = (np.ones((1, 1), dtype=np.int8), np.ones((1, 1), dtype=np.int8),
              np.array([scales[0]], dtype=np.float32), np.array([scales[1]], dtype=np.float32))
    for oracle in (module.oracle, old_reference):
        with np.errstate(over="ignore", under="ignore"):
            try:
                oracle(*inputs)
            except ValueError as error:
                assert "FP32 overflow or scale underflow" in str(error), error
            else:
                raise AssertionError("unsupported FP32 domain was accepted")
`);
});

test('large oracle agrees across row and RHS blocks and retains the INT64 fallback', () => {
  runPython(`
inputs = random_inputs(257, 513, 512)
expected = old_reference(*inputs)
same(module.oracle(*inputs), expected)
calls = []
matmul = np.matmul
def record(left, right):
    calls.append((left.shape, right.shape, left.dtype, right.dtype))
    return matmul(left, right)
with patch.object(module, "_ORACLE_BLOCK_ROWS", 37), \\
     patch.object(module, "_ORACLE_RHS_BYTES", 71 * 512 * 8), \\
     patch.object(module.np, "matmul", record):
    same(module.oracle(*inputs), expected)
assert len(calls) == 7 * 8, len(calls)
assert all(left[0] <= 37 and right[1] <= 71 and ltype == np.float64 and rtype == np.float64
           for left, right, ltype, rtype in calls)

# Check the actual precision boundary without allocating enormous matrices.
assert module._accumulator_dtype((2**53) // 16384) == np.float64
assert module._accumulator_dtype((2**53) // 16384 + 1) == np.int64
inputs = random_inputs(9, 11, 17)
with patch.object(module, "_accumulator_dtype", return_value=np.int64), \\
     patch.object(module, "_ORACLE_BLOCK_ROWS", 4), \\
     patch.object(module, "_ORACLE_RHS_BYTES", 3 * 17 * 8):
    same(module.oracle(*inputs), old_reference(*inputs))
`);
});

test('case generation preserves the previous random input and golden file bytes', () => {
  runPython(`
expected = {
    "input/x1.bin": "169871537d109e3de2a8f1344f9de88a1539c5ed0101a20bcf02a9617a914126",
    "input/x2.bin": "5b98801d5d492e68f06af09b50fb97989f5efd26f103fb1bdb95385d4ddb5510",
    "input/x1Scale.bin": "f94612afa0601b5b1a448f44e04105e557b733e831a867d0839b58be95de24ee",
    "input/x2Scale.bin": "11abbe1c6f978a6b6761d9ac550b8ee688b81c4fd00407a56833e0db601670bd",
    "golden/y.bin": "53632932df52ec9409108ac744ee412065d74c28f80f06f665c6fcf118bee3ab",
    "golden/yScale.bin": "a93415a0caceba179688142554d299abd549f91b4bd35a7e02d62b8a4168e4b0",
}
with tempfile.TemporaryDirectory() as directory:
    metadata = module.generate_case(directory, 3, 5, 7, 42)
assert {name: item["sha256"] for name, item in metadata["files"].items()} == expected
assert metadata["scale_tolerance"] == {"rtol": 0.0001, "atol": 0.0001, "max_error_fraction": 0.0001}
assert metadata["integer_output_tolerance"] == 0
`);
});
