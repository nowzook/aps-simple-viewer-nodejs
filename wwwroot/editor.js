export function setupObjectEditor(viewer, getCurrentUrn, onModelReady) {
    const panel = createPanel();
    let selected = null;

    viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, async () => {
        const dbIds = viewer.getSelection();
        if (dbIds.length !== 1) {
            selected = null;
            panel.hide();
            return;
        }
        selected = await getSelectedObject(viewer, dbIds[0]);
        if (selected) {
            panel.setSelectedObject(selected);
        }
    });

    viewer.registerContextMenuCallback('object-edit-menu', (menu, status) => {
        if (!status.hasSelected || status.numSelected !== 1) {
            return;
        }
        menu.push({
            title: '객체편집',
            target: [
                {
                    title: '위치이동',
                    target: async () => {
                        selected = await getSelectedObject(viewer, viewer.getSelection()[0]);
                        panel.open('move', selected);
                    }
                },
                {
                    title: '회전',
                    target: async () => {
                        selected = await getSelectedObject(viewer, viewer.getSelection()[0]);
                        panel.open('rotate', selected);
                    }
                }
            ]
        });
    });

    panel.onApply = async values => {
        if (!selected) {
            throw new Error('객체가 선택되지 않았습니다.');
        }
        const urn = getCurrentUrn();
        if (!urn) {
            throw new Error('로드된 모델 URN을 확인할 수 없습니다.');
        }
        panel.setBusy('DWG 편집 작업을 시작하는 중...');
        const resp = await fetch(`/api/models/${encodeURIComponent(urn)}/edits`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                handle: selected.handle,
                mode: values.mode,
                x: values.x,
                y: values.y,
                angle: values.angle,
                rotationBaseX: selected.center.x,
                rotationBaseY: selected.center.y
            })
        });
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const { workItemId } = await resp.json();
        pollWorkItem(workItemId, panel, onModelReady);
    };
}

async function pollWorkItem(workItemId, panel, onModelReady) {
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const resp = await fetch(`/api/edits/${encodeURIComponent(workItemId)}`);
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const status = await resp.json();
        panel.setBusy(`DWG 편집 진행 상태: ${status.status}${status.progress ? ` (${status.progress})` : ''}`);
        if (status.status === 'success') {
            panel.setBusy('DWG 수정 완료. 새 도면 번역을 시작했습니다.');
            onModelReady(status.model);
            return;
        }
        if (!['pending', 'inprogress'].includes(status.status)) {
            throw new Error(`DWG 편집 실패: ${status.status}`);
        }
    }
}

async function getSelectedObject(viewer, dbId) {
    const properties = await getProperties(viewer, dbId);
    let bounds;
    try {
        bounds = getBounds2D(viewer, dbId);
    } catch (err) {
        bounds = getBounds3D(viewer, dbId);
    }
    const handle = getHandle(properties);
    if (!handle) {
        throw new Error('선택 객체에서 DWG handle(externalId)을 찾을 수 없습니다.');
    }
    return {
        dbId,
        handle,
        name: properties.name || `dbId ${dbId}`,
        center: bounds.center,
        angle: 0
    };
}

function getProperties(viewer, dbId) {
    return new Promise((resolve, reject) => {
        viewer.getProperties(dbId, resolve, reject);
    });
}

function getHandle(properties) {
    if (!properties.externalId) {
        return null;
    }
    const parts = String(properties.externalId).split(/[\s/:|\\_-]+/);
    for (let i = parts.length - 1; i >= 0; i--) {
        if (/^[0-9A-Z]+$/i.test(parts[i])) {
            return parts[i];
        }
    }
    const match = String(properties.externalId).match(/[0-9A-Z]+$/i);
    return match ? match[0] : null;
}

function getBounds2D(viewer, dbId) {
    const model = viewer.model;
    const frags = model.getFragmentList();
    let fragIds = frags.fragments.dbId2fragId[dbId];
    if (!Array.isArray(fragIds)) {
        fragIds = fragIds === undefined ? [] : [fragIds];
    }
    const bounds = new THREE.Box3();
    const boundsCallback = new Autodesk.Viewing.Private.BoundsCallback(bounds);
    for (const fragId of fragIds) {
        const mesh = frags.getVizmesh(fragId);
        const vbr = new Autodesk.Viewing.Private.VertexBufferReader(mesh.geometry, viewer.impl.use2dInstancing);
        vbr.enumGeomsForObject(dbId, boundsCallback);
    }
    if (bounds.isEmpty()) {
        throw new Error('선택 객체의 2D 좌표를 계산할 수 없습니다.');
    }
    const center = bounds.getCenter(new THREE.Vector3());
    return { bounds, center };
}

