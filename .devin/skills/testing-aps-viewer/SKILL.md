---
name: testing-aps-viewer
description: End-to-end test the APS Simple Viewer (object editor panel + DELETE flow + Design Automation entity edits) on a local server with live APS. Use when verifying UI changes in wwwroot/editor.js, wwwroot/main.js, wwwroot/main.css, routes/models.js, services/aps.js, or services/designAutomation.js.
---

# Testing the APS Simple Viewer end-to-end

This app is an Autodesk Platform Services (APS) Forge Viewer host plus a small server that uploads DWG/RVT files to OSS, translates them via Model Derivative, and exposes a `/edits` endpoint that posts edits to a Design Automation work item. Test it against a **local server connected to live APS**.

## Devin Secrets Needed

- `APS_CLIENT_ID` (user-scope)
- `APS_CLIENT_SECRET` (user-scope)
- Optional: `APS_DESIGN_AUTOMATION_NICKNAME` (defaults to `APS_CLIENT_ID`)

These should already be saved at user scope from prior sessions. If not, request them with `should_save=true` and `save_scope="user"`. Without them, `node server.js` exits immediately at `config.js`.

## Bring-up

```bash
cd /home/ubuntu/repos/aps-simple-viewer-nodejs
# Write .env from session secrets (do NOT commit .env; it is .gitignored).
cat > .env <<EOF
APS_CLIENT_ID=${APS_CLIENT_ID}
APS_CLIENT_SECRET=${APS_CLIENT_SECRET}
EOF
npm install
node server.js   # foreground; or run in a background shell
```

Server listens on `http://localhost:8080`. The dropdown auto-populates from OSS bucket `<APS_CLIENT_ID>-basic-app`. If the bucket is empty, upload a DWG from `dwg/` via the `Upload` button.

## Opening the object editor panel — production flow

The production path: right-click on a selected entity → context menu shows `객체편집` with a submenu (`위치이동`, `회전`). Hovering `객체편집` reveals the submenu after a short delay; click a submenu item to open the panel.

In automation, after right-clicking to open the menu, use `mouse_move` (not click) on the `객체편집` row to reveal the submenu before clicking `위치이동`/`회전`.

If the canvas right-click misses the entity (the menu opens but `선택 객체` is wrong), pre-select the entity programmatically before right-clicking:

```js
NOP_VIEWER.select([dbId]);   // selection survives the right-click
```

## Picking an entity that the editor can actually open on

The editor calls `getBounds3D(viewer, dbId)` which uses `tree.enumNodeFragments` + `frags.getWorldBounds`. **Many DWG entities have `hasFrags=false`** in the SVF2 translation (especially `AcDbBlockReference`s nested deep in layouts) — for those, `enumNodeFragments` returns empty and the panel throws `선택 객체의 좌표를 계산할 수 없습니다.`

Before right-clicking, scan the model and pick a dbId whose fragments actually exist:

```js
const v = NOP_VIEWER;
v.model.getBulkProperties([], { propFilter: ['Handle','Rotation'] }, function(results) {
  const tree = v.model.getInstanceTree();
  const ok = results.filter(r => {
    let hasFrag = false;
    tree.enumNodeFragments(r.dbId, () => { hasFrag = true; }, true);
    return hasFrag;
  });
  console.log('clickable dbIds:', ok.map(r => ({ dbId: r.dbId, name: r.name })));
});
```

