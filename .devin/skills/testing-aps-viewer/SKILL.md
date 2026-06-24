---
name: testing-aps-viewer
description: End-to-end test the APS Simple Viewer (object editor panel + DELETE flow) on a local server with live APS. Use when verifying UI changes in wwwroot/editor.js, wwwroot/main.js, wwwroot/main.css, routes/models.js, or services/aps.js.
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

## Open the editor panel from JS

Production code opens the editor via the Forge canvas context menu (`객체편집 → 위치이동` or `회전`). Driving that from automation is unreliable for tiny floor-plan lines, so `wwwroot/editor.js` exposes a **test-only hook** when `window` exists:

```js
window.__editorTest = { panel, getSelected, setSelected };
// Open the move panel with a synthetic selected:
window.__editorTest.setSelected(synthetic);
window.__editorTest.panel.open('move', synthetic);   // or 'rotate'
```

Use this hook in tests instead of trying to click into the canvas.

## DWG SVF gotcha: no fragments for individual entities

Forge's DWG SVF does NOT populate `dbId2fragId` for individual `AcDbLine` / `AcDbPolyline` / `AcDbBlockReference` dbIds. `enumNodeFragments(dbId, …)` returns an empty list and `getBounds2D`/`getBounds3D` throws `선택 객체의 좌표를 계산할 수 없습니다.`

**Workaround for tests:** construct a synthetic `selected` object with known coordinates and pass it through `window.__editorTest.setSelected`:

```js
const synthetic = {
  dbId: 1017,
  handle: 'aa11',
  type: 'AcDbLine',
  name: 'TEST LINE',
  center: new THREE.Vector3(8050.123, 12000.456, 0),
  modelCenter: new THREE.Vector3(8050.123, 12000.456, 0),
  pageToModelTransform: null,
  angle: 0
};
```

For rotation tests you usually want a **real** rotated `AcDbBlockReference`. Scan the loaded model for one:

```js
const tree = NOP_VIEWER.model.getInstanceTree();
const ids = [];
tree.enumNodeChildren(tree.getRootId(), id => ids.push(id), true);
// Then for each id, NOP_VIEWER.getProperties(id, props => …) and look for
// a property with name in ['Rotation','Angle','Rotate','회전','회전각도'] !== 0.
```

In `paris-baguette-v3.dwg`, dbId 447 (`SINK500 [ED97]`, `AcDbBlockReference`) has `Rotation = 90` and is a reliable target.

## Capturing POST /edits payloads

The key correctness assertion for the editor is what the client sends. Wrap `window.fetch` immediately before clicking `DWG 수정/저장`:

```js
window.__captured = [];
window.__origFetch = window.fetch;
window.fetch = function(input, init){
  try {
    const url = (typeof input === 'string') ? input : (input && input.url);
    if (url && /\/edits$/.test(url) && init && init.method === 'POST') {
      window.__captured.push({url, body: JSON.parse(init.body)});
    }
  } catch(e){}
  return window.__origFetch.apply(this, arguments);
};
// click apply, wait ~1.5s
window.fetch = window.__origFetch;
```

Do NOT wait for the Design Automation work item to finish (30 s – 2 min). The PR's correctness is in the **client → server contract**, which the server forwards verbatim. The server response is `202`-style with `{ workItemId }`.

Expected payload shape (move + rotate combined endpoint):

```json
{
  "handle": "ed97",
  "mode": "absolute" | "relative",
  "x": <input>, "y": <input>, "angle": <input>,
  "rotationBaseX": <modelCenter.x>,
  "rotationBaseY": <modelCenter.y>,
  "moveDeltaX": <delta mm>,
  "moveDeltaY": <delta mm>
}
```

In `relative` mode `moveDeltaX === x` input. In `absolute` mode `moveDeltaX === x - modelCenter.x`. Rotation: `angle` is the **delta** (`input - currentAngle`) regardless of mode.

## Chrome form-restore gotcha

Chrome restores form state (including radio `:checked`) across reloads. To verify the `절대좌표 checked by default` assertion, **hard-reload** with `Ctrl+Shift+R` (cache-bypass) before opening the panel. The HTML markup is the source of truth: `wwwroot/editor.js:318` has `checked` on the absolute radio.

## Testing the DELETE button

Driving a native `window.confirm` dialog from automation is brittle. Stub it with a recorder before clicking:

```js
window.__confirmMsg = null;
window.__origConfirm = window.confirm;
window.confirm = msg => { window.__confirmMsg = msg; return true; };
// click the Delete button
// after: window.__confirmMsg includes the model name + 삭제하시겠습니까
window.confirm = window.__origConfirm;
```

Assertions for DELETE:
- Button has class `danger` and red `background-color` (≈ `rgb(221, 51, 51)`).
- `DELETE /api/models/<urn>` returns `200` with `{ urn, name }`.
- Dropdown count decreases by 1; the deleted URN is gone.
- **Re-upload the same DWG** to confirm the OSS object was actually deleted, not just hidden. A leftover OSS object would return `409`.

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

- `paris-baguette-v3.dwg` — has a rotated `AcDbBlockReference` (`SINK500 [ED97]`, dbId 447, `Rotation=90`). Good for rotation tests.
- `cadsample1.dwg`, `[롯데리아]260427_레이아웃+유형+9_rev.1_pocv3.dwg` — generic DWGs for upload/delete cycle tests.

## Common assertions

| Test | Assertion |
|---|---|
| Radios on same row | `Math.abs(absRect.top - relRect.top) < 5` |
| Absolute default | fresh-load `:checked.value === 'absolute'` |
| DWG mm display | `/^X -?\d{4,7}…, Y -?\d{4,7}…$/` (not page units `<200`) |
| Relative X=50 | POST `moveDeltaX === 50` exactly (was `~8050–13000` with old `pageToModelTransform` bug) |
| Rotation default | `[data-field="current-angle"]` shows `R°`, `[data-field="angle"].value === R` |
| Rotation delta | After `+1`, POST `angle ≈ 1` (delta), NOT `R+1` (absolute) |
| Absolute move | `moveDeltaX = input - modelCenter.x` (delta, NOT absolute) |
| Delete success | DELETE 200 → dropdown shrinks → re-upload returns 200 (not 409) |

## Out of scope

- Round-trip verification that Design Automation actually shifts entities inside the DWG (Activity-side, unchanged by client PRs). Tests verify the client → server contract only.
- Multi-viewport DWGs (`pageToModelTransform` varies per viewport).
- MText rotation (different property name).
- Concurrent edits / races on the in-memory `edits` map.