function getBounds3D(viewer, dbId) {
    const model = viewer.model;
    const tree = model.getInstanceTree();
    const frags = model.getFragmentList();
    const bounds = new THREE.Box3();
    tree.enumNodeFragments(dbId, fragId => {
        const fragBounds = new THREE.Box3();
        frags.getWorldBounds(fragId, fragBounds);
        bounds.union(fragBounds);
    }, true);
    if (bounds.isEmpty()) {
        throw new Error('선택 객체의 좌표를 계산할 수 없습니다.');
    }
    const center = bounds.getCenter(new THREE.Vector3());
    return { bounds, center };
}

function createPanel() {
    const element = document.createElement('div');
    element.id = 'object-editor';
    element.innerHTML = `
        <div class="object-editor-header">
            <strong>객체편집</strong>
            <button type="button" data-action="close">×</button>
        </div>
        <div class="object-editor-body">
            <div class="object-editor-row"><span>선택 객체</span><output data-field="name">-</output></div>
            <div class="object-editor-row"><span>현재 좌표</span><output data-field="current">-</output></div>
            <fieldset>
                <legend>이동 방식</legend>
                <label><input type="radio" name="move-mode" value="absolute" checked> 절대좌표</label>
                <label><input type="radio" name="move-mode" value="relative"> 상대좌표</label>
            </fieldset>
            <label>X <input type="number" step="1" data-field="x"></label>
            <div class="object-editor-buttons">
                <button type="button" data-action="x-minus">-</button>
                <button type="button" data-action="x-plus">+</button>
            </div>
            <label>Y <input type="number" step="1" data-field="y"></label>
            <div class="object-editor-buttons">
                <button type="button" data-action="y-minus">-</button>
                <button type="button" data-action="y-plus">+</button>
            </div>
            <label>회전각도 <input type="number" step="1" data-field="angle"></label>
            <div class="object-editor-buttons">
                <button type="button" data-action="angle-minus">-</button>
                <button type="button" data-action="angle-plus">+</button>
            </div>
            <button type="button" class="primary" data-action="apply">DWG 수정/저장</button>
            <div class="object-editor-status" data-field="status"></div>
        </div>
    `;
    document.body.appendChild(element);

    const panel = {
        onApply: null,
        open(mode, selected) {
            this.setSelectedObject(selected);
            element.style.display = 'block';
            if (mode === 'move') {
                element.querySelector('[data-field="x"]').focus();
            } else {
                element.querySelector('[data-field="angle"]').focus();
            }
        },
        hide() {
            element.style.display = 'none';
        },
        setSelectedObject(selected) {
            if (!selected) {
                return;
            }
            element.querySelector('[data-field="name"]').textContent = `${selected.name} (${selected.handle})`;
            element.querySelector('[data-field="current"]').textContent = `X ${formatNumber(selected.center.x)}, Y ${formatNumber(selected.center.y)}`;
            element.querySelector('[data-field="x"]').value = formatNumber(selected.center.x);
            element.querySelector('[data-field="y"]').value = formatNumber(selected.center.y);
            element.querySelector('[data-field="angle"]').value = selected.angle;
            element.querySelector('[data-field="status"]').textContent = '';
        },
        setBusy(message) {
            element.querySelector('[data-field="status"]').textContent = message;
        }
    };

    element.addEventListener('click', async event => {
        const action = event.target.dataset.action;
        if (!action) {
            return;
        }
        if (action === 'close') {
            panel.hide();
            return;
        }
        if (action === 'apply') {
            try {
                await panel.onApply({
                    mode: element.querySelector('input[name="move-mode"]:checked').value,
                    x: parseFloat(element.querySelector('[data-field="x"]').value),
                    y: parseFloat(element.querySelector('[data-field="y"]').value),
                    angle: parseFloat(element.querySelector('[data-field="angle"]').value)
                });
            } catch (err) {
                panel.setBusy(err.message);
                console.error(err);
            }
            return;
        }
        const [field, direction] = action.split('-');
        const input = element.querySelector(`[data-field="${field}"]`);
        if (input) {
            input.value = formatNumber(parseFloat(input.value || 0) + (direction === 'plus' ? 1 : -1));
        }
    });

    element.addEventListener('change', event => {
        if (event.target.name === 'move-mode' && event.target.value === 'relative') {
            element.querySelector('[data-field="x"]').value = 0;
            element.querySelector('[data-field="y"]').value = 0;
        }
    });

    return panel;
}

function formatNumber(value) {
    return Number(value.toFixed(3));
}
