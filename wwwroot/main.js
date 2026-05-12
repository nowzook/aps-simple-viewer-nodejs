import { initViewer, loadModel } from './viewer.js';
import { setupObjectEditor } from './editor.js';

initViewer(document.getElementById('preview')).then(viewer => {
    const urn = window.location.hash?.substring(1);
    setupModelSelection(viewer, urn);
    setupModelUpload(viewer);
    setupModelDownload();
    setupModelDelete(viewer);
    setupObjectEditor(viewer, () => window.location.hash?.substring(1), model => {
        setupModelSelection(viewer, model.urn);
    });
});

async function setupModelSelection(viewer, selectedUrn) {
    const dropdown = document.getElementById('models');
    const downloadButton = document.getElementById('download');
    const deleteButton = document.getElementById('delete');
    dropdown.innerHTML = '';
    try {
        const resp = await fetch('/api/models');
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const models = await resp.json();
        dropdown.innerHTML = models.map(model => `<option value=${model.urn} ${model.urn === selectedUrn ? 'selected' : ''}>${model.name}</option>`).join('\n');
        dropdown.onchange = () => onModelSelected(viewer, dropdown.value);
        if (dropdown.value) {
            onModelSelected(viewer, dropdown.value);
            if (downloadButton) {
                downloadButton.removeAttribute('disabled');
            }
            if (deleteButton) {
                deleteButton.removeAttribute('disabled');
            }
        } else {
            unloadCurrentModel(viewer);
            window.location.hash = '';
            if (downloadButton) {
                downloadButton.setAttribute('disabled', 'true');
            }
            if (deleteButton) {
                deleteButton.setAttribute('disabled', 'true');
            }
        }
    } catch (err) {
        alert('Could not list models. See the console for more details.');
        console.error(err);
    }
}

function setupModelDownload() {
    const button = document.getElementById('download');
    if (!button) {
        return;
    }
    button.onclick = () => {
        const dropdown = document.getElementById('models');
        const urn = dropdown.value;
        if (!urn) {
            return;
        }
        window.location.href = `/api/models/${encodeURIComponent(urn)}/download`;
    };
}

function unloadCurrentModel(viewer) {
    try {
        const models = viewer.getVisibleModels ? viewer.getVisibleModels() : [];
        if (Array.isArray(models)) {
            for (const model of models) {
                viewer.unloadModel(model);
            }
        } else if (viewer.model) {
            viewer.unloadModel(viewer.model);
        }
    } catch (err) {
        console.error('Could not unload current model from viewer.', err);
    }
}

function setupModelDelete(viewer) {
    const button = document.getElementById('delete');
    if (!button) {
        return;
    }
    button.onclick = async () => {
        const dropdown = document.getElementById('models');
        const urn = dropdown.value;
        if (!urn) {
            return;
        }
        const modelName = dropdown.options[dropdown.selectedIndex]?.text || urn;
        if (!window.confirm(`현재 도면 "${modelName}"을(를) 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.`)) {
            return;
        }
        button.setAttribute('disabled', 'true');
        dropdown.setAttribute('disabled', 'true');
        showNotification(`Deleting model <em>${modelName}</em>...`);
        try {
            const resp = await fetch(`/api/models/${encodeURIComponent(urn)}`, { method: 'DELETE' });
            if (!resp.ok) {
                throw new Error(await resp.text());
            }
            unloadCurrentModel(viewer);
            window.location.hash = '';
            await setupModelSelection(viewer);
        } catch (err) {
            alert(`Could not delete model ${modelName}. See the console for more details.`);
            console.error(err);
            button.removeAttribute('disabled');
        } finally {
            clearNotification();
            dropdown.removeAttribute('disabled');
        }
    };
}

async function setupModelUpload(viewer) {
    const upload = document.getElementById('upload');
    const input = document.getElementById('input');
    const models = document.getElementById('models');
    upload.onclick = () => input.click();
    input.onchange = async () => {
        const file = input.files[0];
        let data = new FormData();
        data.append('model-file', file);
        if (file.name.endsWith('.zip')) { // When uploading a zip file, ask for the main design file in the archive
            const entrypoint = window.prompt('Please enter the filename of the main design inside the archive.');
            data.append('model-zip-entrypoint', entrypoint);
        }
        upload.setAttribute('disabled', 'true');
        models.setAttribute('disabled', 'true');
        showNotification(`Uploading model <em>${file.name}</em>. Do not reload the page.`);
        try {
            const resp = await fetch('/api/models', { method: 'POST', body: data });
            if (!resp.ok) {
                throw new Error(await resp.text());
            }
            const model = await resp.json();
            setupModelSelection(viewer, model.urn);
        } catch (err) {
            alert(`Could not upload model ${file.name}. See the console for more details.`);
            console.error(err);
        } finally {
            clearNotification();
            upload.removeAttribute('disabled');
            models.removeAttribute('disabled');
            input.value = '';
        }
    };
}

async function onModelSelected(viewer, urn) {
    if (window.onModelSelectedTimeout) {
        clearTimeout(window.onModelSelectedTimeout);
        delete window.onModelSelectedTimeout;
    }
    window.location.hash = urn;
    try {
        const resp = await fetch(`/api/models/${urn}/status`);
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const status = await resp.json();
        switch (status.status) {
            case 'n/a':
                showNotification(`Model has not been translated.`);
                break;
            case 'pending':
            case 'inprogress':
                showNotification(`Model is being translated (${status.progress})...`);
                window.onModelSelectedTimeout = setTimeout(onModelSelected, 5000, viewer, urn);
                break;
            case 'failed':
                showNotification(`Translation failed. <ul>${status.messages.map(msg => `<li>${JSON.stringify(msg)}</li>`).join('')}</ul>`);
                break;
            default:
                clearNotification();
                loadModel(viewer, urn);
                break; 
        }
    } catch (err) {
        alert('Could not load model. See the console for more details.');
        console.error(err);
    }
}

function showNotification(message) {
    const overlay = document.getElementById('overlay');
    overlay.innerHTML = `<div class="notification">${message}</div>`;
    overlay.style.display = 'flex';
}

function clearNotification() {
    const overlay = document.getElementById('overlay');
    overlay.innerHTML = '';
    overlay.style.display = 'none';
}
