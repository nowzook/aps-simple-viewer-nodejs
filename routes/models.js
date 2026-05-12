const express = require('express');
const formidable = require('express-formidable');
const { APS_BUCKET } = require('../config.js');
const { listObjects, uploadObject, deleteObject, translateObject, getManifest, urnify } = require('../services/aps.js');
const { decodeObjectName, encodeObjectName } = require('../services/modelNames.js');

function parseObjectName(urn) {
    const padded = urn + '='.repeat((4 - urn.length % 4) % 4);
    const objectId = Buffer.from(padded, 'base64').toString('utf8');
    const prefix = `urn:adsk.objects:os.object:${APS_BUCKET}/`;
    if (!objectId.startsWith(prefix)) {
        const error = new Error('URN does not belong to the current bucket.');
        error.status = 400;
        throw error;
    }
    return objectId.substring(prefix.length);
}

let router = express.Router();

router.get('/api/models', async function (req, res, next) {
    try {
        const objects = await listObjects();
        res.json(objects.map(o => ({
            name: decodeObjectName(o.objectKey),
            urn: urnify(o.objectId)
        })));
    } catch (err) {
        next(err);
    }
});

router.get('/api/models/:urn/status', async function (req, res, next) {
    try {
        const manifest = await getManifest(req.params.urn);
        if (manifest) {
            let messages = [];
            if (manifest.derivatives) {
                for (const derivative of manifest.derivatives) {
                    messages = messages.concat(derivative.messages || []);
                    if (derivative.children) {
                        for (const child of derivative.children) {
                            messages.concat(child.messages || []);
                        }
                    }
                }
            }
            res.json({ status: manifest.status, progress: manifest.progress, messages });
        } else {
            res.json({ status: 'n/a' });
        }
    } catch (err) {
        next(err);
    }
});

router.post('/api/models', formidable({ maxFileSize: Infinity }), async function (req, res, next) {
    const file = req.files['model-file'];
    if (!file) {
        res.status(400).send('The required field ("model-file") is missing.');
        return;
    }
    try {
        const objectName = encodeObjectName(file.name);
        const obj = await uploadObject(objectName, file.path);
        await translateObject(urnify(obj.objectId), req.fields['model-zip-entrypoint']);
        res.json({
            name: decodeObjectName(obj.objectKey),
            urn: urnify(obj.objectId)
        });
    } catch (err) {
        next(err);
    }
});

router.delete('/api/models/:urn', async function (req, res, next) {
    try {
        const objectName = parseObjectName(req.params.urn);
        await deleteObject(objectName);
        res.json({
            name: decodeObjectName(objectName),
            urn: req.params.urn
        });
    } catch (err) {
        if (err.status === 400) {
            res.status(400).send(err.message);
            return;
        }
        next(err);
    }
});

module.exports = router;