**Known-good dbIds in `paris-baguette-v3.dwg`:**
- `MText [111A4]` (dbId varies per translation; look up by handle). Insertion point varies — read it from the panel's `현재 좌표`. Good for **move** tests (entmod fix targets DXF group 10).
- `카운터가구 500x500x760 [10DE7]` — also clickable.
- `SINK500 [ED97]` (dbId 447) has Rotation=90° but in recent SVF2 builds shows `hasFrags=false`. If the panel throws, fall back to a different entity. The block reference *can* still be edited via the server-side DA path (it works at DXF level regardless of the viewer's fragments).

## Verifying that Design Automation actually applied the edit (PR #7 critical)

**This is in scope and must be verified.** Earlier versions of `services/designAutomation.js` used command-based `_.MOVE`/`_.ROTATE` which silently no-op'd in accoreconsole batch mode (`(ssadd ent)` returns `nil`). The workitem still reported success and produced a new `_edited_*.dwg`, so HTTP/status checks looked green even though the entity was unchanged.

The current implementation uses `entget`/`entmod`/`entupd` (DXF group codes 10, 11, 50). Both code paths return HTTP 200, so **POST=200 is not enough** — you must reopen the new `_edited_*.dwg` and read the entity's actual coordinates.

Procedure:
1. Note the entity's `현재 좌표` (panel) before the edit.
2. Submit `상대좌표` X=500 (or another distinctive delta).
3. Wait for the status banner: `DWG 수정 완료. 새 도면 번역을 시작했습니다.`
4. Wait ~10–15 s; the dropdown auto-selects the new `*_edited_<timestamp>.dwg`.
5. Find the same entity by handle (via `getBulkProperties` propFilter `Handle`), select it, right-click → 객체편집 → 위치이동.
6. Read the new `현재 좌표`. **It must differ from the original by the requested delta (±2 mm for floating-point round-trip).**

If the new coordinate equals the old one, the LISP write-back is broken — this is exactly the user-reported bug in PR #7. Don't trust a green HTTP status alone.

## Capturing POST /edits payloads

The key correctness assertion for the editor's *client-side* contract is what the client sends. Wrap `window.fetch` immediately before clicking `DWG 수정/저장`:

```js
window.__captured = [];
const origFetch = window.fetch.bind(window);
window.fetch = function(url, opts) {
  if (typeof url === 'string' && url.includes('/edits') && opts && opts.method === 'POST') {
    try { window.__captured.push({ url, body: JSON.parse(opts.body) }); } catch(e){}
  }
  return origFetch(url, opts);
};
```

Expected payload shape (combined move + rotate endpoint):

```json
{
  "handle": "111a4",
  "mode": "absolute" | "relative",
  "x": <input>, "y": <input>, "angle": <input>,
  "rotationBaseX": <modelCenter.x>,
  "rotationBaseY": <modelCenter.y>,
  "moveDeltaX": <delta mm>,
  "moveDeltaY": <delta mm>
}
```

In `relative` mode `moveDeltaX === x` input. In `absolute` mode `moveDeltaX === x - modelCenter.x`. Rotation: `angle` is the **delta** (`input - currentAngle`) regardless of mode.

## Testing the DELETE button on non-ASCII filenames

Korean / bracket filenames (`[파리바게트]…dwg`, `[세븐일레븐]…rvt`) are stored as OSS object keys with **double URL-encoding** inside the base64 URN (e.g. `%255B%25ED%25...`). The route's `parseObjectName` must do a single `decodeURIComponent` before handing the key to `ossClient.deleteObject`, otherwise OSS gets a triple-encoded key and returns 404 → the route surfaces a 500 with `Could not delete model …` alert.

Stub the confirm dialog and the DELETE response capture before clicking:

```js
window.confirm = () => true;
window.__deleteResult = null;
const origFetch = window.fetch.bind(window);
window.fetch = function(url, opts) {
  const p = origFetch(url, opts);
  if (typeof url === 'string' && url.startsWith('/api/models/') && opts && opts.method === 'DELETE') {
    p.then(r => { window.__deleteResult = { status: r.status, ok: r.ok }; });
  }
  return p;
};
```

Assertions:
- `DELETE /api/models/<urn>` returns **exactly 200**.
- Dropdown shrinks by 1; the deleted URN/name is gone.
- **Re-upload the same DWG** with `curl -F "model-file=@dwg/<name>.dwg" http://localhost:8080/api/models` to confirm OSS deletion was real. Should return 200, NOT 409 (a leftover OSS object → conflict).
  - Do NOT pass `-F "model-zip-entrypoint="` with a non-zip file — the server treats the empty string as a non-empty rootFilename and the model-derivative startJob fails with 400. Omit the field entirely.

## Bulk-cleanup of `_edited_*` test artifacts

From the box (no auth needed against local server):

```bash
curl -s http://localhost:8080/api/models \
  | python3 -c "import json,sys; [print(m['urn']) for m in json.load(sys.stdin) if '_edited_' in m['name']]" \
  | while read urn; do
      curl -s -o /dev/null -w "%{http_code} \$urn\n" -X DELETE "http://localhost:8080/api/models/\$urn";
    done
```

Do this after each round of editor tests; otherwise the dropdown grows quickly and the bucket fills up.

## Chrome form-restore gotcha

Chrome restores form state (including radio `:checked`) across reloads. To verify the `절대좌표 checked by default` assertion, **hard-reload** with `Ctrl+Shift+R` (cache-bypass) before opening the panel. The HTML markup is the source of truth: `wwwroot/editor.js` ships absolute as `checked`.

## Recording

If your test plan involves UI, record. Before starting:

```bash
sudo apt-get install -y wmctrl 2>/dev/null
wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz
```

Do NOT use `xdotool key super+Up` (tiles instead of maximizing on this WM).

Use `annotate_recording` with structured types:
- `setup`: navigation / login.
- `test_start`: one per test (`It should ...`).
- `assertion`: one consolidated bullet per test_start (`test_result: passed|failed|untested`).

## Known-good test DWGs (in `dwg/`)

- `paris-baguette-v3.dwg` — ASCII name, has `MText [111A4]`, `SINK500 [ED97]`, 카운터가구 entities. Good for move tests.
- `[파리바게트]240511_파리바게트_v3.dwg` — Korean + brackets in filename. Required for non-ASCII DELETE regression.
- `[롯데리아]…dwg`, `[세븐일레븐]…rvt` — additional non-ASCII assets.
- `cadsample1.dwg` — generic small DWG for upload/delete cycle smoke tests.

## Common assertions

| Test | Assertion |
|---|---|
| Radios on same row | `Math.abs(absRect.top - relRect.top) < 5` |
| Absolute default | fresh-load `:checked.value === 'absolute'` |
| DWG mm display | `/^X -?\d{4,7}…, Y -?\d{4,7}…$/` (not page units `<200`) |
| Relative X=500 (payload) | POST `moveDeltaX === 500` exactly (was `~8050–13000` with old `pageToModelTransform` bug) |
| **Relative X=500 (round-trip)** | **After workitem completes, reopen new `_edited_*.dwg` → same entity's `현재 좌표.x` increased by 500 (±2 mm)** |
| Rotation default | `[data-field="current-angle"]` shows `R°`, `[data-field="angle"].value === R` |
| Rotation delta (payload) | After `+1`, POST `angle ≈ 1` (delta), NOT `R+1` (absolute) |
| **Rotation (round-trip)** | **Reopen edited DWG → same handle's `Rotation` property changed by the delta (±0.001 rad / ±0.1°)** |
| Absolute move | `moveDeltaX = input - modelCenter.x` (delta, NOT absolute) |
| Delete success (ASCII) | DELETE 200 → dropdown shrinks → re-upload returns 200 (not 409) |
| **Delete success (non-ASCII)** | **Same as ASCII; key risk is `parseObjectName` double-encoding regression. Always include `[파리바게트]…dwg` or similar in the test matrix.** |

## Out of scope

- Multi-viewport DWGs (`pageToModelTransform` varies per viewport).
- Concurrent edits / races on the in-memory `edits` map.
- DA Activity provisioning (`DwgObjectTransform` activity is assumed to exist for this nickname).
