const express = require('express');
const { APS_BUCKET } = require('../config.js');
const { runDwgTransform, getWorkItemStatus } = require('../services/designAutomation.js');
const { translateObject, urnify } = require('../services/aps.js');

function parseObjectId(urn) {
    const padded = urn + '='.repeat((4 - urn.length % 4) % 4);
    const objectId = Buffer.from(padded, 'base64').toString('utf8');
    const prefix = 'urn:adsk.objects:os.object:';
    if (!objectId.startsWith(prefix)) {
        throw new Error('Unsupported model URN.');
    }
    const objectPath = objectId.substring(prefix.length);
    const slashIndex = objectPath.indexOf('/');
    if (slashIndex === -1) {
        throw new Error('Could not parse object key from model URN.');
    }
    return {
        objectId,
        objectName: objectPath.substring(slashIndex + 1)
    };
}

function createOutputObjectName(inputObjectName) {
    const dotIndex = inputObjectName.lastIndexOf('.');
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').substring(0, 14);
    if (dotIndex === -1) {
        return `${inputObjectName}_edited_${timestamp}.dwg`;
    }
    return `${inputObjectName.substring(0, dotIndex)}_edited_${timestamp}${inputObjectName.substring(dotIndex)}`;
}

function validateTransform(body) {
    const handle = String(body?.handle || '').replace(/[^0-9A-Z]/gi, '');
    if (!handle) {
        const err = new Error('DWG entity handle is required.');
        err.status = 400;
        throw err;
    }
    return {
        handle,
        mode: body.mode === 'absolute' ? 'absolute' : 'relative',
        x: normalizeNumber(body.x),
        y: normalizeNumber(body.y),
        angle: normalizeNumber(body.angle),
        rotationBaseX: normalizeNumber(body.rotationBaseX),
        rotationBaseY: normalizeNumber(body.rotationBaseY)
    };
}

function normalizeNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

const router = express.Router();
const edits = new Map();

router.use(express.json());

router.post('/api/models/:urn/edits', async function (req, res, next) {
    try {
        const transform = validateTransform(req.body);
        const { objectName } = parseObjectId(req.params.urn);
        const outputObjectName = createOutputObjectName(objectName);
        const status = await runDwgTransform({
            inputObjectName: objectName,
            outputObjectName,
            transform
        });
        edits.set(status.id, {
            outputObjectName,
            translated: false
        });
        res.json({
            workItemId: status.id,
            status: status.status
        });
    } catch (err) {
        next(err);
    }
});

router.get('/api/edits/:workItemId', async function (req, res, next) {
    try {
        const edit = edits.get(req.params.workItemId);
        if (!edit) {
            res.status(404).send('Unknown edit work item.');
            return;
        }
        const status = await getWorkItemStatus(req.params.workItemId);
        const response = {
            workItemId: req.params.workItemId,
            status: status.status,
            progress: status.progress,
            reportUrl: status.reportUrl
        };
        if (status.status === 'success') {
            const outputObjectId = `urn:adsk.objects:os.object:${APS_BUCKET}/${edit.outputObjectName}`;
            const urn = urnify(outputObjectId);
            if (!edit.translated) {
                await translateObject(urn);
                edit.translated = true;
            }
            response.model = {
                name: edit.outputObjectName,
                urn
            };
        }
        res.json(response);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
