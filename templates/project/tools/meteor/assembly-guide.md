# Meteor version assembly guide

This file documents the currently supported version assembly contract. Chief selects one template for each `(op_id, dtype_id)` target with `meteor_configure_assembly_template`. Meteor freezes the selected file under `templates/<op>/<dtype>/assembly/<template_id>.version.asc.tmpl`, records its hash in `meteor.config.json`, and uses that exact content for later automatic integration.

Bundled templates are examples. They are not selected automatically for schema v2 workspaces.

## Template contract

Slot contract: `meteor-version-slots-v1`.

A version template must contain each slot exactly once and must not contain unknown `{{...}}` slots:

- `{{ASSEMBLY_KEY}}` — stable integration key for generated names, comments, or trace labels.
- `{{DEPENDENCY_PREAMBLE}}` — concatenated submitted dependencies marked `kind: "preamble"`.
- `{{SHARED_CODE}}` — concatenated submitted dependencies marked `kind: "shared"`.
- `{{HOST_CONTEXT_HELPERS}}` — target host context helpers pinned by the target template resources.
- `{{KERNEL_DEVICE_CODE}}` — selected kernel device source blocks, each prefixed with a module comment.
- `{{KERNEL_HOST_LAUNCHERS}}` — selected kernel host launcher source blocks, each prefixed with a module comment.
- `{{IMPLEMENTATION_TABLE}}` — one macro-style implementation entry per selected kernel implementation.
- `{{BUCKET_TABLE}}` — one macro-style bucket entry per routed measured case group.
- `{{ROUTE_FUNCTION_BODY}}` — C/C++ statements that return the selected `{ruleId, implementationId}` for exact measured shapes.

Meteor validates the template before freezing it and validates the frozen hash before rendering.

## Macro data emitted by Meteor

Meteor emits data through two macro names so the chosen template controls the outer ABI and call shape.

`{{IMPLEMENTATION_TABLE}}` expands to lines like:

```cpp
METEOR_IMPLEMENTATION(1U, some_kernel_launch, "some_kernel@r1")
```

Fields:

1. `ID` — positive uint32 implementation id.
2. `LAUNCHER` — the launcher symbol from the selected kernel module manifest.
3. `LABEL` — string label `<kernel_id>@<revision>`.

`{{BUCKET_TABLE}}` expands to lines like:

```cpp
METEOR_BUCKET(1U, 1U, "case_a,case_b")
```

Fields:

1. `RULE_ID` — positive uint32 route rule id.
2. `IMPLEMENTATION_ID` — implementation id selected for this bucket.
3. `CASES` — comma-separated measured case ids represented by the bucket.

The template decides what these macros mean. A QMQ-style template can make `METEOR_IMPLEMENTATION` produce a `switch` body that calls `LAUNCHER(call, shape, resources)`. Another target can map the same data into a table, generated wrapper, or different dispatch signature. Meteor does not generate the outer launcher ABI for schema v2 version assembly.

## Route function body

`{{ROUTE_FUNCTION_BODY}}` expands to exact-shape predicates over the target case suite, for example:

```cpp
if ((shape.m == 16U && shape.n == 16U && shape.k == 64U)) { return {1U, 1U}; }
if ((shape.m == 32U && shape.n == 16U && shape.k == 64U)) { return {2U, 1U}; }
```

The surrounding template must provide the route function signature and fallback behavior. The function may return any type required by the target template, as long as the inserted statements are valid in that body. The bundled examples use a small `{ruleId, implementationId}` style choice struct.

Routing rules are generated only from measured case ids selected by integration. Partial shape predicates are not supported. Duplicate shapes, duplicate route ids, overlapping routes, and routes to unsupported cases are rejected.

## Performance selection and buckets

Automatic integration compares full-size measurement receipts at the case level. A submitted kernel can enter a version only for case ids that are both:

- `PASS` in its full-size receipt, and
- listed in the subagent submission `recommended_case_ids`.

For every selected measured case, integration chooses the compatible recommended `PASS` kernel with the smallest measured median latency for that exact case. A submitted kernel that is faster by any positive amount wins that shape; there is no near-tie improvement threshold in version selection. If medians are exactly equal, the earlier committed candidate keeps deterministic priority. If a new submission does not change the selected routing, integration returns `NO_CHANGE`; it preserves the existing route selections and does not render a new version.

When integration renders a version, each selected case becomes a route rule. Multiple case ids may appear in one route rule if the frozen spec groups them, but every route still resolves to a selected implementation id and exact measured shape predicate.

## Target isolation

Schema v2 workspaces are scoped by `(workspace_id, op_id, dtype_id)`.

Version assembly rejects kernels, receipts, submissions, and frozen templates that belong to a different target. Two targets may use the same local kernel id, revision, or template id without mixing artifacts, because generated paths and target metadata are scoped by op and dtype.

## Freeze and retry behavior

Integration writes `spec.json` before rendering `kernel.asc`. The spec records the selected route rules and the assembly template reference/hash in effect at that time. If rendering is interrupted and later retried, Meteor reuses the frozen spec and frozen template reference from `spec.json`; a later Chief template change does not alter that existing integration artifact.

New integration events use the current configured template for their target.
